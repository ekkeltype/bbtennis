import { describe, expect, it } from 'vitest';
import { BELTS, isMilestoneBelt } from '../../src/core/belts';
import { CPU_LEVELS } from '../../src/core/cpu';

describe('BELTS', () => {
  it('has 15 ranks whose index is the level', () => {
    expect(BELTS).toHaveLength(15);
    BELTS.forEach((b, i) => expect(b.level).toBe(i));
  });

  it('has the same labels, belts, stripes and dan as CPU_LEVELS', () => {
    expect(BELTS.map((b) => b.label)).toEqual(CPU_LEVELS.map((l) => l.label));
    expect(BELTS.map((b) => [b.belt, b.stripes, b.dan])).toEqual(CPU_LEVELS.map((l) => [l.belt, l.stripes, l.dan]));
  });

  it('labels the star and dan ranks as the typing game does', () => {
    expect(BELTS[8]?.label).toBe('GREEN BELT ★★');
    expect(BELTS[13]?.label).toBe('BLACK BELT 2ND DAN');
  });
});

describe('isMilestoneBelt', () => {
  it('is true exactly for levels 0, 3, 6, 9, 12, 13, 14', () => {
    const milestones = BELTS.map((b) => b.level).filter(isMilestoneBelt);
    expect(milestones).toEqual([0, 3, 6, 9, 12, 13, 14]);
  });

  it('is false outside the table', () => {
    expect(isMilestoneBelt(-1)).toBe(false);
    expect(isMilestoneBelt(15)).toBe(false);
  });
});
