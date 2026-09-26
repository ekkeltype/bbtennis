import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tier, WordOption } from '../../src/core/types';
import { GLYPHS, textWidth } from '../../src/render/font';
import type { PlateBox } from '../../src/render/layout';
import { OUTLINE, PAL, PLATE, TIER_COLOR } from '../../src/render/palette';
import { drawLeader, drawPlate, drawTierRing, drawTimingBar, type PlateDraw } from '../../src/render/plates';

/** A minimal software 2D canvas: whole-pixel fillRect and 1:1 drawImage with source-over alpha. */
class PixelCanvas {
  readonly rgba: Float64Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgba = new Float64Array(width * height * 4);
  }
  getContext(): PixelContext {
    return new PixelContext(this);
  }
}

class PixelContext {
  fillStyle = '#000000';
  globalAlpha = 1;
  private saved: { fillStyle: string; globalAlpha: number }[] = [];
  constructor(readonly canvas: PixelCanvas) {}
  save(): void {
    this.saved.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha });
  }
  restore(): void {
    Object.assign(this, this.saved.pop());
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    if (![x, y, w, h].every(Number.isInteger)) throw new Error(`fillRect off the pixel grid: ${x},${y},${w},${h}`);
    const [r, g, b] = rgb(this.fillStyle);
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) this.blend(px, py, r, g, b, this.globalAlpha);
    }
  }
  drawImage(
    src: PixelCanvas,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void {
    if (![sx, sy, sw, sh, dx, dy].every(Number.isInteger) || dw !== sw || dh !== sh) {
      throw new Error('drawImage must copy whole pixels 1:1');
    }
    for (let j = 0; j < sh; j++) {
      for (let i = 0; i < sw; i++) {
        const k = ((sy + j) * src.width + sx + i) * 4;
        const a = src.rgba[k + 3]!;
        if (a > 0) this.blend(dx + i, dy + j, src.rgba[k]!, src.rgba[k + 1]!, src.rgba[k + 2]!, a * this.globalAlpha);
      }
    }
  }
  private blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
    const c = this.canvas;
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
    const k = (y * c.width + x) * 4;
    const da = c.rgba[k + 3]!;
    const oa = a + da * (1 - a);
    if (oa === 0) return;
    c.rgba[k] = (r * a + c.rgba[k]! * da * (1 - a)) / oa;
    c.rgba[k + 1] = (g * a + c.rgba[k + 1]! * da * (1 - a)) / oa;
    c.rgba[k + 2] = (b * a + c.rgba[k + 2]! * da * (1 - a)) / oa;
    c.rgba[k + 3] = oa;
  }
}

function rgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`fillStyle must be #RRGGBB, got ${hex}`);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: number[]): string =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

/** `top` composited over `bottom` at opacity `a`, rounded like the canvas readback. */
const mix = (top: string, bottom: string, a: number): string => {
  const [t, b] = [rgb(top), rgb(bottom)];
  return toHex(t.map((v, i) => v * a + b[i]! * (1 - a)));
};

const BG = '#808080';

/** Spec §4.2 plate width: 6n + 11 px at 1×. */
const plateWidth = (len: number, scale: 1 | 2 = 1): number => (6 * len + 11) * scale;

function scene(w = 220, h = 90): PixelContext {
  const g = new PixelCanvas(w, h).getContext();
  g.fillStyle = BG;
  g.fillRect(0, 0, w, h);
  return g;
}

const as2d = (g: PixelContext): CanvasRenderingContext2D => g as unknown as CanvasRenderingContext2D;

function at(g: PixelContext, x: number, y: number): string {
  const c = g.canvas;
  const k = (y * c.width + x) * 4;
  return toHex([c.rgba[k]!, c.rgba[k + 1]!, c.rgba[k + 2]!]);
}

function colours(g: PixelContext, x: number, y: number, w: number, h: number): Set<string> {
  const out = new Set<string>();
  for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) out.add(at(g, px, py));
  return out;
}

const tierOf = (len: number): Tier => (len <= 5 ? 'easy' : len <= 9 ? 'medium' : 'hard');

