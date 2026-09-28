import { describe, expect, it, vi } from 'vitest';

// Projection (Task 13) is exercised by its own tests; here the net line is the spec §4.1 value.
vi.mock('../../src/render/projection', () => ({ netScreenY: () => -80 + 320 / 1.5 }));

import { COURT } from '../../src/core/court';
import { TUNING } from '../../src/core/tuning';
import {
  BANDS,
  growUp,
  layoutChoice,
  layoutChoiceStack,
  layoutServeFar,
  layoutServeNear,
  layoutSingle,
  plateWidth,
  stackHeight,
  type PlateBox,
} from '../../src/render/layout';
import { CELL, type View } from '../../src/render/sprites/animations';
import { posesFor } from '../../src/render/sprites/poses';

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

/** Screen x of the tossing hand's centre relative to the feet, from serve frame 0 (as `ball.ts` places the toss). */
const tossHandDx = (view: View): number => posesFor('serve', view)[0]!.handL.x + 0.5 - CELL.anchorX;

/** First and last column of the tossed ball (a 5 px sprite, outline included) for feet at screen x `hx`. */
function tossBallCols(hx: number, view: View): [number, number] {
  const cx = Math.round(hx + tossHandDx(view));
  return [cx - 2, cx + 2];
}

/** Every plate whose 1 px halo (x − 1 … x + w) leaves no court pixel between it and the tossed ball. */
function tossProblems(boxes: PlateBox[], hx: number, view: View, id: string): string[] {
  const [first, last] = tossBallCols(hx, view);
  return boxes
    .filter((b) => b.x - 1 <= last + 1 && b.x + b.w >= first - 1)
    .map((b) => `${id}: option ${b.option} (x ${b.x}–${b.x + b.w - 1}) within 1 px of the ball (x ${first}–${last})`);
}

/** Screen x of a server's feet at world y `y` (spec §4.1: x = 240 ± serverX · 27.35 / d, viewer at end 0). */
function serverScreenXs(y: number): number[] {
  const d = 1 + (y + COURT.halfLength) / (2 * COURT.halfLength);
  const dx = (TUNING.positions.serverX * 27.35) / d;
  return [240 - dx, 240 + dx];
}
const NEAR_SERVER_XS = serverScreenXs(-TUNING.positions.serverY);
const FAR_SERVER_XS = serverScreenXs(TUNING.positions.serverY);

describe('the tossed ball (ball.ts)', () => {
  it('rises over the tossing hand: 6.5 px left of the feet for a near server, 6.5 px right for a far one', () => {
    // The serve layouts' toss clearances assume this; revisit TOSS_CLEAR_NEAR/FAR if the sprite changes.
    expect(tossHandDx('near')).toBe(-6.5);
    expect(tossHandDx('far')).toBe(6.5);
    expect(NEAR_SERVER_XS.map((x) => x.toFixed(2))).toEqual(['217.73', '262.27']);
    expect(FAR_SERVER_XS.map((x) => x.toFixed(2))).toEqual(['229.15', '250.85']);
  });
});

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
      expect(() => layoutChoice(lens, targets, 'far'), `${lens.length} lens`).toThrow(/3 or 4/);
    }
    for (const ts of [[], [240, 200], [240, 200, 280, 100]]) {
      expect(() => layoutChoice([5, 9, 14], ts, 'near'), `${ts.length} targets`).toThrow(/3 or 4/);
    }
  });
});

