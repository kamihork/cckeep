import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'io.github.kamihork.agenttether';

function cliPath() {
  return fileURLToPath(new URL('../bin/agenttether.js', import.meta.url));
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
    ? `    <key>EnvironmentVariables</key>\n    <dict>\n        <key>AGENTTETHER_HOME</key>\n        <string>${home}</string>\n    </dict>\n`
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
Description=agenttether — keep Claude Code Remote Control alive

[Service]
Type=oneshot
ExecStart=${node} ${cli} once
`;
}

export function renderSystemdTimer({ interval }) {
  return `[Unit]
Description=agenttether — keep Claude Code Remote Control alive

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
  const os = platform();
  if (os === 'darwin') {
    const p = plistPath();
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(p, renderPlist({ interval, home: process.env.AGENTTETHER_HOME }));
    const uid = process.getuid();
    run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]);
    const ok = run('launchctl', ['bootstrap', `gui/${uid}`, p]);
    return { kind: 'launchd', path: p, ok };
  }
  if (os === 'linux') {
    const dir = systemdDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agenttether.service'), renderSystemdService({}));
    writeFileSync(join(dir, 'agenttether.timer'), renderSystemdTimer({ interval }));
    run('systemctl', ['--user', 'daemon-reload']);
    const ok = run('systemctl', ['--user', 'enable', '--now', 'agenttether.timer']);
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
    run('systemctl', ['--user', 'disable', '--now', 'agenttether.timer']);
    for (const f of ['agenttether.timer', 'agenttether.service']) {
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
  if (os === 'linux') return existsSync(join(systemdDir(), 'agenttether.timer'));
  return false;
}
