import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, emptyState, readScreen, DEFAULTS } from '../src/detect.js';

// Screens shaped like what Claude Code actually paints. The footer indicator and
// the notification wording are the only parts the detector reads.
const CONNECTED = 'assistant reply here\n> \n  /rc active  ·  claude.ai/code';
const RETRYING = 'assistant reply here\n> \n  /rc reconnecting';
const DISCONNECTED = 'Remote Control disconnected · /remote-control\n> ';
const FAILED_FOOTER = 'blah\n  /rc failed';
const SILENT = 'just an ordinary idle session\n> ';
const PANEL = 'Remote Control\n❯ Disconnect this session\n  Show QR code';
const PERMISSION = 'Do you want to run this command?\n❯ 1. Yes\n  2. No';

/** Feed the same screen through `decide` n times, threading state. */
function pump(screen, times, { state = emptyState(), now = 0, config = {} } = {}) {
  let s = state;
  let last;
  for (let i = 0; i < times; i++) {
    last = decide({ screen, state: s, now, config });
    s = last.state;
  }
  return last;
}

test('readScreen picks out each indicator', () => {
  assert.equal(readScreen(CONNECTED).connected, true);
  assert.equal(readScreen(RETRYING).retrying, true);
  assert.equal(readScreen(DISCONNECTED).failed, true);
  assert.equal(readScreen(FAILED_FOOTER).failed, true);
  assert.equal(readScreen(PANEL).panel, true);
  assert.equal(readScreen(PERMISSION).modal, true);
  assert.equal(readScreen(SILENT).connected, false);
});

test('a connected pane is left alone and remembered', () => {
  const { action, reason, state } = decide({ screen: CONNECTED });
  assert.equal(action, 'none');
  assert.equal(reason, 'connected');
  assert.equal(state.seen, true);
});

test('an explicit disconnect is re-armed immediately', () => {
  const { action, reason } = decide({ screen: DISCONNECTED });
  assert.equal(action, 'rearm');
  assert.equal(reason, 'disconnected');
});

test('the footer failure indicator counts as an explicit disconnect', () => {
  assert.equal(decide({ screen: FAILED_FOOTER }).action, 'rearm');
});

test('a pane retrying inside its own budget is not touched', () => {
  const out = pump(RETRYING, DEFAULTS.stuckLimit - 1);
  assert.equal(out.action, 'none');
  assert.equal(out.reason, 'retrying');
});

test('a pane wedged in "reconnecting" is cycled once past the budget', () => {
  const out = pump(RETRYING, DEFAULTS.stuckLimit);
  assert.equal(out.action, 'rearm');
  assert.equal(out.reason, 'stuck');
  // The wedged path has to finish through the panel, so it flags that.
  assert.equal(out.state.panelPending, true);
});

test('a pane that was never connected is never switched on', () => {
  const out = pump(SILENT, 20);
  assert.equal(out.action, 'none');
  assert.equal(out.reason, 'never-connected');
});

test('a pane that lost its indicator is re-armed only after missLimit checks', () => {
  const seen = { ...emptyState(), seen: true };
  const early = pump(SILENT, DEFAULTS.missLimit - 1, { state: seen });
  assert.equal(early.action, 'none');
  assert.equal(early.reason, 'waiting');

  const late = pump(SILENT, DEFAULTS.missLimit, { state: seen });
  assert.equal(late.action, 'rearm');
  assert.equal(late.reason, 'silent');
});

test('a permission prompt is never typed into', () => {
  const screen = `${DISCONNECTED}\n${PERMISSION}`;
  const { action, reason } = decide({ screen });
  assert.equal(action, 'none');
  assert.equal(reason, 'dialog');
});

test('a status panel the user opened is never typed into', () => {
  // Disconnected *and* showing the panel: the user is looking at it.
  const seen = { ...emptyState(), seen: true };
  const out = pump(PANEL, 20, { state: seen });
  assert.equal(out.action, 'none');
  assert.equal(out.reason, 'dialog');
});

test('the cooldown blocks a second re-arm of the same pane', () => {
  const first = decide({ screen: DISCONNECTED, now: 1000 });
  assert.equal(first.action, 'rearm');
  const second = decide({ screen: DISCONNECTED, state: first.state, now: 1000 + DEFAULTS.cooldown - 1 });
  assert.equal(second.action, 'none');
  assert.equal(second.reason, 'cooldown');
  const third = decide({ screen: DISCONNECTED, state: first.state, now: 1000 + DEFAULTS.cooldown });
  assert.equal(third.action, 'rearm');
});

test('the panel we opened ourselves is confirmed, and clears the cooldown', () => {
  const state = { ...emptyState(), panelPending: true, lastActionAt: 999 };
  const out = decide({ screen: PANEL, state, now: 1000 });
  assert.equal(out.action, 'confirm-panel');
  assert.equal(out.state.panelPending, false);
  assert.equal(out.state.lastActionAt, 0, 'the follow-up re-arm must not wait out the cooldown');
});

test('a pending panel that never appeared falls back to judging the screen', () => {
  const state = { ...emptyState(), panelPending: true, seen: true };
  const out = decide({ screen: CONNECTED, state });
  assert.equal(out.action, 'none');
  assert.equal(out.reason, 'connected');
  assert.equal(out.state.panelPending, false);
});

test('reconnecting resets the stuck counter once the pane recovers', () => {
  let out = pump(RETRYING, 3);
  assert.equal(out.state.stuck, 3);
  out = decide({ screen: CONNECTED, state: out.state });
  assert.equal(out.state.stuck, 0);
});

test('thresholds are configurable', () => {
  const out = pump(RETRYING, 2, { config: { stuckLimit: 2 } });
  assert.equal(out.action, 'rearm');
  assert.equal(out.reason, 'stuck');
});
