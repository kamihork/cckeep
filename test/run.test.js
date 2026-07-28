import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// State is written under AGENTTETHER_HOME; point it somewhere disposable before
// anything imports the state module.
const HOME = mkdtempSync(join(tmpdir(), 'agenttether-test-'));
process.env.AGENTTETHER_HOME = HOME;

const { runPass } = await import('../src/run.js');
const { loadConfig } = await import('../src/config.js');
const { emptyState } = await import('../src/detect.js');
const { saveState } = await import('../src/state.js');

const CONNECTED = '> \n  /rc active';
const DISCONNECTED = 'Remote Control disconnected · /remote-control\n> ';
const PANEL = 'Remote Control\n❯ Disconnect this session\n  Show QR code';

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
    listPanes: () => [{ id: '%1', command, session: 'dev', windowIndex: '0', paneIndex: '0', label: 'dev:0.0' }],
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
  const tmux = fakeTmux({ screens: [DISCONNECTED, DISCONNECTED, DISCONNECTED, CONNECTED] });
  const { acted, results } = await runPass({ tmux, config: config(), now: 1000 });
  assert.equal(acted, 0);
  assert.deepEqual(tmux.sent, []);
  assert.equal(results[0].reason, 'recovered');
});

test('a dialog that appears during the idle wait aborts the send', async () => {
  const withPrompt = 'Do you want to proceed?\n❯ 1. Yes\n  2. No';
  const tmux = fakeTmux({ screens: [DISCONNECTED, DISCONNECTED, DISCONNECTED, withPrompt] });
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

process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));
