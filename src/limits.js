// Usage-limit recovery.
//
// Kept out of detect.js on purpose. That module answers "is the Remote Control
// link alive"; this one answers "is this session blocked on quota". Different
// signals, different actions — and separating them means neither set of rules
// can quietly shift the other's behaviour when it changes.
//
// Pure, for the reason detect.js is pure: the failure mode is typing into
// someone's terminal at the wrong moment, so every rule has to be testable
// without a tmux server.
//
// Why the screen and not a hook: Claude Code does fire a `StopFailure` hook when
// a turn dies on a rate limit, but its only useful payload — the message text —
// is the very banner the pane already shows. The hook would buy at most one poll
// interval of latency on a recovery measured in hours, in exchange for making
// every user edit settings.json. Not a trade worth making.

import { trimmedLines } from './detect.js';

/**
 * The banner Claude Code prints when a quota window is exhausted:
 *
 *   You've hit your session limit · resets 3pm
 *
 * The label varies with which window ran out — "session limit", "weekly limit",
 * "Opus limit" and so on — and is kept only to tell one outage from the next.
 * Nothing here acts on which one it is: every limit is waited out the same way.
 *
 * Captured loosely rather than as an alternation of the known labels, so a label
 * added upstream still registers as a limit instead of going unnoticed.
 */
const BANNER_ALL = /You(?:'|’)ve hit your ([^\n·]{1,40}?limit)\b/g;

/** Ceiling on the wait between resume attempts. */
const BACKOFF_MAX = 7200;

export const LIMIT_DEFAULTS = {
  /**
   * Off by default. Everyone running 0.6.0 upgrades into this code, and a
   * watchdog that suddenly starts typing prompts into their panes because a
   * banner appeared is not something to opt people into silently.
   */
  limits: false,
  /** Seconds before the first resume attempt. Doubles on each failed attempt. */
  limitBackoff: 900,
  /** Resume attempts per outage, before leaving the pane alone for good. */
  limitMaxAttempts: 6,
  /**
   * What gets typed to pick the work back up. It lands in a real conversation,
   * so it is a config value and not a string buried in the source — and it is
   * deliberately free of anything a model could read as authority to commit,
   * push, or deploy on its own.
   */
  limitResumePrompt: 'Continue where you left off.',
};

export function emptyLimitState() {
  return { banner: null, waitUntil: 0, attempts: 0 };
}

/**
 * The limit banner, or null.
 *
 * Footer-scoped, like the Remote Control indicator and for the same reason: the
 * words appear verbatim in any conversation *about* usage limits, and in this
 * project's own test fixtures. Reading the whole pane would make a session that
 * merely discusses the banner look like a session blocked by one — the exact
 * class of false positive detect.js's FOOTER_LINES comment was written about.
 *
 * The last match rather than the first: a resume that was too early leaves its
 * own banner below the one that is already there, and the newest is the one in
 * effect.
 */
export function readLimit(screen, footerLines = 12) {
  const lines = trimmedLines(screen);
  const footer = lines.slice(Math.max(0, lines.length - footerLines)).join('\n');
  let label = null;
  for (const m of footer.matchAll(BANNER_ALL)) label = m[1].trim();
  return label;
}

function backoffFor(attempts, cfg) {
  const grown = cfg.limitBackoff * 2 ** Math.min(attempts, 4);
  return Math.min(grown, BACKOFF_MAX);
}

/**
 * Decide what to do about quota on one pane.
 *
 * Returns `{ action, reason, state }` where action is one of:
 *   'none'   — no limit on screen, or the wait has not expired
 *   'resume' — type the resume prompt; the window has had time to refill
 *
 * Like decide(), this is a recommendation. The caller still has to confirm the
 * pane is idle and free of dialogs before typing anything.
 *
 * Everything here is driven by a banner on the *current* screen. Nothing is
 * carried across passes waiting to be spent later, which is what keeps pane-id
 * reuse — tmux numbers panes from %0 again after its server restarts — from
 * being able to aim a resume at a session that never hit a limit at all.
 */
export function decideLimit({ screen, state = emptyLimitState(), now = 0, config = {} }) {
  const cfg = { ...LIMIT_DEFAULTS, ...config };
  const next = { ...emptyLimitState(), ...state };
  const label = readLimit(screen);

  if (!label) {
    // Working again: let a later, unrelated outage start from a clean breaker.
    next.banner = null;
    next.waitUntil = 0;
    next.attempts = 0;
    return { action: 'none', reason: 'no-limit', state: next };
  }

  // The banner sits in the footer for the entire wait — hours, for a weekly
  // window. Cooldown cannot express that, so the wait is held on the pane.
  if (next.banner === label && now < next.waitUntil) {
    return { action: 'none', reason: 'limit-wait', state: next };
  }

  if (next.attempts >= cfg.limitMaxAttempts) {
    return { action: 'none', reason: 'limit-gave-up', state: next };
  }

  // Only the clock helps.
  //
  // The banner does carry a reset time ("· resets 3pm"), but it is formatted for
  // humans and localised, and a parser that mis-reads it either waits hours too
  // long or resumes into the same wall. Backing off instead is self-correcting:
  // a resume that is too early fails, the banner comes straight back, and the
  // next wait is twice as long.
  if (next.banner !== label) {
    next.banner = label;
    next.waitUntil = now + backoffFor(next.attempts, cfg);
    return { action: 'none', reason: 'limit-wait', state: next };
  }

  next.attempts += 1;
  next.waitUntil = now + backoffFor(next.attempts, cfg);
  return { action: 'resume', reason: 'limit-expired', state: next };
}
