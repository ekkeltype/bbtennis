import { describe, expect, it } from 'vitest';
import { CPU_LEVELS } from '../../src/core/cpu';
import { sanitizeName } from '../../src/core/text';
import { BELT_COLOR } from '../../src/render/palette';
import { attractPlayers, cpuPlayer, humanPlayer } from '../../src/ui/players';
import { DEFAULT_PROFILE, isProfile } from '../../src/ui/settings';

describe('cpuPlayer', () => {
  it.each(CPU_LEVELS.map((l) => l.level))('level %i: a valid name and look, wearing its belt as a headband', (level) => {
    const p = cpuPlayer(level);
    expect(p.kind).toBe('cpu');
    expect(p.cpuLevel).toBe(level);
    expect(sanitizeName(p.name)).toBe(p.name);
    expect(isProfile({ name: p.name, look: p.look })).toBe(true);
    expect(p.look.headband).toBe(BELT_COLOR[CPU_LEVELS[level]!.belt]);
  });

  it('gives every level its own name', () => {
    const names = CPU_LEVELS.map((l) => cpuPlayer(l.level).name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('humanPlayer', () => {
  it('plays the profile as a human', () => {
    const p = humanPlayer({ name: 'ALEX', look: DEFAULT_PROFILE.look });
    expect(p).toEqual({ name: 'ALEX', look: DEFAULT_PROFILE.look, kind: 'human', cpuLevel: null });
  });

  it('copies the look, so later profile edits do not reach a running match', () => {
    const profile = { name: 'ALEX', look: { ...DEFAULT_PROFILE.look } };
    const p = humanPlayer(profile);
    profile.look.shirt = 5;
    expect(p.look.shirt).toBe(DEFAULT_PROFILE.look.shirt);
  });
});

describe('attractPlayers', () => {
  it('picks two CPU levels from Green to Black (6..12) with the random source', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const r = (i * 0.618) % 1;
      const [a, b] = attractPlayers(() => r);
      for (const p of [a, b]) {
        expect(p.kind).toBe('cpu');
        expect(p.cpuLevel).toBeGreaterThanOrEqual(6);
        expect(p.cpuLevel).toBeLessThanOrEqual(12);
        seen.add(p.cpuLevel!);
      }
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it('picks two different levels, even from a stuck random source', () => {
    for (const r of [0, 0.5, 0.999]) {
      const [a, b] = attractPlayers(() => r);
      expect(a.cpuLevel).not.toBe(b.cpuLevel);
      expect(a.name).not.toBe(b.name);
    }
  });
});
