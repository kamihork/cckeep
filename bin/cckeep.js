#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { runPass } from '../src/run.js';
import { loadConfig, configPath } from '../src/config.js';
import { logPath, statePath, homeDir, claimNudge } from '../src/state.js';
import * as tmux from '../src/tmux.js';
import * as scheduler from '../src/scheduler.js';
import { pickLang, strings } from '../src/i18n.js';
import { resolveCommand, isKnownCommand } from '../src/commands.js';
import { parsePsTable, isTargetPane } from '../src/procs.js';

const HELP = `cckeep — keep Claude Code Remote Control from silently going dead

USAGE
  cckeep [command] [options]

COMMANDS
  status          what cckeep sees right now (default)
  watch           run in the foreground, one pass every --interval seconds
  once            a single pass — what the scheduler runs
  enable          start checking in the background (launchd / systemd user timer)
  disable         stop checking
  doctor          check tmux, Claude Code panes, and the scheduler
  logs            show recent actions

  "npm install -g cckeep" only puts this CLI on your PATH. "cckeep enable" is
  what registers the background job. (install / uninstall still work as aliases.)

OPTIONS
  --interval <s>  seconds between passes (default 15)
  --dry-run       report what would be sent, send nothing
  --json          machine-readable output
  --lang en|ja    output language (default: from LANG)
  -h, --help      this text
  -v, --version   print version

Remote Control retries 5 times over ~31 seconds and then gives up for good.
cckeep watches tmux panes running Claude Code and types /remote-control
into the ones that went dead — never into one that is busy or showing a dialog.

Usage-limit recovery is a separate, opt-in job: set "limits": true in
~/.cckeep/config.json and cckeep also moves a pane to another model when that
model's weekly window runs out, and picks the work back up once an
account-wide window refills. Off by default, because it types prompts.
`;

function parseArgs(argv) {
  const opts = { command: null, dryRun: false, json: false, lang: null, interval: null, error: null };
  const fail = (msg) => {
    if (!opts.error) opts.error = msg;
  };
  // Unknown flags used to be skipped in silence, so `--dry-runn` performed real
  // sends into live panes. The one flag that prevents sending must never fail
  // open on a typo.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--lang') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) fail('--lang needs a value: en or ja');
      else if (v !== 'en' && v !== 'ja') fail(`--lang must be en or ja, not "${v}"`);
      else opts.lang = v;
    } else if (a === '--interval') {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || v.startsWith('-')) fail('--interval needs a value in seconds');
      else if (!Number.isInteger(n) || n < 1) fail(`--interval must be a whole number of seconds, not "${v}"`);
      else opts.interval = n;
    } else if (a === '-h' || a === '--help') opts.command = 'help';
    else if (a === '-v' || a === '--version') opts.command = 'version';
    else if (a.startsWith('-')) fail(`Unknown option: ${a}`);
    else if (!opts.command) opts.command = a;
    else fail(`Unexpected argument: ${a}`);
  }
  return opts;
}

/**
 * Display width, not character count: CJK labels occupy two columns each, so
 * padEnd (which counts UTF-16 units) misaligns them.
 */
function displayWidth(text) {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function version() {
  const p = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(p, 'utf8')).version;
}

const REASON_KEY = {
  connected: 'connected',
  retrying: 'retrying',
  waiting: 'waiting',
  'never-connected': 'neverConnected',
  dialog: 'dialog',
  cooldown: 'cooldown',
  busy: 'busy',
  'composer-busy': 'composerBusy',
  unavailable: 'unavailable',
  'gave-up': 'gaveUp',
  recovered: 'recovered',
  'limit-wait': 'limitWait',
  'limit-gave-up': 'limitGaveUp',
  'no-prompt': 'noPrompt',
};

function describe(result, t) {
  if (result.action === 'rearm') return `${t.rearmed} (${result.reason})`;
  if (result.action === 'confirm-panel') return t.confirmed;
  if (result.action === 'would-rearm') return `${t.wouldRearm} (${result.reason})`;
  if (result.action === 'would-confirm-panel') return t.wouldConfirm;
  if (result.action === 'switch-model') return t.switched(result.model);
  if (result.action === 'restore-model') return t.restored(result.model);
  if (result.action === 'resume') return t.resumed;
  if (result.action === 'would-switch-model') return t.wouldSwitch(result.model);
  if (result.action === 'would-restore-model') return t.wouldRestore(result.model);
  if (result.action === 'would-resume') return t.wouldResume;
  return t[REASON_KEY[result.reason]] ?? result.reason;
}

function render(out, t, opts) {
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (out.error === 'no-tmux') return console.log(t.noTmux);
  if (out.error === 'no-server') return console.log(t.noServer);
  if (!out.results.length) {
    console.log(t.noPanes);
    console.log(t.hintOutside);
    return;
  }
  // Session names carry a path hash, so they easily outrun a fixed column.
  const width = Math.max(...out.results.map((r) => displayWidth(r.pane))) + 2;
  for (const r of out.results) {
    console.log(`${r.pane}${' '.repeat(Math.max(1, width - displayWidth(r.pane)))}${describe(r, t)}`);
  }
}

/**
 * Printed once, the first time the user runs cckeep after it has actually
 * helped. Never from the scheduled run — its stdout goes to the log file — and
 * never into a pipe, which is why this is gated on an attached terminal.
 */
