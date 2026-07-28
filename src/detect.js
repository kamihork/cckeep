// The decision core. Deliberately pure: it takes what is on screen plus what we
// remembered about a pane, and returns what to do. No tmux, no clock, no disk —
// so every rule below is directly testable, which matters a lot for a tool whose
// failure mode is typing into someone's terminal at the wrong moment.

/**
 * The Remote Control indicator Claude Code right-aligns in its footer.
 *
 * It reads `/rc active`, `/rc reconnecting` or `/rc failed` when there is room
 * — but it is right-aligned on the status line, so a custom statusline or a
 * narrow pane truncates it to a bare `/rc`. Matching the full phrase therefore
 * never fires for anyone with a status line of their own, which is common.
 *
 * Anchored to the end of the line because the indicator is right-aligned. A
 * separator and link may follow it (`/rc active · claude.ai/code`), but prose
 * may not — that is what keeps `/rc` written mid-sentence from matching.
 */
const RC_INDICATOR = /(?:^|\s)\/rc(?:\s+(active|reconnecting|failed))?(?:\s*[\u00b7|].*)?\s*$/;

/** Lines a user types into; they may well contain `/rc` themselves. */
const INPUT_LINE = /^[❯>]/;

/** The notification Claude Code prints when it has given up for good. */
const FAILED_NOTICE = /Remote Control disconnected|Remote Control failed/;

/** The /remote-control status panel — its first entry is "Disconnect this session". */
const PANEL = /Disconnect this session|(?:Show|Hide) QR code/;

/**
 * Anything that turns Enter or a slash command into a selection: permission
 * prompts, pickers, confirmations. Typing into one of these picks an option.
 */
const MODAL = /(?:❯|›)\s*(?:\d+\.|Yes|No)|Do you want|\(y\/n\)/;

/**
 * How many lines from the bottom count as "the footer".
 *
 * The indicators live just below the input box, but the words themselves can
 * appear anywhere in a transcript — a session where you discuss cckeep, or run
 * it, will have "/rc active" sitting in the conversation body. Matching the
 * whole pane made such a session look connected, which then armed the
 * missing-indicator fallback and pointed it at a perfectly healthy session.
 */
const FOOTER_LINES = 12;

/**
 * The indicator sits on the status line, one or two rows from the bottom — a
 * tighter window than the notifications above it, so that `/rc` typed into the
 * input box cannot be mistaken for it.
 */
const INDICATOR_LINES = 4;

export const DEFAULTS = {
  /** Consecutive checks stuck in "reconnecting" before we treat the bridge as wedged. */
  stuckLimit: 8,
  /** Consecutive checks with no indicator at all before re-arming a pane that had one. */
  missLimit: 4,
  /** Seconds before the same pane may be acted on again. */
  cooldown: 300,
};

export function emptyState() {
  return { seen: false, miss: 0, stuck: 0, panelPending: false, lastActionAt: 0 };
}

/**
 * Reduce a captured pane to the handful of signals the rules care about.
 * @param {string} screen raw `tmux capture-pane -p` output
 */
/**
 * Read the indicator out of the last few lines.
 *
 * Returns 'active' | 'reconnecting' | 'failed', or null when no indicator is on
 * screen. A truncated `/rc` counts as 'active': the indicator only renders while
 * a link exists, and reading it as connected merely records the pane and waits,
 * which is the safe direction.
 */
function readIndicator(lines, window = INDICATOR_LINES) {
  for (const line of lines.slice(Math.max(0, lines.length - window))) {
    if (INPUT_LINE.test(line.trim())) continue;
    const m = line.match(RC_INDICATOR);
    if (m) return m[1] ?? 'active';
  }
  return null;
}

