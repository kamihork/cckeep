import { decide, readScreen } from './detect.js';
import { parsePsTable, isTargetPane } from './procs.js';
import * as realTmux from './tmux.js';
import { loadState, saveState, forPane, prune, appendLog } from './state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is the pane quiet enough to type into?
 *
 * A running turn animates a spinner and a token counter, so two byte-identical
 * captures a couple of seconds apart is a cheap and reliable "nothing is
 * happening here" signal — and it needs no knowledge of Claude Code's changing
 * status-line wording.
 */
export async function isIdle(tmux, paneId, settle) {
  const a = tmux.capture(paneId);
  await sleep(settle);
  const b = tmux.capture(paneId);
  return a.length > 0 && a === b;
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

    if (action === 'confirm-panel') {
      tmux.sendEnter(pane.id);
      appendLog(`${pane.label}: closing wedged bridge via panel`);
      acted += 1;
      results.push(result);
      continue;
    }

    // action === 'rearm'. The decision was made from a single capture; make
    // sure nothing has started running in the meantime before typing.
    if (!(await isIdle(tmux, pane.id, config.settle))) {
      result.action = 'none';
      result.reason = 'busy';
      state[pane.id] = { ...after, lastActionAt: before.lastActionAt, panelPending: before.panelPending };
      results.push(result);
      continue;
    }

    // Re-read: the pane may have reconnected or opened a dialog while we waited.
    const recheck = readScreen(tmux.capture(pane.id));
    if (recheck.connected || recheck.modal || recheck.panel) {
      result.action = 'none';
      result.reason = recheck.connected ? 'recovered' : 'dialog';
      state[pane.id] = { ...after, lastActionAt: before.lastActionAt, panelPending: before.panelPending };
      results.push(result);
      continue;
    }

    tmux.sendText(pane.id, '/remote-control');
    await sleep(config.keyDelay ?? 1000);
    tmux.sendEnter(pane.id);
    appendLog(`${pane.label}: re-arming Remote Control (${reason})`);
    acted += 1;
    results.push(result);
  }

  if (!dryRun) saveState(prune(state, panes.map((p) => p.id)));
  return { results, acted };
}
