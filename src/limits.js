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
 * The label names the bucket that died — and the bucket names the model that was
 * running, which is what makes a useful fallback possible without asking Claude
 * Code what model is selected. The set is fixed in the binary:
 *
 *   five_hour                 -> "session limit"      (all models)
 *   seven_day                 -> "weekly limit"       (all models)
 *   seven_day_opus            -> "Opus limit"
 *   seven_day_sonnet          -> "Sonnet limit"
 *   seven_day_overage_included-> "Fable 5 limit"
 *   overage                   -> "usage credit limit"
 *
 * Captured loosely rather than as an alternation of those six, so a label added
 * upstream still registers as *a* limit. An unrecognised label falls through to
 * the wait branch, which is the safe direction: waiting on a limit that would
 * have allowed a model switch costs time, switching on one that is actually
 * account-wide costs nothing but does not help either.
 */
const BANNER_ALL = /You(?:'|’)ve hit your ([^\n·]{1,40}?limit)\b/g;

/**
 * Where a still-usable model exists, and which one to move to.
 *
 * Only model-scoped buckets appear here. "session limit" and "weekly limit"
 * cover every model at once, so switching is pointless — those wait. Sonnet is
 * the end of the line: below it there is nothing worth handing a coding session.
 */
const NEXT_MODEL = new Map([
  ['fable 5 limit', 'opus'],
  ['opus limit', 'sonnet'],
]);

/**
 * How long the model switch is given to land before the pane is touched again.
 * Long enough that `/model` has redrawn, short enough that the resume follows
 * while the session is obviously still the same piece of work.
 */
const SWITCH_SETTLE = 30;

/** Ceiling on the wait between resume attempts. */
const BACKOFF_MAX = 7200;

/**
 * How long a pending resume stays valid.
 *
 * The switch is picked up on the very next pass — 15 seconds later — so this is
 * generous. It exists because tmux hands out pane ids from %0 again after the
 * server restarts, and state is keyed by pane id: a `resumePending` left over
 * from yesterday's %0 would otherwise be spent typing a "carry on" prompt into
 * whatever unrelated session happens to be %0 today.
 */
const RESUME_WINDOW = 600;

/**
 * How long past its due time a scheduled restore stays valid.
 *
 * Same hazard as RESUME_WINDOW, but the due time is hours out by design, so the
 * grace has to cover an ordinary overnight rather than a single pass. Generous
 * because the payload is milder: a stale restore types `/model fable`, not a
 * sentence into someone's conversation.
 */
const RESTORE_WINDOW = 43200;

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
  /** Model alias to return to once its window refills. Empty = stay put. */
  limitRestoreModel: '',
  /** Seconds after a switch before trying to go back. Doubles on each relapse. */
  limitRestoreAfter: 3600,
};

export function emptyLimitState() {
  return {
    banner: null,
    waitUntil: 0,
    attempts: 0,
    resumePending: false,
    resumeBy: 0,
    switchedOn: null,
    restoreTo: null,
    restoreAt: 0,
    restoreBy: 0,
    restoreFails: 0,
    restored: false,
    restoredAt: 0,
  };
}

/**
 * The limit banner, or null.
 *
 * Footer-scoped, like the Remote Control indicator and for the same reason: the
 * words appear verbatim in any conversation *about* usage limits, and in this
 * project's own test fixtures. Reading the whole pane would make a session that
 * merely discusses the banner look like a session blocked by one — the exact
 * class of false positive detect.js's FOOTER_LINES comment was written about.
 */
