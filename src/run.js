import { decide, readScreen, readPanel } from './detect.js';
import { parsePsTable, isTargetPane } from './procs.js';
import * as realTmux from './tmux.js';
import { loadState, saveState, forPane, prune, appendLog, acquireLock, releaseLock, markEarned } from './state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const { action, reason, state: after } = decide({ screen, state: before, now, config });
    state[pane.id] = after;

    const result = { pane: pane.label, id: pane.id, action, reason, signals: readScreen(screen) };

    if (action === 'none') {
      results.push(result);
      continue;
    }

    if (dryRun) {
      result.action = `would-${action}`;
      results.push(result);
      continue;
    }

    // Both actions type into the pane, so both go through the same checks: the
    // decision came from one capture, and anything could have happened since.
    if (!(await isIdle(tmux, pane.id, config.settle))) {
      result.action = 'none';
      result.reason = 'busy';
      state[pane.id] = { ...after, ...abortedCounters(before) };
      results.push(result);
      continue;
    }

    // Re-read: the pane may have reconnected, opened a dialog, or had something
    // typed into it while we waited.
    const recheck = readScreen(tmux.capture(pane.id));
    const stillSafe =
      action === 'confirm-panel'
        ? recheck.panel && !recheck.modal && recheck.composer !== 'draft'
        : !recheck.connected && !recheck.modal && !recheck.panel && recheck.composer === 'empty';
    if (!stillSafe) {
      result.action = 'none';
      result.reason = recheck.connected ? 'recovered' : recheck.composer !== 'empty' ? 'composer-busy' : 'dialog';
      state[pane.id] = { ...after, ...abortedCounters(before) };
      results.push(result);
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
    } else {
      tmux.sendText(pane.id, '/remote-control');
      await sleep(config.keyDelay ?? 1000);
      tmux.sendEnter(pane.id);
      appendLog(`${pane.label}: re-arming Remote Control (${reason})`);
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