describe('4-option plates (power-meter spec §6)', () => {
  const BANDS_ = ['far', 'near'] as const;
  const RANGE = { easy: [2, 4], medium: [5, 7], hard: [8, 11], insane: [12, 15] } as const;
  const lensGrid = (): number[][] => {
    const out: number[][] = [];
    for (let e = RANGE.easy[0]; e <= RANGE.easy[1]; e++)
      for (let m = RANGE.medium[0]; m <= RANGE.medium[1]; m++)
        for (let h = RANGE.hard[0]; h <= RANGE.hard[1]; h++)
          for (let i = RANGE.insane[0]; i <= RANGE.insane[1]; i++) out.push([e, m, h, i]);
    return out;
  };
  const overlap = (a: PlateBox, b: PlateBox): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const inside = (b: PlateBox): boolean => b.x >= 4 && b.x + b.w <= 476 && b.y >= 22 && b.y + b.h <= 266;
  /** Target screen x for [easy, medium, hard, insane]: medium and insane on one side, insane outermost. */
  const XS = { left: [240, 150, 340, 110], right: [240, 330, 140, 370] };

  it('puts the four plates in slots 60 / 180 / 300 / 420 by target x: insane outermost on medium\'s side', () => {
    const lens = [3, 6, 10, 14];
    const centre = (b: PlateBox): number => b.x + (b.w - 1) / 2;
    const left = layoutChoice(lens, XS.left, 'far');
    expect(left.map((b) => Math.round(centre(b)))).toEqual([300, 180, 420, 60]);
    const right = layoutChoice(lens, XS.right, 'far');
    expect(right.map((b) => Math.round(centre(b)))).toEqual([180, 300, 60, 420]);
  });

  it('never overlaps and stays inside x 4–476, y 22–266 for every length in each tier\'s band', () => {
    const bad: string[] = [];
    for (const lens of lensGrid()) {
      for (const band of BANDS_) {
        for (const xs of [XS.left, XS.right]) {
          const boxes = layoutChoice(lens, xs, band);
          boxes.forEach((a, i) => {
            if (!inside(a)) bad.push(`${lens} ${band} option ${i} outside`);
            boxes.slice(i + 1).forEach((b) => overlap(a, b) && bad.push(`${lens} ${band} ${a.option}/${b.option}`));
          });
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('serve stacks and rows of 4 stay inside, never overlap, keep clear of the toss column, and the widest plate is 101 px', () => {
    expect(plateWidth(15)).toBe(101);
    const bad: string[] = [];
    for (const lens of lensGrid()) {
      const near = layoutServeNear(lens, 262, 200);
      const far = layoutServeFar(lens, 251);
      for (const boxes of [near, far]) {
        boxes.forEach((a, i) => {
          if (!inside(a)) bad.push(`${lens} option ${i} outside`);
          boxes.slice(i + 1).forEach((b) => overlap(a, b) && bad.push(`${lens} ${a.option}/${b.option}`));
        });
      }
      // Near server right of centre: the stack goes left, its inner edge ≥ 10 px from the head.
      for (const b of near) if (b.x + b.w > 252) bad.push(`${lens} near option ${b.option} in the toss column`);
      // Far server: every plate ends ≥ 12 px left of it or starts ≥ 12 px right of it.
      for (const b of far) if (!(b.x + b.w <= 239 || b.x >= 263)) bad.push(`${lens} far option ${b.option} in the toss gap`);
    }
    expect(bad).toEqual([]);
  });

  it('rejects 2 or 5 options, or mismatched target counts', () => {
    expect(() => layoutChoice([3, 6], [240, 150], 'far')).toThrow(/3 or 4/);
    expect(() => layoutChoice([3, 6, 10, 14, 5], [1, 2, 3, 4, 5], 'far')).toThrow(/3 or 4/);
    expect(() => layoutChoice([3, 6, 10, 14], [240, 150, 340], 'far')).toThrow(/3 or 4/);
  });
});

describe('layoutServeNear', () => {
  const HEAD_XS = [0, 4, 20, 100, ...NEAR_SERVER_XS, 239.5, 240, 240.5, 262, 262.5, 263, 380, 460, 476, 480];

  it('stacks easy, medium, hard top to bottom with 3 px gaps, bottom level with the head top', () => {
    const boxes = layoutServeNear([5, 9, 14], 200, 200);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
    expect(boxes.map((b) => b.h)).toEqual([16, 16, 16]);
    expect(boxes.map((b) => b.y)).toEqual([146, 165, 184]);
    expect(boxes[2]!.y + boxes[2]!.h).toBe(200);
  });

  it('puts the stack right of a head left of centre, inner edges 10 px from the head', () => {
    const boxes = layoutServeNear([4, 7, 12], 200, 200);
    expect(boxes.map((b) => b.x)).toEqual([210, 210, 210]);
    expect(boxes.map((b) => b.w)).toEqual([4, 7, 12].map((n) => plateWidth(n)));
  });

  it('puts the stack left of a head right of centre, right edges 10 px from the head', () => {
    const boxes = layoutServeNear([4, 7, 12], 300, 200);
    expect(boxes.map((b) => b.x + b.w)).toEqual([290, 290, 290]);
  });

  it('rounds a fractional head outwards so the gap to the head stays ≥ 10 px', () => {
    expect(layoutServeNear([5], 199.5, 200)[0]!.x).toBe(210);
    const left = layoutServeNear([5], 300.5, 200)[0]!;
    expect(left.x + left.w).toBe(290);
  });

  it('leaves a court pixel between the halo and the tossed ball of the real deuce-court server', () => {
    // Feet at x 262.27: the ball (x 254–258) sits left of the head, on the stack's side; the plates
    // end at x 251, their halo at x 252, and x 253 shows court.
    const [hx] = NEAR_SERVER_XS.slice(1) as [number];
    expect(tossBallCols(hx, 'near')).toEqual([254, 258]);
    const boxes = layoutServeNear([5, 9, 14], hx, 200);
    expect(boxes.map((b) => b.x + b.w)).toEqual([252, 252, 252]);
  });

  it('keeps the tossed ball clear, toward the screen centre, for heads near both edges', () => {
    const bad = TRIPLES.flatMap((lens) =>
      HEAD_XS.flatMap((hx) =>
        [200, 60].flatMap((hy) => {
          const boxes = layoutServeNear(lens, hx, hy);
          const id = `${lens.join('/')} head ${hx},${hy}`;
          const out = problems(boxes).map((p) => `${id}: ${p}`);
          out.push(...tossProblems(boxes, hx, 'near', id));
          for (const b of boxes) {
            const right = b.x >= hx + 10;
            if (!right && b.x + b.w > hx - 10) out.push(`${id}: option ${b.option} within 10 px of the head`);
            if (hx < 240 && !right) out.push(`${id}: option ${b.option} left of a head left of centre`);
            if (hx > 240 && right) out.push(`${id}: option ${b.option} right of a head right of centre`);
          }
          return out;
        }),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('grows a locked word redrawn at 2× (Large words) away from the head, keeping its inner edge and bottom', () => {
    const one = layoutServeNear([4, 7, 12], 200, 200);
    const big = layoutServeNear([4, 7, 12], 200, 200, 1);
    expect(big[1]).toEqual({ x: 210, y: one[1]!.y + 16 - 32, w: plateWidth(7, 2), h: 32, option: 1 });
    expect([big[0], big[2]]).toEqual([one[0], one[2]]);
    const left = layoutServeNear([4, 7, 12], 300, 200, 2)[2]!;
    expect([left.x + left.w, left.y + left.h, left.w, left.h]).toEqual([290, 200, plateWidth(12, 2), 32]);
  });

  it('keeps the tossed ball clear of a locked word at 2× for every word length 3–14, on both sides of the screen', () => {
    const bad = TRIPLES.flatMap((lens) =>
      HEAD_XS.flatMap((hx) =>
        [200, 60].flatMap((hy) =>
          [0, 1, 2].flatMap((large) => {
            const b = layoutServeNear(lens, hx, hy, large)[large]!;
            const id = `${lens.join('/')} head ${hx},${hy}, option ${large} at 2×`;
            const out = problems([b]).map((p) => `${id}: ${p}`);
            out.push(...tossProblems([b], hx, 'near', id));
            if (b.w !== plateWidth(lens[large]!, 2) || b.h !== 32) out.push(`${id}: not doubled`);
            const right = layoutServeNear(lens, hx, hy)[large]!.x >= hx;
            if (right ? b.x < hx + 10 : b.x + b.w > hx - 10) out.push(`${id}: within 10 px of the head`);
            return out;
          }),
        ),
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
  const SERVER_XS = [0, 4, 30, 100, 180, ...FAR_SERVER_XS, 239.5, 240, 240.5, 251, 300, 380, 450, 476, 480];

  it('splits easy, medium, hard around a 24 px gap centred on the server, 4 px apart otherwise', () => {
    const boxes = layoutServeFar([5, 9, 14], 240);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2]);
    expect(boxes.map((b) => b.y)).toEqual([22, 22, 22]);
    expect(boxes.map((b) => b.h)).toEqual([16, 16, 16]);
    expect(boxes.map((b) => b.w)).toEqual([41, 65, 95]);
    // 41 + 4 + 65 = 110 px left of the gap and 95 right of it balance the row best.
    expect(boxes.map((b) => b.x)).toEqual([118, 163, 252]);
  });

  it('leaves a court pixel between the first plate right of the gap and the tossed ball', () => {
    // The ball rises right of the far server's feet: x 234–238 for feet at x 229.15, 255–259 at 250.85.
    const [left, right] = FAR_SERVER_XS as [number, number];
    expect(tossBallCols(left, 'far')).toEqual([234, 238]);
    expect(layoutServeFar([5, 9, 14], left).map((b) => b.x)).toEqual([107, 152, 242]);
    expect(tossBallCols(right, 'far')).toEqual([255, 259]);
    expect(layoutServeFar([5, 9, 14], right).map((b) => b.x)).toEqual([128, 173, 263]);
  });

  it('chooses the split that centres the row best, here one plate left of the gap', () => {
    // The easy + medium pair (110 px) no longer fits left of a gap at x 88, so easy goes alone.
    expect(layoutServeFar([5, 9, 14], 100).map((b) => b.x)).toEqual([47, 112, 181]);
  });

  it('puts the whole row on one side of the gap for a server near an edge', () => {
    expect(layoutServeFar([5, 9, 14], 30).map((b) => b.x)).toEqual([42, 87, 156]);
    expect(layoutServeFar([5, 9, 14], 450).map((b) => b.x)).toEqual([229, 274, 343]);
  });

  it('keeps the toss gap and the tossed ball clear, easy to hard left to right, on screen near both edges', () => {
    const bad = TRIPLES.flatMap((lens) =>
      SERVER_XS.flatMap((sx) => {
        const boxes = layoutServeFar(lens, sx);
        const id = `${lens.join('/')} server ${sx}`;
        const out = problems(boxes).map((p) => `${id}: ${p}`);
        out.push(...tossProblems(boxes, sx, 'far', id));
        for (const b of boxes) {
          if (b.y !== 22) out.push(`${id}: option ${b.option} outside the far band`);
          if (b.x + b.w > sx - 12 && b.x < sx + 12) out.push(`${id}: option ${b.option} in the toss gap`);
        }
        boxes.slice(1).forEach((b, i) => {
          if (b.x < boxes[i]!.x + boxes[i]!.w + 4) out.push(`${id}: option ${b.option} not 4+ px right of ${i}`);
        });
        return out;
      }),
    );
    expect(bad).toEqual([]);
  });

  it('grows a locked word redrawn at 2× (Large words) away from the toss gap, keeping its top and gap-side edge', () => {
    // At 1×: x 118 / 163 / 252, 41 / 65 / 95 px wide, the gap x 228–251.
    const one = layoutServeFar([5, 9, 14], 240);
    expect(layoutServeFar([5, 9, 14], 240, 0)[0]).toEqual({ x: 159 - 82, y: 22, w: 82, h: 32, option: 0 });
    expect(layoutServeFar([5, 9, 14], 240, 1)[1]).toEqual({ x: 228 - 130, y: 22, w: 130, h: 32, option: 1 });
    const big = layoutServeFar([5, 9, 14], 240, 2);
    expect(big[2]).toEqual({ x: 252, y: 22, w: 190, h: 32, option: 2 });
    expect(big.slice(0, 2)).toEqual(one.slice(0, 2));
  });

  it('moves a 2× word with no room on its side of the gap next to the gap on the other side', () => {
    // Easy alone left of a server at x 70 (x 17–57); 82 px wide at 2×, it cannot end left of x 58.
    expect(layoutServeFar([5, 9, 14], 70)[0]).toMatchObject({ x: 17, w: 41 });
    expect(layoutServeFar([5, 9, 14], 70, 0)[0]).toEqual({ x: 82, y: 22, w: 82, h: 32, option: 0 });
  });

  it('keeps the toss gap and the tossed ball clear of a locked word at 2× for every word length 3–14', () => {
    const bad = TRIPLES.flatMap((lens) =>
      [...SERVER_XS, -50, 530].flatMap((sx) =>
        [0, 1, 2].flatMap((large) => {
          const b = layoutServeFar(lens, sx, large)[large]!;
          const id = `${lens.join('/')} server ${sx}, option ${large} at 2×`;
          const out = problems([b]).map((p) => `${id}: ${p}`);
          out.push(...tossProblems([b], sx, 'far', id));
          if (b.w !== plateWidth(lens[large]!, 2) || b.h !== 32) out.push(`${id}: not doubled`);
          if (b.y !== 22) out.push(`${id}: not at the top of the far band`);
          if (b.x + b.w > sx - 12 && b.x < sx + 12) out.push(`${id}: in the toss gap`);
          return out;
        }),
      ),
    );
    expect(bad).toEqual([]);
  });

  it('rounds a fractional server outwards so the gap stays ≥ 24 px', () => {
    const boxes = layoutServeFar([5, 9, 14], 240.5);
    expect(boxes[1]!.x + boxes[1]!.w).toBe(228);
    expect(boxes[2]!.x).toBe(253);
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

describe('layoutChoiceStack (choice-stack spec §2)', () => {
  /** Every length of each tier's band (easy 2–4, medium 5–7, hard 8–11, insane 12–15), 3 and 4 options. */
  const STACKS: number[][] = [2, 3, 4].flatMap((e) =>
    [5, 6, 7].flatMap((m) => [8, 9, 10, 11].flatMap((h) => [[e, m, h], ...[12, 13, 14, 15].map((i) => [e, m, h, i])])),
  );

  it('stacks the options in tier order, 3 px apart, ending at bottomY, each centred on the column', () => {
    const boxes = layoutChoiceStack([4, 7, 11, 15], 200, 190);
    expect(boxes.map((b) => b.option)).toEqual([0, 1, 2, 3]);
    expect(boxes.map((b) => b.w)).toEqual([35, 53, 77, 101]);
    expect(boxes.map((b) => b.y)).toEqual([117, 136, 155, 174]);
    expect(boxes.every((b) => b.h === 16)).toBe(true);
    for (const b of boxes) expect(b.x + (b.w - 1) / 2).toBe(200);
    expect(stackHeight(4)).toBe(73);
    expect(stackHeight(3)).toBe(54);
  });

  it('is a pyramid: each plate reaches at least 3 px farther than the one above on both sides', () => {
    for (const lens of STACKS) {
      const boxes = layoutChoiceStack(lens, 240.4, 200);
      for (let i = 1; i < boxes.length; i++) {
        const [up, b] = [boxes[i - 1]!, boxes[i]!];
        expect(b.x, `${lens}`).toBeLessThanOrEqual(up.x - 3);
        expect(b.x + b.w, `${lens}`).toBeGreaterThanOrEqual(up.x + up.w + 3);
      }
    }
  });

  it('throws unless given 3 or 4 lengths', () => {
    expect(() => layoutChoiceStack([4, 7], 240, 200)).toThrow('layoutChoiceStack needs 3 or 4 word lengths');
  });
});

describe('growUp (choice-stack spec §2, Large words)', () => {
  it('doubles a stack plate around its centre column, keeping its bottom edge', () => {
    expect(growUp({ x: 150, y: 174, w: 101, h: 16, option: 3 })).toEqual({ x: 100, y: 158, w: 202, h: 32, option: 3 });
  });

  it('stays inside x 4–476 and y 22–266', () => {
    expect(growUp({ x: 4, y: 30, w: 101, h: 16, option: 3 })).toEqual({ x: 4, y: 22, w: 202, h: 32, option: 3 });
    expect(growUp({ x: 375, y: 250, w: 101, h: 16, option: 3 }).x).toBe(274);
  });
});
