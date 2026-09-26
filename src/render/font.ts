/** One bitmap glyph: 10 rows of '#' (ink) / '.' (blank), each `w` px wide, in a 6×10 cell. */
export interface Glyph {
  w: number;
  rows: string[];
}

/**
 * Cell metrics (spec §4.1): row 0 is headroom, capitals/digits/ascenders fill rows 1–7, the
 * x-height body rows 3–7, `baseline` is the lowest non-descender row, descenders use rows 8–9.
 * Each glyph advances `w + 1` px (1 px letter gap), so letters and digits step by `cellW`.
 */
export const FONT: { cellW: 6; cellH: 10; baseline: 7; xHeight: 5; capHeight: 7 } = {
  cellW: 6,
  cellH: 10,
  baseline: 7,
  xHeight: 5,
  capHeight: 7,
};

/** Glyph sheets: the characters of a strip, then its 10 pixel rows with glyphs separated by spaces. */
const STRIPS: [chars: string, art: string][] = [
  [
    'abcdefghi',
    `
    .....  .....  .....  .....  .....  .....  .....  .....  .....
    .....  #....  .....  ....#  .....  ..##.  .....  #....  ..#..
    .....  #....  .....  ....#  .....  .#..#  .....  #....  .....
    .###.  ####.  .####  .####  .###.  ####.  .####  ####.  .##..
    ....#  #...#  #....  #...#  #...#  .#...  #...#  #...#  ..#..
    .####  #...#  #....  #...#  #####  .#...  #...#  #...#  ..#..
    #...#  #...#  #....  #...#  #....  .#...  #...#  #...#  ..#..
    .####  ####.  .####  .####  .###.  .#...  .####  #...#  .###.
    .....  .....  .....  .....  .....  .....  ....#  .....  .....
    .....  .....  .....  .....  .....  .....  .###.  .....  .....
    `,
  ],
  [
    'jklmnopqr',
    `
    .....  .....  .....  .....  .....  .....  .....  .....  .....
    ...#.  #....  .##..  .....  .....  .....  .....  .....  .....
    .....  #....  ..#..  .....  .....  .....  .....  .....  .....
    ..##.  #..#.  ..#..  ##.#.  ####.  .###.  ####.  .####  #.###
    ...#.  #.#..  ..#..  #.#.#  #...#  #...#  #...#  #...#  ##...
    ...#.  ##...  ..#..  #.#.#  #...#  #...#  #...#  #...#  #....
    ...#.  #.#..  ..#..  #.#.#  #...#  #...#  #...#  #...#  #....
    ...#.  #..#.  ...##  #.#.#  #...#  .###.  ####.  .####  #....
    #..#.  .....  .....  .....  .....  .....  #....  ....#  .....
    .##..  .....  .....  .....  .....  .....  #....  ....#  .....
    `,
  ],
  [
    'stuvwxyz',
    `
    .....  .....  .....  .....  .....  .....  .....  .....
    .....  .....  .....  .....  .....  .....  .....  .....
    .....  .#...  .....  .....  .....  .....  .....  .....
    .####  ####.  #...#  #...#  #...#  #...#  #...#  #####
    #....  .#...  #...#  #...#  #...#  .#.#.  #...#  ...#.
    .###.  .#...  #...#  #...#  #.#.#  ..#..  #...#  ..#..
    ....#  .#...  #...#  .#.#.  #.#.#  .#.#.  #...#  .#...
    ####.  ..##.  .####  ..#..  .#.#.  #...#  .####  #####
    .....  .....  .....  .....  .....  .....  ....#  .....
    .....  .....  .....  .....  .....  .....  .###.  .....
    `,
  ],
  [
    'ABCDEFGHIJKLM',
    `
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    .###.  ####.  .###.  ####.  #####  #####  .###.  #...#  .###.  ..###  #...#  #....  #...#
    #...#  #...#  #...#  #...#  #....  #....  #...#  #...#  ..#..  ...#.  #..#.  #....  ##.##
    #...#  #...#  #....  #...#  #....  #....  #....  #...#  ..#..  ...#.  #.#..  #....  #.#.#
    #####  ####.  #....  #...#  ####.  ####.  #.###  #####  ..#..  ...#.  ##...  #....  #.#.#
    #...#  #...#  #....  #...#  #....  #....  #...#  #...#  ..#..  ...#.  #.#..  #....  #...#
    #...#  #...#  #...#  #...#  #....  #....  #...#  #...#  ..#..  #..#.  #..#.  #....  #...#
    #...#  ####.  .###.  ####.  #####  #....  .####  #...#  .###.  .##..  #...#  #####  #...#
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    `,
  ],
  [
    'NOPQRSTUVWXYZ',
    `
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    #...#  .###.  ####.  .###.  ####.  .###.  #####  #...#  #...#  #...#  #...#  #...#  #####
    #...#  #...#  #...#  #...#  #...#  #...#  ..#..  #...#  #...#  #...#  #...#  #...#  ....#
    ##..#  #...#  #...#  #...#  #...#  #....  ..#..  #...#  #...#  #...#  .#.#.  .#.#.  ...#.
    #.#.#  #...#  ####.  #...#  ####.  .###.  ..#..  #...#  #...#  #.#.#  ..#..  ..#..  ..#..
    #..##  #...#  #....  #.#.#  #.#..  ....#  ..#..  #...#  .#.#.  #.#.#  .#.#.  ..#..  .#...
    #...#  #...#  #....  #..#.  #..#.  #...#  ..#..  #...#  .#.#.  ##.##  #...#  ..#..  #....
    #...#  .###.  #....  .##.#  #...#  .###.  ..#..  .###.  ..#..  #...#  #...#  ..#..  #####
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    `,
  ],
  [
    '0123456789',
    `
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    .###.  ..#..  .###.  .###.  ...#.  #####  ..##.  #####  .###.  .###.
    #...#  .##..  #...#  #...#  ..##.  #....  .#...  ....#  #...#  #...#
    #..##  #.#..  ....#  ....#  .#.#.  ####.  #....  ...#.  #...#  #...#
    #.#.#  ..#..  ...#.  ..##.  #..#.  ....#  ####.  ..#..  .###.  .####
    ##..#  ..#..  ..#..  ....#  #####  ....#  #...#  .#...  #...#  ....#
    #...#  ..#..  .#...  #...#  ...#.  #...#  #...#  .#...  #...#  ...#.
    .###.  #####  #####  .###.  ...#.  .###.  .###.  .#...  .###.  .##..
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    .....  .....  .....  .....  .....  .....  .....  .....  .....  .....
    `,
  ],
  [
    `.,:;!?'"-+/()`,
    `
    .  ..  .  ..  .  .....  .  ...  ....  .....  .....  ...  ...
    .  ..  .  ..  #  .###.  #  #.#  ....  .....  ....#  ..#  #..
    .  ..  .  ..  #  #...#  #  #.#  ....  ..#..  ...#.  .#.  .#.
    .  ..  .  ..  #  ....#  .  ...  ....  ..#..  ...#.  #..  ..#
    .  ..  #  .#  #  ..##.  .  ...  ####  #####  ..#..  #..  ..#
    .  ..  .  ..  #  ..#..  .  ...  ....  ..#..  .#...  #..  ..#
    .  ..  .  ..  .  .....  .  ...  ....  ..#..  .#...  .#.  .#.
    #  .#  #  .#  #  ..#..  .  ...  ....  .....  #....  ..#  #..
    .  #.  .  #.  .  .....  .  ...  ....  .....  .....  ...  ...
    .  ..  .  ..  .  .....  .  ...  ....  .....  .....  ...  ...
    `,
  ],
  [
    '%&*#@<>=_[] ★',
    `
    .....  .....  .....  .....  .....  ...  ...  ....  .....  ...  ...  ...  .....
    ##..#  .##..  .....  .#.#.  .###.  ...  ...  ....  .....  ###  ###  ...  .....
    ##..#  #..#.  ..#..  .#.#.  #...#  ..#  #..  ....  .....  #..  ..#  ...  ..#..
    ...#.  #.#..  #.#.#  #####  #.###  .#.  .#.  ####  .....  #..  ..#  ...  ..#..
    ..#..  .#...  .###.  .#.#.  #.#.#  #..  ..#  ....  .....  #..  ..#  ...  #####
    .#...  #.#.#  #.#.#  #####  #.###  .#.  .#.  ####  .....  #..  ..#  ...  .###.
    #..##  #..#.  ..#..  .#.#.  #....  ..#  #..  ....  .....  #..  ..#  ...  .#.#.
    #..##  .##.#  .....  .#.#.  .###.  ...  ...  ....  .....  ###  ###  ...  #...#
    .....  .....  .....  .....  .....  ...  ...  ....  #####  ...  ...  ...  .....
    .....  .....  .....  .....  .....  ...  ...  ....  .....  ...  ...  ...  .....
    `,
  ],
];

