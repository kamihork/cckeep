import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readLimit, decideLimit, emptyLimitState, LIMIT_DEFAULTS } from '../src/limits.js';

/**
 * The banners, verbatim. Claude Code builds them as `You've hit your ${label}`
 * with the reset time appended, and the label set is fixed — so these strings
 * are the contract this module is written against.
 */
const FABLE = "You've hit your Fable 5 limit · resets 3pm\n> ";
const OPUS = "You've hit your Opus limit · resets 3pm\n> ";
const SONNET = "You've hit your Sonnet limit · resets 3pm\n> ";
const SESSION = "You've hit your session limit · resets 3pm\n> ";
const WEEKLY = "You've hit your weekly limit · resets Aug 20\n> ";
const CLEAR = '> \n  /rc active';

const cfg = (over = {}) => ({ ...LIMIT_DEFAULTS, limits: true, ...over });

test('each banner is read back as its label', () => {
  assert.equal(readLimit(FABLE), 'Fable 5 limit');
  assert.equal(readLimit(OPUS), 'Opus limit');
  assert.equal(readLimit(SESSION), 'session limit');
  assert.equal(readLimit(WEEKLY), 'weekly limit');
  assert.equal(readLimit(CLEAR), null);
});

test('the curly apostrophe Claude Code may render is read too', () => {
  assert.equal(readLimit('You’ve hit your session limit\n> '), 'session limit');
});

/**
 * The failure this project has already had once, in the Remote Control half:
 * a session that merely *discusses* the signal looks like a session showing it.
 * Developing this very feature puts the banner in transcripts and fixtures, so
 * the footer scoping is the thing keeping cckeep from typing into that session.
 */
test('a banner in the scrollback does not count — only the footer does', () => {
  const transcript = [
    "The banner reads: You've hit your session limit · resets 3pm",
    ...Array(20).fill('  ... more conversation ...'),
    '> ',
    '  /rc active',
  ].join('\n');
  assert.equal(readLimit(transcript), null);
});

test('trailing blank rows do not push the banner out of the footer', () => {
  assert.equal(readLimit(`${SESSION}\n\n\n\n\n\n\n\n\n\n\n\n\n\n`), 'session limit');
});

test("a model's own window sends the pane to the next model", () => {
  const r = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(r.action, 'switch-model');
  assert.equal(r.model, 'opus');
  assert.equal(r.state.resumePending, true);
});

