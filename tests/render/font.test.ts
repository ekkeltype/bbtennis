import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NAME_CHARS } from '../../src/core/text';
import { FONT, GLYPHS, drawText, textWidth, type Glyph } from '../../src/render/font';

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = LOWER.toUpperCase();
const DIGITS = '0123456789';
const PUNCT = `.,:;!?'"-+/()%&*#@<>=_[]`;
const DESCENDERS = 'gjpqy';

function glyph(ch: string): Glyph {
  const g = GLYPHS[ch];
  if (!g) throw new Error(`no glyph for ${JSON.stringify(ch)}`);
  return g;
}

function inkRows(ch: string): number[] {
  return glyph(ch).rows.flatMap((row, y) => (row.includes('#') ? [y] : []));
}

/** Number of columns (over the wider glyph) whose 10-pixel column strips differ. */
function differingColumns(a: string, b: string): number {
  const ga = glyph(a);
  const gb = glyph(b);
  let n = 0;
  for (let x = 0; x < Math.max(ga.w, gb.w); x++) {
    const col = (g: Glyph) => g.rows.map((row) => row[x] ?? '.').join('');
    if (col(ga) !== col(gb)) n++;
  }
  return n;
}

describe('FONT', () => {
  it('declares the 6×10 cell with baseline row 7, x-height 5 and cap height 7', () => {
    expect(FONT).toEqual({ cellW: 6, cellH: 10, baseline: 7, xHeight: 5, capHeight: 7 });
  });
});

describe('GLYPHS coverage', () => {
  it('covers a–z, A–Z, 0–9, the punctuation set, space and ★', () => {
    const missing = [...LOWER, ...UPPER, ...DIGITS, ...PUNCT, ' ', '★'].filter((c) => !(c in GLYPHS));
    expect(missing).toEqual([]);
  });

  it('covers every character allowed in player names', () => {
    expect([...NAME_CHARS].every((c) => c in GLYPHS)).toBe(true);
  });
});

