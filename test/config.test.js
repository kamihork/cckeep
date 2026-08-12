import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cckeep-config-'));
process.env.CCKEEP_HOME = HOME;

const { loadConfig, configPath, BASE } = await import('../src/config.js');

const CONFIG = join(HOME, 'config.json');

beforeEach(() => {
  rmSync(CONFIG, { force: true });
  for (const k of Object.keys(process.env)) if (k.startsWith('CCKEEP_') && k !== 'CCKEEP_HOME') delete process.env[k];
});

test('defaults apply with no config file', () => {
  const cfg = loadConfig();
  assert.equal(cfg.interval, BASE.interval);
  assert.equal(cfg.paneCommand, 'claude');
});

test('the config file overrides defaults', () => {
  writeFileSync(CONFIG, JSON.stringify({ interval: 60, cooldown: 30 }));
  const cfg = loadConfig();
  assert.equal(cfg.interval, 60);
  assert.equal(cfg.cooldown, 30);
});

test('environment overrides the config file, and flags override environment', () => {
  writeFileSync(CONFIG, JSON.stringify({ interval: 60 }));
  process.env.CCKEEP_INTERVAL = '30';
  assert.equal(loadConfig().interval, 30);
  assert.equal(loadConfig({ interval: 5 }).interval, 5);
});

test('a malformed config file is a hard error, never a silent half-load', () => {
  writeFileSync(CONFIG, '{ not json');
  assert.throws(() => loadConfig(), /not valid JSON/);
});

test('a nonsense threshold is rejected', () => {
  writeFileSync(CONFIG, JSON.stringify({ cooldown: 'soon' }));
  assert.throws(() => loadConfig(), /non-negative number/);
});

test('configPath sits under CCKEEP_HOME', () => {
  assert.equal(configPath(), CONFIG);
});

test('limit recovery is off unless it is asked for', () => {
  assert.equal(loadConfig().limits, false);
  writeFileSync(CONFIG, JSON.stringify({ limits: true }));
  assert.equal(loadConfig().limits, true);
});

/**
 * An environment variable is always a string, and "false" is a truthy one. Left
 * uncoerced, the obvious way to turn the feature off would turn it on — into a
 * feature whose whole job is typing into people's terminals.
 */
test('CCKEEP_LIMITS=false turns it off rather than on', () => {
  writeFileSync(CONFIG, JSON.stringify({ limits: true }));
  for (const off of ['false', '0', 'no', 'off', 'FALSE']) {
    process.env.CCKEEP_LIMITS = off;
    assert.equal(loadConfig().limits, false, `"${off}" must read as off`);
  }
  for (const on of ['true', '1', 'yes']) {
    process.env.CCKEEP_LIMITS = on;
    assert.equal(loadConfig().limits, true, `"${on}" must read as on`);
  }
  delete process.env.CCKEEP_LIMITS;
});

process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));