test('Opus falls through to Sonnet', () => {
  const r = decideLimit({ screen: OPUS, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(r.action, 'switch-model');
  assert.equal(r.model, 'sonnet');
});

test('Sonnet is the end of the chain, so it waits instead of switching', () => {
  const r = decideLimit({ screen: SONNET, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'limit-wait');
});

test('an account-wide window is waited out, not switched away from', () => {
  const first = decideLimit({ screen: SESSION, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(first.action, 'none');
  assert.equal(first.reason, 'limit-wait');
  assert.equal(first.state.waitUntil, 1000 + LIMIT_DEFAULTS.limitBackoff);
});

test('an unknown label waits rather than guessing a model to switch to', () => {
  const r = decideLimit({ screen: "You've hit your galaxy limit\n> ", state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'limit-wait');
});

test('nothing happens again until the wait expires', () => {
  const first = decideLimit({ screen: SESSION, state: emptyLimitState(), now: 1000, config: cfg() });
  const during = decideLimit({ screen: SESSION, state: first.state, now: 1000 + 60, config: cfg() });
  assert.equal(during.action, 'none');
  assert.equal(during.reason, 'limit-wait');
});

test('once the wait expires the work is resumed', () => {
  const first = decideLimit({ screen: SESSION, state: emptyLimitState(), now: 1000, config: cfg() });
  const after = decideLimit({ screen: SESSION, state: first.state, now: first.state.waitUntil, config: cfg() });
  assert.equal(after.action, 'resume');
  assert.equal(after.reason, 'limit-expired');
});

test('a resume that did not take backs off further each time', () => {
  let state = emptyLimitState();
  const waits = [];
  for (let i = 0; i < 4; i++) {
    const now = state.waitUntil;
    const r = decideLimit({ screen: SESSION, state, now, config: cfg() });
    state = r.state;
    waits.push(state.waitUntil - now);
  }
  // First pass only arms the wait; the rest are resume attempts, each waiting
  // longer than the last.
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] > waits[i - 1], `${waits[i]} > ${waits[i - 1]}`);
});

test('the breaker stops the retries rather than typing on a timer forever', () => {
  let state = emptyLimitState();
  let resumes = 0;
  for (let i = 0; i < 40; i++) {
    const r = decideLimit({ screen: SESSION, state, now: state.waitUntil, config: cfg() });
    state = r.state;
    if (r.action === 'resume') resumes += 1;
    if (r.reason === 'limit-gave-up') break;
  }
  assert.equal(resumes, LIMIT_DEFAULTS.limitMaxAttempts);
});

/**
 * The banner is the failed turn's own output, so it is still in the transcript
 * after the switch is sent. The follow-up therefore cannot be conditioned on the
 * screen going clear — it has to run off the pending flag and the clock.
 */
test('the resume follows a switch even while the banner is still on screen', () => {
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  const stillShowing = `${FABLE}\n  ⎿  Set model to opus\n> `;

  const next = decideLimit({ screen: stillShowing, state: switched.state, now: 1040, config: cfg() });
  assert.equal(next.action, 'resume');
  assert.equal(next.reason, 'switched');
  assert.equal(next.state.attempts, 1, 'the follow-up must not spend an attempt');
});

test('one switch per banner: a lingering banner does not walk down the model list', () => {
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  // Past the resume window, so the pending follow-up is dropped and the banner
  // is judged on its own — the case that used to re-send /model on every wait.
  const later = decideLimit({ screen: FABLE, state: switched.state, now: 1000 + 99999, config: cfg() });
  assert.notEqual(later.action, 'switch-model');
});

test('when two banners share the footer the newer one is the one answered', () => {
  const both = ["You've hit your Fable 5 limit · resets 3pm", '> /model opus', "You've hit your Opus limit · resets 5pm", '> '].join('\n');
  assert.equal(readLimit(both), 'Opus limit');
});

test('a restore whose due time passed while cckeep was down is dropped, not fired', () => {
  const conf = cfg({ limitRestoreModel: 'fable', limitRestoreAfter: 600 });
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: conf });
  const state = { ...switched.state, resumePending: false };

  const wayLater = decideLimit({ screen: CLEAR, state, now: state.restoreBy + 1, config: conf });
  assert.equal(wayLater.action, 'none');
  assert.equal(wayLater.state.restoreTo, null, 'and it is cleared rather than retried for ever');
});

test('the pass after a switch resumes the work, and only once', () => {
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  const resumed = decideLimit({ screen: CLEAR, state: switched.state, now: 1100, config: cfg() });
  assert.equal(resumed.action, 'resume');
  assert.equal(resumed.reason, 'switched');

  const next = decideLimit({ screen: CLEAR, state: resumed.state, now: 1200, config: cfg() });
  assert.equal(next.action, 'none');
});

/**
 * tmux numbers panes from %0 again after its server restarts, and state is keyed
 * by pane id. Without an expiry, a resume left pending by yesterday's %0 would be
 * spent typing "carry on" into whatever unrelated session is %0 today.
 */
test('a resume left pending for too long is dropped, not fired at a new pane', () => {
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(switched.state.resumePending, true);

  const muchLater = decideLimit({ screen: CLEAR, state: switched.state, now: 1000 + 86400, config: cfg() });
  assert.equal(muchLater.action, 'none');
  assert.equal(muchLater.state.resumePending, false);
});

test('a clear screen resets the breaker so a later outage starts fresh', () => {
  let state = { ...emptyLimitState(), attempts: 4, banner: 'session limit', waitUntil: 5 };
  state = decideLimit({ screen: CLEAR, state, now: 1000, config: cfg() }).state;
  assert.equal(state.attempts, 0);
  assert.equal(state.banner, null);
});

test('the preferred model is restored once its window has had time to refill', () => {
  const conf = cfg({ limitRestoreModel: 'fable', limitRestoreAfter: 600 });
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: conf });
  assert.equal(switched.state.restoreTo, 'fable');

  const early = decideLimit({ screen: CLEAR, state: { ...switched.state, resumePending: false }, now: 1100, config: conf });
  assert.equal(early.action, 'none');

  const due = decideLimit({ screen: CLEAR, state: { ...switched.state, resumePending: false }, now: 1600, config: conf });
  assert.equal(due.action, 'restore-model');
  assert.equal(due.model, 'fable');
});

test('restoring too early makes the next restore wait longer', () => {
  const conf = cfg({ limitRestoreModel: 'fable', limitRestoreAfter: 600 });
  // Delays, not absolute stamps: comparing restoreAt directly only happens to
  // work while `now` is 0, and stops meaning anything the moment it is not.
  const first = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 500, config: conf });
  const firstDelay = first.state.restoreAt - 500;

  // The restore actually fired...
  const restored = decideLimit({
    screen: CLEAR,
    state: { ...first.state, resumePending: false },
    now: first.state.restoreAt,
    config: conf,
  });
  assert.equal(restored.action, 'restore-model');

  // ...the window was still full, and the same banner came straight back.
  const at = restored.state.restoredAt + 10;
  const relapse = decideLimit({ screen: FABLE, state: restored.state, now: at, config: conf });
  const nextDelay = relapse.state.restoreAt - at;
  assert.ok(nextDelay > firstDelay, `${nextDelay} > ${firstDelay}`);
});

/**
 * The escalation has to decay, or one early restore penalises every outage for
 * the rest of the pane's life: `restoreFails` only ever grew, and a perfectly
 * ordinary limit days later inherited the maximum delay.
 */
test('a restore that held is not counted against the next outage', () => {
  const conf = cfg({ limitRestoreModel: 'fable', limitRestoreAfter: 600 });
  const first = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 500, config: conf });
  const firstDelay = first.state.restoreAt - 500;

  const restored = decideLimit({
    screen: CLEAR,
    state: { ...first.state, resumePending: false },
    now: first.state.restoreAt,
    config: conf,
  });

  // A long clean stretch, then an unrelated new outage.
  const settled = decideLimit({ screen: CLEAR, state: restored.state, now: restored.state.restoredAt + 99999, config: conf });
  assert.equal(settled.state.restoreFails, 0);

  const at = restored.state.restoredAt + 100000;
  const fresh = decideLimit({ screen: FABLE, state: settled.state, now: at, config: conf });
  assert.equal(fresh.state.restoreAt - at, firstDelay, 'back to the configured delay');
});

test('no restore model configured means the pane simply stays where it landed', () => {
  const switched = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(switched.state.restoreTo, null);
  const later = decideLimit({ screen: CLEAR, state: { ...switched.state, resumePending: false }, now: 999999, config: cfg() });
  assert.equal(later.action, 'none');
});
