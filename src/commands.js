/**
 * `npm install -g cckeep` puts the CLI on your PATH; registering the background
 * job is a separate, deliberate step. Naming that step `install` too made the
 * quick start read as if you were installing twice, so the scheduler verbs are
 * `enable` / `disable` — the same words systemctl uses for the same idea.
 *
 * The old names stay as aliases: they shipped in 0.1.x and in the plists people
 * already generated, and breaking them buys nothing.
 */
export const ALIASES = {
  install: 'enable',
  uninstall: 'disable',
};

export const COMMANDS = new Set([
  'status',
  'watch',
  'once',
  'enable',
  'disable',
  'doctor',
  'logs',
  'help',
  'version',
]);

/** Map whatever the user typed onto a canonical command. */
export function resolveCommand(input) {
  const name = input ?? 'status';
  return ALIASES[name] ?? name;
}

export function isKnownCommand(input) {
  return COMMANDS.has(resolveCommand(input));
}