export function readScreen(screen, footerLines = FOOTER_LINES) {
  // `capture-pane` returns the whole pane, blank rows included, so a UI that
  // does not fill the pane leaves the bottom padded with empty lines. Scanning
  // the last N lines would then scan nothing but padding and see no indicator
  // at all — a silent failure. Measure the footer from the last row that has
  // something on it.
  const all = String(screen).split('\n');
  let end = all.length;
  while (end > 0 && all[end - 1].trim() === '') end -= 1;
  const lines = all.slice(0, end);

  const footer = lines.slice(Math.max(0, lines.length - footerLines)).join('\n');
  const indicator = readIndicator(lines);

  return {
    // Signals that make cckeep act are read from the footer only, so text in
    // the conversation cannot trigger anything.
    connected: indicator === 'active',
    retrying: indicator === 'reconnecting',
    failed: indicator === 'failed' || FAILED_NOTICE.test(footer),

    // Signals that make cckeep hold off are read from the whole pane. A false
    // positive here costs a skipped pass; missing one costs a keystroke in the
    // wrong place.
    panel: PANEL.test(screen),
    modal: MODAL.test(screen),
  };
}

/**
 * Decide what to do with one pane.
 *
 * Returns `{ action, reason, state }` where action is one of:
 *   'none'          — leave the pane alone
 *   'confirm-panel' — press Enter on the /remote-control panel we opened, which
 *                     selects "Disconnect this session" and tears down the
 *                     wedged bridge so the next pass can build a fresh one
 *   'rearm'         — type /remote-control
 *
 * `rearm` is a recommendation, not a green light: the caller must still confirm
 * the pane is idle (see isIdle in run.js) before typing, because a running turn
 * would swallow the command as a chat message.
 */
export function decide({ screen, state = emptyState(), now = 0, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const s = readScreen(screen);
  const next = { ...state };

  // Step two of the wedged-bridge recovery. We opened the panel on an earlier
  // pass, so "Disconnect this session" should now be focused. Confirm it from
  // the text actually on screen rather than by counting arrow keys — and only
  // when we are the one who opened it, since the user may have opened the same
  // panel to read the QR code.
  if (next.panelPending) {
    next.panelPending = false;
    if (s.panel && !s.modal) {
      next.lastActionAt = 0; // let the next pass re-arm without waiting out the cooldown
      return { action: 'confirm-panel', reason: 'stuck-cycle', state: next };
    }
    // The panel never appeared: the command we sent probably reconnected
    // directly. Fall through and judge the pane on what it shows now.
  }

  if (s.connected) {
    next.seen = true;
    next.miss = 0;
    next.stuck = 0;
    return { action: 'none', reason: 'connected', state: next };
  }

  let dead = null;

  if (s.retrying) {
    // Claude Code's own retry budget is 5 attempts over roughly 31 seconds, and
    // a healthy reconnect resolves well inside that. Sitting in "reconnecting"
    // far past it is the wedge from anthropics/claude-code#34255, which never
    // recovers on its own.
    next.stuck += 1;
    if (next.stuck < cfg.stuckLimit) {
      return { action: 'none', reason: 'retrying', state: next };
    }
    next.stuck = 0;
    dead = 'stuck';
  } else {
    next.stuck = 0;
    if (s.failed) {
      next.miss = 0;
      dead = 'disconnected';
    } else if (!next.seen) {
      // Never seen connected. Could be a session the user runs without Remote
      // Control on purpose — not ours to switch on.
      return { action: 'none', reason: 'never-connected', state: next };
    } else {
      next.miss += 1;
      if (next.miss < cfg.missLimit) {
        return { action: 'none', reason: 'waiting', state: next };
      }
      next.miss = 0;
      dead = 'silent';
    }
  }

  if (s.modal || s.panel) {
    return { action: 'none', reason: 'dialog', state: next };
  }

  if (state.lastActionAt && now - state.lastActionAt < cfg.cooldown) {
    return { action: 'none', reason: 'cooldown', state: next };
  }

  next.lastActionAt = now;
  if (dead === 'stuck') {
    // A wedged bridge still believes it is connecting, so /remote-control opens
    // the status panel instead of retrying. Remember that, and finish the cycle
    // next pass once the panel is visible.
    next.panelPending = true;
  }
  return { action: 'rearm', reason: dead, state: next };
}