function parseStrips(strips: [string, string][]): Record<string, Glyph> {
  const glyphs: Record<string, Glyph> = {};
  for (const [chars, art] of strips) {
    const list = [...chars];
    const lines = art
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => line.split(/ +/));
    if (lines.length !== FONT.cellH || lines.some((cells) => cells.length !== list.length)) {
      throw new Error(`font strip "${chars}" must be ${FONT.cellH} rows of ${list.length} glyphs`);
    }
    list.forEach((ch, i) => {
      const rows = lines.map((cells) => cells[i] ?? '');
      const w = rows[0]?.length ?? 0;
      if (rows.some((row) => row.length !== w || !/^[#.]+$/.test(row))) {
        throw new Error(`glyph ${JSON.stringify(ch)} has ragged or invalid rows`);
      }
      glyphs[ch] = { w, rows };
    });
  }
  return glyphs;
}

/** The bitmap font: a–z, A–Z, 0–9, `.,:;!?'"-+/()%&*#@<>=_[]`, space and ★ (covers `NAME_CHARS`). */
export const GLYPHS: Record<string, Glyph> = parseStrips(STRIPS);

interface Slot {
  glyph: Glyph;
  index: number;
}

const SLOTS = new Map<string, Slot>(Object.entries(GLYPHS).map(([ch, glyph], index) => [ch, { glyph, index }]));
const FALLBACK = SLOTS.get('?')!;

function slotOf(ch: string): Slot {
  return SLOTS.get(ch) ?? FALLBACK;
}

/** Pixel width of `s` (per code point; unknown characters measure as '?'), without a trailing gap. */
export function textWidth(s: string, scale: 1 | 2 = 1): number {
  let w = 0;
  for (const ch of s) w += slotOf(ch).glyph.w + 1;
  return w === 0 ? 0 : (w - 1) * scale;
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): { canvas: CanvasImageSource; g: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas context unavailable');
    return { canvas, g };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  return { canvas, g };
}

const atlases = new Map<string, CanvasImageSource>();

/** All glyphs in one row of cells, painted once per (colour, scale) and cached. */
function atlas(color: string, scale: 1 | 2): CanvasImageSource {
  const key = `${scale}|${color}`;
  const cached = atlases.get(key);
  if (cached) return cached;
  const { canvas, g } = makeCanvas(SLOTS.size * FONT.cellW * scale, FONT.cellH * scale);
  g.fillStyle = color;
  for (const { glyph, index } of SLOTS.values()) {
    glyph.rows.forEach((row, y) => {
      for (let x = 0; x < glyph.w; x++) {
        if (row[x] === '#') g.fillRect((index * FONT.cellW + x) * scale, y * scale, scale, scale);
      }
    });
  }
  atlases.set(key, canvas);
  return canvas;
}

/**
 * Draws `s` with its first cell's top-left at (x, y), snapped to whole pixels, in `color` at 1× or
 * 2×. Unknown characters draw as '?'. Glyph bitmaps are cached per (colour, scale).
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  color: string,
  scale: 1 | 2 = 1,
): void {
  const src = atlas(color, scale);
  const h = FONT.cellH * scale;
  let cx = Math.round(x);
  const cy = Math.round(y);
  for (const ch of s) {
    const { glyph, index } = slotOf(ch);
    const w = glyph.w * scale;
    ctx.drawImage(src, index * FONT.cellW * scale, 0, w, h, cx, cy, w, h);
    cx += (glyph.w + 1) * scale;
  }
}
