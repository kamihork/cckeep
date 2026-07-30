import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cckeep-state-'));
process.env.CCKEEP_HOME = HOME;

const { appendLog, logPath, statePath, saveState, loadState, acquireLock, releaseLock } = await import('../src/state.js');

test('the log rolls over instead of growing forever', () => {
  // A scheduled pass runs every 15s for as long as the machine is up.
  const p = logPath();
  writeFileSync(p, 'x'.repeat(200));
  appendLog('after the limit', 100);
  assert.ok(existsSync(`${p}.1`), 'the previous generation is kept');
  assert.ok(statSync(p).size < 200, 'the live log restarted');
  assert.match(readFileSync(p, 'utf8'), /after the limit/);
});

test('a log under the limit is simply appended to', () => {
  const p = logPath();
  writeFileSync(p, 'small\n');
  appendLog('next line', 1024 * 1024);
  const body = readFileSync(p, 'utf8');
  assert.match(body, /^small/);
  assert.match(body, /next line/);
});

test('state is written atomically', () => {
  // A reader that catches a half-written file falls back to {}, losing every
  // pane ever seen connected — so the write has to be a rename, not a truncate
  // and refill.
  //
  // Interleaving cannot be produced from one process, so this pins the
  // mechanism instead: writing straight to the destination fails on a
  // read-only file, while replacing it by rename succeeds.
  saveState({ '%1': { seen: true } });
  chmodSync(statePath(), 0o444);
  saveState({ '%2': { seen: true } });
  chmodSync(statePath(), 0o644);

  const after = loadState();
  assert.equal(after['%2']?.seen, true, 'the new state landed');
  assert.equal(after['%1'], undefined, 'and replaced the old one');
  assert.deepEqual(readdirSync(HOME).filter((f) => f.endsWith('.tmp')), [], 'no temp file left behind');
});

test('the lock is exclusive and releasable', () => {
  assert.equal(acquireLock(), true);
  assert.equal(acquireLock(), false, 'a second holder is refused');
  releaseLock();
  assert.equal(acquireLock(), true, 'and it can be taken again afterwards');
  releaseLock();
});

test('a stale lock does not block forever', async () => {
  // A pass killed mid-run must not disable the tool until someone notices.
  assert.equal(acquireLock(), true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(acquireLock(1), true, 'a lock older than the staleness window is taken over');
  releaseLock();
});

process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));
