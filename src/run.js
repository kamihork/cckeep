import { decide, readScreen, readPanel } from './detect.js';
import { decideLimit } from './limits.js';
import { parsePsTable, isTargetPane } from './procs.js';
import * as realTmux from './tmux.js';
import { loadState, saveState, forPane, forLimit, prune, appendLog, acquireLock, releaseLock, markEarned } from './state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Actions that come from the quota rules rather than the Remote Control ones. */
const LIMIT_ACTIONS = new Set(['switch-model', 'restore-model', 'resume']);

/** Reasons worth showing even though nothing was done, because they explain a long silence. */
const LIMIT_REASONS = new Set(['limit-wait', 'limit-gave-up']);

/**
 * What to put back when a send is called off at the last moment. The counters
 * had already matured to reach this point; discarding them would make the pane
 * start its wait from scratch every time it happened to be busy.
 */
function abortedCounters(before) {
  return {
    lastActionAt: before.lastActionAt,
    panelPending: before.panelPending,
    miss: before.miss,
    stuck: before.stuck,
  };
}

/**
 * Is the pane quiet enough to type into?
 *
 * A running turn animates a spinner and a token counter, so two byte-identical
 * captures a couple of seconds apart is a cheap and reliable "nothing is
 * happening here" signal — and it needs no knowledge of Claude Code's changing
 * status-line wording.
 */
export async function isIdle(tmux, paneId, settle) {
  // Three samples, not two: with two, any animation whose period divides the
  // interval aliases to identical frames and a running turn reads as idle.
  const a = tmux.capture(paneId);
  await sleep(settle);
  const b = tmux.capture(paneId);
  if (a.length === 0 || a !== b) return false;
  await sleep(Math.round(settle / 2));
  return tmux.capture(paneId) === b;
}

/**
 * One pass over every tmux pane running Claude Code.
 *
 * @returns {Promise<{results: Array, acted: number}>} one result per candidate
 *          pane, for the CLI to render. Nothing is written when dryRun is set.
 */
