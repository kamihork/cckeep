import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePsTable, hasDescendantNamed, isTargetPane } from '../src/procs.js';

// Real `ps -Ao pid=,ppid=,comm=` output, trimmed. Note pid 90512: tmux reports
// that pane's command as "2.1.220" because Claude Code rewrites its process
// title — the whole reason this module exists.
const PS = `
    1     0 /sbin/launchd
90511     1 tmux
90512 90511 claude
94129 90512 caffeinate
92731 90511 login
92800 92731 -zsh
92850 92800 claude
99999 92850 node
`;

test('parses pid, ppid and command', () => {
  const t = parsePsTable(PS);
  assert.equal(t.get(90512).comm, 'claude');
  assert.equal(t.get(90512).ppid, 90511);
  assert.equal(t.get(1).comm, 'launchd', 'a full path collapses to its basename');
});

test('malformed lines are skipped rather than throwing', () => {
  const t = parsePsTable('garbage\n\n  12 34 sh\nnot a row');
  assert.equal(t.size, 1);
  assert.equal(t.get(12).comm, 'sh');
});

test('finds the process running directly in the pane', () => {
  assert.equal(hasDescendantNamed(parsePsTable(PS), 90512, 'claude'), true);
});

test('finds Claude Code running under a shell', () => {
  // pane pid 92731 -> zsh -> claude
  assert.equal(hasDescendantNamed(parsePsTable(PS), 92731, 'claude'), true);
});

test('says no when nothing in the tree matches', () => {
  assert.equal(hasDescendantNamed(parsePsTable(PS), 94129, 'claude'), false);
  assert.equal(hasDescendantNamed(parsePsTable(PS), 1234567, 'claude'), false);
  assert.equal(hasDescendantNamed(parsePsTable(PS), undefined, 'claude'), false);
});

test('stops descending past maxDepth', () => {
  assert.equal(hasDescendantNamed(parsePsTable(PS), 92731, 'node', 1), false);
  assert.equal(hasDescendantNamed(parsePsTable(PS), 92731, 'node', 4), true);
});

test('a pane whose title tmux reports as a version is still recognised', () => {
  // This is the bug: matching pane_current_command alone found nothing.
  const pane = { command: '2.1.220', pid: 90512 };
  assert.equal(pane.command === 'claude', false, 'the name tmux reports does not match');
  assert.equal(isTargetPane(pane, parsePsTable(PS), 'claude'), true);
});

test('the fast path still works when the title is left alone', () => {
  assert.equal(isTargetPane({ command: 'claude', pid: 0 }, parsePsTable(PS), 'claude'), true);
});

test('an unrelated pane is not picked up', () => {
  assert.equal(isTargetPane({ command: 'vim', pid: 94129 }, parsePsTable(PS), 'claude'), false);
});