function plate(word: string, over: Partial<PlateDraw> = {}, x = 40, y = 40): PlateDraw {
  const opt: WordOption = { word, len: word.length, tier: tierOf(word.length) };
  const scale = over.scale ?? 1;
  const box: PlateBox = { x, y, w: plateWidth(opt.len, scale), h: 16 * scale, option: 0 };
  return {
    box,
    opt,
    typed: 0,
    locked: true,
    faded: 0,
    style: 'localActive',
    lastWrongAgeMs: null,
    isNextCursor: false,
    showInitialBlock: false,
    nameChip: null,
    oppColor: null,
    scale,
    reduceEffects: false,
    ...over,
  };
}

function hidden(len: number, tier: Tier, over: Partial<PlateDraw> = {}): PlateDraw {
  const p = plate('x'.repeat(len), { style: 'hiddenRemote', ...over });
  return { ...p, opt: { word: '', len, tier, hidden: true } };
}

/** Letter cell `i` of a 1× plate at `box`: 6×10 px starting 7 px right of and 3 px below the box corner. */
const cell = (box: PlateBox, i: number): { x: number; y: number } => ({ x: box.x + 7 + 6 * i, y: box.y + 3 });

/** Asserts the 6×10 cell at (x, y) shows glyph `ch` in `ink` on `paper` (the 6th column is the letter gap). */
function expectGlyph(g: PixelContext, x: number, y: number, ch: string, ink: string, paper: string): void {
  const glyph = GLYPHS[ch]!;
  const got: string[] = [];
  const want: string[] = [];
  for (let row = 0; row < 10; row++) {
    for (let col = 0; col < 6; col++) {
      got.push(at(g, x + col, y + row));
      want.push(glyph.rows[row]![col] === '#' ? ink : paper);
    }
  }
  expect(got, `glyph ${ch} at ${x},${y}`).toEqual(want);
}

/** Leftmost x on row `y` holding `colour`, or -1. */
function firstX(g: PixelContext, y: number, colour: string): number {
  for (let x = 0; x < g.canvas.width; x++) if (at(g, x, y) === colour) return x;
  return -1;
}

beforeAll(() => {
  vi.stubGlobal('OffscreenCanvas', PixelCanvas);
});

describe('drawPlate — local active', () => {
  it('frames the plate: dark halo, dark stroke outside the tier outline, dark fill', () => {
    const g = scene();
    const p = plate('rally');
    drawPlate(as2d(g), p);
    const { x, y, w, h } = p.box;
    const tier = TIER_COLOR.easy;
    expect([at(g, x - 2, y + 8), at(g, x - 1, y + 8), at(g, x, y + 8), at(g, x + 1, y + 8), at(g, x + 2, y + 8)])
      .toEqual([BG, PLATE.halo, PLATE.outline, tier, PLATE.fill]);
    expect([at(g, x + 8, y - 1), at(g, x + 8, y), at(g, x + 8, y + 1), at(g, x + 8, y + 2)])
      .toEqual([PLATE.halo, PLATE.outline, tier, PLATE.fill]);
    expect([at(g, x + w - 3, y + 8), at(g, x + w - 2, y + 8), at(g, x + w - 1, y + 8), at(g, x + w, y + 8)])
      .toEqual([PLATE.fill, tier, PLATE.outline, PLATE.halo]);
    expect([at(g, x + 8, y + h - 2), at(g, x + 8, y + h - 1), at(g, x + 8, y + h)])
      .toEqual([tier, PLATE.outline, PLATE.halo]);
  });

  it('carries 1, 2 and 3 tier-coloured 2×2 pips at the left edge for easy, medium and hard', () => {
    for (const [word, pips] of [['ace', 1], ['backhand', 2], ['counterpuncher', 3]] as const) {
      const g = scene();
      const p = plate(word);
      drawPlate(as2d(g), p);
      const tier = TIER_COLOR[p.opt.tier];
      const { x, y } = p.box;
      const rows = [];
      for (let py = y + 2; py < y + 14; py++) {
        if (at(g, x + 3, py) === tier) {
          expect(at(g, x + 4, py)).toBe(tier);
          rows.push(py);
        }
      }
      expect(rows.length).toBe(2 * pips);
      expect(colours(g, x + 2, y + 2, 1, 12)).toEqual(new Set([PLATE.fill]));
      expect(colours(g, x + 5, y + 2, 2, 12)).toEqual(new Set([PLATE.fill]));
    }
  });

  it('draws typed letters in the tier colour, the next letter as an inverse block, the rest near-white', () => {
    const g = scene();
    const p = plate('rally', { typed: 2, isNextCursor: true });
    drawPlate(as2d(g), p);
    const tier = TIER_COLOR.easy;
    [...'rally'].forEach((ch, i) => {
      const { x, y } = cell(p.box, i);
      if (i < 2) expectGlyph(g, x, y, ch, tier, PLATE.fill);
      else if (i === 2) expectGlyph(g, x, y, ch, PLATE.fill, PLATE.text);
      else expectGlyph(g, x, y, ch, PLATE.text, PLATE.fill);
    });
  });

  it('shows no cursor once the word is complete', () => {
    const g = scene();
    const p = plate('ace', { typed: 3, isNextCursor: true });
    drawPlate(as2d(g), p);
    [...'ace'].forEach((ch, i) => {
      const { x, y } = cell(p.box, i);
      expectGlyph(g, x, y, ch, TIER_COLOR.easy, PLATE.fill);
    });
  });

  it('marks the first letter of an unlocked option as an inverse block in the tier colour', () => {
    const g = scene();
    const p = plate('backhand', { locked: false, showInitialBlock: true });
    drawPlate(as2d(g), p);
    const tier = TIER_COLOR.medium;
    [...'backhand'].forEach((ch, i) => {
      const { x, y } = cell(p.box, i);
      if (i === 0) expectGlyph(g, x, y, ch, PLATE.fill, tier);
      else expectGlyph(g, x, y, ch, PLATE.text, PLATE.fill);
    });
  });

  it('drops the initial block once the option is locked', () => {
    const g = scene();
    const p = plate('backhand', { locked: true, showInitialBlock: true });
    drawPlate(as2d(g), p);
    const { x, y } = cell(p.box, 0);
    expectGlyph(g, x, y, 'b', PLATE.text, PLATE.fill);
  });
});

