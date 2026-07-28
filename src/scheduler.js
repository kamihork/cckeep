import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
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

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function systemdDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}

export function renderPlist({ interval, node = nodePath(), cli = cliPath(), home }) {
  const env = home
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n        <key>CCKEEP_HOME</key>\n        <string>${home}</string>\n    </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node}</string>
        <string>${cli}</string>
        <string>once</string>
    </array>
    <key>StartInterval</key>
    <integer>${interval}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${env}</dict>
</plist>
`;
}

export function renderSystemdService({ node = nodePath(), cli = cliPath() }) {
  return `[Unit]
Description=cckeep — keep Claude Code Remote Control alive

[Service]
Type=oneshot
ExecStart=${node} ${cli} once
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
    writeFileSync(p, renderPlist({ interval, home: process.env.CCKEEP_HOME }));
    const uid = process.getuid();
    run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    const ok = run('launchctl', ['bootstrap', `gui/${uid}`, p]);
    return { kind: 'launchd', path: p, ok };
  }
  if (os === 'linux') {
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cckeep.service'), renderSystemdService({}));
    writeFileSync(join(dir, 'cckeep.timer'), renderSystemdTimer({ interval }));
    run('systemctl', ['--user', 'daemon-reload']);
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
      const args = [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
      return args.find((a) => a.endsWith('cckeep.js')) ?? null;
    }
    if (os === 'linux') {
      const p = join(systemdDir(), 'cckeep.service');
      if (!existsSync(p)) return null;
      const unit = readFileSync(p, 'utf8');
      const line = unit.match(/^ExecStart=(.*)$/m)?.[1] ?? '';
      return line.split(/\s+/).find((a) => a.endsWith('cckeep.js')) ?? null;
    }
  } catch {}
  return null;
}
