import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, emptyState, readScreen, DEFAULTS } from '../src/detect.js';

// Screens shaped like what Claude Code actually paints. The footer indicator and
// the notification wording are the only parts the detector reads.
const CONNECTED = 'assistant reply here\n> \n  /rc active  ·  claude.ai/code';
const COMPOSER = '> ';
const RETRYING = 'assistant reply here\n> \n  /rc reconnecting';
const DISCONNECTED = 'Remote Control disconnected · /remote-control\n> ';
const FAILED_FOOTER = ['blah', '> ', '  /rc failed'].join('\n');
const SILENT = 'just an ordinary idle session\n> ';
const PANEL = ['Remote Control', '❯ Disconnect this session', '  Show QR code', '> '].join('\n');
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

// --- footer scoping -------------------------------------------------------
// A session where you discuss cckeep, or run it, has "/rc active" sitting in
// the conversation body. Matching the whole pane made that session look
// connected, which armed the missing-indicator fallback against a healthy one.

const CONVERSATION_MENTION = [
  'user: なぜ /rc active が出ないの?',
  'assistant: /rc active はフッターに出ます。',
  ...Array(20).fill('  (会話が続く)'),
  '> ',
  '  [Opus 5] myproject | ctx 40%',
].join('\n');

test('the indicator in the conversation body does not count as connected', () => {
  assert.equal(readScreen(CONVERSATION_MENTION).connected, false);
  const { action, reason } = decide({ screen: CONVERSATION_MENTION });
  assert.equal(action, 'none');
  assert.equal(reason, 'never-connected');
});

test('the same words in the footer do count', () => {
  const screen = ['user: 何か話している', ...Array(20).fill('  ...'), '> ', '  /rc active'].join('\n');
  assert.equal(readScreen(screen).connected, true);
});

test('a disconnect notice quoted in the conversation does not trigger a re-arm', () => {
  const screen = [
    'assistant: 「Remote Control disconnected」と出たら切断です。',
    ...Array(20).fill('  (会話が続く)'),
    '> ',
  ].join('\n');
  assert.equal(readScreen(screen).failed, false);
  assert.equal(decide({ screen, state: { ...emptyState(), seen: true } }).action, 'none');
});

test('dialogs are still detected anywhere on screen', () => {
  // Holding off is the safe direction, so this one is deliberately permissive.
  const screen = ['Do you want to proceed?', '❯ 1. Yes', ...Array(30).fill('  ...'), '> '].join('\n');
  assert.equal(readScreen(screen).modal, true);
});

test('panel text left far up the transcript does not hold the pane off forever', () => {
  // cckeep itself puts panel text in the scrollback as step one of its own
  // wedged-bridge cycle. Treating that as "a panel is open" poisoned the pane
  // against every future recovery.
  const screen = ['❯ Disconnect this session', ...Array(30).fill('  ...'), '> '].join('\n');
  assert.equal(readScreen(screen).panel, false);
});

test('a panel actually open above the composer is detected', () => {
  const screen = ['...', '❯ Disconnect this session', '  Show QR code', '> '].join('\n');
  assert.equal(readScreen(screen).panel, true);
});


// --- the indicator itself -------------------------------------------------
// Verbatim from a real 140-column pane. The user's own status line eats the
// row, so Claude Code right-aligns the indicator into what is left and it
// renders as a bare "/rc" — no "active". Matching the full phrase found
// nothing here, which made cckeep useless for anyone with a status line.
const REAL_FOOTER = [
  'assistant: ...',
  '',
  '\u2500'.repeat(60),
  '\u276f ',
  '\u2500'.repeat(60),
  '  [Opus 5 (1M context)] cckeep \u2387 main | ctx 59% | 5h \u2591\u2591 5%(\u21923h50m) | 7d \u2588\u2591 18%(\u2192131h50m)                    /rc',
  '  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents',
].join('\n');

