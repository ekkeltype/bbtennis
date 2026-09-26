import { describe, expect, it } from 'vitest';
import { NAME_CHARS, NAME_MAX, sanitizeName } from '../../src/core/text';

describe('sanitizeName', () => {
  it('keeps a plain name unchanged', () => {
    expect(sanitizeName('Alex')).toBe('Alex');
  });

  it('keeps every allowed character', () => {
    expect(sanitizeName("a.B-_!?'9 z")).toBe("a.B-_!?'9 z");
  });

  it('strips markup characters from a hostile name and respects the length cap', () => {
    const name = sanitizeName('<b>Zoë😀</b>');
    expect(name).not.toContain('<');
    expect(name).not.toContain('>');
    expect(name.length).toBeLessThanOrEqual(12);
    expect(name).toBe('?b?Zo????b?');
  });

  it('replaces a surrogate pair (one code point) with a single ?', () => {
    expect(sanitizeName('A😀B')).toBe('A?B');
  });

  it('replaces a lone surrogate with a single ?', () => {
    expect(sanitizeName('A\uD83DB')).toBe('A?B');
  });

  it('replaces control and non-space whitespace characters', () => {
    expect(sanitizeName('Al\tex\n')).toBe('Al?ex?');
  });

  it('collapses runs of spaces and trims', () => {
    expect(sanitizeName('  Big   Ben  ')).toBe('Big Ben');
  });

  it('falls back to PLAYER for empty or blank names', () => {
    expect(sanitizeName('')).toBe('PLAYER');
    expect(sanitizeName('   ')).toBe('PLAYER');
  });

  it('cuts a 20-character name to NAME_MAX characters', () => {
    expect(NAME_MAX).toBe(12);
    expect(sanitizeName('ABCDEFGHIJKLMNOPQRST')).toBe('ABCDEFGHIJKL');
  });

  it('does not leave a trailing space where the cut falls after a space', () => {
    expect(sanitizeName('abcdefghijk lmnop')).toBe('abcdefghijk');
  });

  it('always yields only NAME_CHARS characters', () => {
    const name = sanitizeName('Ünïcödé 名前 & "quotes" <tag>');
    for (const ch of name) expect(NAME_CHARS).toContain(ch);
    expect(name.length).toBeLessThanOrEqual(NAME_MAX);
  });
});
