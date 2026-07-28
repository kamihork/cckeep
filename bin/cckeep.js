#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { runPass } from '../src/run.js';
import { loadConfig, configPath } from '../src/config.js';
import { logPath, statePath, homeDir } from '../src/state.js';
import * as tmux from '../src/tmux.js';
import * as scheduler from '../src/scheduler.js';
import { pickLang, strings } from '../src/i18n.js';

const HELP = `cckeep — keep Claude Code Remote Control from silently going dead

USAGE
  cckeep [command] [options]

COMMANDS
  status          what cckeep sees right now (default)
  watch           run in the foreground, one pass every --interval seconds
  once            a single pass — what the scheduler runs
  install         register a background job (launchd on macOS, systemd on Linux)
  uninstall       remove it
  doctor          check tmux, Claude Code panes, and the scheduler
  logs            show recent actions

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
  const opts = { command: null, dryRun: false, json: false, lang: null, interval: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--lang') opts.lang = argv[++i];
    else if (a === '--interval') opts.interval = Number(argv[++i]);
    else if (a === '-h' || a === '--help') opts.command = 'help';
    else if (a === '-v' || a === '--version') opts.command = 'version';
    else if (!a.startsWith('-') && !opts.command) opts.command = a;
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
  for (const r of out.results) {
    console.log(`${r.pane.padEnd(14)}${describe(r, t)}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const lang = pickLang(opts.lang);
  const t = strings(lang);

  if (opts.command === 'help') return console.log(HELP);
  if (opts.command === 'version') return console.log(version());

  let config;
  try {
    config = loadConfig(opts.interval ? { interval: opts.interval } : {});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  switch (opts.command ?? 'status') {
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
    case 'install': {
      const res = scheduler.install({ interval: config.interval });
      if (res.kind === 'unsupported') {
        console.log(t.unsupported);
        process.exit(1);
      }
      console.log(res.ok ? t.installed(res.kind, res.path) : t.installFailed(res.kind));
      if (!res.ok) process.exit(1);
      break;
    }
    case 'uninstall': {
      const res = scheduler.uninstall();
      if (res.kind === 'unsupported') return console.log(t.unsupported);
      console.log(t.uninstalled(res.kind));
      break;
    }
    case 'doctor': {
      const bin = tmux.tmuxPath();
      const panes = bin && tmux.hasServer() ? tmux.listPanes() : [];
      const claudePanes = panes.filter((p) => p.command === config.paneCommand);
      const rows = [
        ['platform', platform()],
        ['node', process.version],
        ['tmux', bin || t.doctorFail],
        ['tmux server', bin && tmux.hasServer() ? t.doctorOk : t.doctorFail],
        ['claude panes', String(claudePanes.length)],
        ['scheduler', scheduler.isInstalled() ? t.doctorOk : t.doctorFail],
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
