import { describe, expect, it } from 'vitest';
import { insaneRallyTarget, rallyTargets } from '../../src/core/court';
import type { Look, Tier } from '../../src/core/types';
import { besideColumn, layoutChoiceStack, plateWidth } from '../../src/render/layout';
import { placeChoiceStack, routeStackLeaders, type PlacedStack } from '../../src/render/leaders';
import { inRingKeepOut, leaderPixels, type Pt } from '../../src/render/plates';
import { project } from '../../src/render/projection';
import { headHeight } from '../../src/render/prompts';

const TIERS: readonly Tier[] = ['easy', 'medium', 'hard', 'insane'];
const BAND: Record<Tier, readonly number[]> = { easy: [2, 3, 4], medium: [5, 6, 7], hard: [8, 9, 10, 11], insane: [12, 13, 14, 15] };
const W = 480;
const H = 270;
const LOOK: Look = { skin: 1, hairStyle: 0, hair: 1, shirt: 6, shorts: 0, headband: null, racket: 0 };

/** The rounded screen rings of player `dest`'s half's rally targets for viewer 0, medium's side `m`: easy, medium, hard, insane. */
function ringsOn(dest: 0 | 1, m: 1 | -1): Pt[] {
  return [...rallyTargets(dest, m), insaneRallyTarget(dest, m)].map((p) => {
    const q = project({ ...p, z: 0 }, 0);
    return { x: Math.round(q.x), y: Math.round(q.y) };
  });
}

/** The near typist's rings (on the far half), medium's side `m`. */
const ringsFor = (m: 1 | -1): Pt[] => ringsOn(1, m);
/** The far typist's rings (on the near half), medium's side `m`. */
const farRingsFor = (m: 1 | -1): Pt[] => ringsOn(0, m);

/** Which leader last covered each pixel (−1 none); reset after every check. */
const owner = new Int8Array(W * H).fill(-1);
/** The leader pass that last looked at each pixel, so every outlined pixel is checked once per leader. */
const seen = new Int32Array(W * H);
let pass = 0;
/** Per ring set: each pixel's bit j set inside ring j's keep-out. */
const ringMasks = new Map<string, Uint8Array>();

function ringMask(rings: readonly Pt[]): Uint8Array {
  const id = rings.map((r) => `${r.x},${r.y}`).join(' ');
  let mask = ringMasks.get(id);
  if (mask === undefined) {
    const bits = new Uint8Array(W * H);
    rings.forEach((r, j) => {
      for (let dy = -5; dy <= 5; dy++) {
        for (let dx = -8; dx <= 8; dx++) {
          const k = (r.y + dy) * W + r.x + dx;
          if (inRingKeepOut(TIERS[j]!, dx, dy)) bits[k] = bits[k]! | (1 << j);
        }
      }
    });
    ringMasks.set(id, bits);
    mask = bits;
  }
  return mask;
}

/** Every way `s` breaks the choice-stack spec §3 guarantee; empty when it holds. */
function breaches(s: PlacedStack, rings: readonly Pt[]): string[] {
  const out = new Set<string>();
  const touched: number[] = [];
  const inRing = ringMask(rings);
  for (const b of s.boxes) {
    if (b.x < 4 || b.x + b.w > 476 || b.y < 22 || b.y + b.h > 266) out.add(`plate ${b.option} outside the plate area`);
  }
  s.routes.forEach((route, i) => {
    pass++;
    for (const [ix, iy] of leaderPixels(route, TIERS[i]!)) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = ix + dx;
          const y = iy + dy;
          if (x < 4 || x > 475 || y < 0 || y >= H) {
            out.add(`leader ${i} leaves x 4–475`);
            continue;
          }
          const k = y * W + x;
          if (seen[k] === pass) continue;
          seen[k] = pass;
          const o = owner[k]!;
          if (o >= 0) out.add(`leaders ${o} and ${i} overlap`);
          owner[k] = i;
          touched.push(k);
          const other = inRing[k]! & ~(1 << i);
          if (other !== 0) out.add(`leader ${i} enters ring ${Math.log2(other & -other)}`);
          for (let j = 0; j < s.boxes.length; j++) {
            const b = s.boxes[j]!;
            if (j !== i && x >= b.x - 1 && x <= b.x + b.w && y >= b.y - 1 && y <= b.y + b.h) out.add(`leader ${i} enters plate ${j}`);
          }
        }
      }
    }
  });
  for (const k of touched) owner[k] = -1;
  return [...out];
}

