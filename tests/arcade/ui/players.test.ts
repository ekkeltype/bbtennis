import { describe, expect, it } from 'vitest';
import { ArcadeAttract } from '../../../src/arcade/ui/attract';
import { arcadeCpuPlayer } from '../../../src/arcade/ui/players';
import { BELTS } from '../../../src/core/belts';
import { BELT_COLOR } from '../../../src/render/palette';
import { isLook } from '../../../src/ui/settings';

describe('arcadeCpuPlayer', () => {
  it('names the CPU after its belt colour, title case', () => {
    expect(arcadeCpuPlayer(0).name).toBe('White Belt');
    expect(arcadeCpuPlayer(4).name).toBe('Yellow Belt');
    expect(arcadeCpuPlayer(8).name).toBe('Green Belt');
    expect(arcadeCpuPlayer(10).name).toBe('Brown Belt');
    for (const level of [12, 13, 14]) expect(arcadeCpuPlayer(level).name).toBe('Black Belt');
  });

  it.each(BELTS.map((b) => b.level))('level %i: a valid look with its belt colour as the headband, the same every time', (level) => {
    const p = arcadeCpuPlayer(level);
    expect(p.kind).toBe('cpu');
    expect(p.cpuLevel).toBe(level);
    expect(isLook(p.look)).toBe(true);
    expect(p.look.headband).toBe(BELT_COLOR[BELTS[level]!.belt]);
    expect(Object.values(BELT_COLOR)).not.toContain(p.look.shirt);
    expect(arcadeCpuPlayer(level)).toEqual(p);
  });

  it('dresses the levels differently (seeded per level)', () => {
    const looks = new Set(BELTS.map((b) => JSON.stringify(arcadeCpuPlayer(b.level).look)));
    expect(looks.size).toBeGreaterThan(10);
  });
});

describe('ArcadeAttract', () => {
  it('plays CPU vs CPU for a spectator: two different belts from Green to Black, Normal-pace tiebreak', () => {
    for (const r of [0, 0.3, 0.6, 0.999]) {
      const view = new ArcadeAttract(() => r).frame(0);
      expect(view.viewer).toBe('spectator');
      const { config, players } = view.state;
      expect(config.format).toBe('tiebreak');
      expect(config.pace).toBe('normal');
      const levels = players.map((p) => p.cpuLevel);
      expect(players.every((p) => p.kind === 'cpu')).toBe(true);
      for (const l of levels) {
        expect(l).toBeGreaterThanOrEqual(6);
        expect(l).toBeLessThanOrEqual(12);
      }
      expect(levels[0]).not.toBe(levels[1]);
    }
  });

  it('keeps one demo until it is over, then starts a new one', () => {
    const attract = new ArcadeAttract();
    const first = attract.frame(0).state;
    let view = attract.frame(0);
    let frames = 0;
    while (view.state === first && frames < 50_000) {
      view = attract.frame(250);
      frames++;
    }
    expect(first.status).toBe('over');
    expect(view.state).not.toBe(first);
    expect(view.state.status).toBe('playing');
  });
});
