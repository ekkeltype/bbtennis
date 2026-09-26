import { describe, expect, it } from 'vitest';
import type { Look } from '../../src/core/types';
import { RAMPS } from '../../src/render/palette';
import { ANIMS, ANIM_NAMES, CELL, VIEWS, frameIndex, type AnimName, type View } from '../../src/render/sprites/animations';
import { HAIR_STYLES, SLOT, lintGrid, lintParts, lintRamps } from '../../src/render/sprites/parts';
import { posesFor } from '../../src/render/sprites/poses';
import { composeFrame } from '../../src/render/sprites/rig';
import { SHEET, cellOrigin, slotColors } from '../../src/render/sprites/sheet';

// buildSheet/drawPlayer need a canvas, which node lacks: everything below exercises pure data.

const FRAMES: Record<AnimName, number> = {
  idle: 2,
  runLeft: 6,
  runRight: 6,
  runToward: 4,
  runAway: 4,
  forehand: 4,
  backhand: 4,
  serve: 4,
  stretch: 2,
  celebrate: 2,
  dejected: 2,
};
const LOCOMOTION: AnimName[] = ['idle', 'runLeft', 'runRight', 'runToward', 'runAway'];
const SKIN = new Set<number>([SLOT.skinHi, SLOT.skinMid, SLOT.skinLo]);
const RACKET = new Set<number>([SLOT.racketHi, SLOT.racketLo, SLOT.strings]);
const BAND = new Set<number>([SLOT.bandMid, SLOT.bandLo]);

const at = (buf: Uint8Array, x: number, y: number): number =>
  x < 0 || y < 0 || x >= CELL.w || y >= CELL.h ? SLOT.clear : (buf[y * CELL.w + x] ?? SLOT.clear);

function pixels(buf: Uint8Array, keep: (slot: number) => boolean): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < CELL.h; y++) {
    for (let x = 0; x < CELL.w; x++) if (keep(at(buf, x, y))) out.push({ x, y });
  }
  return out;
}

const opaque = (slot: number): boolean => slot !== SLOT.clear && slot !== SLOT.hole;

function everyFrame(fn: (anim: AnimName, view: View, i: number) => void): void {
  for (const anim of ANIM_NAMES) for (const view of VIEWS) for (let i = 0; i < FRAMES[anim]; i++) fn(anim, view, i);
}

describe('ANIMS', () => {
  it('lists the eleven animations with the spec frame counts (34 authored per view)', () => {
    expect([...ANIM_NAMES].sort()).toEqual(Object.keys(FRAMES).sort());
    for (const anim of ANIM_NAMES) expect(ANIMS[anim].frames, anim).toBe(FRAMES[anim]);
    // Spec §4.1 counts the lateral run once: runRight is runLeft mirrored.
    expect(ANIM_NAMES.filter((a) => a !== 'runRight').reduce((n, a) => n + ANIMS[a].frames, 0)).toBe(34);
  });

  it('plays every frame for a positive, finite time', () => {
    for (const anim of ANIM_NAMES) {
      expect(ANIMS[anim].msPerFrame, anim).toBeGreaterThan(0);
      expect(Number.isFinite(ANIMS[anim].msPerFrame), anim).toBe(true);
    }
  });

  it('declares a 48×48 cell with the feet anchor at (24, 46)', () => {
    expect(CELL).toEqual({ w: 48, h: 48, anchorX: 24, anchorY: 46 });
  });
});

describe('frameIndex', () => {
  it('wraps looping animations in both directions', () => {
    expect(frameIndex('runLeft', 7)).toBe(1);
    expect(frameIndex('runLeft', -1)).toBe(5);
    expect(frameIndex('idle', 4)).toBe(0);
  });

  it('holds one-shot animations on their first and last frames', () => {
    expect(frameIndex('forehand', 9)).toBe(3);
    expect(frameIndex('forehand', -2)).toBe(0);
    expect(frameIndex('serve', 2)).toBe(2);
  });

  it('floors fractional frame numbers', () => {
    expect(frameIndex('idle', 1.7)).toBe(1);
    expect(frameIndex('forehand', 2.99)).toBe(2);
  });
});