describe('drawPlate — wrong-key feedback', () => {
  it('flashes the fill light grey for 80 ms, letters turning dark so the word stays readable', () => {
    const g = scene();
    const p = plate('rally', { typed: 1, isNextCursor: true, lastWrongAgeMs: 30, reduceEffects: true });
    drawPlate(as2d(g), p);
    expect(at(g, p.box.x + 2, p.box.y + 2)).toBe(PLATE.flash);
    const c0 = cell(p.box, 0);
    const c1 = cell(p.box, 1);
    const c2 = cell(p.box, 2);
    expectGlyph(g, c0.x, c0.y, 'r', PLATE.fill, PLATE.flash);
    expectGlyph(g, c1.x, c1.y, 'a', PLATE.flash, PLATE.fill);
    expectGlyph(g, c2.x, c2.y, 'l', PLATE.fill, PLATE.flash);

    for (const age of [80, 500, null, -5]) {
      const g2 = scene();
      drawPlate(as2d(g2), { ...p, lastWrongAgeMs: age });
      expect(at(g2, p.box.x + 2, p.box.y + 2), `age ${age}`).toBe(PLATE.fill);
    }
  });

  it('uses only plate and tier colours: no red feedback', () => {
    const g = scene();
    const p = plate('rally', { typed: 2, isNextCursor: true, lastWrongAgeMs: 10 });
    drawPlate(as2d(g), p);
    const allowed = new Set([BG, PLATE.halo, PLATE.outline, PLATE.fill, PLATE.flash, PLATE.text, TIER_COLOR.easy]);
    const used = colours(g, 0, 0, g.canvas.width, g.canvas.height);
    expect(used.has(PLATE.flash)).toBe(true);
    expect([...used].filter((c) => !allowed.has(c))).toEqual([]);
  });

  it('shakes the plate by up to 2 px during the flash unless reduce effects is on', () => {
    const p = plate('rally', { lastWrongAgeMs: 0 });
    const shifts = new Set<number>();
    for (let age = 0; age < 80; age += 5) {
      const g = scene();
      drawPlate(as2d(g), { ...p, lastWrongAgeMs: age });
      shifts.add(firstX(g, p.box.y + 8, PLATE.outline) - p.box.x);
    }
    expect([...shifts].every((d) => Math.abs(d) <= 2)).toBe(true);
    expect([...shifts].some((d) => d !== 0)).toBe(true);

    for (const over of [{ lastWrongAgeMs: 10, reduceEffects: true }, { lastWrongAgeMs: 80 }]) {
      const g = scene();
      drawPlate(as2d(g), { ...p, ...over });
      expect(firstX(g, p.box.y + 8, PLATE.outline)).toBe(p.box.x);
    }
  });
});

