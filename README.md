<div align="center">
  <img src="https://raw.githubusercontent.com/kamihork/cckeep/main/assets/logo.png" width="140" height="140" alt="cckeep logo — a link held open between two ends">

  <h1>cckeep</h1>

  <p><strong>Keeps Claude Code Remote Control from silently going dead.</strong><br>
  Remote Control retries for about 31 seconds and then gives up for good.<br>
  <code>cckeep</code> notices, and re-arms the session — without touching one that's busy.</p>

  <p>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/v/cckeep?color=1f9d8f&label=npm" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/cckeep"><img src="https://img.shields.io/npm/dt/cckeep?color=3987e5" alt="npm downloads"></a>
    <a href="https://github.com/kamihork/cckeep/actions/workflows/test.yml"><img src="https://github.com/kamihork/cckeep/actions/workflows/test.yml/badge.svg" alt="test status"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/kamihork/cckeep?color=199e70" alt="license"></a>
  </p>

  <p><a href="https://kamihork.github.io/cckeep/">Website</a> | English | <a href="README.ja.md">日本語</a></p>
</div>

## The problem

[Remote Control](https://code.claude.com/docs/en/remote-control) lets you drive a local Claude Code session from your phone or from claude.ai. It reconnects on its own when the link drops — for **5 attempts with 1/2/4/8/16-second backoff**. That is a **31-second** budget. Close your laptop lid, switch Wi-Fi, ride an elevator, and the budget is gone. The connection closes and never comes back.

There is a second failure too: the session wedges in `/rc reconnecting` and sits there forever. That one is [anthropics/claude-code#34255](https://github.com/anthropics/claude-code/issues/34255) — open since March 2026, 99 👍, no fix.

Either way you find out the same way: you reach for your phone, and the session is gone. The documented recovery is to walk back to your desk and type `/remote-control`.

## Quick start

```sh
npm install -g cckeep
cckeep enable
```

`npm install` only puts the CLI on your `PATH`; `cckeep enable` is the step that registers a background job — launchd on macOS, a systemd user timer on Linux — that checks every 15 seconds and re-arms whatever went dead.

Install it globally rather than running `npx cckeep enable`. The scheduled job runs cckeep from wherever it was installed, and npx's cache is throwaway: a job pointing into it keeps working until the cache is cleared and then stops, silently — the one failure a watchdog must not have. `cckeep enable` refuses to schedule from an npx path for that reason.

To look before installing anything, `npx` is fine — neither of these changes a thing:

```sh
npx cckeep            # what it sees right now
npx cckeep doctor     # check tmux, panes, and the scheduler
```

**`command not found: cckeep` right after installing?** You are on a shim-based
version manager. `nodenv` and `rbenv`-style setups need a rehash before a newly
installed binary appears on `PATH`, and `nvm` needs a new shell:

```sh
nodenv rehash     # nodenv
asdf reshim nodejs # asdf
# nvm: just open a new shell
```

One requirement: **Claude Code has to be running inside tmux.** A session started in a bare terminal cannot be reached from another process, so there is nothing any tool can do for it. See [Running Claude Code in tmux](#running-claude-code-in-tmux).

> If cckeep saved you a walk back to your desk, a ⭐ helps other Remote Control users find it.

## It will not type into a session that is working

This is the whole design problem. A watchdog that types into your terminal on a timer is a liability unless it is certain the moment is safe. Every one of these is enforced, and [tested](test/):

- **Never during a turn.** The pane is captured twice, two seconds apart. A running turn animates a spinner and a token counter, so identical captures mean nothing is happening. Different ones mean hands off.
- **Never into a dialog.** Permission prompts and pickers turn Enter into a selection. If a selection marker is on screen, the pass is skipped.
- **Never into the panel you opened.** `/remote-control` opens a status panel with a QR code. cckeep only presses Enter there when it opened the panel itself.
- **Never a session you turned off.** Only panes seen connected at least once are ever chased. Disable Remote Control deliberately and it stays off.
- **Never in a tight loop.** One action per pane per 5 minutes.
- **Re-checked at the last moment.** The decision is made from one capture, then re-verified after the idle wait — if the pane reconnected or opened a dialog in between, nothing is sent.

`--dry-run` prints what it would do and sends nothing.

## What it watches for

| State on screen | What it means | What cckeep does |
|---|---|---|
| `/rc active`, or a truncated `/rc` | connected | remembers the pane, nothing else |
| `/rc reconnecting` | inside the 31-second budget | waits — this usually resolves |
| `/rc reconnecting`, 2 minutes on | wedged ([#34255](https://github.com/anthropics/claude-code/issues/34255)) | cycles the bridge: opens the panel, disconnects, reconnects |
| `Remote Control disconnected` | gave up | re-arms immediately |
| no indicator, on a pane that had one | notification scrolled away | re-arms after 4 quiet checks |
| no indicator, on a pane that never had one | not your setup | nothing, ever |

## Commands

```
cckeep                 # status: one line per Claude Code pane
cckeep watch           # run in the foreground instead of scheduling
cckeep once            # a single pass — what the scheduler runs
cckeep enable          # start checking in the background
cckeep disable         # stop checking
cckeep doctor          # tmux, panes, scheduler, paths
cckeep logs            # what it has done
```

Options: `--dry-run`, `--json`, `--interval <s>`, `--lang en|ja` (auto-detected from `LANG`).

`install` and `uninstall` still work as aliases for `enable` and `disable`.

## Running Claude Code in tmux

cckeep reads and types into tmux panes. That is the only channel a separate process has into a live Claude Code session — and it is why the session must be started inside tmux. Restarting the process is not an alternative: it would end the conversation, which is exactly what you are trying to save.

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
  if [ -n "$TMUX" ]; then command claude "$@"; return; fi
  if ! tmux has-session -t "=$session" 2>/dev/null; then
    tmux new-session -s "$session" -c "$PWD" claude "$@"; return
  fi

  # The tmux session outlives the claude process inside it, so attaching can
  # drop you at a bare shell with the conversation gone. Bring it back.
  local pane_cmd cmd
  pane_cmd=$(tmux list-panes -t "=$session:" -F '#{pane_current_command}' 2>/dev/null | head -1)
  case "$pane_cmd" in
    zsh|bash|sh|fish)
      cmd="claude"
      case " $* " in
        *" -c "*|*" --continue "*|*" -r "*|*" --resume "*|*" --session-id "*) ;;
        *) cmd="$cmd --continue" ;;
      esac
      [ $# -gt 0 ] && cmd="$cmd $*"
      tmux send-keys -t "=$session:" "$cmd" C-m ;;
  esac
  tmux attach-session -t "=$session"
}
```

`cc -c` and `cc --continue` work as you'd expect — the flag is passed straight
through to Claude Code. The block above covers the case the flag can't: a tmux
session whose Claude Code process has already exited.

Claude Code also needs two lines in `~/.tmux.conf`, or Shift+Enter and desktop notifications break inside tmux ([official guidance](https://code.claude.com/docs/en/terminal-config#configure-tmux)):

```sh
set -g allow-passthrough on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

Ctrl+B needs no fix: Claude Code detects tmux and rebinds its own shortcut to `Ctrl+B Ctrl+B`.

## Configuration

Defaults are tuned so you never notice it. Override in `~/.cckeep/config.json`, by environment variable, or per-run flag — later wins. A malformed config is a hard error rather than a silent half-load.

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

- `interval` — seconds between passes (also what `enable` schedules)
- `cooldown` — seconds before the same pane may be acted on again
- `stuckLimit` — checks in `reconnecting` before the bridge is treated as wedged
- `missLimit` — checks with no indicator before re-arming a pane that had one
- `settle` — milliseconds between the two captures of the idle check; raise it on a slow machine
- `paneCommand` — foreground process name that marks a pane as Claude Code
- `tmuxSocket` — socket name or path, if your tmux runs on something other than the default server (`tmux -L name` / `-S path`). Empty means the default

Every key has an env twin: `CCKEEP_INTERVAL`, `CCKEEP_COOLDOWN`, `CCKEEP_STUCK_LIMIT`, `CCKEEP_MISS_LIMIT`, `CCKEEP_SETTLE`, `CCKEEP_PANE_COMMAND`, `CCKEEP_TMUX_SOCKET`. `CCKEEP_HOME` moves state, config and log off `~/.cckeep`.

## Scope

cckeep re-arms the connection. It does **not** raise Claude Code's retry budget — that is a constant inside a closed-source binary, and only Anthropic can change it. If [#34255](https://github.com/anthropics/claude-code/issues/34255) is fixed, this tool becomes unnecessary, which is the right outcome. Until then, a 👍 there is worth more than a star here.

Out of reach by design:

- **Sessions outside tmux** — no channel to type into
- **The VS Code extension** — not a terminal TUI; tmux cannot wrap it
- **Server mode** (`claude remote-control`) — that one is a process you own, so supervise it with launchd/systemd directly, or a `while true` loop
- **Outages past ~10 minutes** — Claude Code exits the session itself; there is nothing left to re-arm

## Privacy

cckeep reads the visible text of your tmux panes to decide whether a pane is connected. That text is your conversation. Therefore:

- everything stays on your machine; there is no network code in this package
- no telemetry, no account, no phone-home
- pane text is matched against a handful of indicator strings and thrown away — only pane labels and verdicts reach the log
- the log lives at `~/.cckeep/cckeep.log`; `cckeep logs` prints it

## How it works

Claude Code paints a Remote Control indicator in its footer: `/rc active` when connected, `/rc reconnecting` while retrying, and a `Remote Control disconnected` notification when it gives up. cckeep finds the panes running Claude Code, reads those indicators out of `tmux capture-pane`, and keeps a small per-pane counter in `~/.cckeep/state.json`.

Finding those panes takes one extra step: Claude Code rewrites its own process title, so tmux reports such a pane as `2.1.220` rather than `claude`. Matching the name tmux reports therefore finds nothing on a real machine. cckeep checks the process table as well, and treats a pane as Claude Code's when the pane's process — or anything it spawned — is actually `claude`.

The indicator is right-aligned, so a custom status line or a narrow pane squeezes it down to a bare `/rc` with the word cut off. cckeep treats that as connected: the indicator only renders while a link exists, and reading it as connected merely records the pane and waits.

Where it looks matters as much as what it looks for. The state indicators are read from the last dozen lines only, because the words themselves turn up in ordinary conversation — a session where you happen to discuss `/rc active` would otherwise read as connected. Dialog and status-panel detection deliberately scans the whole pane instead: a false positive there costs one skipped pass, while a miss costs a keystroke in the wrong place.

The decision layer (`src/detect.js`) is a pure function of screen text plus prior state, which is why the safety rules can be tested exhaustively without a terminal. The runner (`src/run.js`) does the I/O: the idle check, the last-moment re-check, and the keystrokes.

None of this is a published API — the indicator strings are UI text and can change. When they do, cckeep stops acting rather than acting wrongly: a pane it cannot read looks "never connected", and panes it has never seen connected are never touched.

## Development

```sh
git clone https://github.com/kamihork/cckeep.git && cd cckeep
npm test                       # 36 tests, no network, no tmux required
node bin/cckeep.js doctor
```

The test suite fakes tmux, so it runs anywhere. Contributions welcome — especially indicator strings from Claude Code versions or terminals where detection misses. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © [kamihork](https://github.com/kamihork)
