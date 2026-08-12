import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readLimit, decideLimit, emptyLimitState, LIMIT_DEFAULTS } from '../src/limits.js';

/**
 * The banners, verbatim. Claude Code builds them as `You've hit your ${label}`
 * with the reset time appended, and the label set is fixed — so these strings
 * are the contract this module is written against.
 */
const SESSION = "You've hit your session limit · resets 3pm\n> ";
const WEEKLY = "You've hit your weekly limit · resets Aug 20\n> ";
const FABLE = "You've hit your Fable 5 limit · resets 3pm\n> ";
const CLEAR = '> \n  /rc active';

const cfg = (over = {}) => ({ ...LIMIT_DEFAULTS, limits: true, ...over });

test('each banner is read back as its label', () => {
  assert.equal(readLimit(SESSION), 'session limit');
  assert.equal(readLimit(WEEKLY), 'weekly limit');
  assert.equal(readLimit(FABLE), 'Fable 5 limit');
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

test('when two banners share the footer the newer one is the one answered', () => {
  const both = [
    "You've hit your session limit · resets 3pm",
    '> Continue where you left off.',
    "You've hit your session limit · resets 5pm",
    '> ',
  ].join('\n');
  assert.equal(readLimit(both), 'session limit');
});

/**
 * Every window is waited out, whichever one ran out. Model switching used to
 * step over the model-scoped ones; it was dropped for the complexity it carried,
 * so a Fable or Opus window now takes exactly the same path as a session one.
 */
test('a model-scoped window is waited out like any other', () => {
  const r = decideLimit({ screen: FABLE, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'limit-wait');
});

test('an account-wide window types nothing on the pass that finds it', () => {
  const first = decideLimit({ screen: SESSION, state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(first.action, 'none');
  assert.equal(first.reason, 'limit-wait');
  assert.equal(first.state.waitUntil, 1000 + LIMIT_DEFAULTS.limitBackoff);
});

test('an unrecognised label is still treated as a limit', () => {
  const r = decideLimit({ screen: "You've hit your galaxy limit\n> ", state: emptyLimitState(), now: 1000, config: cfg() });
  assert.equal(r.reason, 'limit-wait');
  assert.equal(r.state.banner, 'galaxy limit');
});

test('nothing happens again until the wait expires', () => {
  const first = decideLimit({ screen: SESSION, state: emptyLimitState(), now: 1000, config: cfg() });
  const during = decideLimit({ screen: SESSION, state: first.state, now: 1060, config: cfg() });
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
  // The first pass only arms the wait; the rest are resume attempts, each
  // waiting longer than the last.
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

test('a clear screen resets the breaker so a later outage starts fresh', () => {
  let state = { ...emptyLimitState(), attempts: 4, banner: 'session limit', waitUntil: 5 };
  state = decideLimit({ screen: CLEAR, state, now: 1000, config: cfg() }).state;
  assert.equal(state.attempts, 0);
  assert.equal(state.banner, null);
});

/**
 * Nothing is held pending across passes, so there is no stored intention that a
 * later pass could spend on the wrong pane. tmux numbers panes from %0 again
 * after its server restarts and state is keyed by pane id, so a decision that
 * outlived its screen would eventually be typed into someone else's session.
 */
test('a pane with no banner is never acted on, whatever the stored state says', () => {
  const stale = { banner: 'session limit', waitUntil: 0, attempts: 3 };
  const r = decideLimit({ screen: CLEAR, state: stale, now: 999999999, config: cfg() });
  assert.equal(r.action, 'none');
  assert.equal(r.reason, 'no-limit');
});