function footerWith(indicator) {
  return [
    'assistant: ...',
    '\u2500'.repeat(60),
    '\u276f ',
    '\u2500'.repeat(60),
    `  [Opus 5] proj | ctx 10%                    ${indicator}`,
    '  \u23f5\u23f5 auto mode on',
  ].join('\n');
}

test('a truncated indicator still reads as connected', () => {
  assert.equal(readScreen(REAL_FOOTER).connected, true);
  assert.equal(decide({ screen: REAL_FOOTER }).state.seen, true);
});

test('the full labels are read as their own states', () => {
  assert.equal(readScreen(footerWith('/rc active')).connected, true);
  assert.equal(readScreen(footerWith('/rc reconnecting')).retrying, true);
  assert.equal(readScreen(footerWith('/rc reconnecting')).connected, false);
  assert.equal(readScreen(footerWith('/rc failed')).failed, true);
  assert.equal(readScreen(footerWith('/rc failed')).connected, false);
});

test('no indicator at all means no indicator', () => {
  const screen = footerWith('');
  assert.equal(readScreen(screen).connected, false);
  assert.equal(readScreen(screen).retrying, false);
  assert.equal(readScreen(screen).failed, false);
});

test('/rc typed into the input box is not the indicator', () => {
  // The prompt row sits inside the window we scan, and a user asking about
  // "/rc" would otherwise mark their session as connected.
  const screen = [
    '\u2500'.repeat(60),
    '\u276f /rc',
    '\u2500'.repeat(60),
    '  [Opus 5] proj | ctx 10%',
    '  \u23f5\u23f5 auto mode on',
  ].join('\n');
  assert.equal(readScreen(screen).connected, false);
});

test('/rc written mid-sentence is not the indicator', () => {
  const screen = [
    'assistant: \u5165\u529b\u6b04\u306e\u4e0b\u306b /rc \u3068\u8868\u793a\u3055\u308c\u307e\u3059',
    ...Array(10).fill('  ...'),
    '  [Opus 5] proj | ctx 10%',
    '  \u23f5\u23f5 auto mode on',
  ].join('\n');
  assert.equal(readScreen(screen).connected, false);
});

test('the disconnect notification is still read from the wider footer', () => {
  const screen = [
    ...Array(10).fill('  ...'),
    'Remote Control disconnected \u00b7 /remote-control',
    '\u2500'.repeat(60),
    '\u276f ',
    '  [Opus 5] proj | ctx 10%',
  ].join('\n');
  assert.equal(readScreen(screen).failed, true);
  assert.equal(decide({ screen }).action, 'rearm');
});


test('an indicator still reads through trailing blank rows', () => {
  // capture-pane returns the whole pane, so a UI that does not fill it leaves
  // the bottom padded. Scanning the last N rows would scan only padding.
  const padded = footerWith('/rc active') + '\n'.repeat(18);
  assert.equal(readScreen(padded).connected, true);
});

test('a disconnect notice reads through trailing blank rows too', () => {
  const padded = ['Remote Control disconnected', '> '].join('\n') + '\n'.repeat(18);
  assert.equal(readScreen(padded).failed, true);
});

test('a pane that is genuinely empty reads as nothing', () => {
  assert.equal(readScreen('\n'.repeat(24)).connected, false);
  assert.equal(readScreen('').connected, false);
});


// --- guards that a mutation test found nothing was pinning ----------------

function pane(...rows) {
  // A realistic pane: transcript, then the composer, then the status row.
  return [...rows, '\u2500'.repeat(40), '\u276f ', '\u2500'.repeat(40), '  [Opus 5] proj | ctx 9%'].join('\n');
}

function paneWithDraft(...rows) {
  return [...rows, '\u2500'.repeat(40), '\u276f push the release branch', '\u2500'.repeat(40), '  [Opus 5] proj'].join('\n');
}