/** Word lengths per option for `n` options: every length of each band (`all`), or each band's shortest and longest. */
function lengthSets(n: 3 | 4, all: boolean): number[][] {
  let sets: number[][] = [[]];
  for (const t of TIERS.slice(0, n)) {
    const band = BAND[t];
    const pick = all ? band : [band[0]!, band[band.length - 1]!];
    sets = sets.flatMap((s) => pick.map((len) => [...s, len]));
  }
  return sets;
}

/** The stack's bottom edge beside a near player hitting `depth` m behind the net: level with the top of a `head`-px head. */
function stackBottom(depth: number, head: number): number {
  return Math.round(project({ x: 0, y: -depth, z: 0 }, 0).y) - head;
}

/** The shortest and tallest head seen from `view` over every hair style, with and without a headband. */
function headRange(view: 'near' | 'far' = 'near'): [number, number] {
  const heads = [0, 1, 2, 3, 4].flatMap((hairStyle) =>
    [0, null].map((headband) => headHeight({ ...LOOK, hairStyle, headband }, view)),
  );
  return [Math.min(...heads), Math.max(...heads)];
}

/** The far stack's top edge beside a far player hitting `depth` m behind the net: level with the top of a `head`-px head. */
function farStackTop(depth: number, head: number): number {
  return Math.round(project({ x: 0, y: depth, z: 0 }, 0).y) - head;
}

/** The stack of `who` (the near or the far typist) placed on `col` for a hit from `depth` m, with the rings it shows. */
function placeFor(
  who: 'near' | 'far',
  m: 1 | -1,
  lens: number[],
  col: number,
  depth: number,
  head: number,
): { s: PlacedStack; rings: Pt[] } {
  const rings = (who === 'near' ? ringsFor(m) : farRingsFor(m)).slice(0, lens.length);
  const s = who === 'near'
    ? placeChoiceStack(lens, col, stackBottom(depth, head), rings)
    : placeChoiceStack(lens, col, farStackTop(depth, head), rings, 'down');
  return { s, rings };
}

/** Depths (m behind the net) a near player can hit from: the service line to 1.2 m behind the baseline. */
const DEPTHS = [6.4, 8, 10, 11.5, 12.2, 12.5, 13.085];

describe('routeStackLeaders (choice-stack spec §3)', () => {
  // A centred 4-stack: easy x 223–257, medium 214–266, hard 202–278, insane 190–290; rows 127 / 146 / 165 / 184.
  const centred = layoutChoiceStack([4, 7, 11, 15], 240, 200);
  const spread: Pt[] = [{ x: 240, y: 90 }, { x: 180, y: 90 }, { x: 300, y: 82 }, { x: 170, y: 80 }];

  it('runs a leader straight out along its row, then up to its ring, when the ring lies farther out', () => {
    const r = routeStackLeaders(centred, spread, 240);
    expect(r[1]).toEqual([{ x: 212, y: 154 }, { x: 180, y: 154 }, { x: 180, y: 90 }]);
    expect(r[2]).toEqual([{ x: 280, y: 173 }, { x: 300, y: 173 }, { x: 300, y: 82 }]);
    expect(r[3]).toEqual([{ x: 188, y: 192 }, { x: 170, y: 192 }, { x: 170, y: 80 }]);
  });

  it('sends easy out on hard\'s side when its ring is on the column, up a lane above the stack when the ring lies inward', () => {
    const r = routeStackLeaders(centred, spread, 240);
    expect(r[0]).toEqual([{ x: 259, y: 135 }, { x: 259, y: 123 }, { x: 240, y: 90 }]);
  });

  it('nests lanes: a lower plate takes a lane farther out and turns higher', () => {
    const off = layoutChoiceStack([4, 7, 11, 15], 120, 200);
    const rings: Pt[] = [{ x: 240, y: 90 }, { x: 199, y: 89 }, { x: 290, y: 82 }, { x: 186, y: 80 }];
    const r = routeStackLeaders(off, rings, 120);
    expect(r[1]).toEqual([{ x: 92, y: 154 }, { x: 92, y: 123 }, { x: 199, y: 89 }]);
    expect(r[3]).toEqual([{ x: 68, y: 192 }, { x: 68, y: 119 }, { x: 186, y: 80 }]);
    expect(r[0]).toEqual([{ x: 139, y: 135 }, { x: 240, y: 135 }, { x: 240, y: 90 }]);
    expect(r[2]).toEqual([{ x: 160, y: 173 }, { x: 290, y: 173 }, { x: 290, y: 82 }]);
  });
});

