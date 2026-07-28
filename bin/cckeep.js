#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { runPass } from '../src/run.js';
import { loadConfig, configPath } from '../src/config.js';
import { logPath, statePath, homeDir } from '../src/state.js';
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
  recovered: 'recovered',
};

function describe(result, t) {
  if (result.action === 'rearm') return `${t.rearmed} (${result.reason})`;
  if (result.action === 'confirm-panel') return t.confirmed;
  if (result.action === 'would-rearm') return `${t.wouldRearm} (${result.reason})`;
  if (result.action === 'would-confirm-panel') return t.wouldConfirm;
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
  const width = Math.max(...out.results.map((r) => r.pane.length)) + 2;
  for (const r of out.results) {
    console.log(`${r.pane.padEnd(width)}${describe(r, t)}`);
  }
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
      break;
    }
    case 'once': {
      const out = await runPass({ config, dryRun: opts.dryRun });
      render(out, t, opts);
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
      const panes = bin && tmux.hasServer() ? tmux.listPanes() : [];
      const procs = parsePsTable(tmux.processTable());
      const claudePanes = panes.filter((p) => isTargetPane(p, procs, config.paneCommand));
      const rows = [
        ['platform', platform()],
        ['node', process.version],
        ['tmux', bin || t.doctorFail],
        ['tmux server', bin && tmux.hasServer() ? t.doctorOk : t.doctorFail],
        ['claude panes', String(claudePanes.length)],
        ['scheduler', scheduler.isInstalled() ? t.doctorOk : t.doctorFail],
        [t.scheduledPath, (() => {
          const cli = scheduler.scheduledCli();
          if (!cli) return '—';
          return existsSync(cli) ? cli : `${cli}  ${t.scheduledMissing}`;
        })()],
        ['home', homeDir()],
        ['config', existsSync(configPath()) ? configPath() : `${configPath()} (defaults)`],
        ['state', statePath()],
        ['log', logPath()],
      ];
      if (opts.json) console.log(JSON.stringify(Object.fromEntries(rows), null, 2));
      else for (const [k, v] of rows) console.log(`${k.padEnd(14)}${v}`);
      if (!bin) process.exitCode = 1;
      break;
    }
    case 'logs': {
      const p = logPath();
      if (!existsSync(p)) return console.log(t.noLog);
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      console.log(lines.slice(-40).join('\n'));
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
