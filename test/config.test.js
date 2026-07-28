import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'agenttether-config-'));
process.env.AGENTTETHER_HOME = HOME;

const { loadConfig, configPath, BASE } = await import('../src/config.js');

const CONFIG = join(HOME, 'config.json');

beforeEach(() => {
  rmSync(CONFIG, { force: true });
  for (const k of Object.keys(process.env)) if (k.startsWith('AGENTTETHER_') && k !== 'AGENTTETHER_HOME') delete process.env[k];
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
  process.env.AGENTTETHER_INTERVAL = '30';
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

test('configPath sits under AGENTTETHER_HOME', () => {
  assert.equal(configPath(), CONFIG);
});

process.on('exit', () => rmSync(HOME, { recursive: true, force: true }));