describe('lintGrid', () => {
  it('accepts a closed, outlined grid with an enclosed see-through hole', () => {
    expect(lintGrid('ok', ['.###.', '#sss#', '#s:s#', '.###.'])).toEqual([]);
  });

  it('reports rows of unequal length', () => {
    const problems = lintGrid('ragged', ['.##.', '#ss#', '.##']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/ragged.*row 2/);
  });

  it('reports characters missing from the legend', () => {
    const problems = lintGrid('odd', ['.##.', '#s?#', '.##.']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/odd.*'\?'/);
  });

  it('reports an opaque pixel on the silhouette edge that is not outline', () => {
    expect(lintGrid('gap', ['.##.', '#ss.', '.##.'])[0]).toMatch(/gap.*\(2, 1\)/);
    expect(lintGrid('border', ['.##.', '#sss', '.##.'])[0]).toMatch(/border.*\(3, 1\)/);
  });

  it('reports a see-through hole that leaks to the outside', () => {
    expect(lintGrid('leak', ['.###.', '#s:.#', '.###.'])[0]).toMatch(/leak.*\(2, 1\)/);
  });
});

describe('lintRamps', () => {
  it('accepts slots listed light to dark with strictly increasing shades', () => {
    expect(lintRamps([{ source: 'skin', slots: [SLOT.skinHi, SLOT.skinMid, SLOT.skinLo], shades: [0, 1, 2] }])).toEqual([]);
  });

  it('reports a ramp whose shades do not darken monotonically', () => {
    expect(lintRamps([{ source: 'headband', slots: [SLOT.bandMid, SLOT.bandLo], shades: [2, 1] }])).toHaveLength(1);
    expect(lintRamps([{ source: 'hair', slots: [SLOT.hairHi, SLOT.hairMid], shades: [1, 1] }])).toHaveLength(1);
  });

  it('reports a ramp whose slot and shade lists disagree in length', () => {
    expect(lintRamps([{ source: 'shirt', slots: [SLOT.shirtHi, SLOT.shirtMid], shades: [0] }])).toHaveLength(1);
  });
});

describe('lintParts', () => {
  it('finds no problems in the authored parts, overlays and ramps', () => {
    expect(lintParts()).toEqual([]);
  });

  it('offers five hair styles', () => {
    expect(HAIR_STYLES).toHaveLength(5);
    expect(new Set(HAIR_STYLES).size).toBe(5);
  });
});

