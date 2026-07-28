import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketArgs } from '../src/tmux.js';

test('no socket configured means the default server', () => {
  assert.deepEqual(socketArgs(''), []);
});

test('a bare name becomes -L', () => {
  assert.deepEqual(socketArgs('work'), ['-L', 'work']);
});

test('anything path-shaped becomes -S', () => {
  // tmux -S takes a socket path; -L takes a name under the socket directory.
  assert.deepEqual(socketArgs('/tmp/tmux-501/work'), ['-S', '/tmp/tmux-501/work']);
});
