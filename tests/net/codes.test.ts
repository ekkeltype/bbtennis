import { describe, expect, it } from 'vitest';
import { ALPHABET, genCode, normalizeCode } from '../../src/net/codes';
import { seedRng, uniform } from '../../src/core/rng';

describe('ALPHABET', () => {
  it('has the 31 unambiguous characters and none of 0/O/1/I/L', () => {
    expect(ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    expect(ALPHABET).toHaveLength(31);
    for (const ch of '0O1IL') expect(ALPHABET).not.toContain(ch);
  });
});

describe('genCode', () => {
  it('returns 5 characters, all from the alphabet', () => {
    const rng = seedRng(7);
    for (let i = 0; i < 2000; i++) {
      const code = genCode(() => uniform(rng));
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
    }
  });

  it('maps the ends of [0, 1) to the first and last alphabet characters', () => {
    expect(genCode(() => 0)).toBe('AAAAA');
    expect(genCode(() => 0.999999999)).toBe('99999');
  });

  it('stays inside the alphabet even if rand returns exactly 1', () => {
    expect(genCode(() => 1)).toBe('99999');
  });

  it('uses every alphabet character given enough draws', () => {
    const rng = seedRng(42);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of genCode(() => uniform(rng))) seen.add(ch);
    expect([...seen].sort().join('')).toBe([...ALPHABET].sort().join(''));
  });
});

describe('normalizeCode', () => {
  it('trims and uppercases a valid code', () => {
    expect(normalizeCode(' k7tqm ')).toBe('K7TQM');
    expect(normalizeCode('ABCDE')).toBe('ABCDE');
  });

  it.each(['K7TQ0', 'K7TQO', 'K7TQ1', 'K7TQI', 'K7TQL', 'k7tqo', 'k7tql', 'k7tqi'])('rejects %s (ambiguous character)', (s) => {
    expect(normalizeCode(s)).toBeNull();
  });

  it.each(['', '     ', 'K7TQ', 'K7TQMM', 'K7 QM', 'K7-QM', 'K7TQ!', 'ÄBCDE'])('rejects %j (wrong length or character)', (s) => {
    expect(normalizeCode(s)).toBeNull();
  });
});
