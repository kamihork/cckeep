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

import { trimmedLines, FOOTER_LINES } from './detect.js';

/**
 * The banner Claude Code prints when a quota window is exhausted:
 *
 *   You've hit your session limit · resets 3pm
 *
 * Read out of the 2.1.239 binary rather than guessed, because the first version
 * of this pattern was written against a shape the product does not print and so
 * matched nothing in the common case. What it actually emits:
 *
 *   - `You've hit your ${label}`, where label comes from
 *     { five_hour: "session limit", seven_day: "weekly limit",
 *       seven_day_opus: "Opus limit", seven_day_sonnet: "Sonnet limit",
 *       seven_day_overage_included: "Fable 5 limit" }
 *   - the same builder called with no label at all — a bare
 *     `You've hit your limit`, which is why the label may be zero-length
 *   - `You've reached your Fable 5 limit`
 *   - retry lines of the form `<Label> reached`, e.g. "Session limit reached"
 *
 * The label is kept only to tell one outage from the next; nothing acts on which
 * window ran out. Captured loosely rather than as an alternation of the known
 * labels, so a label added upstream still registers instead of going unnoticed.
 */
const BANNER_ALL = /You(?:'|’)ve (?:hit|reached) your ([^\n·]{0,40}?limit)\b|(?:^|\s)([A-Za-z][^\n·]{0,40}?limit) reached\b/g;

/**
 * Banners that look like a limit but are not a window that refills.
 *
 * Running out of usage credits, or hitting a monthly spend cap, is a spend
 * problem: the fix is a payment or a model switch, not time. The whole backoff
 * here tops out around ten hours, so waiting could never clear one — it would
 * just type the resume prompt into the pane six times for nothing. Recognised
 * and refused, the way detect.js refuses an auth or plan wall.
 */
const NOT_WAITABLE = /You(?:'|’)re out of usage credits|monthly spend limit/;

/** Ceiling on the wait between resume attempts. */
const BACKOFF_MAX = 7200;

/**
 * How far past its own deadline a stored wait may be before it stops counting.
 *
 * The wait is the one thing here that survives a pass, so it is the one thing
 * that could be spent on the wrong session: tmux numbers panes from %0 again
 * after its server restarts, so days-old state keyed to `%1` can meet a
 * different session that happens to show the same label, and the expired wait
 * would resume it instantly.
 *
 * Measured against waitUntil rather than against the last sighting, and set to
 * the backoff ceiling, so that it cannot fire during normal operation: a pass
 * runs every `interval` seconds, so a live wait is at most one interval past
 * its deadline when it is spent. A threshold tied to how recently the pane was
 * seen would instead re-arm the wait every time the machine slept through a
 * poll, and a wait that restarts forever is a feature that never fires.
 */
const STALE_AFTER = BACKOFF_MAX;

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
export function readLimit(screen, footerLines = FOOTER_LINES) {
  const lines = trimmedLines(screen);
  const footer = lines.slice(Math.max(0, lines.length - footerLines)).join('\n');
  if (NOT_WAITABLE.test(footer)) return null;
  let label = null;
  for (const m of footer.matchAll(BANNER_ALL)) label = (m[1] ?? m[2]).trim();
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
    return { action: 'none', reason: 'no-limit', state: emptyLimitState() };
  }

  // A new outage — a different window ran out, or this pane has not been seen
  // carrying a banner recently enough for the stored wait to be about this one.
  // Either way it starts over: a fresh wait, and a fresh breaker, since an
  // outage that has already been given up on must not condemn the next one.
  //
  // Only the clock helps, so the wait is a backoff rather than a reading of the
  // "· resets 3pm" on the banner. That timestamp is localised prose, and a
  // parser that mis-reads it either waits hours too long or resumes into the
  // same wall. Backing off is self-correcting: a resume that is too early
  // fails, the banner comes straight back, and the next wait is twice as long.
  if (next.banner !== label || now - next.waitUntil > STALE_AFTER) {
    next.banner = label;
    next.attempts = 0;
    next.waitUntil = now + backoffFor(0, cfg);
    return { action: 'none', reason: 'limit-wait', state: next };
  }

  // The banner sits in the footer for the entire wait — hours, for a weekly
  // window. Cooldown cannot express that, so the wait is held on the pane.
  if (now < next.waitUntil) {
    return { action: 'none', reason: 'limit-wait', state: next };
  }

  if (next.attempts >= cfg.limitMaxAttempts) {
    return { action: 'none', reason: 'limit-gave-up', state: next };
  }

  next.attempts += 1;
  next.waitUntil = now + backoffFor(next.attempts, cfg);
  return { action: 'resume', reason: 'limit-expired', state: next };
}
