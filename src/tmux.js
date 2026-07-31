import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Schedulers run with a minimal PATH — cron notoriously omits /opt/homebrew/bin,
// and launchd is no better. Resolving tmux to an absolute path here is what
// keeps a scheduled run from silently finding nothing to do.
const CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/bin/tmux',
  '/opt/local/bin/tmux',
  '/home/linuxbrew/.linuxbrew/bin/tmux',
];

let cached;

/**
 * tmux runs one server per socket. Anyone using `tmux -L name` or `-S path` has
 * their panes on a different server, and without this cckeep silently watches
 * the wrong one — it reports "no panes" while the sessions are right there.
 * It also makes cckeep testable against a throwaway server instead of the one
 * holding your real conversations.
 */
export function socketArgs(socketOverride) {
  // `||` rather than `??`: the config default is an empty string, and an empty
  // string must fall through to the environment instead of shadowing it.
  const socket = socketOverride || process.env.CCKEEP_TMUX_SOCKET;
  if (!socket) return [];
  return socket.includes('/') ? ['-S', socket] : ['-L', socket];
}

/**
 * Settings that reach tmux from the config file rather than the environment.
 * Set once from the CLI after the config is loaded, because every call site
 * below is deep inside a pass and threading them through would touch every
 * signature for no gain.
 */
let configured = { socket: '', binary: '' };

export function configureTmux({ socket = '', binary = '' } = {}) {
  configured = { socket, binary };
  cached = binary && existsSync(binary) ? binary : undefined;
}

export function tmuxPath() {
  if (cached) return cached;
  if (configured.binary && existsSync(configured.binary)) return (cached = configured.binary);
  const fromEnv = process.env.CCKEEP_TMUX;
  if (fromEnv && existsSync(fromEnv)) return (cached = fromEnv);
  for (const p of CANDIDATES) if (existsSync(p)) return (cached = p);
  try {
    const found = execFileSync('command', ['-v', 'tmux'], { shell: true, encoding: 'utf8' }).trim();
    if (found && existsSync(found)) return (cached = found);
  } catch {}
  return null;
}

function tmux(args, { allowFail = true } = {}) {
  const bin = tmuxPath();
  if (!bin) return null;
  try {
    return execFileSync(bin, [...socketArgs(configured.socket), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

export function hasServer() {
  return tmux(['has-session']) !== null;
}

/** Every pane on the server, with the process currently in the foreground. */
/**
 * Every pane on the server, or null if tmux could not be asked.
 *
 * The distinction matters: an empty array used to also mean "the query failed",
 * and the caller pruned its state to match — wiping every pane it had ever seen
 * connected, which no pane can re-earn while it is disconnected.
 */
/**
 * Field separator for `list-panes -F`.
 *
 * Not a tab, and not any control character: outside an interactive shell — a
 * launchd job, a cron entry — tmux replaces those in format output with "_".
 * The rows then parse into one field each, every pane is discarded, and cckeep
 * reports "no panes running Claude Code" while doing nothing at all. That is
 * how it ran 15,000 times on the author's machine without ever acting.
 */
export const SEP = '|;|';

/** Fixed fields first, free-form session name last so it can contain anything. */
export const FORMAT = ['#{pane_id}', '#{pane_pid}', '#{window_index}', '#{pane_index}',
  '#{pane_current_command}', '#{session_name}'].join(SEP);

export function listPanes() {
  const out = tmux(['list-panes', '-a', '-F', FORMAT]);
  if (out === null) return null;
  return parsePaneRows(out);
}

/** The parsing half, split out so it can be tested without a tmux server. */
export function parsePaneRows(out) {
  if (!out.trim()) return [];

  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split(SEP);
    if (parts.length < 6) continue;
    const [id, pid, windowIndex, paneIndex, command] = parts;
    // The session name is whatever is left, rejoined, so a separator inside it
    // cannot shift the other fields.
    const session = parts.slice(5).join(SEP);
    if (!/^%\d+$/.test(id) || !/^\d+$/.test(pid)) continue;
    rows.push({
      id,
      command,
      session,
      windowIndex,
      paneIndex,
      pid: Number(pid),
      label: `${session}:${windowIndex}.${paneIndex}`,
    });
  }

  // Output that yields nothing usable is a parse failure, not an empty server.
  // Returning [] here would prune away every pane cckeep has ever seen.
  if (rows.length === 0) return null;
  return rows;
}

/**
 * One snapshot of the process table per pass. Claude Code rewrites its process
 * title, so the name tmux reports is not enough to recognise a pane running it.
 */
export function processTable() {
  try {
    return execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

export function capture(paneId) {
  return tmux(['capture-pane', '-p', '-t', paneId]) ?? '';
}

export function sendText(paneId, text) {
  // -l sends the string literally, so a pane in some unexpected mode cannot
  // reinterpret it as a key name.
  tmux(['send-keys', '-l', '-t', paneId, text]);
}

export function sendEnter(paneId) {
  tmux(['send-keys', '-t', paneId, 'Enter']);
}