describe('drawPlate — fading', () => {
  it('draws nothing when fully faded and blends with the scene half way', () => {
    const gone = scene();
    drawPlate(as2d(gone), plate('rally', { faded: 1 }));
    expect(colours(gone, 0, 0, gone.canvas.width, gone.canvas.height)).toEqual(new Set([BG]));

    const g = scene();
    const p = plate('rally', { faded: 0.5 });
    drawPlate(as2d(g), p);
    expect(at(g, p.box.x, p.box.y + 8)).toBe(mix(PLATE.outline, BG, 0.5));
    expect(at(g, p.box.x + 2, p.box.y + 2)).toBe(mix(PLATE.fill, BG, 0.5));
  });

  it("multiplies into the caller's opacity and restores the canvas state", () => {
    const g = scene();
    g.globalAlpha = 0.5;
    g.fillStyle = '#123456';
    const p = plate('rally', { style: 'remote', faded: 0.2 });
    drawPlate(as2d(g), p);
    expect(at(g, p.box.x, p.box.y + 8)).toBe(mix(PLATE.outline, BG, 0.4));
    expect(at(g, p.box.x + 2, p.box.y + 2)).toBe(mix(PLATE.fill, BG, 0.4 * 0.7));
    expect([g.globalAlpha, g.fillStyle]).toEqual([0.5, '#123456']);
  });
});

describe('drawPlate — remote', () => {
  it('has a grey outline, 70 % fill, no halo, no cursor and typed letters in the opponent colour', () => {
    const g = scene();
    const opp = '#46A946';
    const p = plate('rally', { style: 'remote', typed: 2, isNextCursor: true, oppColor: opp });
    drawPlate(as2d(g), p);
    const { x, y } = p.box;
    expect([at(g, x - 1, y + 8), at(g, x, y + 8), at(g, x + 1, y + 8), at(g, x + 2, y + 2)])
      .toEqual([BG, PLATE.outline, PLATE.dim, mix(PLATE.fill, BG, 0.7)]);
    const fill = mix(PLATE.fill, BG, 0.7);
    [...'rally'].forEach((ch, i) => {
      const c = cell(p.box, i);
      expectGlyph(g, c.x, c.y, ch, i < 2 ? opp : PLATE.text, fill);
    });
  });

  it('falls back to the tier colour for typed letters without an opponent colour', () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', typed: 1 });
    drawPlate(as2d(g), p);
    const c = cell(p.box, 0);
    expectGlyph(g, c.x, c.y, 'r', TIER_COLOR.easy, mix(PLATE.fill, BG, 0.7));
  });

  it('hides the word: one dim dot per letter, typed letters as 3×5 tier blocks, tier outline and pips', () => {
    const g = scene();
    const p = hidden(8, 'medium', { typed: 3 });
    drawPlate(as2d(g), p);
    const tier = TIER_COLOR.medium;
    const fill = mix(PLATE.fill, BG, 0.7);
    expect(p.box.w).toBe(plateWidth(8));
    expect(at(g, p.box.x + 1, p.box.y + 8)).toBe(tier);
    expect(at(g, p.box.x + 3, p.box.y + 5)).toBe(tier);
    for (let i = 0; i < 8; i++) {
      const c = cell(p.box, i);
      for (let row = 0; row < 10; row++) {
        for (let col = 0; col < 6; col++) {
          const block = col >= 1 && col <= 3 && row >= 3 && row <= 7;
          const dot = col === 2 && row === 5;
          const want = i < 3 ? (block ? tier : fill) : dot ? PLATE.dim : fill;
          expect(at(g, c.x + col, c.y + row), `cell ${i} (${col},${row})`).toBe(want);
        }
      }
    }
  });

  it('shakes on a wrong key but never flashes', () => {
    const g = scene();
    const p = hidden(5, 'easy', { lastWrongAgeMs: 10 });
    drawPlate(as2d(g), p);
    const shift = Math.abs(firstX(g, p.box.y + 8, PLATE.outline) - p.box.x);
    expect(shift).toBeGreaterThan(0);
    expect(shift).toBeLessThanOrEqual(2);
    expect(colours(g, 0, 0, g.canvas.width, g.canvas.height).has(PLATE.flash)).toBe(false);
  });
});

