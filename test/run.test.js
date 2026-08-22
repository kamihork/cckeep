import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// State is written under CCKEEP_HOME; point it somewhere disposable before
// anything imports the state module.
const HOME = mkdtempSync(join(tmpdir(), 'cckeep-test-'));
process.env.CCKEEP_HOME = HOME;

const { runPass } = await import('../src/run.js');
const { loadConfig } = await import('../src/config.js');
const { emptyState } = await import('../src/detect.js');
const { saveState, loadState, acquireLock, releaseLock } = await import('../src/state.js');

const CONNECTED = '> \n  /rc active';
const DISCONNECTED = 'Remote Control disconnected · /remote-control\n> ';
const PANEL = ['Remote Control', '❯ Disconnect this session', '  Show QR code', '> '].join('\n');

/**
 * A tmux stand-in. `screens` is a list of successive captures; the last one
 * repeats, so a test that wants "still the same" just supplies one.
 */
function fakeTmux({ screens, command = 'claude' }) {
  const sent = [];
  let i = 0;
  return {
    sent,
    tmuxPath: () => '/fake/tmux',
    hasServer: () => true,
    processTable: () => '',
    listPanes: () => [{ id: '%1', command, pid: 0, session: 'dev', windowIndex: '0', paneIndex: '0', label: 'dev:0.0' }],
    capture: () => screens[Math.min(i++, screens.length - 1)],
    sendText: (_id, text) => sent.push(text),
    sendEnter: () => sent.push('<Enter>'),
  };
}

const config = () => loadConfig({ settle: 1, keyDelay: 1 });

beforeEach(() => {
  rmSync(join(HOME, 'state.json'), { force: true });
});

test('an idle disconnected pane gets /remote-control typed into it', async () => {
  const tmux = fakeTmux({ screens: [DISCONNECTED] });
  const { results, acted } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 1);
  assert.deepEqual(tmux.sent, ['/remote-control', '<Enter>']);
  assert.equal(results[0].action, 'rearm');
});

test('a pane whose screen keeps changing is treated as busy and left alone', async () => {
  // decide -> capture A -> (settle) -> capture B. Differing captures mean a turn
  // is running, so nothing may be typed.
  const tmux = fakeTmux({ screens: [DISCONNECTED, `${DISCONNECTED}\nworking 1`, `${DISCONNECTED}\nworking 2`] });
  const { results, acted } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'busy');
});

test('a pane that reconnects during the idle wait is not typed into', async () => {
  // decide + three idle samples, then the re-check: the pane comes back on the
  // last read, after the idle check has already said "safe".
  const tmux = fakeTmux({ screens: [DISCONNECTED, DISCONNECTED, DISCONNECTED, DISCONNECTED, CONNECTED] });
  const { acted, results } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'recovered');
});

test('a dialog that appears during the idle wait aborts the send', async () => {
  const withPrompt = ['Do you want to proceed?', '❯ 1. Yes', '  2. No', '> '].join('\n');
  const tmux = fakeTmux({ screens: [DISCONNECTED, DISCONNECTED, DISCONNECTED, DISCONNECTED, withPrompt] });
  const { acted, results } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'dialog');
});

test('--dry-run reports the action but sends nothing', async () => {
  const tmux = fakeTmux({ screens: [DISCONNECTED] });
  const { results, acted } = await runPass({ tmux, config: config(), dryRun: true, now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].action, 'would-rearm');
});

test('panes not running Claude Code are ignored entirely', async () => {
  const tmux = fakeTmux({ screens: [DISCONNECTED], command: 'vim' });
  const { results, acted } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.equal(results.length, 0);
  assert.deepEqual(tmux.sent, []);
});

test('the wedged-bridge follow-up presses Enter on our panel', async () => {
  saveState({ '%1': { ...emptyState(), seen: true, panelPending: true } });
  const tmux = fakeTmux({ screens: [PANEL] });
  const { results, acted } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 1);
  assert.deepEqual(tmux.sent, ['<Enter>']);
  assert.equal(results[0].action, 'confirm-panel');
});