describe('glyph shapes', () => {
  it('stores every glyph as 10 rows of #/. exactly w wide, 1 ≤ w ≤ 5 (fits the cell with a 1 px gap)', () => {
    for (const [ch, g] of Object.entries(GLYPHS)) {
      expect(g.rows, ch).toHaveLength(FONT.cellH);
      expect(g.w, ch).toBeGreaterThanOrEqual(1);
      expect(g.w, ch).toBeLessThanOrEqual(FONT.cellW - 1);
      for (const row of g.rows) expect(row, ch).toMatch(new RegExp(`^[#.]{${g.w}}$`));
    }
  });

  it('keeps row 0 blank in every glyph and the space glyph empty', () => {
    for (const [ch, g] of Object.entries(GLYPHS)) expect(g.rows[0], ch).not.toContain('#');
    expect(inkRows(' ')).toEqual([]);
  });

  it('makes every lowercase glyph 5 wide and 10 rows', () => {
    for (const ch of LOWER) {
      expect(glyph(ch).w, ch).toBe(5);
      expect(glyph(ch).rows, ch).toHaveLength(10);
    }
  });

  it('uses the descender rows 8–9 only in g, j, p, q, y, and 2 px deep there', () => {
    for (const ch of LOWER) {
      const rows = inkRows(ch);
      if (DESCENDERS.includes(ch)) {
        expect(rows, ch).toContain(8);
        expect(rows, ch).toContain(9);
      } else {
        expect(Math.max(...rows), ch).toBeLessThanOrEqual(FONT.baseline);
      }
    }
  });

  it('sits every lowercase letter on the baseline row', () => {
    for (const ch of LOWER) expect(inkRows(ch), ch).toContain(FONT.baseline);
  });

  it('gives x-height letters a 5-row body and ascenders the full cap height', () => {
    const xTop = FONT.baseline - FONT.xHeight + 1;
    const capTop = FONT.baseline - FONT.capHeight + 1;
    for (const ch of 'acegmnopqrsuvwxyz') expect(Math.min(...inkRows(ch)), ch).toBe(xTop);
    for (const ch of 'bdfhkl') expect(Math.min(...inkRows(ch)), ch).toBe(capTop);
  });

  it('gives capitals and digits cap height 7, standing on the baseline', () => {
    for (const ch of UPPER + DIGITS) {
      const rows = inkRows(ch);
      expect(Math.max(...rows) - Math.min(...rows) + 1, ch).toBe(FONT.capHeight);
      expect(Math.max(...rows), ch).toBe(FONT.baseline);
    }
  });

  it('keeps punctuation in the cap-height box; only , ; _ dip one row below the baseline', () => {
    for (const ch of [...PUNCT, '★']) {
      const rows = inkRows(ch);
      expect(rows.length, ch).toBeGreaterThan(0);
      expect(Math.min(...rows), ch).toBeGreaterThanOrEqual(1);
      expect(Math.max(...rows), ch).toBeLessThanOrEqual(',;_'.includes(ch) ? FONT.baseline + 1 : FONT.baseline);
    }
    for (const ch of '()[]/!?') expect([Math.min(...inkRows(ch)), Math.max(...inkRows(ch))], ch).toEqual([1, 7]);
  });

  it('makes i, l and j differ pairwise in ≥ 2 columns', () => {
    expect(differingColumns('i', 'l')).toBeGreaterThanOrEqual(2);
    expect(differingColumns('i', 'j')).toBeGreaterThanOrEqual(2);
    expect(differingColumns('l', 'j')).toBeGreaterThanOrEqual(2);
  });

  it('keeps the classic confusables 0/O, 1/l, 1/I, l/I apart in ≥ 2 columns', () => {
    for (const [a, b] of [['0', 'O'], ['1', 'l'], ['1', 'I'], ['l', 'I']] as const) {
      expect(differingColumns(a, b), `${a}/${b}`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('textWidth', () => {
  it("measures 'ball' as 23 px (4 · 6 − 1)", () => {
    expect(textWidth('ball')).toBe(23);
  });

  it('doubles at scale 2 and is 0 for the empty string', () => {
    expect(textWidth('ball', 2)).toBe(46);
    expect(textWidth('')).toBe(0);
    expect(textWidth('', 2)).toBe(0);
  });

  it('advances each glyph by its own width plus a 1 px gap', () => {
    expect(textWidth('a.b')).toBe(5 + 1 + glyph('.').w + 1 + 5);
    expect(textWidth('15-40')).toBe(4 * 6 + glyph('-').w);
  });

  it('measures characters without a glyph (per code point) as "?"', () => {
    expect(textWidth('é😀<')).toBe(textWidth('??<'));
  });
});

/** Minimal pixel-recording stand-in for OffscreenCanvas: remembers fillRect pixels and their colour. */
class FakeCanvas {
  static made: FakeCanvas[] = [];
  readonly pixels = new Map<string, string>();
  readonly ctx = {
    fillStyle: '',
    fillRect: (x: number, y: number, w: number, h: number) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.pixels.set(`${x + i},${y + j}`, this.ctx.fillStyle);
    },
  };
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    FakeCanvas.made.push(this);
  }
  getContext(kind: string) {
    return kind === '2d' ? this.ctx : null;
  }
}

/** Target context that composites drawImage blits from FakeCanvas atlases into a pixel map. */
function targetCtx() {
  const pixels = new Map<string, string>();
  const blits: { dx: number; dy: number; dw: number; dh: number }[] = [];
  const ctx = {
    drawImage(src: FakeCanvas, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
      expect([dw, dh]).toEqual([sw, sh]);
      blits.push({ dx, dy, dw, dh });
      for (let j = 0; j < sh; j++) {
        for (let i = 0; i < sw; i++) {
          const c = src.pixels.get(`${sx + i},${sy + j}`);
          if (c !== undefined) pixels.set(`${dx + i},${dy + j}`, c);
        }
      }
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, pixels, blits };
}

/** The pixels `s` should produce at (x, y), built straight from GLYPHS. */
function expectedPixels(s: string, x: number, y: number, color: string, scale: 1 | 2): Map<string, string> {
  const out = new Map<string, string>();
  let cx = x;
  for (const ch of s) {
    const g = GLYPHS[ch] ?? glyph('?');
    g.rows.forEach((row, gy) => {
      [...row].forEach((p, gx) => {
        if (p !== '#') return;
        for (let j = 0; j < scale; j++) {
          for (let i = 0; i < scale; i++) out.set(`${cx + gx * scale + i},${y + gy * scale + j}`, color);
        }
      });
    });
    cx += (g.w + 1) * scale;
  }
  return out;
}

describe('drawText', () => {
  beforeAll(() => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('draws exactly the glyph pixels, advancing w + 1 per character', () => {
    const { ctx, pixels, blits } = targetCtx();
    drawText(ctx, 'Game, Alex', 10, 20, '#F5F2E8');
    expect(pixels).toEqual(expectedPixels('Game, Alex', 10, 20, '#F5F2E8', 1));
    expect(blits.every((b) => b.dy === 20 && b.dh === FONT.cellH)).toBe(true);
  });

  it('doubles every pixel and advance at scale 2', () => {
    const { ctx, pixels } = targetCtx();
    drawText(ctx, '15-40 ★', 3, 4, '#56B4E9', 2);
    expect(pixels).toEqual(expectedPixels('15-40 ★', 3, 4, '#56B4E9', 2));
  });

  it('draws characters without a glyph as "?"', () => {
    const { ctx, pixels } = targetCtx();
    drawText(ctx, 'Zoë😀', 0, 0, '#F0E442');
    expect(pixels).toEqual(expectedPixels('Zo??', 0, 0, '#F0E442', 1));
  });

  it('snaps fractional positions to whole pixels', () => {
    const { ctx, blits } = targetCtx();
    drawText(ctx, 'ab', 10.6, 20.4, '#F5F2E8');
    expect(blits.map((b) => [b.dx, b.dy])).toEqual([
      [11, 20],
      [17, 20],
    ]);
  });

  it('builds one glyph atlas per colour and scale and reuses it', () => {
    const before = FakeCanvas.made.length;
    const { ctx } = targetCtx();
    drawText(ctx, 'abc', 0, 0, '#D55E00');
    drawText(ctx, 'xyz', 0, 30, '#D55E00');
    expect(FakeCanvas.made.length - before).toBe(1);
    drawText(ctx, 'abc', 0, 0, '#D55E00', 2);
    drawText(ctx, 'abc', 0, 0, '#7B7C94');
    expect(FakeCanvas.made.length - before).toBe(3);
  });
});