export function readLimit(screen, footerLines = 12) {
  const lines = trimmedLines(screen);
  const footer = lines.slice(Math.max(0, lines.length - footerLines)).join('\n');
  // The last match, not the first. Two banners can share the footer — a switch
  // away from an exhausted model that then meets the next model's own window
  // leaves both on screen — and the first match is the older one. Acting on it
  // would keep answering a limit that has already been dealt with.
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
 * Returns `{ action, reason, state }`, and `model` for the two model actions:
 *   'none'          — nothing to do, or the wait has not expired
 *   'switch-model'  — type `/model <model>`; a model-scoped window died and
 *                     another model is usable right now
 *   'resume'        — type the resume prompt; either the wait expired or a
 *                     switch landed and the work needs picking back up
 *   'restore-model' — type `/model <model>` to go back to the preferred one
 *
 * Like decide(), this is a recommendation. The caller still has to confirm the
 * pane is idle and free of dialogs before typing anything.
 */
export function decideLimit({ screen, state = emptyLimitState(), now = 0, config = {} }) {
  const cfg = { ...LIMIT_DEFAULTS, ...config };
  const next = { ...emptyLimitState(), ...state };
  const label = readLimit(screen);

  // A switch was sent on an earlier pass, and the follow-up is driven by this
  // flag and the clock — never by the banner going away.
  //
  // Whether the switch worked cannot be read off the screen at all: the banner
  // that triggered it is the failed turn's own output and stays in the
  // transcript either way. An earlier version waited for a clear screen before
  // resuming, which meant that whenever the banner was still inside the footer
  // the pane fell back through to the switch branch instead — re-sending
  // `/model` once per backoff until the breaker stopped it, and never resuming
  // at all. Resuming on the clock is also the safe direction: a resume sent
  // while the window is genuinely still full simply fails and re-banners.
  if (next.resumePending) {
    if (now < next.waitUntil) return { action: 'none', reason: 'limit-wait', state: next };
    const fresh = now <= next.resumeBy;
    next.resumePending = false;
    next.resumeBy = 0;
    // Too old to trust that this is even the same pane — see RESUME_WINDOW.
    if (fresh) return { action: 'resume', reason: 'switched', state: next };
  }

  if (!label) {
    next.banner = null;
    next.waitUntil = 0;
    // The transcript is clear, so a banner seen from here on is a new one.
    next.switchedOn = null;

    // A restore that has held longer than it took to schedule counts as having
    // worked. Forget the escalation, so the next outage starts from the
    // configured delay instead of inheriting yesterday's penalty forever.
    if (next.restored && now - next.restoredAt > cfg.limitRestoreAfter) {
      next.restored = false;
      next.restoreFails = 0;
    }

    if (next.restoreTo && now >= next.restoreAt) {
      const model = next.restoreTo;
      const fresh = now <= next.restoreBy;
      next.restoreTo = null;
      next.restoreAt = 0;
      next.restoreBy = 0;
      if (fresh) {
        // Remembered so the same limit coming straight back can be told apart
        // from the first time it appeared — one is a restore that was too
        // early, the other is just a new outage.
        next.restored = true;
        next.restoredAt = now;
        return { action: 'restore-model', model, reason: 'restore', state: next };
      }
      // The due time came and went while cckeep was not running. Pane ids are
      // handed out from %0 again after a tmux server restart, so a restore this
      // stale may be aimed at a different session entirely. Dropping it costs
      // the user a manual /model; firing it types into someone else's work.
    }

    // Working again: let a later, unrelated outage start from a clean breaker.
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

  // One switch per banner. The text that triggered the first one is still in the
  // transcript afterwards, and treating it as a fresh signal would walk the
  // session down the whole model list for a single outage. A limit that is
  // genuinely still blocking shows up as a resume that fails, which lands here
  // as the *next* model's label — a different string, so it is not suppressed.
  const target = label === next.switchedOn ? undefined : NEXT_MODEL.get(label.toLowerCase());
  if (target) {
    next.banner = label;
    next.switchedOn = label;
    next.attempts += 1;
    next.resumePending = true;
    next.resumeBy = now + RESUME_WINDOW;
    next.waitUntil = now + SWITCH_SETTLE;

    if (cfg.limitRestoreModel) {
      // Landing back on the preferred model's own window shortly *after a
      // restore* means that restore was too early, so the next one waits longer.
      // Both guards matter: without `restored` the very first switch counts as a
      // relapse — the banner naturally names the model being left — and without
      // the time bound a perfectly ordinary outage days later inherits the
      // penalty, which then never decays.
      const recent = now - next.restoredAt <= cfg.limitRestoreAfter;
      const relapsed = next.restored && recent && label.toLowerCase().includes(cfg.limitRestoreModel.toLowerCase());
      if (relapsed) next.restoreFails = Math.min(next.restoreFails + 1, 4);
      next.restored = false;
      next.restoreTo = cfg.limitRestoreModel;
      next.restoreAt = now + cfg.limitRestoreAfter * 2 ** next.restoreFails;
      next.restoreBy = next.restoreAt + RESTORE_WINDOW;
    }

    return { action: 'switch-model', model: target, reason: 'model-limit', state: next };
  }

  // Account-wide window, or a label we do not recognise. Only the clock helps.
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