describe('drawPlate — name chip', () => {
  const chipText = (g: PixelContext, x: number, y: number, text: string): void => {
    let cx = x;
    for (const ch of text) {
      const glyph = GLYPHS[ch]!;
      for (let row = 1; row < 8; row++) {
        for (let col = 0; col < glyph.w; col++) {
          const want = glyph.rows[row]![col] === '#' ? PLATE.text : PLATE.fill;
          expect(at(g, cx + col, y + row), `${ch} (${col},${row})`).toBe(want);
        }
      }
      cx += glyph.w + 1;
    }
  };

  it('shows the first 3 letters of the name, capitalised, on a tab above the plate', () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', nameChip: 'alexander' });
    drawPlate(as2d(g), p);
    const { x, y } = p.box;
    const w = textWidth('ALE') + 4;
    expect(at(g, x, y - 10)).toBe(PLATE.outline);
    expect(at(g, x + w - 1, y - 5)).toBe(PLATE.outline);
    expect(at(g, x + w, y - 5)).toBe(BG);
    chipText(g, x + 2, y - 9, 'ALE');
  });

  it('hangs the tab below a plate at the top of the far band', () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', nameChip: 'Bo' }, 40, 22);
    drawPlate(as2d(g), p);
    const { x, y, h } = p.box;
    expect(colours(g, x, y - 11, 30, 11)).toEqual(new Set([BG]));
    expect(at(g, x, y + h + 9)).toBe(PLATE.outline);
    chipText(g, x + 2, y + h, 'BO');
  });
});

describe('drawPlate — 2×', () => {
  it('is the 1× plate scaled up pixel for pixel', () => {
    const over: Partial<PlateDraw> = { typed: 2, isNextCursor: true };
    const one = scene(120, 60);
    const p1 = plate('backhand', over, 10, 10);
    drawPlate(as2d(one), p1);
    const two = scene(240, 120);
    const p2 = plate('backhand', { ...over, scale: 2 }, 20, 20);
    drawPlate(as2d(two), p2);
    const got: string[] = [];
    const want: string[] = [];
    for (let y = -2; y < p2.box.h + 2; y++) {
      for (let x = -2; x < p2.box.w + 2; x++) {
        got.push(at(two, 20 + x, 20 + y));
        want.push(at(one, 10 + Math.floor(x / 2), 10 + Math.floor(y / 2)));
      }
    }
    expect(new Set(want)).toEqual(new Set([PLATE.halo, PLATE.outline, PLATE.fill, PLATE.text, TIER_COLOR.medium]));
    expect(got).toEqual(want);
  });
});

describe('drawTierRing', () => {
  const inkAround = (tier: Tier): { ink: string[]; all: Set<string>; g: PixelContext } => {
    const g = scene(40, 40);
    drawTierRing(as2d(g), tier, 20, 20);
    const ink: string[] = [];
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) if (at(g, x, y) === TIER_COLOR[tier]) ink.push(`${x - 20},${y - 20}`);
    }
    return { ink, all: colours(g, 0, 0, 40, 40), g };
  };

  it('draws a different shape per tier (circle, diamond, star), symmetric about the target', () => {
    const shapes = (['easy', 'medium', 'hard'] as const).map((t) => inkAround(t).ink.sort().join(' '));
    expect(new Set(shapes).size).toBe(3);
    for (const t of ['easy', 'medium', 'hard'] as const) {
      const ink = new Set(inkAround(t).ink);
      expect(ink.size).toBeGreaterThan(0);
      for (const p of ink) {
        const [dx, dy] = p.split(',').map(Number) as [number, number];
        expect(ink.has(`${-dx},${dy}`) && ink.has(`${dx},${-dy}`), `${t} ${p}`).toBe(true);
      }
    }
  });

  it('outlines every tier pixel in near-black', () => {
    for (const t of ['easy', 'medium', 'hard'] as const) {
      const { ink, all, g } = inkAround(t);
      expect(all).toEqual(new Set([BG, OUTLINE, TIER_COLOR[t]]));
      for (const p of ink) {
        const [dx, dy] = p.split(',').map(Number) as [number, number];
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) expect(at(g, 20 + dx + i, 20 + dy + j)).not.toBe(BG);
        }
      }
    }
  });
});

