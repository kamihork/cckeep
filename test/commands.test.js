import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommand, isKnownCommand, ALIASES } from '../src/commands.js';

test('the scheduler verbs are enable and disable', () => {
  assert.equal(resolveCommand('enable'), 'enable');
  assert.equal(resolveCommand('disable'), 'disable');
});

test('the 0.1.x names keep working as aliases', () => {
  // They shipped, and people have them in notes and scripts. Breaking them
  // would buy nothing.
  assert.equal(resolveCommand('install'), 'enable');
  assert.equal(resolveCommand('uninstall'), 'disable');
});

test('no command means status', () => {
  assert.equal(resolveCommand(undefined), 'status');
  assert.equal(resolveCommand(null), 'status');
});

test('every other command passes through untouched', () => {
  for (const c of ['status', 'watch', 'once', 'doctor', 'logs']) {
    assert.equal(resolveCommand(c), c);
  }
});

test('an unknown command is not silently accepted', () => {
  assert.equal(isKnownCommand('frobnicate'), false);
  assert.equal(isKnownCommand('install'), true);
});

test('aliases only ever point at real commands', () => {
  for (const target of Object.values(ALIASES)) assert.equal(isKnownCommand(target), true);
});
