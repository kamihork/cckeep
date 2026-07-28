// The decision core. Deliberately pure: it takes what is on screen plus what we
// remembered about a pane, and returns what to do. No tmux, no clock, no disk —
// so every rule below is directly testable, which matters a lot for a tool whose
// failure mode is typing into someone's terminal at the wrong moment.

/** Indicators Claude Code paints in the footer for the Remote Control link. */
const CONNECTED = '/rc active';
const RETRYING = '/rc reconnecting';
const FAILED = /Remote Control disconnected|Remote Control failed|\/rc failed/;

/** The /remote-control status panel — its first entry is "Disconnect this session". */
const PANEL = /Disconnect this session|(?:Show|Hide) QR code/;

/**
 * Anything that turns Enter or a slash command into a selection: permission
 * prompts, pickers, confirmations. Typing into one of these picks an option.
 */
const MODAL = /(?:❯|›)\s*(?:\d+\.|Yes|No)|Do you want|\(y\/n\)/;

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
export function readScreen(screen) {
  return {
    connected: screen.includes(CONNECTED),
    retrying: screen.includes(RETRYING),
    failed: FAILED.test(screen),
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