describe('drawLeader', () => {
  /** Number of 8-connected groups of non-background pixels. */
  function marks(g: PixelContext): number {
    const { width, height } = g.canvas;
    const seen = new Set<number>();
    let groups = 0;
    for (let start = 0; start < width * height; start++) {
      if (seen.has(start) || at(g, start % width, Math.floor(start / width)) === BG) continue;
      groups++;
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const k = stack.pop()!;
        const [x, y] = [k % width, Math.floor(k / width)];
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const [nx, ny] = [x + i, y + j];
            const n = ny * width + nx;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height || seen.has(n) || at(g, nx, ny) === BG) continue;
            seen.add(n);
            stack.push(n);
          }
        }
      }
    }
    return groups;
  }

  it('runs a 1 px tier line from the plate end, outlined in near-black, into the ring as one mark', () => {
    const g = scene(60, 50);
    drawLeader(as2d(g), { x: 10, y: 5 }, { x: 40.4, y: 35.2 }, 'hard');
    drawTierRing(as2d(g), 'hard', 40.4, 35.2);
    const tier = TIER_COLOR.hard;
    expect(at(g, 10, 5)).toBe(tier);
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < 32; x++) {
        if (at(g, x, y) !== tier) continue;
        expect(x - 10, `leader pixel ${x},${y} off the line`).toBe(y - 5);
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) expect(at(g, x + i, y + j)).not.toBe(BG);
      }
    }
    expect(colours(g, 0, 0, 60, 50)).toEqual(new Set([BG, OUTLINE, tier]));
    expect(marks(g)).toBe(1);
  });

  it('stops at the ring outline, leaving the ring untouched from any direction', () => {
    for (const t of ['easy', 'medium', 'hard'] as const) {
      const ring = scene(60, 60);
      drawTierRing(as2d(ring), t, 30, 30);
      for (const from of [{ x: 30, y: 0 }, { x: 2, y: 12 }, { x: 55, y: 50 }, { x: 0, y: 30 }]) {
        const g = scene(60, 60);
        drawTierRing(as2d(g), t, 30, 30);
        drawLeader(as2d(g), from, { x: 30, y: 30 }, t);
        // The ring's footprint: on each row, everything from its leftmost to its rightmost pixel.
        for (let y = 0; y < 60; y++) {
          const xs = [];
          for (let x = 0; x < 60; x++) if (at(ring, x, y) !== BG) xs.push(x);
          for (let x = xs[0] ?? 0; x <= (xs.at(-1) ?? -1); x++) {
            expect(at(g, x, y), `${t} from ${from.x},${from.y} at ${x},${y}`).toBe(at(ring, x, y));
          }
        }
        expect(marks(g), `${t} from ${from.x},${from.y}`).toBe(1);
      }
    }
  });
});

describe('drawTimingBar', () => {
  it('fills the remaining fraction in white from the left over a dark outlined 2 px track', () => {
    const g = scene(60, 20);
    drawTimingBar(as2d(g), 10, 10, 40, 0.25, false);
    for (const y of [10, 11]) {
      expect(colours(g, 10, y, 10, 1)).toEqual(new Set([PAL.white]));
      expect(colours(g, 20, y, 30, 1)).toEqual(new Set([OUTLINE]));
      expect([at(g, 9, y), at(g, 50, y)]).toEqual([OUTLINE, OUTLINE]);
    }
    expect(colours(g, 9, 9, 42, 1)).toEqual(new Set([OUTLINE]));
    expect(colours(g, 9, 12, 42, 1)).toEqual(new Set([OUTLINE]));
    expect([at(g, 8, 10), at(g, 51, 10), at(g, 10, 8), at(g, 10, 13)]).toEqual([BG, BG, BG, BG]);
  });

  it('clamps the fraction to 0–1', () => {
    const full = scene(60, 20);
    drawTimingBar(as2d(full), 10, 10, 40, 1.7, false);
    expect(colours(full, 10, 10, 40, 2)).toEqual(new Set([PAL.white]));
    const empty = scene(60, 20);
    drawTimingBar(as2d(empty), 10, 10, 40, -0.2, false);
    expect(colours(empty, 10, 10, 40, 2)).toEqual(new Set([OUTLINE]));
  });

  it('switches the filled part to a 1 px white/dark checker in the grace window', () => {
    const g = scene(60, 20);
    drawTimingBar(as2d(g), 10, 10, 40, 0.5, true);
    for (const y of [10, 11]) {
      for (let x = 10; x < 30; x++) expect(at(g, x, y), `${x},${y}`).toBe((x + y) % 2 === 0 ? PAL.white : OUTLINE);
      expect(colours(g, 30, y, 20, 1)).toEqual(new Set([OUTLINE]));
    }
  });
});
