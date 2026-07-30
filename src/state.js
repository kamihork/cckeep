import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { emptyState } from './detect.js';

export function homeDir() {
  return process.env.CCKEEP_HOME || join(homedir(), '.cckeep');
}

export function statePath() {
  return join(homeDir(), 'state.json');
}

export function logPath() {
  return join(homeDir(), 'cckeep.log');
}

export function loadState() {
  const p = statePath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt state file must never stop the watchdog: the worst it costs is
    // one forgotten pane, and every counter rebuilds within a few passes.
    return {};
  }
}

export function saveState(state) {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  // Write then rename, so a concurrent reader never sees a half-written file
  // and falls back to an empty state — which would lose every `seen` flag.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, p);
}

/**
 * One pass at a time. `cckeep watch` in a terminal alongside the scheduled job
 * is an easy thing to end up with, and two passes acting on the same pane
 * interleave into a single garbled prompt — the cooldown cannot help, because
 * both read the state before either writes it.
 */
export function acquireLock(staleAfterMs = 120000) {
  const p = join(homeDir(), 'cckeep.lock');
  mkdirSync(dirname(p), { recursive: true });
  try {
    writeFileSync(p, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(p).mtimeMs > staleAfterMs) {
        rmSync(p, { force: true });
        writeFileSync(p, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch {}
    return false;
  }
}

export function releaseLock() {
  try {
    rmSync(join(homeDir(), 'cckeep.lock'), { force: true });
  } catch {}
}

export function forPane(state, paneId) {
  return { ...emptyState(), ...(state[paneId] || {}) };
}

/** Forget panes that no longer exist, so state.json cannot grow without bound. */
export function prune(state, livePaneIds) {
  const live = new Set(livePaneIds);
  const out = {};
  for (const [id, value] of Object.entries(state)) if (live.has(id)) out[id] = value;
  return out;
}

/** Bytes before the log is rolled over. One generation is kept. */
const LOG_MAX_BYTES = 512 * 1024;

export function appendLog(line, maxBytes = LOG_MAX_BYTES) {
  try {
    const p = logPath();
    mkdirSync(dirname(p), { recursive: true });
    // A scheduled pass runs every 15s forever, so an append-only file that only
    // `cckeep logs` ever reads would grow without bound.
    try {
      if (statSync(p).size > maxBytes) renameSync(p, `${p}.1`);
    } catch {}
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    writeFileSync(p, `[${stamp}] ${line}\n`, { flag: 'a' });
  } catch {}
}
