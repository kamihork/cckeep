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

/** The /remote-control status panel. */
const PANEL = /Disconnect this session|(?:Show|Hide) QR code/;

/**
 * Read the status panel's selectable items and where the focus marker sits.
 *
 * Pressing Enter selects whatever is focused, and the default focus is
 * "Continue" — not "Disconnect this session". Blindly pressing Enter therefore
 * closes the panel and fixes nothing, which is exactly what the wedged-bridge
 * recovery used to do. (Found live: the panel lists Disconnect / Show QR code /
 * ❯ Continue.) Navigation has to be computed from what is actually focused,
 * and verified again after every keystroke.
 *
 * Returns { focused, disconnect } as item indices, or null when the panel is
 * not on screen in a recognisable shape.
 */
export function readPanel(screen) {
  const lines = String(screen).split('\n');
  const items = [];
  for (const line of lines) {
    const m = line.match(/^\s*(❯)?\s*(Disconnect this session|(?:Show|Hide) QR code|Continue)\b/);
    if (m) items.push({ name: m[2], focused: Boolean(m[1]) });
  }
  const disconnect = items.findIndex((i) => i.name === 'Disconnect this session');
  const focused = items.findIndex((i) => i.focused);
  if (disconnect === -1 || focused === -1) return null;
  return { focused, disconnect, count: items.length };
}

/**
 * Anything that turns Enter into a selection: permission prompts, pickers,
 * confirmations. Typing into one of these picks an option.
 *
 * Split in two on purpose. A selection marker followed by an option is close to
 * unambiguous, so it counts anywhere on screen. The bare English phrases are
 * things Claude Code also writes in ordinary replies ("Do you want me to run
 * the tests as well?"), and such a sentence sitting in the transcript forever
 * would hold the pane off forever — so those only count near the composer,
 * where a real dialog renders.
 */
const MODAL_MARKER = /(?:^|\s)(?:❯|›|>)\s*(?:\d+\s*[.)]|Yes\b|No\b)/m;
const MODAL_PROMPT = /Do you want|Would you like|Allow\b[^\n]{0,40}\?|\(y\/n\)|\[y\/N\]/i;

/** How far up from the composer a dialog can plausibly render. */
const MODAL_LINES = 20;

/**
 * The composer, and whether anything is typed in it.
 *
 * `send-keys` inserts at the cursor and Enter submits whatever is in the box,
 * so an unsent draft would be submitted with `/remote-control` glued onto it —
 * a text injection into the conversation *and* a failed reconnect. The idle
 * check cannot catch this: a draft sitting in the box is perfectly still.
 */
const COMPOSER = /^(?:│\s*)?(?:❯|>)\s?(.*?)\s*(?:│)?$/;

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
/**
 * 'empty' | 'draft' | 'unknown'. Unknown means we could not find the composer,
 * which is treated like a draft: if we cannot see the box, we do not type.
 */
function readComposer(lines, window = INDICATOR_LINES + 4) {
  for (const line of lines.slice(Math.max(0, lines.length - window)).reverse()) {
    const m = line.match(COMPOSER);
    if (m) return m[1].trim() === '' ? 'empty' : 'draft';
  }
  return 'unknown';
}

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
  const modalWindow = lines.slice(Math.max(0, lines.length - MODAL_LINES)).join('\n');
  const indicator = readIndicator(lines);

  return {
    // Signals that make cckeep act are read from the footer only, so text in
    // the conversation cannot trigger anything.
    connected: indicator === 'active',
    retrying: indicator === 'reconnecting',
    failed: indicator === 'failed' || FAILED_NOTICE.test(footer),

    // Signals that make cckeep hold off. A false positive here costs a skipped
    // pass; missing one costs a keystroke in the wrong place.
    panel: PANEL.test(footer),
    modal: MODAL_MARKER.test(lines.join('\n')) || MODAL_PROMPT.test(modalWindow),

    composer: readComposer(lines),
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
    // Not into a dialog, and not on top of a visible draft. The composer is
    // hidden while the panel is open — it reads as 'unknown' — and demanding
    // 'empty' here silently disabled this whole recovery path. 'draft' means
    // the panel text is stale transcript and the user is mid-sentence below
    // it, which is exactly when Enter must not be pressed.
    if (s.panel && !s.modal && s.composer !== 'draft') {
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

  // Held off before any counter moves. Doing this after the counters were
  // consumed meant a dialog — or a sentence merely worded like one, or panel
  // text cckeep itself had left in the scrollback — reset the progress every
  // pass, so the pane could never mature into a recovery at all.
  if (s.modal || s.panel) {
    return { action: 'none', reason: 'dialog', state: next };
  }

  // Enter submits whatever sits in the composer, so an unsent draft would go
  // out with the command glued to it.
  if (s.composer !== 'empty') {
    return { action: 'none', reason: 'composer-busy', state: next };
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
