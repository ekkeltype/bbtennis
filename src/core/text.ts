/** Characters allowed in player names; the bitmap font must provide a glyph for each. */
export const NAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .-_!?'";

/** Maximum player name length in characters. */
export const NAME_MAX = 12;

/** Replaces characters outside NAME_CHARS with '?', collapses runs of spaces, trims, caps at NAME_MAX; empty → 'PLAYER'. */
export function sanitizeName(s: string): string {
  let allowed = '';
  for (const ch of s) allowed += NAME_CHARS.includes(ch) ? ch : '?';
  const name = allowed.replace(/ {2,}/g, ' ').trim().slice(0, NAME_MAX).trimEnd();
  return name === '' ? 'PLAYER' : name;
}
