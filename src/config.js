import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './state.js';
import { DEFAULTS } from './detect.js';
import { LIMIT_DEFAULTS } from './limits.js';

export const BASE = {
  ...DEFAULTS,
  ...LIMIT_DEFAULTS,
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

const NUMERIC = new Set([
  'stuckLimit', 'missLimit', 'cooldown', 'interval', 'settle', 'keyDelay', 'maxRearms',
  'limitBackoff', 'limitMaxAttempts', 'limitRestoreAfter',
]);

/** launchd and systemd both want whole seconds, and a fraction breaks the plist. */
const INTEGER = new Set([
  'interval', 'stuckLimit', 'missLimit', 'maxRearms',
  'limitBackoff', 'limitMaxAttempts', 'limitRestoreAfter',
]);

/**
 * Settings that gate an action rather than tune one.
 *
 * Coerced from the string an environment variable always is, because
 * `CCKEEP_LIMITS=false` is the obvious way to turn something off and the string
 * "false" is truthy — which would enable the very thing the user just disabled.
 */
const BOOLEAN = new Set(['limits']);

const ENV = {
  CCKEEP_INTERVAL: 'interval',
  CCKEEP_COOLDOWN: 'cooldown',
  CCKEEP_STUCK_LIMIT: 'stuckLimit',
  CCKEEP_MISS_LIMIT: 'missLimit',
  CCKEEP_MAX_REARMS: 'maxRearms',
  CCKEEP_SETTLE: 'settle',
  CCKEEP_KEY_DELAY: 'keyDelay',
  CCKEEP_PANE_COMMAND: 'paneCommand',
  CCKEEP_TMUX_SOCKET: 'tmuxSocket',
  CCKEEP_TMUX: 'tmuxBinary',
  CCKEEP_LIMITS: 'limits',
  CCKEEP_LIMIT_BACKOFF: 'limitBackoff',
  CCKEEP_LIMIT_MAX_ATTEMPTS: 'limitMaxAttempts',
  CCKEEP_LIMIT_RESUME_PROMPT: 'limitResumePrompt',
  CCKEEP_LIMIT_RESTORE_MODEL: 'limitRestoreModel',
  CCKEEP_LIMIT_RESTORE_AFTER: 'limitRestoreAfter',
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
  for (const key of BOOLEAN) {
    const value = merged[key];
    merged[key] = typeof value === 'string' ? !/^(0|false|no|off|)$/i.test(value.trim()) : Boolean(value);
  }
  if (merged.limits) {
    // Caught here rather than at send time. A pane that reaches the send and is
    // turned away every pass never advances its own breaker, so a permanently
    // broken setting is a permanent loop rather than something that gives up.
    if (!String(merged.limitResumePrompt ?? '').trim()) {
      throw new Error('config: limitResumePrompt must not be empty when limits is on');
    }
    // Typed straight after `/model`, so anything with whitespace or a slash in
    // it would open the model picker and leave the pane sitting on it.
    const model = String(merged.limitRestoreModel ?? '').trim();
    if (model && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
      throw new Error(`config: limitRestoreModel must be a model name or alias, not "${model}"`);
    }
    merged.limitRestoreModel = model;
  }
  for (const key of NUMERIC) {
    const value = Number(merged[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`config: ${key} must be a non-negative number`);
    if (INTEGER.has(key) && !Number.isInteger(value)) throw new Error(`config: ${key} must be a whole number`);
    merged[key] = value;
  }
  return merged;
}
