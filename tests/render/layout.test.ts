import { describe, expect, it, vi } from 'vitest';

// Projection (Task 13) is exercised by its own tests; here the net line is the spec §4.1 value.
vi.mock('../../src/render/projection', () => ({ netScreenY: () => -80 + 320 / 1.5 }));

import {
  BANDS,
  layoutChoice,
  layoutServeFar,
  layoutServeNear,
  layoutSingle,
  plateWidth,
  type PlateBox,
} from '../../src/render/layout';

const EASY = [3, 4, 5];
const MEDIUM = [6, 7, 8, 9];
const HARD = [10, 11, 12, 13, 14];
const TRIPLES: number[][] = EASY.flatMap((e) => MEDIUM.flatMap((m) => HARD.map((h) => [e, m, h])));
const NEAR_BAND_TOP = Math.round(-80 + 320 / 1.5 + 6);

/** Every way the boxes break the spec §4.2 rules: off the 4–476 × 22–266 area, fractional, or overlapping. */
function problems(boxes: PlateBox[]): string[] {
  const out: string[] = [];
  for (const b of boxes) {
    const id = `option ${b.option} ${JSON.stringify(b)}`;
    if (![b.x, b.y, b.w, b.h].every(Number.isInteger)) out.push(`${id} not on whole pixels`);
    if (b.x < 4 || b.x + b.w > 476) out.push(`${id} outside x 4–476`);
    if (b.y < 22 || b.y + b.h > 266) out.push(`${id} outside y 22–266`);
  }
  boxes.forEach((a, i) =>
    boxes.slice(i + 1).forEach((b) => {
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        out.push(`options ${a.option} and ${b.option} intersect`);
      }
    }),
  );
  return out;
}

const centreX = (b: PlateBox): number => b.x + (b.w - 1) / 2;

describe('plateWidth', () => {
  it('is 6n + 11 px at 1×, capped by the longest word at 95', () => {
    expect(plateWidth(3)).toBe(29);
    expect(plateWidth(8)).toBe(59);
    expect(plateWidth(14)).toBe(95);
  });

  it('doubles at 2×', () => {
    expect(plateWidth(14, 2)).toBe(190);
    expect(plateWidth(3, 2)).toBe(58);
  });
});

describe('BANDS', () => {
  it('reserves y 0–21 for the HUD and y 22–38 for the far prompt band', () => {
    expect(BANDS).toEqual({ hud: [0, 21], far: [22, 38] });
  });
});

describe('layoutChoice', () => {
  const sides: [string, number[]][] = [
    ['medium left, hard right', [240, 200, 280]],
    ['medium right, hard left', [240, 280, 200]],
  ];

  for (const band of ['far', 'near'] as const) {
    for (const [side, targets] of sides) {
      it(`${band} band, ${side}: every length triple fits the screen without overlaps`, () => {
        const bad = TRIPLES.flatMap((lens) =>
          problems(layoutChoice(lens, targets, band)).map((p) => `${lens.join('/')}: ${p}`),
        );
        expect(bad).toEqual([]);
      });

      it(`${band} band, ${side}: easy takes the centre slot, medium and hard their target's side`, () => {
        const mediumSlot = targets[1]! < targets[2]! ? 90 : 390;
        const hardSlot = 480 - mediumSlot;
        for (const lens of TRIPLES) {
          const boxes = layoutChoice(lens, targets, band);
          expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
          expect(boxes.map((b) => b.w)).toEqual(lens.map((n) => plateWidth(n)));
          expect(boxes.map((b) => b.h)).toEqual([16, 16, 16]);
          expect(boxes.map(centreX)).toEqual([240, mediumSlot, hardSlot]);
        }
      });
    }
  }

  it('puts far-band plates at the top of the far prompt band', () => {
    for (const b of layoutChoice([5, 9, 14], [240, 200, 280], 'far')) expect(b.y).toBe(BANDS.far[0]);
  });

  it('tops near-band plates 6 px below the net line', () => {
    for (const b of layoutChoice([5, 9, 14], [240, 200, 280], 'near')) expect(b.y).toBe(NEAR_BAND_TOP);
  });

  it('decides the side by comparing the medium and hard targets, even when both lie on one half', () => {
    const boxes = layoutChoice([4, 7, 12], [240, 250, 230], 'far');
    expect(boxes.map(centreX)).toEqual([240, 390, 90]);
  });
});