test('state survives between passes', async () => {
  const tmux = fakeTmux({ screens: [CONNECTED] });
  await runPass({ tmux, config: config(), now: 1000 });
  const tmux2 = fakeTmux({ screens: [DISCONNECTED] });
  const { results } = await runPass({ tmux: tmux2, config: config(), now: 1001 });
  assert.equal(results[0].action, 'rearm', 'the pane was remembered as one that wants Remote Control');
});

test('a busy pane does not burn its cooldown', async () => {
  const busy = fakeTmux({ screens: [DISCONNECTED, `${DISCONNECTED}\na`, `${DISCONNECTED}\nb`] });
  await runPass({ tmux: busy, config: config(), now: 1000 });
  // Next pass, one second later: still inside the cooldown window, but since
  // nothing was sent the pane must remain eligible.
  const idle = fakeTmux({ screens: [DISCONNECTED] });
  const { acted } = await runPass({ tmux: idle, config: config(), now: 1001 });
  assert.equal(acted, 1);
});

test('no tmux binary is reported rather than thrown', async () => {
  const tmux = { tmuxPath: () => null };
  const out = await runPass({ tmux, config: config() });
  assert.equal(out.error, 'no-tmux');
});

test('no running tmux server is reported rather than thrown', async () => {
  const tmux = { tmuxPath: () => '/fake/tmux', hasServer: () => false };
  const out = await runPass({ tmux, config: config() });
  assert.equal(out.error, 'no-server');
});

test('an animation that repeats on the sample interval is still caught', async () => {
  // Two samples alias: any spinner whose period divides the interval shows the
  // same frame twice and reads as idle. The third sample is what breaks the tie.
  const a = `${DISCONNECTED}\nworking |`;
  const b = `${DISCONNECTED}\nworking /`;
  const tmux = fakeTmux({ screens: [DISCONNECTED, a, a, b] });
  const { acted, results } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'busy');
});

test('a send called off at the last moment keeps the progress it had made', () => {
  // The counters had already matured to reach the send. Throwing them away
  // meant a pane that happens to be busy starts its whole wait again.
  const SILENT = 'just a reply\n> \n  [Opus 5] proj';
  const cfg = config();
  const seen = fakeTmux({ screens: [CONNECTED] });
  return runPass({ tmux: seen, config: cfg, now: 1000 }).then(async () => {
    // Three quiet passes: miss climbs to 3 of 4.
    for (let i = 0; i < 3; i++) {
      await runPass({ tmux: fakeTmux({ screens: [SILENT] }), config: cfg, now: 1001 + i });
    }
    // The fourth pass matures the counter but the pane turns out to be busy.
    const busy = fakeTmux({ screens: [SILENT, `${SILENT}a`, `${SILENT}b`] });
    const aborted = await runPass({ tmux: busy, config: cfg, now: 1010 });
    assert.equal(aborted.results[0].reason, 'busy');
    assert.deepEqual(busy.sent, []);
    // Next quiet pass should act, because the wait was not thrown away.
    const idle = fakeTmux({ screens: [SILENT] });
    const out = await runPass({ tmux: idle, config: cfg, now: 1011 });
    assert.equal(out.acted, 1, 'the aborted pass must not have reset the counter');
    assert.deepEqual(idle.sent, ['/remote-control', '<Enter>']);
  });
});


test('a failed pane query is not read as "there are no panes"', () => {
  // list-panes returning nothing used to mean both "no panes" and "could not
  // ask". Pruning state to match wiped every pane ever seen connected — and a
  // disconnected pane can never re-earn that flag.
  saveState({ '%1': { ...emptyState(), seen: true } });
  const broken = { tmuxPath: () => '/fake/tmux', hasServer: () => true, listPanes: () => null };
  return runPass({ tmux: broken, config: config(), now: 1000 }).then(() => {
    assert.equal(loadState()['%1']?.seen, true, 'state must survive a failed query');
  });
});

