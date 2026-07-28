/**
 * Claude Code rewrites its own process title, so tmux reports a pane running it
 * as e.g. "2.1.220" rather than "claude". Matching `pane_current_command`
 * against a name therefore finds nothing on a real machine — which is exactly
 * the bug this module exists to fix.
 *
 * The executable name is still correct in the process table, so that is what we
 * check. Pure functions here; the one `ps` call lives in tmux.js.
 */

/** Parse `ps -Ao pid=,ppid=,comm=` into a pid -> {ppid, comm} map. */
export function parsePsTable(output) {
  const table = new Map();
  for (const line of String(output).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, ppid, rawComm] = m;
    // macOS prints the full path here for some processes; Linux prints a name.
    const comm = rawComm.trim().split('/').pop();
    table.set(Number(pid), { ppid: Number(ppid), comm });
  }
  return table;
}

/**
 * Does `rootPid` — or anything it spawned — run `name`?
 *
 * A pane usually runs Claude Code directly, but someone may have it under a
 * shell, a wrapper, or a version manager's shim, so descendants count too.
 */
export function hasDescendantNamed(table, rootPid, name, maxDepth = 4) {
  if (!table || !rootPid) return false;

  const children = new Map();
  for (const [pid, info] of table) {
    if (!children.has(info.ppid)) children.set(info.ppid, []);
    children.get(info.ppid).push(pid);
  }

  const seen = new Set();
  let frontier = [Number(rootPid)];
  for (let depth = 0; depth <= maxDepth && frontier.length; depth++) {
    const next = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (table.get(pid)?.comm === name) return true;
      next.push(...(children.get(pid) ?? []));
    }
    frontier = next;
  }
  return false;
}

/**
 * Is this pane running Claude Code?
 *
 * The name tmux reports is the fast path and still works wherever the title is
 * left alone; the process table is the fallback that makes it work at all.
 */
export function isTargetPane(pane, table, name) {
  if (pane.command === name) return true;
  return hasDescendantNamed(table, pane.pid, name);
}
