import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketArgs, parsePaneRows, SEP, FORMAT } from '../src/tmux.js';

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


// --- the field separator ---------------------------------------------------
// Outside an interactive shell — a launchd job, a cron entry — tmux replaces
// control characters in format output with "_". With a tab separator every row
// parsed into a single field, every pane was discarded, and cckeep reported
// "no panes" while doing nothing. It ran 15,000 times that way.

test('the separator contains no control characters', () => {
  for (const ch of SEP) {
    const code = ch.codePointAt(0);
    assert.ok(code > 0x20 && code !== 0x7f, `${JSON.stringify(ch)} would be sanitised to _`);
  }
});

test('the session name comes last so it can contain anything', () => {
  // Fixed-shape fields first; whatever follows the fifth separator is the name.
  const fields = FORMAT.split(SEP);
  assert.equal(fields.length, 6);
  assert.equal(fields[0], '#{pane_id}');
  assert.equal(fields[fields.length - 1], '#{session_name}');
});

test('a row parses into the fields cckeep needs', () => {
  const row = parsePaneRows([`%3${SEP}18277${SEP}0${SEP}0${SEP}2.1.220${SEP}claude-openjob`].join('\n'));
  assert.deepEqual(row, [{
    id: '%3', command: '2.1.220', session: 'claude-openjob',
    windowIndex: '0', paneIndex: '0', pid: 18277, label: 'claude-openjob:0.0',
  }]);
});

test('a session name containing the separator does not shift the other fields', () => {
  const [row] = parsePaneRows(`%1${SEP}42${SEP}0${SEP}0${SEP}claude${SEP}weird${SEP}name`);
  assert.equal(row.pid, 42);
  assert.equal(row.command, 'claude');
  assert.equal(row.session, `weird${SEP}name`);
});

test('output mangled by the sanitiser is a failure, not an empty server', () => {
  // This is the exact shape tmux produced under launchd. Returning [] here
  // would have pruned away every pane cckeep had ever seen connected.
  assert.equal(parsePaneRows('%1_8093_0_0_2.1.220_claude-kenta'), null);
  assert.equal(parsePaneRows('nonsense\nmore nonsense'), null);
});

test('a row with the right shape but the wrong contents is rejected', () => {
  // Enough separators to look parseable, but not a pane. Without the check
  // this became a pane object with pid NaN, which then matched nothing and
  // silently displaced the real ones.
  const junk = ['garbage', 'notapid', 'x', 'y', 'z', 'w'].join(SEP);
  assert.equal(parsePaneRows(junk), null);
  const mixed = [junk, `%2${SEP}17705${SEP}0${SEP}0${SEP}claude${SEP}real`].join('\n');
  const rows = parsePaneRows(mixed);
  assert.equal(rows.length, 1, 'the junk row is dropped, the real one kept');
  assert.equal(rows[0].pid, 17705);
});

test('a genuinely empty server is still an empty list', () => {
  assert.deepEqual(parsePaneRows(''), []);
  assert.deepEqual(parsePaneRows('   \n'), []);
});