test('two passes cannot act on the same pane at once', async () => {
  // `cckeep watch` alongside the scheduled job is an easy thing to end up with.
  // The cooldown cannot help: both passes read the state before either writes.
  assert.equal(acquireLock(), true);
  const tmux = fakeTmux({ screens: [DISCONNECTED] });
  const out = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(out.error, 'busy-elsewhere');
  assert.deepEqual(tmux.sent, []);
  releaseLock();
});



test('the wedged-bridge recovery walks the focus to Disconnect before pressing Enter', async () => {
  // Default focus is Continue (two below Disconnect), so two Ups then Enter.
  const PANEL_CONT = ['Remote Control', '    Disconnect this session', '    Show QR code  Scan', '  \u276f Continue', '  Enter to select \u00b7 Esc to continue'].join('\n');
  const PANEL_QR   = PANEL_CONT.replace('    Show QR code', '  \u276f Show QR code').replace('\u276f Continue', '  Continue');
  const PANEL_DISC = PANEL_CONT.replace('    Disconnect this session', '  \u276f Disconnect this session').replace('\u276f Continue', '  Continue');
  saveState({ '%1': { ...emptyState(), seen: true, panelPending: true } });
  // decide, three idle samples and the recheck all see the untouched panel;
  // then each Up is verified against a fresh capture.
  const screens = [PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_QR, PANEL_DISC];
  const sent = [];
  let i = 0;
  const tmux = {
    sent,
    tmuxPath: () => '/fake/tmux',
    hasServer: () => true,
    processTable: () => '',
    listPanes: () => [{ id: '%1', command: 'claude', pid: 0, session: 'dev', windowIndex: '0', paneIndex: '0', label: 'dev:0.0' }],
    capture: () => screens[Math.min(i++, screens.length - 1)],
    sendText: (_id, text) => sent.push(text),
    sendKey: (_id, key) => sent.push(`<${key}>`),
    sendEnter: () => sent.push('<Enter>'),
  };
  const { acted } = await runPass({ tmux, config: config(), now: 5000 });
  assert.equal(acted, 1);
  assert.deepEqual(sent, ['<Up>', '<Up>', '<Enter>'], 'verified navigation, then Enter');
});

test('navigation direction follows where Disconnect actually is', async () => {
  // Defensive: if a future layout puts the focus above Disconnect, the walk
  // must go Down, not blindly Up.
  const P_TOP  = ['Remote Control', '  \u276f Continue', '    Disconnect this session', '  Enter to select'].join('\n');
  const P_DONE = ['Remote Control', '    Continue', '  \u276f Disconnect this session', '  Enter to select'].join('\n');
  saveState({ '%1': { ...emptyState(), seen: true, panelPending: true } });
  const sent = [];
  let i = 0;
  const screens = [P_TOP, P_TOP, P_TOP, P_TOP, P_TOP, P_TOP, P_DONE];
  const tmux = {
    tmuxPath: () => '/fake/tmux', hasServer: () => true, processTable: () => '',
    listPanes: () => [{ id: '%1', command: 'claude', pid: 0, session: 'dev', windowIndex: '0', paneIndex: '0', label: 'dev:0.0' }],
    capture: () => screens[Math.min(i++, screens.length - 1)],
    sendText: (_id, t) => sent.push(t),
    sendKey: (_id, k) => sent.push(`<${k}>`),
    sendEnter: () => sent.push('<Enter>'),
  };
  const { acted } = await runPass({ tmux, config: config(), now: 6000 });
  assert.equal(acted, 1);
  assert.deepEqual(sent, ['<Down>', '<Enter>']);
});