test('an unsent draft is never submitted', () => {
  // send-keys inserts at the cursor and Enter submits the box, so a draft would
  // go out with the command glued onto it. The idle check cannot catch this:
  // a draft sitting in the box is perfectly still.
  const screen = paneWithDraft('Remote Control disconnected');
  assert.equal(readScreen(screen).composer, 'draft');
  const { action, reason } = decide({ screen, state: { ...emptyState(), seen: true } });
  assert.equal(action, 'none');
  assert.equal(reason, 'composer-busy');
});

test('a composer we cannot find is treated as occupied', () => {
  // If the layout changed and we cannot see the box, we do not type into it.
  const screen = ['Remote Control disconnected', 'no composer anywhere'].join('\n');
  assert.equal(readScreen(screen).composer, 'unknown');
  assert.equal(decide({ screen }).action, 'none');
});

test('each permission-prompt shape is caught on its own', () => {
  // The old fixture contained every alternative at once, so deleting any one
  // of them left the suite green.
  for (const marker of ['\u276f 1. Yes', '\u276f 1) Yes', '> 1. Yes', '\u276f Yes', '> No']) {
    assert.equal(readScreen(pane('...', marker)).modal, true, marker);
  }
  for (const phrase of ['Do you want to proceed?', 'Would you like me to continue?', 'Allow this tool call?', 'proceed (y/n)', 'proceed [y/N]']) {
    assert.equal(readScreen(pane(phrase)).modal, true, phrase);
  }
});

test('a dialog stops the pane without eating its progress', () => {
  // Consuming the counters first meant a sentence merely worded like a dialog
  // reset the wait every pass, so the pane could never mature into a recovery.
  const withDialog = pane('Do you want me to run the tests as well?');
  const quiet = pane('just a reply');
  let state = { ...emptyState(), seen: true };
  const reasons = [];
  for (const screen of [quiet, withDialog, quiet, withDialog, quiet, quiet]) {
    const out = decide({ screen, state });
    state = out.state;
    reasons.push(out.reason);
  }
  // Four quiet checks happened across those six passes. If the dialog passes
  // had reset the counter — as they used to — the pane would sit at 'waiting'
  // forever and this sequence would never reach a recovery.
  assert.deepEqual(reasons, ['waiting', 'dialog', 'waiting', 'dialog', 'waiting', 'silent']);
});

test('the panel guard is measured from the composer, not the whole transcript', () => {
  const scrolledAway = pane('\u276f Disconnect this session', ...Array(25).fill('  ...'));
  assert.equal(readScreen(scrolledAway).panel, false);
});

test('confirm-panel refuses when a draft is in the box', () => {
  const screen = paneWithDraft('Remote Control', '\u276f Disconnect this session', '  Show QR code');
  const out = decide({ screen, state: { ...emptyState(), panelPending: true } });
  assert.equal(out.action, 'none');
});

test('the footer scoping is pinned right at its boundary', () => {
  // The old fixture put the mention 23 rows up — outside any plausible window,
  // so it could not have detected a regression back to whole-pane matching.
  const justOutside = [...Array(9).fill('assistant: ...'), 'assistant: /rc active means connected',
    '\u2500'.repeat(40), '\u276f ', '\u2500'.repeat(40), '  [Opus 5] proj'].join('\n');
  assert.equal(readScreen(justOutside).connected, false);
});


test('the indicator window is tight enough to exclude the transcript', () => {
  // Widening this window is exactly how a sentence in a reply becomes a false
  // "connected", which then arms the missing-indicator fallback against a pane
  // that never had Remote Control. Placed 8 rows up: outside the real window,
  // inside a careless one.
  const rows = [
    'assistant: the footer shows /rc active',
    ...Array(4).fill('assistant: ...'),
    '\u2500'.repeat(40),
    '\u276f ',
    '\u2500'.repeat(40),
    '  [Opus 5] proj | ctx 9%',
  ];
  assert.equal(rows.length - 1, 8, 'the mention sits 8 rows above the last line');
  assert.equal(readScreen(rows.join('\n')).connected, false);
});
