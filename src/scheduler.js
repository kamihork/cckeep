import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { logPath } from './state.js';
import { ENV } from './config.js';
import { fileURLToPath } from 'node:url';

export const LABEL = 'io.github.kamihork.cckeep';

function cliPath() {
  return fileURLToPath(new URL('../bin/cckeep.js', import.meta.url));
}

/**
 * `npx cckeep` runs out of npm's throwaway cache. Baking that path into a
 * launchd job or systemd unit produces a scheduler that works today and stops
 * forever the first time the cache is evicted — silently, which is the one
 * failure this tool must not have. Refuse instead, and ask for a real install.
 */
export function isEphemeralPath(p) {
  return /[\\/]_npx[\\/]/.test(p) || /[\\/]\.npm[\\/]_cacache[\\/]/.test(p);
}

function nodePath() {
  return process.execPath;
}

/** The plist is XML, so anything interpolated into it has to be escaped. */
function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Environment the scheduled job needs but would not otherwise inherit. A
 * scheduled run starts from launchd's or systemd's environment, not the shell
 * you typed `enable` in, so a socket or tmux path set there is simply gone —
 * and the job then watches the wrong server, forever, in silence.
 */
export function inheritedEnv() {
  const keep = {};
  // Driven off config.js's own map rather than a second hand-written list: the
  // limits settings were added there and silently not here, so `cckeep enable`
  // wrote a job that could never act on them while the README promised it did.
  for (const key of ['CCKEEP_HOME', ...Object.keys(ENV)]) {
    if (process.env[key]) keep[key] = process.env[key];
  }
  return keep;
}

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function systemdDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}

export function renderPlist({ interval, node = nodePath(), cli = cliPath(), env = {}, log }) {
  const entries = Object.entries(env).filter(([, v]) => v);
  const envBlock = entries.length
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n${entries
        .map(([k, v]) => `        <key>${xml(k)}</key>\n        <string>${xml(v)}</string>`)
        .join('\n')}\n    </dict>\n`
    : '';
  // Without these, everything a scheduled run reports — a bad config, a
  // missing tmux — goes to /dev/null and the failure is invisible.
  const logBlock = log
    ? `    <key>StandardOutPath</key>\n    <string>${xml(log)}</string>\n    <key>StandardErrorPath</key>\n    <string>${xml(log)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xml(node)}</string>
        <string>${xml(cli)}</string>
        <string>once</string>
    </array>
    <key>StartInterval</key>
    <integer>${Math.max(1, Math.round(interval))}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${envBlock}${logBlock}</dict>
</plist>
`;
}

export function renderSystemdService({ node = nodePath(), cli = cliPath(), env = {} } = {}) {
  // systemd splits ExecStart on whitespace and reads % as a specifier, so the
  // paths are quoted and % is escaped.
  const arg = (v) => `"${String(v).replace(/%/g, '%%').replace(/"/g, '\\"')}"`;
  const envLines = Object.entries(env)
    .filter(([, v]) => v)
    .map(([k, v]) => `Environment=${k}=${String(v).replace(/%/g, '%%')}`)
    .join('\n');
  return `[Unit]
Description=cckeep — keep Claude Code Remote Control alive

[Service]
Type=oneshot
${envLines}${envLines ? '\n' : ''}ExecStart=${arg(node)} ${arg(cli)} once
`;
}

export function renderSystemdTimer({ interval }) {
  return `[Unit]
Description=cckeep — keep Claude Code Remote Control alive

[Timer]
OnBootSec=${interval}s
OnUnitActiveSec=${interval}s
AccuracySec=1s

[Install]
WantedBy=timers.target
`;
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

export function install({ interval }) {
  const cli = cliPath();
  if (isEphemeralPath(cli)) return { kind: 'ephemeral', path: cli, ok: false };

  const os = platform();
  if (os === 'darwin') {
    const p = plistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(p, renderPlist({ interval, env: inheritedEnv(), log: logPath() }));
    const uid = process.getuid();
    run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    const ok = run('launchctl', ['bootstrap', `gui/${uid}`, p]);
    return { kind: 'launchd', path: p, ok };
  }
  if (os === 'linux') {
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cckeep.service'), renderSystemdService({ env: inheritedEnv() }));
    writeFileSync(join(dir, 'cckeep.timer'), renderSystemdTimer({ interval }));
    run('systemctl', ['--user', 'daemon-reload']);
    // Without lingering the user manager stops at logout and the timer dies
    // with it — silently, on exactly the remote boxes this matters most on.
    run('loginctl', ['enable-linger', process.env.USER ?? '']);
    const ok = run('systemctl', ['--user', 'enable', '--now', 'cckeep.timer']);
    return { kind: 'systemd', path: dir, ok };
  }
  return { kind: 'unsupported', path: null, ok: false };
}

export function uninstall() {
  const os = platform();
  if (os === 'darwin') {
    const p = plistPath();
    run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    if (existsSync(p)) unlinkSync(p);
    return { kind: 'launchd', path: p, ok: true };
  }
  if (os === 'linux') {
    const dir = systemdDir();
    run('systemctl', ['--user', 'disable', '--now', 'cckeep.timer']);
    for (const f of ['cckeep.timer', 'cckeep.service']) {
      const p = join(dir, f);
      if (existsSync(p)) unlinkSync(p);
    }
    run('systemctl', ['--user', 'daemon-reload']);
    return { kind: 'systemd', path: dir, ok: true };
  }
  return { kind: 'unsupported', path: null, ok: false };
}

export function isInstalled() {
  const os = platform();
  if (os === 'darwin') return existsSync(plistPath());
  if (os === 'linux') return existsSync(join(systemdDir(), 'cckeep.timer'));
  return false;
}

/**
 * The cckeep path the installed scheduler will actually run. Read back from the
 * unit rather than recomputed, so `doctor` can catch a job left pointing at a
 * copy that has since been moved or deleted.
 */
export function scheduledCli() {
  try {
    const os = platform();
    if (os === 'darwin') {
      const p = plistPath();
      if (!existsSync(p)) return null;
      const xml = readFileSync(p, 'utf8');
      const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) =>
        m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      );
      return args.find((a) => a.endsWith('cckeep.js')) ?? null;
    }
    if (os === 'linux') {
      const p = join(systemdDir(), 'cckeep.service');
      if (!existsSync(p)) return null;
      const unit = readFileSync(p, 'utf8');
      const line = unit.match(/^ExecStart=(.*)$/m)?.[1] ?? '';
      // Paths are quoted, so read the quoted words rather than splitting on
      // whitespace — a path with a space used to come back mangled.
      const quoted = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1].replace(/%%/g, '%'));
      const words = quoted.length ? quoted : line.split(/\s+/);
      return words.find((a) => a.endsWith('cckeep.js')) ?? null;
    }
  } catch {}
  return null;
}