test('a panel that stops looking right is left alone', async () => {
  const PANEL_CONT = ['Remote Control', '    Disconnect this session', '    Show QR code', '  \u276f Continue', '  Enter to select'].join('\n');
  saveState({ '%1': { ...emptyState(), seen: true, panelPending: true } });
  const sent = [];
  let i = 0;
  // After the first Up the panel vanishes entirely.
  const screens = [PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_CONT, PANEL_CONT, 'just a conversation\n> '];
  const tmux = {
    sent,
    tmuxPath: () => '/fake/tmux',
    hasServer: () => true,
    processTable: () => '',
    listPanes: () => [{ id: '%1', command: 'claude', pid: 0, session: 'dev', windowIndex: '0', paneIndex: '0', label: 'dev:0.0' }],
    capture: () => screens[Math.min(i++, screens.length - 1)],
    sendText: (_id, text) => sent.push(text),
    sendKey: (_id, key) => sent.push(`<${key}>`),
    sendEnter: () => sent.push('<Enter>'),
  };
  const { acted, results } = await runPass({ tmux, config: config(), now: 5000 });
  assert.equal(acted, 0);
  assert.deepEqual(sent, ['<Up>'], 'one probe, then hands off');
  assert.equal(results[0].reason, 'panel-shape-changed');
});



test('each real send consumes one attempt from the breaker', async () => {
  saveState({ '%1': { ...emptyState(), seen: true } });
  const cfg = config();
  for (let i = 1; i <= 4; i++) {
    const tmux = fakeTmux({ screens: [DISCONNECTED] });
    const { acted } = await runPass({ tmux, config: cfg, now: 1000 + i * 1000 });
    if (i <= 3) {
      assert.equal(acted, 1, `attempt ${i} fires`);
      assert.equal(loadState()['%1'].fired, i);
    } else {
      assert.equal(acted, 0, 'the fourth is refused');
      assert.deepEqual(tmux.sent, []);
    }
  }
});

// --- usage-limit recovery -------------------------------------------------
// The rules themselves are covered in limits.test.js. What matters here is the
// wiring: that the feature stays off until asked for, and that the resume goes
// through exactly the same "is this pane safe to type into" gauntlet a re-arm
// does.

const LIMIT_SESSION = "You've hit your session limit \u00b7 resets 3pm\n> ";

const limitConfig = (over = {}) => loadConfig({ settle: 1, keyDelay: 1, limits: true, ...over });

test('a usage limit is ignored until limit recovery is turned on', async () => {
  const tmux = fakeTmux({ screens: [LIMIT_SESSION] });
  const { acted } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
});

