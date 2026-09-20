/**
 * theme.js — minimal ANSI terminal styling for human-readable CLI output.
 * No new dependency (plain escape codes). Respects NO_COLOR and non-TTY
 * output (piped/redirected) by degrading to plain text automatically — never
 * pollutes --json output or a file redirect with escape codes.
 */

function colorEnabled() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!process.stdout.isTTY;
}

function wrap(code) {
  return (text) => (colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : String(text));
}

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const magenta = wrap(35);
export const cyan = wrap(36);

/** Green when healthy, yellow when marginal, red when fragile — a quick visual cue, not a new signal. */
export function confidenceColor(score) {
  if (score >= 0.8) return green;
  if (score >= 0.5) return yellow;
  return red;
}

/** Wraps `items` (strings) into lines no wider than `width`, joined by `sep`, each subsequent line indented. */
export function wrapList(items, { width = 100, indent = "    ", sep = ", " } = {}) {
  if (!items.length) return "";
  const lines = [];
  let current = "";
  for (const item of items) {
    const candidate = current ? `${current}${sep}${item}` : item;
    if (candidate.length > width && current) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.map((l, i) => (i === 0 ? l : `${indent}${l}`)).join("\n");
}
