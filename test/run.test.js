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

process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));
