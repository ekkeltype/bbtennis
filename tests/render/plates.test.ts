import { beforeAll, describe, expect, it, vi } from 'vitest';
import { COURT } from '../../src/core/court';
import { TUNING } from '../../src/core/tuning';
import type { Tier, WordOption } from '../../src/core/types';
import { contrastRatio } from '../../src/render/color';
import { GLYPHS, textWidth } from '../../src/render/font';
import { layoutServeFar, type PlateBox } from '../../src/render/layout';
import { BELT_COLOR, OUTLINE, PAL, PLATE, RAMPS, TIER_COLOR, TIER_TYPED } from '../../src/render/palette';
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

  it("draws typed letters in the tier's typed shade, the next letter as an inverse block, the rest near-white", () => {
    const g = scene();
    const p = plate('rally', { typed: 2, isNextCursor: true });
    drawPlate(as2d(g), p);
    const tier = TIER_TYPED.easy;
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
      expectGlyph(g, x, y, ch, TIER_TYPED.easy, PLATE.fill);
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
  it("has a grey outline, 70 % fill, no halo, no cursor and typed letters in the tier's typed shade", () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', typed: 2, isNextCursor: true, oppColor: '#46A946' });
    drawPlate(as2d(g), p);
    const { x, y } = p.box;
    expect([at(g, x - 1, y + 8), at(g, x, y + 8), at(g, x + 1, y + 8), at(g, x + 2, y + 2)])
      .toEqual([BG, PLATE.outline, PLATE.dim, mix(PLATE.fill, BG, 0.7)]);
    const fill = mix(PLATE.fill, BG, 0.7);
    [...'rally'].forEach((ch, i) => {
      const c = cell(p.box, i);
      expectGlyph(g, c.x, c.y, ch, i < 2 ? TIER_TYPED.easy : PLATE.text, fill);
    });
  });

  it('draws typed letters in the typed shade of every tier, local and remote, whatever the belt colour', () => {
    for (const word of ['rally', 'backhand', 'counterpuncher']) {
      for (const style of ['localActive', 'remote'] as const) {
        for (const oppColor of [null, '#FFFFFF', '#353140']) {
          const g = scene();
          const p = plate(word, { style, typed: 2, oppColor });
          drawPlate(as2d(g), p);
          const fill = style === 'remote' ? mix(PLATE.fill, BG, 0.7) : PLATE.fill;
          [...word].forEach((ch, i) => {
            const c = cell(p.box, i);
            expectGlyph(g, c.x, c.y, ch, i < 2 ? TIER_TYPED[p.opt.tier] : PLATE.text, fill);
          });
        }
      }
    }
  });

  it('hides the word on an opaque fill: one dim dot per letter, typed letters as 3×5 tier blocks, tier outline and pips', () => {
    const g = scene();
    const p = hidden(8, 'medium', { typed: 3 });
    drawPlate(as2d(g), p);
    const tier = TIER_COLOR.medium;
    // Opaque, unlike a visible remote word's 70 % fill, so the dots read over the crowd.
    const fill = PLATE.fill;
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
  /** Asserts `text` in capitals (glyph rows 1–7) at (x, y + 1), `ink` on `paper`, gaps included. */
  const chipText = (
    g: PixelContext,
    x: number,
    y: number,
    text: string,
    ink = PAL.white,
    paper = PLATE.fill,
  ): void => {
    let cx = x;
    for (const ch of text) {
      const glyph = GLYPHS[ch]!;
      for (let row = 1; row < 8; row++) {
        for (let col = 0; col <= glyph.w; col++) {
          const want = glyph.rows[row]![col] === '#' ? ink : paper;
          expect(at(g, cx + col, y + row), `${ch} (${col},${row})`).toBe(want);
        }
      }
      cx += glyph.w + 1;
    }
  };

  /**
   * The 1 px edge of a chip at (cx, cy), `w` × `h`, that is not shared with its plate: `shared` names
   * the side lying on the plate's dark stroke. Returns the edge colours and the shared side's colours.
   */
  const chipEdges = (
    g: PixelContext,
    cx: number,
    cy: number,
    w: number,
    h: number,
    shared: 'bottom' | 'left' | 'right',
  ): { free: Set<string>; shared: Set<string> } => {
    const sides = {
      top: colours(g, cx, cy, w, 1),
      bottom: colours(g, cx, cy + h - 1, w, 1),
      left: colours(g, cx, cy, 1, h),
      right: colours(g, cx + w - 1, cy, 1, h),
    };
    const inner = {
      bottom: [sides.top, colours(g, cx, cy, 1, h - 1), colours(g, cx + w - 1, cy, 1, h - 1)],
      left: [colours(g, cx + 1, cy, w - 1, 1), colours(g, cx + 1, cy + h - 1, w - 1, 1), sides.right],
      right: [colours(g, cx, cy, w - 1, 1), colours(g, cx, cy + h - 1, w - 1, 1), sides.left],
    }[shared];
    return { free: new Set(inner.flatMap((s) => [...s])), shared: sides[shared] };
  };

  it("shows the name's first 3 letters in white capitals on a dark tab above the plate without a belt colour", () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', nameChip: 'alexander' });
    drawPlate(as2d(g), p);
    const { x, y } = p.box;
    const w = textWidth('ALE') + 4;
    expect(at(g, x + w - 1, y - 10)).not.toBe(BG);
    expect(at(g, x + w, y - 5)).toBe(BG);
    expect(at(g, x, y - 11)).toBe(BG);
    chipText(g, x + 2, y - 9, 'ALE');
  });

  it('rims a dark tab (black or brown belt, or none) in a light 1 px outline, a light tab in the dark stroke', () => {
    const cases: [string, string | null, boolean][] = [
      ['black', RAMPS.cloth[BELT_COLOR.black]![1], true],
      ['brown', RAMPS.cloth[BELT_COLOR.brown]![1], true],
      ['no belt', null, true],
      ['white', RAMPS.cloth[BELT_COLOR.white]![1], false],
      ['yellow', RAMPS.cloth[BELT_COLOR.yellow]![1], false],
      ['green', RAMPS.cloth[BELT_COLOR.green]![1], false],
    ];
    for (const [label, oppColor, dark] of cases) {
      const g = scene();
      const p = plate('rally', { style: 'remote', nameChip: 'kim', oppColor });
      drawPlate(as2d(g), p);
      const { x, y } = p.box;
      const edges = chipEdges(g, x, y - 10, textWidth('KIM') + 4, 11, 'bottom');
      expect(edges.shared, `${label}: the plate's top stroke stays dark`).toEqual(new Set([PLATE.outline]));
      expect(edges.free.size, label).toBe(1);
      const [rim] = [...edges.free] as [string];
      if (!dark) {
        expect(rim, label).toBe(PLATE.outline);
        continue;
      }
      expect(contrastRatio(rim, PLATE.outline), `${label} rim vs dark ground`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(rim, oppColor ?? PLATE.fill), `${label} rim vs tab`).toBeGreaterThanOrEqual(3);
    }
  });

  it('paints the tab in any cloth shade or the grey belt fallback with text at ≥ 4.5:1', () => {
    const belts: [string, string][] = [
      ...RAMPS.cloth.flatMap((ramp, r) =>
        ramp.map((shade, i): [string, string] => [`cloth ${r}[${i}] ${shade}`, shade]),
      ),
      [`PAL.grey ${PAL.grey}`, PAL.grey],
    ];
    expect(belts.length).toBe(RAMPS.cloth.length * 3 + 1);
    for (const [label, shade] of belts) {
      const g = scene();
      const p = plate('rally', { style: 'remote', nameChip: 'kim', oppColor: shade });
      drawPlate(as2d(g), p);
      const { x, y } = p.box;
      const w = textWidth('KIM') + 4;
      const inside = colours(g, x + 1, y - 9, w - 2, 9);
      const text = [...inside].filter((c) => c !== shade);
      expect(inside.has(shade), label).toBe(true);
      expect(text.length, label).toBe(1);
      expect([PAL.white, PLATE.outline], label).toContain(text[0]);
      expect(contrastRatio(text[0]!, shade), label).toBeGreaterThanOrEqual(4.5);
      chipText(g, x + 2, y - 9, 'KIM', text[0], shade);
      const edges = chipEdges(g, x, y - 10, w, 11, 'bottom');
      expect(edges.free.size, `${label} edge`).toBe(1);
      const [rim] = [...edges.free] as [string];
      if (text[0] === PLATE.outline) expect(rim, `${label} edge`).toBe(PLATE.outline);
      else expect(contrastRatio(rim, shade), `${label} rim vs tab`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(rim, PLATE.outline) >= 3 || contrastRatio(shade, PLATE.outline) >= 3, label).toBe(true);
    }
  });

  it('picks dark text on a white belt and white text on a black belt', () => {
    for (const [ramp, ink] of [[BELT_COLOR.white, PLATE.outline], [BELT_COLOR.black, PAL.white]] as const) {
      const g = scene();
      const shade = RAMPS.cloth[ramp]![1];
      const p = plate('rally', { style: 'remote', nameChip: 'kim', oppColor: shade });
      drawPlate(as2d(g), p);
      chipText(g, p.box.x + 2, p.box.y - 9, 'KIM', ink, shade);
    }
  });

  it('sets the tab beside a plate at the top of the far band, inside the band, never below the plate', () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', nameChip: 'Bo' }, 60, 22);
    drawPlate(as2d(g), p);
    const { width, height } = g.canvas;
    const w = textWidth('BO') + 4;
    const cx = 60 - w + 1;
    expect(colours(g, 0, 0, width, 22), 'HUD band').toEqual(new Set([BG]));
    expect(colours(g, 0, 38, width, height - 38), 'below the plate').toEqual(new Set([BG]));
    expect(colours(g, 0, 22, cx, 16), 'left of the tab').toEqual(new Set([BG]));
    expect(colours(g, cx, 33, w - 1, 5), 'under the tab').toEqual(new Set([BG]));
    chipText(g, cx + 2, 23, 'BO');
    const edges = chipEdges(g, cx, 22, w, 11, 'right');
    expect(edges.shared, "the plate's left stroke stays dark").toEqual(new Set([PLATE.outline]));
    expect(edges.free.size).toBe(1);
  });

  it('sets a far-band tab on the side away from the screen centre: right of a plate right of x 240', () => {
    const g = scene(480, 60);
    const p = plate('rally', { style: 'remote', nameChip: 'Bo' }, 300, 22);
    drawPlate(as2d(g), p);
    const w = textWidth('BO') + 4;
    const cx = 300 + p.box.w - 1;
    expect(colours(g, 0, 0, 300, 60), 'left of the plate').toEqual(new Set([BG]));
    chipText(g, cx + 2, 23, 'BO');
    expect(chipEdges(g, cx, 22, w, 11, 'left').shared).toEqual(new Set([PLATE.outline]));
    expect(colours(g, cx + w, 0, 480 - cx - w, 60)).toEqual(new Set([BG]));
  });

  it('sets a far-band tab left of a plate too near the right edge for it, never right of x 476', () => {
    const g = scene(480, 60);
    const p = plate('rally', { style: 'remote', nameChip: 'Bo' }, 476 - plateWidth(5), 22);
    drawPlate(as2d(g), p);
    const w = textWidth('BO') + 4;
    expect(colours(g, 476, 0, 4, 60), 'right of x 476').toEqual(new Set([BG]));
    chipText(g, p.box.x - w + 3, 23, 'BO');
  });

  it('keeps the tab of a far serve row out of the toss gap over the server, before and after the lock', () => {
    // The far server's feet (spec §4.1 projection of TUNING.positions, x ±0.8 m at y 12.3 m) and the centre.
    const d = 1 + (TUNING.positions.serverY + COURT.halfLength) / (2 * COURT.halfLength);
    const off = (TUNING.positions.serverX * 27.35) / d;
    const words = ['rally', 'backhand', 'counterpuncher'];
    for (const sx of [240 - off, 240, 240 + off]) {
      const row = layoutServeFar(words.map((w) => w.length), sx);
      const gapLeft = Math.max(...row.filter((b) => b.x < sx).map((b) => b.x + b.w));
      const gapRight = Math.min(...row.filter((b) => b.x > sx).map((b) => b.x));
      expect(gapRight - gapLeft, `server ${sx}: plates on both sides of a 24+ px gap`).toBeGreaterThanOrEqual(24);
      for (const chipOn of [0, 1, 2]) {
        const g = scene(480, 60);
        row.forEach((b, i) => {
          const over: Partial<PlateDraw> = { style: 'remote', nameChip: i === chipOn ? 'kim' : null };
          drawPlate(as2d(g), plate(words[i]!, over, b.x, b.y));
        });
        const id = `server ${sx}, chip on option ${chipOn}`;
        expect(colours(g, gapLeft, 0, gapRight - gapLeft, 60), `${id}: the toss gap`).toEqual(new Set([BG]));
        expect(colours(g, 0, 38, 480, 22), `${id}: below the band`).toEqual(new Set([BG]));
      }
    }
  });

  it('sets a far-band tab right of a plate too near the left edge for it, never left of x 4', () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', nameChip: 'Bo' }, 10, 22);
    drawPlate(as2d(g), p);
    const w = textWidth('BO') + 4;
    const cx = 10 + p.box.w - 1;
    expect(colours(g, 0, 0, 10, g.canvas.height), 'left of the plate').toEqual(new Set([BG]));
    expect(colours(g, 0, 38, g.canvas.width, g.canvas.height - 38), 'below the plate').toEqual(new Set([BG]));
    chipText(g, cx + 2, 23, 'BO');
    expect(chipEdges(g, cx, 22, w, 11, 'left').shared).toEqual(new Set([PLATE.outline]));
    expect(at(g, cx + w, 27)).toBe(BG);
  });

  it('keeps the tab out of the HUD band (y 0–21): above a plate from y 32 down, beside it higher up', () => {
    const w = textWidth('BO') + 4;
    const above = scene();
    drawPlate(as2d(above), plate('rally', { style: 'remote', nameChip: 'Bo' }, 40, 32));
    expect(colours(above, 0, 0, above.canvas.width, 22)).toEqual(new Set([BG]));
    chipText(above, 42, 23, 'BO');

    const beside = scene();
    drawPlate(as2d(beside), plate('rally', { style: 'remote', nameChip: 'Bo' }, 40, 31));
    expect(colours(beside, 0, 0, beside.canvas.width, 31)).toEqual(new Set([BG]));
    expect(colours(beside, 0, 47, beside.canvas.width, beside.canvas.height - 47)).toEqual(new Set([BG]));
    chipText(beside, 40 - w + 3, 32, 'BO');
  });

  it('sets a 2× tab beside a 2× plate at the top of the far band', () => {
    const g = scene();
    const p = plate('rally', { style: 'remote', nameChip: 'Bo', scale: 2 }, 60, 22);
    drawPlate(as2d(g), p);
    const w = textWidth('BO', 2) + 8;
    const cx = 60 - w + 2;
    expect(colours(g, 0, 0, g.canvas.width, 22)).toEqual(new Set([BG]));
    expect(colours(g, 0, 22 + 32, g.canvas.width, g.canvas.height - 54)).toEqual(new Set([BG]));
    expect(colours(g, 0, 22, cx, 32)).toEqual(new Set([BG]));
    expect(colours(g, cx, 44, w - 2, 10), 'under the tab').toEqual(new Set([BG]));
    expect(colours(g, 60, 22, 2, 22), "the plate's left stroke stays dark").toEqual(new Set([PLATE.outline]));
    expect(colours(g, cx, 22, 2, 22).size).toBe(1);
    expect(at(g, cx, 22)).not.toBe(BG);
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
    expect(new Set(want)).toEqual(
      new Set([PLATE.halo, PLATE.outline, PLATE.fill, PLATE.text, TIER_COLOR.medium, TIER_TYPED.medium]),
    );
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

  /** The 8-connected groups of `cells` ('dx,dy' keys). */
  const groups = (cells: string[]): string[][] => {
    const left = new Set(cells);
    const out: string[][] = [];
    for (const start of cells) {
      if (!left.delete(start)) continue;
      const group = [start];
      for (let i = 0; i < group.length; i++) {
        const [x, y] = group[i]!.split(',').map(Number) as [number, number];
        for (let j = -1; j <= 1; j++) {
          for (let k = -1; k <= 1; k++) {
            const n = `${x + k},${y + j}`;
            if (left.delete(n)) group.push(n);
          }
        }
      }
      out.push(group);
    }
    return out;
  };

  /** Whether the target point is walled in by ink: no 4-connected ink-free path leads out of the ring's box. */
  const enclosesCentre = (ink: string[]): boolean => {
    const wall = new Set(ink);
    const seen = new Set(['0,0']);
    const queue = [[0, 0] as [number, number]];
    while (queue.length) {
      const [x, y] = queue.pop()!;
      if (Math.abs(x) > 6 || Math.abs(y) > 3) return false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = `${x + dx},${y + dy}`;
        if (wall.has(n) || seen.has(n)) continue;
        seen.add(n);
        queue.push([x + dx, y + dy]);
      }
    }
    return true;
  };

  it('keeps every ring 13×7 px, centred on the target', () => {
    for (const t of ['easy', 'medium', 'hard'] as const) {
      const cells = inkAround(t).ink.map((p) => p.split(',').map(Number) as [number, number]);
      const xs = cells.map(([x]) => x);
      const ys = cells.map(([, y]) => y);
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], t).toEqual([-6, 6, -3, 3]);
    }
  });

  it('draws the medium diamond as one closed line around the target', () => {
    const { ink } = inkAround('medium');
    expect(groups(ink).length).toBe(1);
    expect(enclosesCentre(ink)).toBe(true);
  });

  it('draws the hard star as 4 separate points, one on each axis, around an open hollow centre', () => {
    const { ink } = inkAround('hard');
    const points = groups(ink);
    expect(points.length).toBe(4);
    for (const tip of ['0,-3', '0,3', '-6,0', '6,0']) {
      expect(points.filter((g) => g.includes(tip)).length, `a point reaching ${tip}`).toBe(1);
    }
    for (const p of ink) {
      const [dx, dy] = p.split(',').map(Number) as [number, number];
      expect(Math.abs(dx) <= 2 && Math.abs(dy) <= 1, `${p} inside the hollow centre`).toBe(false);
    }
    expect(enclosesCentre(ink)).toBe(false);
  });

  it('shares under half its pixels with the diamond, so the shapes differ without colour (deutan)', () => {
    const medium = new Set(inkAround('medium').ink);
    const hard = inkAround('hard').ink;
    const shared = hard.filter((p) => medium.has(p)).length;
    expect(shared / (medium.size + hard.length - shared)).toBeLessThan(0.5);
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

  it('switches the filled part to a white/dark checker of 2×2 px cells in the grace window, white first', () => {
    for (const [bx, by] of [[10, 10], [11, 9]] as const) {
      const g = scene(60, 20);
      drawTimingBar(as2d(g), bx, by, 40, 0.5, true);
      for (const y of [by, by + 1]) {
        for (let x = bx; x < bx + 20; x++) {
          expect(at(g, x, y), `bar at ${bx},${by}: ${x},${y}`).toBe(((x - bx) >> 1) % 2 === 0 ? PAL.white : OUTLINE);
        }
        expect(colours(g, bx + 20, y, 20, 1)).toEqual(new Set([OUTLINE]));
      }
    }
  });

  it('keeps the grace checker in place as the bar shrinks', () => {
    const wide = scene(60, 20);
    drawTimingBar(as2d(wide), 10, 10, 40, 0.5, true);
    const narrow = scene(60, 20);
    drawTimingBar(as2d(narrow), 10, 10, 40, 0.3, true);
    for (const y of [10, 11]) {
      for (let x = 10; x < 22; x++) expect(at(narrow, x, y), `${x},${y}`).toBe(at(wide, x, y));
    }
  });
});

describe('module graph', () => {
  it('loads without the projection module: plates take no values from layout', async () => {
    vi.resetModules();
    vi.doMock('../../src/render/projection', () => {
      throw new Error('plates.ts pulled in projection.ts');
    });
    try {
      await expect(import('../../src/render/plates')).resolves.toHaveProperty('drawPlate');
    } finally {
      vi.doUnmock('../../src/render/projection');
      vi.resetModules();
    }
  });
});