describe('placeChoiceStack (choice-stack spec §2)', () => {
  const rings = ringsFor(1);

  it('keeps the chase plate\'s bottom edge and column when nothing is in the way', () => {
    const s = placeChoiceStack([4, 7, 11, 15], 240, 190, rings);
    expect(s.columnX).toBe(240);
    expect(s.boxes.at(-1)!.y + 16).toBe(190);
  });

  it('moves the stack down to stay 8 px below the lowest ring, and inside y 22–266', () => {
    const lowest = Math.max(...rings.map((r) => r.y));
    const s = placeChoiceStack([4, 7, 11, 15], 240, 120, rings);
    expect(s.boxes[0]!.y).toBe(lowest + 8);
    expect(placeChoiceStack([4, 7, 11], 240, 400, rings.slice(0, 3)).boxes.at(-1)!.y + 16).toBe(266);
  });

  it('shifts the stack and its lanes inward together at either screen edge', () => {
    for (const col of [4, 476]) {
      const s = placeChoiceStack([4, 7, 11, 15], col, 190, rings);
      expect(breaches(s, rings), `column ${col}`).toEqual([]);
      expect(s.columnX).not.toBe(col);
    }
  });

  it('meets the guarantee everywhere a near player can stand: no two leaders touch, none enters another plate or ring', () => {
    const heads = headRange();
    const fails: string[] = [];
    const check = (m: 1 | -1, lens: number[], col: number, bottom: number): void => {
      const rings = ringsFor(m).slice(0, lens.length);
      for (const b of breaches(placeChoiceStack(lens, col, bottom, rings), rings)) {
        if (fails.length < 20) fails.push(`m ${m} lens ${lens} column ${col} bottom ${bottom}: ${b}`);
      }
    };
    for (const m of [1, -1] as const) {
      // Every column (step 4), service line to 1.2 m behind the baseline, each band's extremes.
      for (const depth of DEPTHS) {
        for (const head of heads) {
          for (let col = 4; col <= 476; col += 4) {
            for (const n of [3, 4] as const) for (const lens of lengthSets(n, false)) check(m, lens, col, stackBottom(depth, head));
          }
        }
      }
      // Every word length at the edges, the serve-return spots and the centre.
      for (const col of [4, 60, 158, 240, 322, 420, 476]) {
        for (const n of [3, 4] as const) for (const lens of lengthSets(n, true)) check(m, lens, col, stackBottom(12.5, heads[0]));
      }
    }
    expect(fails).toEqual([]);
  }, 120_000);
});

