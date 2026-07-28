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

export function tmuxPath() {
  if (cached) return cached;
  const fromEnv = process.env.AGENTTETHER_TMUX;
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
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

export function hasServer() {
  return tmux(['has-session']) !== null;
}

/** Every pane on the server, with the process currently in the foreground. */
export function listPanes() {
  const out = tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{pane_current_command}\t#{session_name}\t#{window_index}\t#{pane_index}']);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, command, session, windowIndex, paneIndex] = line.split('\t');
      return { id, command, session, windowIndex, paneIndex, label: `${session}:${windowIndex}.${paneIndex}` };
    });
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
