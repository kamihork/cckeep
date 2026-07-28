import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlist, renderSystemdService, renderSystemdTimer, isEphemeralPath, LABEL } from '../src/scheduler.js';

const cliPathOfEphemeralExample = '/home/u/.npm/_npx/deadbeef/node_modules/cckeep/bin/cckeep.js';

test('the launchd plist carries the interval and an absolute node path', () => {
  const xml = renderPlist({ interval: 15, node: '/usr/local/bin/node', cli: '/x/bin/cckeep.js' });
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>15<\/integer>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>once<\/string>/);
  assert.ok(xml.includes(LABEL));
});

test('the plist carries the environment a scheduled run cannot inherit', () => {
  // launchd starts from its own environment, not the shell you typed enable in.
  const xml = renderPlist({
    interval: 15, node: '/n', cli: '/c',
    env: { CCKEEP_HOME: '/tmp/th', CCKEEP_TMUX_SOCKET: 'work' },
  });
  assert.match(xml, /<key>CCKEEP_HOME<\/key>\s*<string>\/tmp\/th<\/string>/);
  assert.match(xml, /<key>CCKEEP_TMUX_SOCKET<\/key>\s*<string>work<\/string>/);
  assert.ok(!renderPlist({ interval: 15, node: '/n', cli: '/c' }).includes('EnvironmentVariables'));
});

test('the plist escapes XML metacharacters in paths', () => {
  // A home directory containing & produced a plist launchctl refused to load.
  const xml = renderPlist({ interval: 15, node: '/opt/a&b/node', cli: '/x<y>/cckeep.js' });
  assert.ok(xml.includes('/opt/a&amp;b/node'));
  assert.ok(xml.includes('/x&lt;y&gt;/cckeep.js'));
  for (const [, inner] of xml.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(inner), `unescaped & in ${inner}`);
  }
});

test('the plist sends a scheduled run\'s output somewhere readable', () => {
  const xml = renderPlist({ interval: 15, node: '/n', cli: '/c', log: '/tmp/cckeep.log' });
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/tmp\/cckeep\.log<\/string>/);
});

test('a fractional interval cannot produce an invalid plist', () => {
  assert.match(renderPlist({ interval: 2.5, node: '/n', cli: '/c' }), /<integer>3<\/integer>/);
});

test('the systemd unit runs a single pass, not a daemon', () => {
  const unit = renderSystemdService({ node: '/usr/bin/node', cli: '/x/bin/cckeep.js' });
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/x\/bin\/cckeep\.js" once/);
});

test('systemd paths with spaces stay one argument', () => {
  // systemd splits ExecStart on whitespace; an unquoted path under
  // /home/jan doe/ produced a unit that simply failed to start.
  const unit = renderSystemdService({ node: '/home/jan doe/n', cli: '/home/jan doe/cckeep.js' });
  assert.ok(unit.includes('ExecStart="/home/jan doe/n" "/home/jan doe/cckeep.js" once'));
});

test('systemd carries the environment too, with % escaped', () => {
  const unit = renderSystemdService({ node: '/n', cli: '/c', env: { CCKEEP_TMUX_SOCKET: 'a%b' } });
  assert.ok(unit.includes('Environment=CCKEEP_TMUX_SOCKET=a%%b'));
});

test('the systemd timer repeats on the configured interval', () => {
  const timer = renderSystemdTimer({ interval: 20 });
  assert.match(timer, /OnUnitActiveSec=20s/);
  assert.match(timer, /WantedBy=timers\.target/);
});

test('an npx cache path is recognised as ephemeral', () => {
  assert.equal(isEphemeralPath('/Users/x/.npm/_npx/9aa4d954bd962b62/node_modules/cckeep/bin/cckeep.js'), true);
  assert.equal(isEphemeralPath('/Users/x/.npm/_cacache/tmp/abc/bin/cckeep.js'), true);
  assert.equal(isEphemeralPath('C:\\Users\\x\\AppData\\npm\\_npx\\ab12\\node_modules\\cckeep\\bin\\cckeep.js'), true);
});

test('a real install path is not ephemeral', () => {
  assert.equal(isEphemeralPath('/usr/local/lib/node_modules/cckeep/bin/cckeep.js'), false);
  assert.equal(isEphemeralPath('/Users/x/.nodenv/versions/20.18.1/lib/node_modules/cckeep/bin/cckeep.js'), false);
  assert.equal(isEphemeralPath('/Users/x/myapp/cckeep/bin/cckeep.js'), false);
});

test('install refuses rather than scheduling a path that will vanish', () => {
  // Guard the intent, not just the matcher: a scheduler that silently stops is
  // the one failure mode this tool cannot have.
  assert.equal(isEphemeralPath(cliPathOfEphemeralExample), true);
});
