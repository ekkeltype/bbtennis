/** Game-code characters: A–Z and 2–9 without the look-alikes 0, O, 1, I, L (spec §4.6). */
export const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Length of a game code. */
export const CODE_LENGTH = 5;

/**
 * A random game code of CODE_LENGTH characters from ALPHABET; `rand` returns uniforms in [0, 1).
 * Out-of-range values are clamped to the first or last character, and NaN counts as 0.
 */
export function genCode(rand: () => number): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    const index = Math.floor(rand() * ALPHABET.length);
    code += ALPHABET[Number.isNaN(index) ? 0 : Math.min(ALPHABET.length - 1, Math.max(0, index))];
  }
  return code;
}

/** Trims and uppercases user input; returns the code, or null unless it is CODE_LENGTH ALPHABET characters. */
export function normalizeCode(s: string): string | null {
  const code = s.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}
