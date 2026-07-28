import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  writeFileSync(p, JSON.stringify(state, null, 2));
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

export function appendLog(line) {
  try {
    const p = logPath();
    mkdirSync(dirname(p), { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    writeFileSync(p, `[${stamp}] ${line}\n`, { flag: 'a' });
  } catch {}
}
