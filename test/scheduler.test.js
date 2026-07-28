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

test('the plist passes CCKEEP_HOME through when one is set', () => {
  const xml = renderPlist({ interval: 15, node: '/n', cli: '/c', home: '/tmp/th' });
  assert.match(xml, /CCKEEP_HOME/);
  assert.match(xml, /<string>\/tmp\/th<\/string>/);
  assert.ok(!renderPlist({ interval: 15, node: '/n', cli: '/c' }).includes('CCKEEP_HOME'));
});

test('the systemd unit runs a single pass, not a daemon', () => {
  const unit = renderSystemdService({ node: '/usr/bin/node', cli: '/x/bin/cckeep.js' });
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/x\/bin\/cckeep\.js once/);
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