describe('besideColumn (choice-stack spec §2, beside the hitting spot)', () => {
  it('puts the widest plate\'s near edge 25 px from the feet, on the court-centre side (right at the centre)', () => {
    const right = layoutChoiceStack([4, 7, 11, 15], besideColumn(100.4, 101), 200);
    expect(right.at(-1)!.x).toBe(100 + 25);
    const left = layoutChoiceStack([4, 7, 11], besideColumn(300.6, 77), 200);
    expect(left.at(-1)!.x + left.at(-1)!.w - 1).toBe(301 - 25);
    const centre = layoutChoiceStack([4, 7, 11], besideColumn(240, 77), 200);
    expect(centre.at(-1)!.x).toBe(240 + 25);
  });

  it('keeps every placed stack clear of the player wherever a player can hit from, near or far', () => {
    const fails: string[] = [];
    for (const who of ['near', 'far'] as const) {
      const head = headRange(who)[0];
      for (const m of [1, -1] as const) {
        for (const depth of DEPTHS) {
          // |x| ≤ 5.8 m at this depth, as screen x.
          const y = who === 'near' ? -depth : depth;
          const [lo, hi] = [-5.8, 5.8].map((x) => project({ x, y, z: 0 }, 0).x).sort((a, b) => a - b) as [number, number];
          for (let feetX = lo; feetX <= hi; feetX += 1.7) {
            for (const n of [3, 4] as const) {
              for (const lens of lengthSets(n, false)) {
                const widest = Math.max(...lens.map((len) => plateWidth(len)));
                const { s } = placeFor(who, m, lens, besideColumn(feetX, widest), depth, head);
                const feet = Math.round(feetX);
                const clear = feet <= 240
                  ? s.boxes.every((b) => b.x >= feet + 25)
                  : s.boxes.every((b) => b.x + b.w - 1 <= feet - 25);
                if (!clear && fails.length < 20) fails.push(`${who} m ${m} depth ${depth} feet ${feetX.toFixed(1)} lens ${lens}`);
              }
            }
          }
        }
      }
    }
    expect(fails).toEqual([]);
  }, 60_000);
});

describe('the far typist\'s stack (choice-stack spec §2–3, rings below)', () => {
  const rings = farRingsFor(1);

  it('puts easy at the bottom and the widest plate on top, starting at the given top edge', () => {
    const s = placeChoiceStack([4, 7, 11, 15], 240, 40, rings, 'down');
    expect(s.boxes.map((b) => b.option)).toEqual([0, 1, 2, 3]);
    expect(s.boxes.map((b) => b.y)).toEqual([97, 78, 59, 40]);
    for (const b of s.boxes) expect(b.x + (b.w - 1) / 2).toBe(240);
  });

  it('runs each leader from a plate side down to its ring', () => {
    const s = placeChoiceStack([4, 7, 11, 15], 240, 40, rings, 'down');
    s.routes.forEach((r, i) => {
      const b = s.boxes[i]!;
      expect([b.x - 2, b.x + b.w + 1]).toContain(r[0]!.x);
      expect(r[0]!.y).toBeGreaterThanOrEqual(b.y);
      expect(r[0]!.y).toBeLessThan(b.y + b.h);
      expect(r.at(-1)).toEqual(rings[i]);
    });
  });

  it('moves up to stay 8 px above the highest ring', () => {
    const highest = Math.min(...rings.map((r) => r.y));
    const s = placeChoiceStack([4, 7, 11, 15], 240, 180, rings, 'down');
    expect(Math.max(...s.boxes.map((b) => b.y + b.h - 1))).toBe(highest - 8);
  });

  it('meets the guarantee everywhere a far player can stand: no two leaders touch, none enters another plate or ring', () => {
    const fails: string[] = [];
    for (const m of [1, -1] as const) {
      for (const depth of DEPTHS) {
        for (const head of headRange('far')) {
          for (let col = 4; col <= 476; col += 4) {
            for (const n of [3, 4] as const) {
              for (const lens of lengthSets(n, false)) {
                const { s, rings: shown } = placeFor('far', m, lens, col, depth, head);
                for (const b of breaches(s, shown)) {
                  if (fails.length < 20) fails.push(`m ${m} lens ${lens} column ${col} depth ${depth}: ${b}`);
                }
              }
            }
          }
        }
      }
    }
    expect(fails).toEqual([]);
  }, 120_000);
});