function maybeNudge(t, opts) {
  if (opts.json || !process.stdout.isTTY) return;
  if (claimNudge()) console.log(t.nudge);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lang = pickLang(opts.lang);
  const t = strings(lang);

  if (opts.command === 'help') return console.log(HELP);
  if (opts.command === 'version') return console.log(version());

  if (opts.error) {
    console.error(opts.error);
    console.error('Run `cckeep --help` for the full list.');
    process.exit(2);
  }

  if (opts.command !== null && !isKnownCommand(opts.command)) {
    console.error(`Unknown command: ${opts.command}\n`);
    console.log(HELP);
    process.exit(1);
  }

  let config;
  try {
    config = loadConfig(opts.interval ? { interval: opts.interval } : {});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // The socket and binary can only come from the config file, so hand them to
  // the tmux layer before anything queries it.
  tmux.configureTmux({ socket: config.tmuxSocket, binary: config.tmuxBinary });

  switch (resolveCommand(opts.command)) {
    case 'status': {
      const out = await runPass({ config, dryRun: true });
      render(out, t, opts);
      maybeNudge(t, opts);
      break;
    }
    case 'once': {
      const out = await runPass({ config, dryRun: opts.dryRun });
      render(out, t, opts);
      maybeNudge(t, opts);
      break;
    }
    case 'watch': {
      if (!opts.json) console.log(t.watching(config.interval));
      for (;;) {
        const out = await runPass({ config, dryRun: opts.dryRun });
        for (const r of out.results) {
          if (r.action !== 'none') console.log(`${new Date().toISOString().slice(11, 19)}  ${r.pane}  ${describe(r, t)}`);
        }
        await new Promise((r) => setTimeout(r, config.interval * 1000));
      }
    }
    case 'enable': {
      const res = scheduler.install({ interval: config.interval });
      if (res.kind === 'ephemeral') {
        console.error(t.ephemeral(res.path));
        process.exit(1);
      }
      if (res.kind === 'unsupported') {
        console.log(t.unsupported);
        process.exit(1);
      }
      console.log(res.ok ? t.enabled(res.kind, res.path) : t.enableFailed(res.kind));
      if (!res.ok) process.exit(1);
      break;
    }
    case 'disable': {
      const res = scheduler.uninstall();
      if (res.kind === 'unsupported') return console.log(t.unsupported);
      console.log(t.disabled(res.kind));
      break;
    }
    case 'doctor': {
      const bin = tmux.tmuxPath();
      const hasServer = Boolean(bin) && tmux.hasServer();
      const panes = hasServer ? tmux.listPanes() ?? [] : [];
      const procs = parsePsTable(tmux.processTable());
      const claudePanes = panes.filter((p) => isTargetPane(p, procs, config.paneCommand));
      const cli = scheduler.scheduledCli();

      // `key` is stable and English so --json stays machine-readable; `label`
      // and the yes/no words are for humans only.
      const rows = [
        { key: 'platform', label: 'platform', value: platform() },
        { key: 'node', label: 'node', value: process.version },
        { key: 'tmux', label: 'tmux', value: bin || null },
        { key: 'tmuxServer', label: 'tmux server', value: hasServer },
        { key: 'tmuxSocket', label: 'tmux socket', value: config.tmuxSocket || null },
        { key: 'claudePanes', label: 'claude panes', value: claudePanes.length },
        // A plain string, not a boolean: the boolean renderer prints "missing"
        // for false, which reads as breakage rather than as a setting left off.
        { key: 'limitRecovery', label: 'limit recovery', value: config.limits ? 'on' : 'off' },
        { key: 'scheduler', label: 'scheduler', value: scheduler.isInstalled() },
        { key: 'scheduledCommand', label: t.scheduledPath, value: cli },
        { key: 'scheduledCommandExists', label: null, value: cli ? existsSync(cli) : null },
        { key: 'home', label: 'home', value: homeDir() },
        { key: 'config', label: 'config', value: existsSync(configPath()) ? configPath() : null },
        { key: 'state', label: 'state', value: statePath() },
        { key: 'log', label: 'log', value: logPath() },
      ];

      if (opts.json) {
        console.log(JSON.stringify(Object.fromEntries(rows.map((r) => [r.key, r.value])), null, 2));
      } else {
        const width = Math.max(...rows.filter((r) => r.label).map((r) => displayWidth(r.label))) + 2;
        for (const r of rows) {
          if (!r.label) continue;
          let shown;
          if (typeof r.value === 'boolean') shown = r.value ? t.doctorOk : t.doctorFail;
          else if (r.value === null) shown = r.key === 'config' ? `${configPath()} (defaults)` : '—';
          else shown = String(r.value);
          if (r.key === 'scheduledCommand' && cli && !existsSync(cli)) shown = `${cli}  ${t.scheduledMissing}`;
          // padEnd counts UTF-16 units, so a double-width Japanese label needs
          // its own measure to line up.
          const pad = ' '.repeat(Math.max(1, width - displayWidth(r.label)));
          console.log(`${r.label}${pad}${shown}`);
        }
      }
      maybeNudge(t, opts);
      if (!bin) process.exitCode = 1;
      break;
    }
    case 'logs': {
      const p = logPath();
      if (!existsSync(p)) return console.log(t.noLog);
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      console.log(lines.slice(-40).join('\n'));
      maybeNudge(t, opts);
      break;
    }
    default:
      console.error(`Unknown command: ${opts.command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
