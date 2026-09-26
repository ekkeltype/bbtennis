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
  it('is 6n + 11 px at 1× (95 for the longest word)', () => {
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

  it('rejects anything but exactly 3 word lengths and 3 targets', () => {
    const targets = [240, 200, 280];
    for (const lens of [[], [5, 9], [5, 9, 14, 4]]) {
      expect(() => layoutChoice(lens, targets, 'far'), `${lens.length} lens`).toThrow(/layoutChoice.*3 word lengths/);
    }
    for (const ts of [[], [240, 200], [240, 200, 280, 100]]) {
      expect(() => layoutChoice([5, 9, 14], ts, 'near'), `${ts.length} targets`).toThrow(/layoutChoice.*3 target/);
    }
  });
});

describe('layoutServeNear', () => {
  const HEAD_XS = [0, 4, 20, 100, 239.5, 240, 240.5, 380, 460, 476, 480];

  it('stacks easy, medium, hard top to bottom with 3 px gaps, bottom level with the head top', () => {
    const boxes = layoutServeNear([5, 9, 14], 200, 200);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
    expect(boxes.map((b) => b.h)).toEqual([16, 16, 16]);
    expect(boxes.map((b) => b.y)).toEqual([146, 165, 184]);
    expect(boxes[2]!.y + boxes[2]!.h).toBe(200);
  });

  it('puts the stack right of a head left of centre, inner edges 8 px from the head', () => {
    const boxes = layoutServeNear([4, 7, 12], 200, 200);
    expect(boxes.map((b) => b.x)).toEqual([208, 208, 208]);
    expect(boxes.map((b) => b.w)).toEqual([4, 7, 12].map((n) => plateWidth(n)));
  });

  it('puts the stack left of a head right of centre, right edges 8 px from the head', () => {
    const boxes = layoutServeNear([4, 7, 12], 300, 200);
    expect(boxes.map((b) => b.x + b.w)).toEqual([292, 292, 292]);
  });

  it('rounds a fractional head outwards so the gap to the head stays ≥ 8 px', () => {
    expect(layoutServeNear([5], 199.5, 200)[0]!.x).toBe(208);
    const left = layoutServeNear([5], 300.5, 200)[0]!;
    expect(left.x + left.w).toBe(292);
  });

  it('keeps the toss column (head x ± 6) clear, toward the screen centre, for heads near both edges', () => {
    const bad = TRIPLES.flatMap((lens) =>
      HEAD_XS.flatMap((hx) =>
        [200, 60].flatMap((hy) => {
          const boxes = layoutServeNear(lens, hx, hy);
          const id = `${lens.join('/')} head ${hx},${hy}`;
          const out = problems(boxes).map((p) => `${id}: ${p}`);
          for (const b of boxes) {
            const right = b.x >= hx + 8;
            if (!right && b.x + b.w > hx - 8) out.push(`${id}: option ${b.option} within 8 px of the head`);
            if (hx < 240 && !right) out.push(`${id}: option ${b.option} left of a head left of centre`);
            if (hx > 240 && right) out.push(`${id}: option ${b.option} right of a head right of centre`);
          }
          return out;
        }),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('pushes the stack below the HUD band when the head is high on screen', () => {
    const boxes = layoutServeNear([5, 9, 14], 200, 40);
    expect(problems(boxes)).toEqual([]);
    expect(boxes[0]!.y).toBe(22);
  });

  it('keeps the stack above the bottom of the plate area when the head is low on screen', () => {
    const boxes = layoutServeNear([5, 9, 14], 200, 300);
    expect(problems(boxes)).toEqual([]);
    expect(boxes[2]!.y + boxes[2]!.h).toBe(266);
  });

  it('rejects an empty stack', () => {
    expect(() => layoutServeNear([], 240, 200)).toThrow(/layoutServeNear.*at least one word/);
  });
});

describe('layoutServeFar', () => {
  const SERVER_XS = [0, 4, 30, 100, 180, 239.5, 240, 240.5, 300, 380, 450, 476, 480];

  it('splits easy, medium, hard around a 12 px gap centred on the server, 4 px apart otherwise', () => {
    const boxes = layoutServeFar([5, 9, 14], 240);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
    expect(boxes.map((b) => b.y)).toEqual([22, 22, 22]);
    expect(boxes.map((b) => b.h)).toEqual([16, 16, 16]);
    expect(boxes.map((b) => b.w)).toEqual([41, 65, 95]);
    // 41 + 4 + 65 = 110 px left of the gap and 95 right of it balance the row best.
    expect(boxes.map((b) => b.x)).toEqual([124, 169, 246]);
  });

  it('chooses the split that centres the row best, here one plate left of the gap', () => {
    // The easy + medium pair (110 px) no longer fits left of a gap at x 94, so easy goes alone.
    expect(layoutServeFar([5, 9, 14], 100).map((b) => b.x)).toEqual([53, 106, 175]);
  });

  it('puts the whole row on one side of the gap for a server near an edge', () => {
    expect(layoutServeFar([5, 9, 14], 30).map((b) => b.x)).toEqual([36, 81, 150]);
    expect(layoutServeFar([5, 9, 14], 450).map((b) => b.x)).toEqual([235, 280, 349]);
  });

  it('keeps the toss gap clear, easy to hard left to right, on screen for servers near both edges', () => {
    const bad = TRIPLES.flatMap((lens) =>
      SERVER_XS.flatMap((sx) => {
        const boxes = layoutServeFar(lens, sx);
        const id = `${lens.join('/')} server ${sx}`;
        const out = problems(boxes).map((p) => `${id}: ${p}`);
        for (const b of boxes) {
          if (b.y !== 22) out.push(`${id}: option ${b.option} outside the far band`);
          if (b.x + b.w > sx - 6 && b.x < sx + 6) out.push(`${id}: option ${b.option} in the toss gap`);
        }
        boxes.slice(1).forEach((b, i) => {
          if (b.x < boxes[i]!.x + boxes[i]!.w + 4) out.push(`${id}: option ${b.option} not 4+ px right of ${i}`);
        });
        return out;
      }),
    );
    expect(bad).toEqual([]);
  });

  it('rounds a fractional server outwards so the gap stays ≥ 12 px', () => {
    const boxes = layoutServeFar([5, 9, 14], 240.5);
    expect(boxes[1]!.x + boxes[1]!.w).toBe(234);
    expect(boxes[2]!.x).toBe(247);
  });

  it('clamps the row to x 4–476 for a server off either side of the screen', () => {
    const left = layoutServeFar([5, 9, 14], -50);
    expect(problems(left)).toEqual([]);
    expect(left.map((b) => b.x)).toEqual([4, 49, 118]);
    const right = layoutServeFar([5, 9, 14], 530);
    expect(problems(right)).toEqual([]);
    expect(right[2]!.x + right[2]!.w).toBe(476);
  });

  it('rejects an empty row', () => {
    expect(() => layoutServeFar([], 240)).toThrow(/layoutServeFar.*at least one word/);
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
