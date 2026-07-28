<div align="center">
  <img src="https://raw.githubusercontent.com/kamihork/agenttether/main/assets/logo.png" width="140" height="140" alt="agenttether logo — a tether line holding a session in place">

  <h1>agenttether</h1>

  <p><strong>Keeps Claude Code Remote Control from silently going dead.</strong><br>
  Remote Control retries for about 31 seconds and then gives up for good.<br>
  <code>agenttether</code> notices, and re-arms the session — without touching one that's busy.</p>

  <p>
    <a href="https://www.npmjs.com/package/agenttether"><img src="https://img.shields.io/npm/v/agenttether?color=1f9d8f&label=npm" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/agenttether"><img src="https://img.shields.io/npm/dt/agenttether?color=3987e5" alt="npm downloads"></a>
    <a href="https://github.com/kamihork/agenttether/actions/workflows/test.yml"><img src="https://github.com/kamihork/agenttether/actions/workflows/test.yml/badge.svg" alt="test status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/kamihork/agenttether?color=199e70" alt="license"></a>
  </p>

  <p><a href="https://kamihork.github.io/agenttether/">Website</a> | English | <a href="README.ja.md">日本語</a></p>
</div>

## The problem

[Remote Control](https://code.claude.com/docs/en/remote-control) lets you drive a local Claude Code session from your phone or from claude.ai. It reconnects on its own when the link drops — for **5 attempts with 1/2/4/8/16-second backoff**. That is a **31-second** budget. Close your laptop lid, switch Wi-Fi, ride an elevator, and the budget is gone. The connection closes and never comes back.

There is a second failure too: the session wedges in `/rc reconnecting` and sits there forever. That one is [anthropics/claude-code#34255](https://github.com/anthropics/claude-code/issues/34255) — open since March 2026, 99 👍, no fix.

Either way you find out the same way: you reach for your phone, and the session is gone. The documented recovery is to walk back to your desk and type `/remote-control`.

## Quick start

```sh
npx agenttether install
```

That registers a background job — launchd on macOS, a systemd user timer on Linux — that checks every 15 seconds and re-arms whatever went dead.

One requirement: **Claude Code has to be running inside tmux.** A session started in a bare terminal cannot be reached from another process, so there is nothing any tool can do for it. See [Running Claude Code in tmux](#running-claude-code-in-tmux).

```sh
npx agenttether            # what it sees right now — changes nothing
npx agenttether doctor     # check tmux, panes, and the scheduler
```

> If agenttether saved you a walk back to your desk, a ⭐ helps other Remote Control users find it.

## It will not type into a session that is working

This is the whole design problem. A watchdog that types into your terminal on a timer is a liability unless it is certain the moment is safe. Every one of these is enforced, and [tested](test/):

- **Never during a turn.** The pane is captured twice, two seconds apart. A running turn animates a spinner and a token counter, so identical captures mean nothing is happening. Different ones mean hands off.
- **Never into a dialog.** Permission prompts and pickers turn Enter into a selection. If a selection marker is on screen, the pass is skipped.
- **Never into the panel you opened.** `/remote-control` opens a status panel with a QR code. agenttether only presses Enter there when it opened the panel itself.
- **Never a session you turned off.** Only panes seen connected at least once are ever chased. Disable Remote Control deliberately and it stays off.
- **Never in a tight loop.** One action per pane per 5 minutes.
- **Re-checked at the last moment.** The decision is made from one capture, then re-verified after the idle wait — if the pane reconnected or opened a dialog in between, nothing is sent.

`--dry-run` prints what it would do and sends nothing.

## What it watches for

| State on screen | What it means | What agenttether does |
|---|---|---|
| `/rc active` | connected | remembers the pane, nothing else |
| `/rc reconnecting` | inside the 31-second budget | waits — this usually resolves |
| `/rc reconnecting`, 2 minutes on | wedged ([#34255](https://github.com/anthropics/claude-code/issues/34255)) | cycles the bridge: opens the panel, disconnects, reconnects |
| `Remote Control disconnected` | gave up | re-arms immediately |
| no indicator, on a pane that had one | notification scrolled away | re-arms after 4 quiet checks |
| no indicator, on a pane that never had one | not your setup | nothing, ever |

## Commands

```
agenttether                 # status: one line per Claude Code pane
agenttether watch           # run in the foreground instead of scheduling
agenttether once            # a single pass — what the scheduler runs
agenttether install         # register the background job
agenttether uninstall       # remove it
agenttether doctor          # tmux, panes, scheduler, paths
agenttether logs            # what it has done
```

Options: `--dry-run`, `--json`, `--interval <s>`, `--lang en|ja` (auto-detected from `LANG`).

## Running Claude Code in tmux

agenttether reads and types into tmux panes. That is the only channel a separate process has into a live Claude Code session — and it is why the session must be started inside tmux. Restarting the process is not an alternative: it would end the conversation, which is exactly what you are trying to save.

The smallest change is a shell function that wraps interactive launches only, so `claude update`, `claude doctor` and `claude -p` still behave normally:

```sh
cc() {
  local a
  for a in "$@"; do
    case "$a" in
      -p|--print|-v|--version|-h|--help|--bg|--background|--output-format) command claude "$@"; return ;;
      agents|auth|doctor|install|mcp|plugin|project|setup-token|update|upgrade|remote-control|rc|config)
        command claude "$@"; return ;;
      -*) ;;
      *) break ;;
    esac
  done
  local session="claude-$(basename "$PWD")-$(printf '%s' "$PWD" | cksum | cut -d' ' -f1)"
  if [ -n "$TMUX" ]; then command claude "$@"
  elif tmux has-session -t "=$session" 2>/dev/null; then tmux attach-session -t "=$session"
  else tmux new-session -s "$session" -c "$PWD" claude "$@"
  fi
}
```

Claude Code also needs two lines in `~/.tmux.conf`, or Shift+Enter and desktop notifications break inside tmux ([official guidance](https://code.claude.com/docs/en/terminal-config#configure-tmux)):

```sh
set -g allow-passthrough on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

Ctrl+B needs no fix: Claude Code detects tmux and rebinds its own shortcut to `Ctrl+B Ctrl+B`.

## Configuration

Defaults are tuned so you never notice it. Override in `~/.agenttether/config.json`, by environment variable, or per-run flag — later wins. A malformed config is a hard error rather than a silent half-load.

```json
{
  "interval": 15,
  "cooldown": 300,
  "stuckLimit": 8,
  "missLimit": 4,
  "settle": 2000,
  "paneCommand": "claude"
}
```

- `interval` — seconds between passes (also what `install` schedules)
- `cooldown` — seconds before the same pane may be acted on again
- `stuckLimit` — checks in `reconnecting` before the bridge is treated as wedged
- `missLimit` — checks with no indicator before re-arming a pane that had one
- `settle` — milliseconds between the two captures of the idle check; raise it on a slow machine
- `paneCommand` — foreground process name that marks a pane as Claude Code

Every key has an env twin: `AGENTTETHER_INTERVAL`, `AGENTTETHER_COOLDOWN`, `AGENTTETHER_STUCK_LIMIT`, `AGENTTETHER_MISS_LIMIT`, `AGENTTETHER_SETTLE`, `AGENTTETHER_PANE_COMMAND`. `AGENTTETHER_HOME` moves state, config and log off `~/.agenttether`.

## Scope

agenttether re-arms the connection. It does **not** raise Claude Code's retry budget — that is a constant inside a closed-source binary, and only Anthropic can change it. If [#34255](https://github.com/anthropics/claude-code/issues/34255) is fixed, this tool becomes unnecessary, which is the right outcome. Until then, a 👍 there is worth more than a star here.

Out of reach by design:

- **Sessions outside tmux** — no channel to type into
- **The VS Code extension** — not a terminal TUI; tmux cannot wrap it
- **Server mode** (`claude remote-control`) — that one is a process you own, so supervise it with launchd/systemd directly, or a `while true` loop
- **Outages past ~10 minutes** — Claude Code exits the session itself; there is nothing left to re-arm

## Privacy

agenttether reads the visible text of your tmux panes to decide whether a pane is connected. That text is your conversation. Therefore:

- everything stays on your machine; there is no network code in this package
- no telemetry, no account, no phone-home
- pane text is matched against a handful of indicator strings and thrown away — only pane labels and verdicts reach the log
- the log lives at `~/.agenttether/agenttether.log`; `agenttether logs` prints it

## How it works

Claude Code paints a Remote Control indicator in its footer: `/rc active` when connected, `/rc reconnecting` while retrying, and a `Remote Control disconnected` notification when it gives up. agenttether asks tmux for every pane whose foreground process is `claude`, reads those indicators out of `tmux capture-pane`, and keeps a small per-pane counter in `~/.agenttether/state.json`.

The decision layer (`src/detect.js`) is a pure function of screen text plus prior state, which is why the safety rules can be tested exhaustively without a terminal. The runner (`src/run.js`) does the I/O: the idle check, the last-moment re-check, and the keystrokes.

None of this is a published API — the indicator strings are UI text and can change. When they do, agenttether stops acting rather than acting wrongly: a pane it cannot read looks "never connected", and panes it has never seen connected are never touched.

## Development

```sh
git clone https://github.com/kamihork/agenttether.git && cd agenttether
npm test                       # 36 tests, no network, no tmux required
node bin/agenttether.js doctor
```

The test suite fakes tmux, so it runs anywhere. Contributions welcome — especially indicator strings from Claude Code versions or terminals where detection misses. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © [kamihork](https://github.com/kamihork)
