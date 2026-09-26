import { describe, expect, it } from 'vitest';
import { nameChipBox, type PlateDraw } from '../../src/render/plates';
import { plateStates, stateBounds } from '../../tools/art/plates';

interface Rect { x: number; y: number; w: number; h: number }

const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const chipOf = (p: PlateDraw): Rect | null =>
  p.nameChip === null ? null : nameChipBox(p.nameChip, p.box.x, p.box.y, p.box.w, p.scale);

describe('art page plates panel', () => {
  it('hangs every name chip clear of the other plates of its row, as the real layouts do', () => {
    const bad = plateStates().flatMap(({ label, plates }) =>
      plates.flatMap((p, i) => {
        const chip = chipOf(p);
        if (chip === null) return [];
        return plates
          .filter((q, j) => j !== i && overlaps(chip, q.box))
          .map((q) => `${label}: ${p.nameChip}'s chip over option ${q.box.option}`);
      }),
    );
    expect(bad).toEqual([]);
  });

  it('crops every row to take in its name chips, beside a plate as well as above it', () => {
    const states = plateStates();
    expect(states.some(({ plates }) => plates.some((p) => chipOf(p) !== null && p.box.y === 22))).toBe(true);
    for (const { label, plates } of states) {
      const b = stateBounds(plates);
      for (const chip of plates.map(chipOf)) {
        if (chip === null) continue;
        expect(chip.x >= b.left && chip.x + chip.w <= b.right && chip.y >= b.top && chip.y + chip.h <= b.bottom, label).toBe(true);
      }
    }
  });

  it('labels the far-band row with its tabs beside the plates, not below', () => {
    const far = plateStates().filter(({ plates }) => plates.every((p) => p.box.y === 22 && p.nameChip !== null));
    expect(far.map((s) => s.label)).toEqual([expect.stringContaining('chips beside')]);
  });
});