describe('layoutServeNear', () => {
  const HEAD_XS = [0, 4, 20, 240, 460, 476, 480];

  it('stacks easy, medium, hard top to bottom with 2 px gaps, bottom 4 px above the head', () => {
    const boxes = layoutServeNear([5, 9, 14], 240, 200);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
    expect(boxes.map((b) => b.y)).toEqual([144, 162, 180]);
    expect(boxes[2]!.y + boxes[2]!.h).toBe(200 - 4);
  });

  it('left-aligns the stack and centres its widest plate over the head', () => {
    const boxes = layoutServeNear([4, 7, 12], 240, 200);
    const widest = plateWidth(12);
    expect(boxes.map((b) => b.x)).toEqual([240 - (widest - 1) / 2, 240 - (widest - 1) / 2, 240 - (widest - 1) / 2]);
  });

  it('keeps every stack on screen for heads near both edges', () => {
    const bad = TRIPLES.flatMap((lens) =>
      HEAD_XS.flatMap((hx) =>
        problems(layoutServeNear(lens, hx, 200)).map((p) => `${lens.join('/')} head ${hx}: ${p}`),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('pushes the stack below the HUD band when the head is high on screen', () => {
    const boxes = layoutServeNear([5, 9, 14], 240, 40);
    expect(problems(boxes)).toEqual([]);
    expect(boxes[0]!.y).toBe(22);
  });
});

describe('layoutServeFar', () => {
  it('lays easy, medium, hard left to right in the far band, centred on the server', () => {
    const boxes = layoutServeFar([5, 9, 14], 240);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
    expect(boxes.map((b) => b.y)).toEqual([22, 22, 22]);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.w);
    expect(boxes[2]!.x).toBeGreaterThan(boxes[1]!.x + boxes[1]!.w);
    const left = boxes[0]!.x;
    const right = boxes[2]!.x + boxes[2]!.w;
    expect(Math.abs((left + right) / 2 - 240)).toBeLessThanOrEqual(0.5);
  });

  it('clamps the row to x 4–476 for servers near both edges', () => {
    const bad = TRIPLES.flatMap((lens) =>
      [0, 30, 240, 450, 480].flatMap((sx) =>
        problems(layoutServeFar(lens, sx)).map((p) => `${lens.join('/')} server ${sx}: ${p}`),
      ),
    );
    expect(bad).toEqual([]);
    expect(layoutServeFar([5, 9, 14], 0)[0]!.x).toBe(4);
    const row = layoutServeFar([5, 9, 14], 480);
    expect(row[2]!.x + row[2]!.w).toBe(476);
  });
});

describe('layoutSingle', () => {
  it('centres the plate on the head, bottom 4 px above it', () => {
    expect(layoutSingle(5, 240, 200, 1)).toEqual({ x: 220, y: 180, w: 41, h: 16, option: 0 });
  });

  it('draws 2× plates at double size', () => {
    expect(layoutSingle(5, 240, 200, 2)).toEqual({ x: 200, y: 164, w: 82, h: 32, option: 0 });
  });

  it('clamps a 2× long word inside x ≤ 476', () => {
    const box = layoutSingle(14, 470, 200, 2);
    expect(box.x + box.w).toBeLessThanOrEqual(476);
    expect(box).toEqual({ x: 286, y: 164, w: 190, h: 32, option: 0 });
  });

  it('clamps to the left edge and below the HUD band', () => {
    expect(layoutSingle(14, 0, 30, 2)).toEqual({ x: 4, y: 22, w: 190, h: 32, option: 0 });
  });
});
