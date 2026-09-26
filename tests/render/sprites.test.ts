import { describe, expect, it } from 'vitest';
import type { Look } from '../../src/core/types';
import { contrastRatio } from '../../src/render/color';
import { RAMPS } from '../../src/render/palette';
import { ANIMS, ANIM_NAMES, CELL, VIEWS, frameIndex, type AnimName, type View } from '../../src/render/sprites/animations';
import {
  HAIR_STYLES,
  HAIR_SWAYS,
  RAMP_SIZE,
  SHOES,
  SLOT,
  headRows,
  lintGrid,
  lintParts,
  lintRamps,
  type RampSource,
} from '../../src/render/sprites/parts';
import { posesFor } from '../../src/render/sprites/poses';
import { composeFrame, linePoints } from '../../src/render/sprites/rig';
import { SHEET, cellOrigin, lookCache, sheetFrames, slotColors } from '../../src/render/sprites/sheet';

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
const RACKET = new Set<number>([SLOT.racketHi, SLOT.racketLo, SLOT.strings]);
const BAND = new Set<number>([SLOT.bandMid, SLOT.bandLo]);
const HAIR = new Set<number>([SLOT.hairHi, SLOT.hairMid, SLOT.hairLo]);
const SHIRT = new Set<number>([SLOT.shirtHi, SLOT.shirtMid, SLOT.shirtLo]);
/** Socks and shoes share the fixed neutral shoe slots. */
const SOCK = new Set<number>([SLOT.shoeHi, SLOT.shoeLo]);
const RUNS: AnimName[] = ['runLeft', 'runRight', 'runToward', 'runAway'];
/** The bare head is an 8 × 8 px grid: head-grid rows 0–7 are the head, the rows below it the neck. */
const HEAD_SIZE = 8;
/** WCAG 2.x minimum contrast for graphical objects (SC 1.4.11): the eyes must read on every skin. */
const EYE_CONTRAST = 3;

function styleOf(name: string): number {
  const i = HAIR_STYLES.indexOf(name);
  if (i < 0) throw new Error(`no hair style ${name}`);
  return i;
}
const CROP = styleOf('crop');
const PONYTAIL = styleOf('ponytail');
const AFRO = styleOf('afro');

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

function bounds(ps: readonly { x: number; y: number }[]): { left: number; right: number; top: number } {
  const xs = ps.map((p) => p.x);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ps.map((p) => p.y)) };
}