export async function runPass({ tmux = realTmux, config, dryRun = false, now = Math.floor(Date.now() / 1000) } = {}) {
  const results = [];
  if (!tmux.tmuxPath()) return { results, acted: 0, error: 'no-tmux' };
  if (!tmux.hasServer()) return { results, acted: 0, error: 'no-server' };

  const panes = tmux.listPanes();
  if (panes === null) return { results, acted: 0, error: 'query-failed' };
  if (!dryRun && !acquireLock()) return { results, acted: 0, error: 'busy-elsewhere' };
  const procs = parsePsTable(tmux.processTable ? tmux.processTable() : '');
  const state = loadState();
  let acted = 0;

  for (const pane of panes) {
    if (!isTargetPane(pane, procs, config.paneCommand)) continue;

    const screen = tmux.capture(pane.id);
    if (!screen) continue;

    const before = forPane(state, pane.id);
    const { action: rcAction, reason: rcReason, state: after } = decide({ screen, state: before, now, config });
    state[pane.id] = after;

    let action = rcAction;
    let reason = rcReason;
    let model = null;

    // Quota is only consulted when the link itself needs nothing. Both halves
    // type into the same pane, and letting them act in the same pass would
    // interleave a re-arm and a resume into one garbled line.
    let limitBefore = null;
    if (action === 'none' && config.limits) {
      limitBefore = forLimit(state, pane.id);
      const lim = decideLimit({ screen, state: limitBefore, now, config });
      state[pane.id] = { ...state[pane.id], limit: lim.state };
      if (lim.action !== 'none') {
        action = lim.action;
        reason = lim.reason;
        model = lim.model ?? null;
      } else if (LIMIT_REASONS.has(lim.reason)) {
        // "connected" is true and useless while a pane sits blocked on quota for
        // an hour; say what it is actually waiting for.
        reason = lim.reason;
      }
    }

    const result = { pane: pane.label, id: pane.id, action, reason, signals: readScreen(screen) };
    if (model) result.model = model;

    if (action === 'none') {
      results.push(result);
      continue;
    }

    if (dryRun) {
      result.action = `would-${action}`;
      results.push(result);
      continue;
    }

    // Every action types into the pane, so all of them go through the same
    // checks: the decision came from one capture, and anything could have
    // happened since.
    const abort = (why) => {
      result.action = 'none';
      result.reason = why;
      state[pane.id] = { ...after, ...abortedCounters(before) };
      // The quota attempt was never spent, so it must not be counted either. A
      // pane that happens to be busy at every check would otherwise burn through
      // limitMaxAttempts without a single prompt ever reaching it.
      if (limitBefore) state[pane.id].limit = limitBefore;
      results.push(result);
    };

    if (!(await isIdle(tmux, pane.id, config.settle))) {
      abort('busy');
      continue;
    }

    // Re-read: the pane may have reconnected, opened a dialog, or had something
    // typed into it while we waited.
    const recheck = readScreen(tmux.capture(pane.id));

    // No action may type into a dialog or on top of a draft. Past that the two
    // halves want different things: the panel step needs the panel still on
    // screen, a re-arm needs the link still down — and a quota action does not
    // care about the link at all, because a *connected* pane blocked on quota is
    // precisely the case it exists for. Reusing the re-arm condition here would
    // have made the resume fire only on disconnected sessions.
    let stillSafe;
    if (action === 'confirm-panel') stillSafe = recheck.panel && !recheck.modal && recheck.composer !== 'draft';
    else if (LIMIT_ACTIONS.has(action)) stillSafe = !recheck.modal && !recheck.panel && recheck.composer === 'empty';
    else stillSafe = !recheck.connected && !recheck.modal && !recheck.panel && recheck.composer === 'empty';

    if (!stillSafe) {
      const recovered = recheck.connected && !LIMIT_ACTIONS.has(action);
      abort(recovered ? 'recovered' : recheck.composer !== 'empty' ? 'composer-busy' : 'dialog');
      continue;
    }

    if (action === 'confirm-panel') {
      // The panel's default focus is "Continue", so a bare Enter would just
      // close it. Walk the focus to "Disconnect this session", re-reading the
      // pane after every keystroke; if the panel ever stops looking the way we
      // expect, stop touching it.
      let moved = 0;
      let panel = readPanel(tmux.capture(pane.id));
      while (panel && panel.focused !== panel.disconnect && moved < 6) {
        tmux.sendKey(pane.id, panel.focused > panel.disconnect ? 'Up' : 'Down');
        moved += 1;
        await sleep(300);
        panel = readPanel(tmux.capture(pane.id));
      }
      if (!panel || panel.focused !== panel.disconnect) {
        result.action = 'none';
        result.reason = 'panel-shape-changed';
        state[pane.id] = { ...after, ...abortedCounters(before) };
        results.push(result);
        continue;
      }
      tmux.sendEnter(pane.id);
      appendLog(`${pane.label}: closing wedged bridge via panel`);
    } else if (LIMIT_ACTIONS.has(action)) {
      const text = action === 'resume' ? String(config.limitResumePrompt ?? '').trim() : `/model ${model}`;
      // loadConfig refuses an empty prompt when limits are on, so this only
      // catches a caller that assembled its own config. Deliberately not routed
      // through abort(): that rewinds the quota counters, and a condition that
      // never clears would then loop forever instead of spending the breaker.
      if (!text) {
        result.action = 'none';
        result.reason = 'no-prompt';
        results.push(result);
        continue;
      }
      tmux.sendText(pane.id, text);
      await sleep(config.keyDelay ?? 1000);
      tmux.sendEnter(pane.id);
      appendLog(`${pane.label}: ${action}${model ? ` -> ${model}` : ''} (${reason})`);
    } else {
      tmux.sendText(pane.id, '/remote-control');
      await sleep(config.keyDelay ?? 1000);
      tmux.sendEnter(pane.id);
      state[pane.id] = { ...state[pane.id], fired: (before.fired ?? 0) + 1 };
      appendLog(`${pane.label}: re-arming Remote Control (${reason}, attempt ${(before.fired ?? 0) + 1})`);
    }
    acted += 1;
    results.push(result);
  }

  if (!dryRun) {
    saveState(prune(state, panes.map((p) => p.id)));
    if (acted > 0) markEarned();
    releaseLock();
  }
  return { results, acted };
}
