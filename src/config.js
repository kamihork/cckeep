import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './state.js';
import { DEFAULTS } from './detect.js';

export const BASE = {
  ...DEFAULTS,
  /** Seconds between passes in watch mode, and what `enable` schedules. */
  interval: 15,
  /** Milliseconds between idle-check captures. Deliberately not a round
   * number: a spinner whose period divides the interval would alias to
   * identical frames and read as idle. */
  settle: 1700,
  /** Milliseconds between typing the command and pressing Enter. */
  keyDelay: 1000,
  /** Foreground process name that marks a pane as Claude Code. */
  paneCommand: 'claude',
  /** tmux socket name or path, for anyone not on the default server. */
  tmuxSocket: '',
  /** Absolute path to tmux, for installs outside the usual locations. */
  tmuxBinary: '',
};

const NUMERIC = new Set(['stuckLimit', 'missLimit', 'cooldown', 'interval', 'settle', 'keyDelay']);

/** launchd and systemd both want whole seconds, and a fraction breaks the plist. */
const INTEGER = new Set(['interval', 'stuckLimit', 'missLimit']);

const ENV = {
  CCKEEP_INTERVAL: 'interval',
  CCKEEP_COOLDOWN: 'cooldown',
  CCKEEP_STUCK_LIMIT: 'stuckLimit',
  CCKEEP_MISS_LIMIT: 'missLimit',
  CCKEEP_SETTLE: 'settle',
  CCKEEP_KEY_DELAY: 'keyDelay',
  CCKEEP_PANE_COMMAND: 'paneCommand',
  CCKEEP_TMUX_SOCKET: 'tmuxSocket',
  CCKEEP_TMUX: 'tmuxBinary',
};

export function configPath() {
  return join(homeDir(), 'config.json');
}

/** Precedence: built-in defaults < config file < environment < CLI flags. */
export function loadConfig(overrides = {}) {
  let fromFile = {};
  const p = configPath();
  if (existsSync(p)) {
    try {
      fromFile = JSON.parse(readFileSync(p, 'utf8')) || {};
    } catch (err) {
      // Silently running with half the settings dropped is worse than stopping.
      throw new Error(`${p} is not valid JSON: ${err.message}`);
    }
  }

  const fromEnv = {};
  for (const [key, name] of Object.entries(ENV)) {
    const raw = process.env[key];
    if (raw !== undefined && raw !== '') fromEnv[name] = raw;
  }

  const merged = { ...BASE, ...fromFile, ...fromEnv, ...overrides };
  if (Number(merged.interval) < 1) throw new Error('config: interval must be at least 1 second');
  for (const key of NUMERIC) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`config: ${key} must be a non-negative number`);
    if (INTEGER.has(key) && !Number.isInteger(value)) throw new Error(`config: ${key} must be a whole number`);
    merged[key] = value;
  }
  return merged;
}