describe('pose tables', () => {
  it('have the spec frame count for every animation in both views', () => {
    for (const view of VIEWS) {
      for (const anim of ANIM_NAMES) expect(posesFor(anim, view), `${anim} ${view}`).toHaveLength(FRAMES[anim]);
    }
  });

  it('keep the feet anchored within ±1 px across locomotion frames', () => {
    for (const anim of LOCOMOTION) {
      for (const view of VIEWS) {
        for (const [i, p] of posesFor(anim, view).entries()) {
          const where = `${anim} ${view} ${i}`;
          expect(Math.abs((p.footL.x + p.footR.x) / 2 - CELL.anchorX), where).toBeLessThanOrEqual(1);
          expect(Math.abs(Math.max(p.footL.y, p.footR.y) - CELL.anchorY), where).toBeLessThanOrEqual(1);
          expect(Math.abs(p.root.x), where).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('mirror the far (front) view: the racket hand is on screen-left there', () => {
    const near = posesFor('idle', 'near')[0];
    const far = posesFor('idle', 'far')[0];
    expect(near && far).toBeTruthy();
    if (!near || !far) return;
    expect(near.handR.x).toBeGreaterThan(CELL.anchorX);
    expect(far.handR.x).toBeLessThan(CELL.anchorX);
    expect(far.handR.x).toBe(CELL.w - 1 - near.handR.x);
  });
});

describe('composeFrame', () => {
  it('outlines every silhouette edge pixel and keeps a clear 1 px border, for every frame and head', () => {
    for (let style = 0; style < HAIR_STYLES.length; style++) {
      for (const band of [false, true]) {
        everyFrame((anim, view, i) => {
          const buf = composeFrame(anim, view, i, style, band);
          const where = `${anim} ${view} ${i} style ${style} band ${band}`;
          for (let x = 0; x < CELL.w; x++) {
            expect(opaque(at(buf, x, 0)) || opaque(at(buf, x, CELL.h - 1)), `${where} top/bottom border x=${x}`).toBe(false);
          }
          for (let y = 0; y < CELL.h; y++) {
            expect(opaque(at(buf, 0, y)) || opaque(at(buf, CELL.w - 1, y)), `${where} side border y=${y}`).toBe(false);
          }
          const bare = pixels(buf, (s) => opaque(s) && s !== SLOT.outline).filter(({ x, y }) =>
            [at(buf, x - 1, y), at(buf, x + 1, y), at(buf, x, y - 1), at(buf, x, y + 1)].includes(SLOT.clear),
          );
          expect(bare, `${where} unoutlined edge pixels`).toEqual([]);
        });
      }
    }
  });

  it('draws a standing player about 40 px tall whose shoes rest on the anchor row', () => {
    for (const view of VIEWS) {
      const body = pixels(composeFrame('idle', view, 0, 0, false), opaque);
      const top = Math.min(...body.map((p) => p.y));
      const bottom = Math.max(...body.map((p) => p.y));
      expect(bottom - top + 1, view).toBeGreaterThanOrEqual(38);
      expect(bottom - top + 1, view).toBeLessThanOrEqual(42);
      expect(bottom, view).toBe(CELL.anchorY);
    }
  });

  it('keeps the shoe soles within ±1 px of the anchor row across locomotion frames', () => {
    for (const anim of LOCOMOTION) {
      for (const view of VIEWS) {
        for (let i = 0; i < FRAMES[anim]; i++) {
          const bottom = Math.max(...pixels(composeFrame(anim, view, i, 0, false), opaque).map((p) => p.y));
          expect(Math.abs(bottom - CELL.anchorY), `${anim} ${view} ${i}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('shows two 1 px eyes in the far (front) view and none from behind', () => {
    const eyes = (view: View) => {
      const buf = composeFrame('idle', view, 0, 0, false);
      return pixels(buf, (s) => s === SLOT.outline).filter(
        ({ x, y }) => SKIN.has(at(buf, x - 1, y)) && SKIN.has(at(buf, x + 1, y)),
      );
    };
    expect(eyes('far')).toHaveLength(2);
    expect(eyes('near')).toHaveLength(0);
  });

  it('draws the headband only when the look has one, for every hair style and view', () => {
    for (let style = 0; style < HAIR_STYLES.length; style++) {
      for (const view of VIEWS) {
        expect(pixels(composeFrame('idle', view, 0, style, true), (s) => BAND.has(s)).length, `${style} ${view}`).toBeGreaterThan(4);
        expect(pixels(composeFrame('idle', view, 0, style, false), (s) => BAND.has(s)), `${style} ${view}`).toEqual([]);
      }
    }
  });

  it('gives every hair style its own head', () => {
    for (const view of VIEWS) {
      const heads = HAIR_STYLES.map((_, style) => composeFrame('idle', view, 0, style, false).join(','));
      expect(new Set(heads).size, view).toBe(HAIR_STYLES.length);
    }
  });

  it('keeps the racket on the right hand: screen-right from behind, screen-left from the front', () => {
    for (const anim of ['idle', 'runLeft', 'runRight'] as const) {
      for (let i = 0; i < FRAMES[anim]; i++) {
        const cx = (view: View) => {
          const r = pixels(composeFrame(anim, view, i, 0, false), (s) => RACKET.has(s));
          return r.reduce((sum, p) => sum + p.x, 0) / r.length;
        };
        expect(cx('near'), `${anim} near ${i}`).toBeGreaterThan(CELL.anchorX);
        expect(cx('far'), `${anim} far ${i}`).toBeLessThan(CELL.anchorX);
      }
    }
  });

  it('runs right as the mirror image of running left', () => {
    for (const view of VIEWS) {
      for (let i = 0; i < FRAMES.runLeft; i++) {
        const left = posesFor('runLeft', view)[i];
        const right = posesFor('runRight', view)[i];
        expect(left && right).toBeTruthy();
        if (!left || !right) continue;
        const mirrored = (x: number) => CELL.w - 1 - x;
        expect(right.footL.x, `${view} ${i}`).toBe(mirrored(left.footR.x));
        expect(right.footR.x, `${view} ${i}`).toBe(mirrored(left.footL.x));
        expect(right.kneeR.y, `${view} ${i}`).toBe(left.kneeL.y);
      }
    }
  });
});

describe('sheet layout', () => {
  it('gives each of the 80 frames (40 per view, runRight included) its own 48×48 cell inside the sheet', () => {
    const seen = new Set<string>();
    everyFrame((anim, view, i) => {
      const { sx, sy } = cellOrigin(anim, view, i);
      expect(sx % CELL.w, `${anim} ${view} ${i}`).toBe(0);
      expect(sy % CELL.h, `${anim} ${view} ${i}`).toBe(0);
      expect(sx + CELL.w, `${anim} ${view} ${i}`).toBeLessThanOrEqual(SHEET.w);
      expect(sy + CELL.h, `${anim} ${view} ${i}`).toBeLessThanOrEqual(SHEET.h);
      seen.add(`${sx},${sy}`);
    });
    expect(seen.size).toBe(80);
  });

  it('maps out-of-range frame numbers like frameIndex', () => {
    expect(cellOrigin('forehand', 'near', 9)).toEqual(cellOrigin('forehand', 'near', 3));
    expect(cellOrigin('runAway', 'far', 5)).toEqual(cellOrigin('runAway', 'far', 1));
  });
});

describe('slotColors', () => {
  const look: Look = { skin: 4, hairStyle: 2, hair: 5, shirt: 6, shorts: 7, headband: 1, racket: 2 };

  it('takes skin, hair, cloth and racket shades from the look ramps', () => {
    const c = slotColors(look);
    expect([c[SLOT.skinHi], c[SLOT.skinMid], c[SLOT.skinLo]]).toEqual(RAMPS.skin[4]);
    expect([c[SLOT.hairHi], c[SLOT.hairMid], c[SLOT.hairLo]]).toEqual(RAMPS.hair[5]);
    expect([c[SLOT.shirtHi], c[SLOT.shirtMid], c[SLOT.shirtLo]]).toEqual(RAMPS.cloth[6]);
    expect([c[SLOT.shortsHi], c[SLOT.shortsMid], c[SLOT.shortsLo]]).toEqual(RAMPS.cloth[7]);
    expect([c[SLOT.bandMid], c[SLOT.bandLo]]).toEqual(RAMPS.cloth[1]?.slice(1));
    expect([c[SLOT.racketHi], c[SLOT.racketLo]]).toEqual([RAMPS.racket[2]?.[0], RAMPS.racket[2]?.[2]]);
  });

  it('leaves clear and see-through pixels transparent', () => {
    const c = slotColors(look);
    expect(c[SLOT.clear]).toBeNull();
    expect(c[SLOT.hole]).toBeNull();
  });

  it('gives every drawn slot a colour', () => {
    const c = slotColors(look);
    for (const [name, slot] of Object.entries(SLOT)) {
      if (slot === SLOT.clear || slot === SLOT.hole) continue;
      expect(c[slot], name).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