const neighbours = (buf: Uint8Array, { x, y }: { x: number; y: number }): number[] => [
  at(buf, x - 1, y),
  at(buf, x + 1, y),
  at(buf, x, y - 1),
  at(buf, x, y + 1),
];

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

  it('shows frame 0 for a non-finite frame number instead of NaN', () => {
    for (const anim of ANIM_NAMES) {
      for (const i of [NaN, Infinity, -Infinity]) expect(frameIndex(anim, i), `${anim} ${i}`).toBe(0);
    }
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

  it('reports a shade beyond the end of its source ramp', () => {
    expect(lintRamps([{ source: 'racket', slots: [SLOT.racketHi, SLOT.racketLo], shades: [0, 3] }])[0]).toMatch(
      /racket.*0,3 go beyond its 3-shade ramp/,
    );
    expect(lintRamps([{ source: 'neutral', slots: [SLOT.strings], shades: [4] }])).toHaveLength(1);
    expect(lintRamps([{ source: 'neutral', slots: [SLOT.shoeHi, SLOT.shoeLo], shades: [0, 3] }])).toEqual([]);
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
    // Problems are gathered and asserted once: 800 frames of per-pixel expects would crawl.
    const problems: string[] = [];
    const list = (ps: readonly { x: number; y: number }[]) => ps.map(({ x, y }) => `(${x}, ${y})`).join(' ');
    for (let style = 0; style < HAIR_STYLES.length; style++) {
      for (const band of [false, true]) {
        everyFrame((anim, view, i) => {
          const buf = composeFrame(anim, view, i, style, band);
          const where = `${anim} ${view} ${i} style ${style} band ${band}`;
          const border = pixels(buf, opaque).filter(({ x, y }) => x === 0 || y === 0 || x === CELL.w - 1 || y === CELL.h - 1);
          if (border.length) problems.push(`${where}: opaque border pixels ${list(border)}`);
          const bare = pixels(buf, (s) => opaque(s) && s !== SLOT.outline).filter((p) => neighbours(buf, p).includes(SLOT.clear));
          if (bare.length) problems.push(`${where}: unoutlined edge pixels ${list(bare)}`);
        });
      }
    }
    expect(problems).toEqual([]);
  });

  it('draws a standing player 40–45 px tall, hair included, whose shoes rest on the anchor row', () => {
    for (let style = 0; style < HAIR_STYLES.length; style++) {
      for (const view of VIEWS) {
        const where = `${HAIR_STYLES[style]} ${view}`;
        const body = pixels(composeFrame('idle', view, 0, style, false), opaque);
        const top = Math.min(...body.map((p) => p.y));
        const bottom = Math.max(...body.map((p) => p.y));
        expect(bottom - top + 1, where).toBeGreaterThanOrEqual(40);
        expect(bottom - top + 1, where).toBeLessThanOrEqual(45);
        expect(bottom, where).toBe(CELL.anchorY);
      }
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

  it('draws each far-view eye as a 1 px pupil beside a sclera pixel, and no eyes from behind', () => {
    for (let style = 0; style < HAIR_STYLES.length; style++) {
      for (const band of [false, true]) {
        const where = `${HAIR_STYLES[style]} band ${band}`;
        const far = composeFrame('idle', 'far', 0, style, band);
        const pupils = pixels(far, (s) => s === SLOT.pupil);
        expect(pupils, where).toHaveLength(2);
        for (const p of pupils) expect(neighbours(far, p).filter((s) => s === SLOT.sclera), where).toHaveLength(1);
        expect(pixels(far, (s) => s === SLOT.sclera), where).toHaveLength(2);
        const near = composeFrame('idle', 'near', 0, style, band);
        expect(pixels(near, (s) => s === SLOT.pupil || s === SLOT.sclera), where).toEqual([]);
      }
    }
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

  it('joins every shoe seen end-on to its leg with a sock, kicked-up soles included', () => {
    everyFrame((anim, view, i) => {
      const pose = posesFor(anim, view)[i];
      if (!pose) throw new Error(`no pose ${anim} ${view} ${i}`);
      const buf = composeFrame(anim, view, i, CROP, false);
      for (const [kind, foot] of [[pose.shoeL, pose.footL], [pose.shoeR, pose.footR]] as const) {
        // A side-on shoe takes the shin at its instep, beside the ankle point, so it has no sock above.
        if (kind === 'sideL' || kind === 'sideR') continue;
        const shoe = SHOES[kind];
        const ankle = { x: Math.round(foot.x - shoe.ax) + shoe.ankle.x, y: Math.round(foot.y - shoe.ay) + shoe.ankle.y };
        const sock = [-1, 0, 1].some((dx) => SOCK.has(at(buf, ankle.x + dx, ankle.y - 1)));
        expect(sock, `${anim} ${view} ${i}: ${kind} shoe at (${foot.x}, ${foot.y})`).toBe(true);
      }
    });
  });

  it('shows a lower leg above a kicked-up sole: the knee is at least 3 px above the shoe', () => {
    let soles = 0;
    everyFrame((anim, view, i) => {
      const pose = posesFor(anim, view)[i];
      if (!pose) throw new Error(`no pose ${anim} ${view} ${i}`);
      for (const [kind, knee, foot] of [[pose.shoeL, pose.kneeL, pose.footL], [pose.shoeR, pose.kneeR, pose.footR]] as const) {
        if (kind !== 'sole') continue;
        soles++;
        const ankleY = Math.round(foot.y - SHOES.sole.ay) + SHOES.sole.ankle.y;
        expect(ankleY - knee.y, `${anim} ${view} ${i}`).toBeGreaterThanOrEqual(3);
      }
    });
    expect(soles).toBeGreaterThan(0);
  });

  it('gives the afro volume past the head outline on both sides and on top, in both views', () => {
    for (const view of VIEWS) {
      const crop = bounds(pixels(composeFrame('idle', view, 0, CROP, false), (s) => HAIR.has(s)));
      const afro = bounds(pixels(composeFrame('idle', view, 0, AFRO, false), (s) => HAIR.has(s)));
      expect(crop.left - afro.left, view).toBeGreaterThanOrEqual(2);
      expect(afro.right - crop.right, view).toBeGreaterThanOrEqual(2);
      expect(crop.top - afro.top, view).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps the headband tight to an afro: the hair bulges past it and no tail flares out', () => {
    for (const view of VIEWS) {
      const plain = composeFrame('idle', view, 0, AFRO, false);
      const banded = composeFrame('idle', view, 0, AFRO, true);
      expect(pixels(banded, opaque).filter(({ x, y }) => !opaque(at(plain, x, y))), `${view} flare`).toEqual([]);
      const band = bounds(pixels(banded, (s) => BAND.has(s)));
      const hair = bounds(pixels(banded, (s) => HAIR.has(s)));
      expect(hair.left, view).toBeLessThan(band.left);
      expect(hair.right, view).toBeGreaterThan(band.right);
      expect(hair.top, view).toBeLessThan(band.top);
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

describe('ponytail', () => {
  /** Ponytail hair lying over shirt pixels that a crop head leaves showing in the same frame. */
  function tailOnShirt(anim: AnimName, i: number): { x: number; y: number }[] {
    const pony = composeFrame(anim, 'near', i, PONYTAIL, false);
    const crop = composeFrame(anim, 'near', i, CROP, false);
    return pixels(pony, (s) => HAIR.has(s)).filter(({ x, y }) => SHIRT.has(at(crop, x, y)));
  }

  /** The tail's left edge on the back, measured from the left edge of the head's hair. */
  function tailOffset(anim: AnimName, i: number): number {
    const head = bounds(pixels(composeFrame(anim, 'near', i, CROP, false), (s) => HAIR.has(s)));
    return bounds(tailOnShirt(anim, i)).left - head.left;
  }

  it('hangs from behind past the head, 2–3 px wide and 5–7 px long, at every sway', () => {
    expect([...HAIR_SWAYS].sort((a, b) => a - b)).toEqual([-1, 0, 1]);
    for (const sway of HAIR_SWAYS) {
      for (const band of [false, true]) {
        const where = `sway ${sway} band ${band}`;
        const { rows, oy } = headRows('near', PONYTAIL, band, sway);
        const widths = rows.slice(HEAD_SIZE - oy).map((r) => [...r].filter((ch) => 'Hhn'.includes(ch)).length);
        const length = widths.findIndex((w) => w === 0);
        expect(length, where).toBeGreaterThanOrEqual(5);
        expect(length, where).toBeLessThanOrEqual(7);
        for (const w of widths.slice(0, length)) {
          expect(w, where).toBeGreaterThanOrEqual(2);
          expect(w, where).toBeLessThanOrEqual(3);
        }
        expect(widths.slice(length).every((w) => w === 0), where).toBe(true);
      }
    }
  });

  it('lies on the upper back of the shirt', () => {
    const tail = tailOnShirt('idle', 0);
    expect(tail.length).toBeGreaterThanOrEqual(4);
    expect(new Set(tail.map((p) => p.y)).size).toBeGreaterThanOrEqual(2);
  });

  it('sways a pixel at a time in run frames and holds still when standing', () => {
    expect(tailOffset('idle', 1)).toBe(tailOffset('idle', 0));
    for (const anim of RUNS) {
      const offsets = Array.from({ length: FRAMES[anim] }, (_, i) => tailOffset(anim, i));
      expect(new Set(offsets).size, `${anim} ${offsets.join(',')}`).toBeGreaterThan(1);
      offsets.forEach((x, i) => {
        const next = offsets[(i + 1) % offsets.length] ?? x;
        expect(Math.abs(next - x), `${anim} ${offsets.join(',')}`).toBeLessThanOrEqual(1);
      });
    }
  });
});

describe('linePoints', () => {
  it('rounds half-pixel endpoints to whole pixels before stepping', () => {
    expect(linePoints({ x: 0.5, y: 0 }, { x: 3.5, y: 2 })).toEqual(linePoints({ x: 1, y: 0 }, { x: 4, y: 2 }));
  });

  it('ends when only one endpoint is half-way, as from a centre-line socket to a joint', () => {
    expect(linePoints({ x: 23.5, y: 20 }, { x: 20, y: 26 })).toEqual(linePoints({ x: 24, y: 20 }, { x: 20, y: 26 }));
    expect(linePoints({ x: 20, y: 26 }, { x: 23.5, y: 20.5 })).toEqual(linePoints({ x: 20, y: 26 }, { x: 24, y: 21 }));
  });

  it('throws on a non-finite endpoint instead of stepping forever', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => linePoints({ x: bad, y: 0 }, { x: 3, y: 2 }), `a.x ${bad}`).toThrow(/non-finite/);
      expect(() => linePoints({ x: 0, y: bad }, { x: 3, y: 2 }), `a.y ${bad}`).toThrow(/non-finite/);
      expect(() => linePoints({ x: 0, y: 0 }, { x: bad, y: 2 }), `b.x ${bad}`).toThrow(/non-finite/);
      expect(() => linePoints({ x: 0, y: 0 }, { x: 3, y: bad }), `b.y ${bad}`).toThrow(/non-finite/);
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
    expect(cellOrigin('runLeft', 'far', NaN)).toEqual(cellOrigin('runLeft', 'far', 0));
  });

  it('places every composed frame in the cell of the frame it was composed for', () => {
    const frames = sheetFrames(1, true);
    expect(frames).toHaveLength(80);
    expect(new Set(frames.map((f) => `${f.anim} ${f.view} ${f.i}`)).size).toBe(80);
    for (const f of frames) expect({ sx: f.sx, sy: f.sy }, `${f.anim} ${f.view} ${f.i}`).toEqual(cellOrigin(f.anim, f.view, f.i));
    // Compared element-wise and asserted once: 80 deep equals of 2304-slot buffers crawl.
    const misplaced = frames.filter((f) => {
      const own = composeFrame(f.anim, f.view, f.i, 1, true);
      return own.length !== f.buf.length || own.some((slot, p) => slot !== f.buf[p]);
    });
    expect(misplaced.map((f) => `${f.anim} ${f.view} ${f.i}`)).toEqual([]);
  });
});

describe('lookCache', () => {
  const lookN = (n: number): Look => ({ skin: n, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 });

  function stubbed() {
    const built: number[] = [];
    const get = lookCache((look: Look) => {
      built.push(look.skin);
      return { skin: look.skin };
    });
    return { built, get };
  }

  it('builds each distinct look once, whatever its property order', () => {
    const { built, get } = stubbed();
    const first = get(lookN(0));
    expect(get({ racket: 0, headband: null, shorts: 0, shirt: 0, hair: 0, hairStyle: 0, skin: 0 })).toBe(first);
    get({ ...lookN(0), headband: 0 });
    expect(built).toEqual([0, 0]);
  });

  it('keeps the 8 most recently used looks, evicting the least recently used first', () => {
    const { built, get } = stubbed();
    const first = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => get(lookN(n)));
    expect(built).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(get(lookN(0))).toBe(first[0]);
    get(lookN(8)); // evicts 1, the least recently used since 0 was just used
    expect(get(lookN(0))).toBe(first[0]);
    expect(get(lookN(7))).toBe(first[7]);
    expect(built).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    get(lookN(1)); // rebuilt, evicting 2
    get(lookN(2)); // rebuilt, evicting 3
    expect(built).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 1, 2]);
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

  it('gives every eye a pixel that contrasts at least 3:1 with every shade of every skin', () => {
    RAMPS.skin.forEach((ramp, skin) => {
      const c = slotColors({ ...look, skin });
      const eye = [c[SLOT.pupil], c[SLOT.sclera]];
      expect(eye.every((e) => typeof e === 'string'), `skin ${skin} eye colours`).toBe(true);
      for (const shade of ramp) {
        const best = Math.max(...eye.map((e) => (e ? contrastRatio(e, shade) : 1)));
        expect(best, `skin ${skin} shade ${shade}`).toBeGreaterThanOrEqual(EYE_CONTRAST);
      }
    });
  });

  it('throws on a shade beyond its ramp instead of leaving the slot transparent', () => {
    const skin = [SLOT.skinHi, SLOT.skinMid, SLOT.skinLo];
    expect(() => slotColors(look, [{ source: 'skin', slots: skin, shades: [1, 2, 3] }])).toThrow(RangeError);
    expect(() => slotColors(look, [{ source: 'neutral', slots: [SLOT.strings], shades: [4] }])).toThrow(RangeError);
  });

  it('resolves exactly the shades the ramp lint allows, for every ramp source', () => {
    for (const source of Object.keys(RAMP_SIZE) as RampSource[]) {
      const last = RAMP_SIZE[source] - 1;
      const c = slotColors(look, [{ source, slots: [SLOT.strings], shades: [last] }]);
      expect(c[SLOT.strings], source).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(() => slotColors(look, [{ source, slots: [SLOT.strings], shades: [last + 1] }]), source).toThrow(RangeError);
    }
  });
});
