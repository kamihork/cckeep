# Contributing

Thanks for helping keep sessions connected. Two areas benefit most from outside contributions.

## 1. Indicator strings (`src/detect.js`)

Detection reads Claude Code's own UI text. That text is not a published API — it changes between versions, and it renders differently in narrow panes, screen-reader mode, and non-English locales. If cckeep misreads a state on your setup, that is the most valuable bug you can report:

- paste the relevant lines from `tmux capture-pane -p` (redact your conversation — only the footer and any notification line matter)
- say which Claude Code version (`claude --version`) and terminal you are on
- add a test in `test/detect.test.js` with that screen text, asserting the verdict you expect

## 2. Safety rules (`src/detect.js`, `src/run.js`)

Every rule exists to stop the tool typing into a terminal at the wrong moment. If you can construct a screen where cckeep would act and should not, that is a bug even if it has never happened to you.

The bar for changes here:

- **A false send is far worse than a missed reconnect.** Missing a dead session costs a walk to your desk. Typing into a live one can approve a permission prompt or inject text into a conversation. When a rule is ambiguous, it must resolve to "do nothing".
- **New guards need both tests**: one screen that must trigger the guard, and one that must not.
- **`decide()` stays pure.** Screen text and prior state in, verdict out — no tmux, no clock, no disk. All I/O lives in `src/run.js`. This is what makes the safety rules testable.

## Testing by hand

`npm test` fakes tmux, so it never touches a running server. If you test against
a real one, give it its own socket:

```sh
tmux -L cckeep-test new-session -d -s probe
CCKEEP_HOME=$(mktemp -d) CCKEEP_TMUX_SOCKET=cckeep-test node bin/cckeep.js status
tmux -L cckeep-test kill-session -t "=probe"   # by name; never kill-server
```

`CCKEEP_TMUX_SOCKET` points cckeep at that throwaway server, so nothing it does
can reach the sessions you are working in.

Never run `tmux kill-server` at all, with or without `-L`. It takes down
**every** session on that server, and a mistyped or unset socket makes "that
server" the default one — including the Claude Code session you were in the
middle of. Kill sessions you created, by exact name. Ask how we know.

## Ground rules

- Node ≥18, standard library only — a runtime dependency needs a very good reason
- `npm test` must pass, and the suite must keep running with no tmux and no network
- Nothing may leave the machine. There is no network code in this package and there should never be
- Pane text is your users' source code and conversations: match it, count it, and drop it — never log it

## Scope

cckeep re-arms a connection Claude Code gave up on. It is not a session manager, not a tmux framework, and not an orchestrator. If [anthropics/claude-code#34255](https://github.com/anthropics/claude-code/issues/34255) is fixed upstream, the right move is to archive this, not to grow it.

## Releasing (maintainers)

```sh
npm test
npm version <patch|minor|major>
npm publish
git push --follow-tags
```
