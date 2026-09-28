/**
 * proc.js — spawn package-manager commands the same way on every OS.
 *
 * On Windows, npm/npx/pnpm/yarn/corepack are `.cmd` shims, and Node ≥20
 * refuses to spawn a `.cmd` without a shell (CVE-2024-27980) — every spawn
 * failed with ENOENT, which silently failed the fix engine's test gate and
 * chat's dev commands on Windows. Running through the shell reintroduces
 * command-line parsing, so any argument containing a cmd.exe metacharacter is
 * REFUSED (throws) rather than escaped: an escape bug would be an injection.
 *
 * Everywhere else, and for any other binary, this is a pass-through.
 */

const CMD_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "corepack"]);
const CMD_META = /[&|<>^%!"\r\n`]/;

/** Returns { file, args, options } to hand to spawn/execFile/execFileSync. */
export function platformCommand(cmd, args = [], options = {}, platform = process.platform) {
  if (platform !== "win32" || !CMD_SHIMS.has(cmd)) return { file: cmd, args, options };
  for (const a of args) {
    if (CMD_META.test(String(a))) throw new Error(`refusing to pass ${JSON.stringify(a)} to ${cmd} through the Windows shell`);
  }
  const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : String(a)));
  return { file: `${cmd}.cmd`, args: quoted, options: { ...options, shell: true, windowsHide: true } };
}