test('the pass that finds a limit types nothing', async () => {
  const tmux = fakeTmux({ screens: [LIMIT_SESSION] });
  const { results, acted } = await runPass({ tmux, config: limitConfig(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'limit-wait');
});

test('the work is picked back up once the wait has expired', async () => {
  const tmux = fakeTmux({ screens: [LIMIT_SESSION] });
  const cfg = limitConfig({ limitBackoff: 60, limitResumePrompt: 'Pick it back up.' });
  await runPass({ tmux, config: cfg, now: 1000 });
  const { acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 1);
  assert.deepEqual(tmux.sent, ['Pick it back up.', '<Enter>']);
});

/**
 * The link being healthy says nothing about quota, and the re-arm path refuses
 * to act on a connected pane. Sharing that condition would have made the resume
 * fire only on sessions that were *also* disconnected — which is to say, almost
 * never.
 */
test('a healthy Remote Control link does not block a quota resume', async () => {
  const screen = "You've hit your session limit \u00b7 resets 3pm\n> \n  /rc active";
  const cfg = limitConfig({ limitBackoff: 60 });
  const tmux = fakeTmux({ screens: [screen] });
  await runPass({ tmux, config: cfg, now: 1000 });
  const { acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 1);
  assert.deepEqual(tmux.sent, ['Continue where you left off.', '<Enter>']);
});

test('a busy pane is left alone, and the attempt is not spent', async () => {
  const cfg = limitConfig({ limitBackoff: 60 });
  await runPass({ tmux: fakeTmux({ screens: [LIMIT_SESSION] }), config: cfg, now: 1000 });

  const tmux = fakeTmux({ screens: [LIMIT_SESSION, `${LIMIT_SESSION}\nworking 1`, `${LIMIT_SESSION}\nworking 2`] });
  const { results, acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'busy');
  assert.equal(loadState()['%1'].limit.attempts, 0, 'a call-off must not burn an attempt');
});

test('a dialog on screen holds off the resume', async () => {
  const screen = `${LIMIT_SESSION}\nDo you want to proceed?\n\u276f 1. Yes\n  2. No\n> `;
  const cfg = limitConfig({ limitBackoff: 60 });
  await runPass({ tmux: fakeTmux({ screens: [screen] }), config: cfg, now: 1000 });
  const tmux = fakeTmux({ screens: [screen] });
  const { acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
});

test('an unsent draft is never typed over', async () => {
  const screen = "You've hit your session limit \u00b7 resets 3pm\n> half a sentence";
  const cfg = limitConfig({ limitBackoff: 60 });
  await runPass({ tmux: fakeTmux({ screens: [screen] }), config: cfg, now: 1000 });
  const tmux = fakeTmux({ screens: [screen] });
  const { acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
});

test('--dry-run reports the resume without typing it', async () => {
  const cfg = limitConfig({ limitBackoff: 60 });
  await runPass({ tmux: fakeTmux({ screens: [LIMIT_SESSION] }), config: cfg, now: 1000 });
  const tmux = fakeTmux({ screens: [LIMIT_SESSION] });
  const { results } = await runPass({ tmux, config: cfg, dryRun: true, now: 1060 });
  assert.equal(results[0].action, 'would-resume');
  assert.deepEqual(tmux.sent, []);
});

/**
 * loadConfig rejects an empty prompt outright, so this is a caller that built a
 * config by hand. What matters is that the refusal spends the breaker instead of
 * rewinding it: routed through abort(), a condition that never clears would loop
 * every 15 seconds forever rather than giving up.
 */
test('an empty resume prompt submits nothing, and does not loop forever', async () => {
  const cfg = { ...limitConfig({ limitBackoff: 60 }), limitResumePrompt: '   ' };
  const tmux = fakeTmux({ screens: [LIMIT_SESSION] });
  await runPass({ tmux, config: cfg, now: 1000 });
  const { results, acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'no-prompt');
  assert.equal(loadState()['%1'].limit.attempts, 1, 'the refusal must consume an attempt');

  // Stepped to each wait's own deadline, the way a real pass lands on it.
  // Jumping an arbitrary distance instead would put the stored wait so far past
  // its deadline that limits.js reads it as state left over from a previous
  // tmux server and re-arms — which is correct, and would never let the breaker
  // trip here even though it does in production.
  let last;
  for (let i = 0; i < 12; i++) {
    last = await runPass({ tmux, config: cfg, now: loadState()['%1'].limit.waitUntil });
    if (last.results[0].reason === 'limit-gave-up') break;
  }
  assert.deepEqual(tmux.sent, []);
  assert.equal(last.results[0].reason, 'limit-gave-up');
});

process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));

/**
 * The resume is the only action that types a sentence into a real conversation,
 * so it has to re-verify its own trigger like the others do. isIdle spends a
 * couple of seconds capturing, and the banner can leave the footer in that time
 * — the session was re-run from another window, or new output pushed it up.
 * Without the re-read the prompt lands in a live, unlimited conversation.
 */
test('a resume is called off when the banner leaves before the last look', async () => {
  const cfg = limitConfig({ limitBackoff: 60 });
  // Three identical captures for the idle check, then a clear screen for the
  // recheck that decides whether to send.
  await runPass({ tmux: fakeTmux({ screens: [LIMIT_SESSION] }), config: cfg, now: 1000 });

  // An acting pass captures five times: once to decide, three for the idle
  // check, once to look again before typing. The banner is there for the first
  // four and gone for the last.
  const tmux = fakeTmux({
    screens: [LIMIT_SESSION, LIMIT_SESSION, LIMIT_SESSION, LIMIT_SESSION, '> \n  /rc active'],
  });
  const { results, acted } = await runPass({ tmux, config: cfg, now: 1060 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, [], 'nothing may be typed once the banner is gone');
  assert.equal(results[0].reason, 'recovered');
});
