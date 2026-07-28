import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlist, renderSystemdService, renderSystemdTimer, LABEL } from '../src/scheduler.js';

test('the launchd plist carries the interval and an absolute node path', () => {
  const xml = renderPlist({ interval: 15, node: '/usr/local/bin/node', cli: '/x/bin/agenttether.js' });
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>15<\/integer>/);
  assert.match(xml, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(xml, /<string>once<\/string>/);
  assert.ok(xml.includes(LABEL));
});

test('the plist passes AGENTTETHER_HOME through when one is set', () => {
  const xml = renderPlist({ interval: 15, node: '/n', cli: '/c', home: '/tmp/th' });
  assert.match(xml, /AGENTTETHER_HOME/);
  assert.match(xml, /<string>\/tmp\/th<\/string>/);
  assert.ok(!renderPlist({ interval: 15, node: '/n', cli: '/c' }).includes('AGENTTETHER_HOME'));
});

test('the systemd unit runs a single pass, not a daemon', () => {
  const unit = renderSystemdService({ node: '/usr/bin/node', cli: '/x/bin/agenttether.js' });
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/x\/bin\/agenttether\.js once/);
});

test('the systemd timer repeats on the configured interval', () => {
  const timer = renderSystemdTimer({ interval: 20 });
  assert.match(timer, /OnUnitActiveSec=20s/);
  assert.match(timer, /WantedBy=timers\.target/);
});
