import type { View } from './animations';

/**
 * Semantic colour slots of the character art (spec §4.1), resolved per look at sheet build time.
 * `hole` is a see-through stringbed gap: transparent when painted, but inside the silhouette.
 */
export const SLOT = {
  clear: 0,
  outline: 1,
  skinHi: 2,
  skinMid: 3,
  skinLo: 4,
  hairHi: 5,
  hairMid: 6,
  hairLo: 7,
  shirtHi: 8,
  shirtMid: 9,
  shirtLo: 10,
  shortsHi: 11,
  shortsMid: 12,
  shortsLo: 13,
  bandMid: 14,
  bandLo: 15,
  shoeHi: 16,
  shoeLo: 17,
  racketHi: 18,
  racketLo: 19,
  strings: 20,
  hole: 21,
} as const;

/** One colour slot (a `SLOT` value). */
export type SlotId = (typeof SLOT)[keyof typeof SLOT];

/**
 * Grid legend: one character per slot. Upper case is a ramp's highlight, lower case its mid tone,
 * and the neighbouring letter its shadow (s/z skin, h/n hair, t/y shirt, p/q shorts).
 */
export const LEGEND: Readonly<Record<string, SlotId>> = {
  '.': SLOT.clear,
  '#': SLOT.outline,
  S: SLOT.skinHi,
  s: SLOT.skinMid,
  z: SLOT.skinLo,
  H: SLOT.hairHi,
  h: SLOT.hairMid,
  n: SLOT.hairLo,
  T: SLOT.shirtHi,
  t: SLOT.shirtMid,
  y: SLOT.shirtLo,
  P: SLOT.shortsHi,
  p: SLOT.shortsMid,
  q: SLOT.shortsLo,
  B: SLOT.bandMid,
  b: SLOT.bandLo,
  W: SLOT.shoeHi,
  w: SLOT.shoeLo,
  R: SLOT.racketHi,
  r: SLOT.racketLo,
  x: SLOT.strings,
  ':': SLOT.hole,
};

/** Where a ramp group takes its colours: a `Look` ramp or the fixed neutral ramp (shoes, strings). */
export type RampSource = 'skin' | 'hair' | 'shirt' | 'shorts' | 'headband' | 'racket' | 'neutral';

/** Slots sharing one ramp, listed light → dark, with the ramp shade index each one uses. */
export interface RampGroup {
  source: RampSource;
  slots: SlotId[];
  shades: number[];
}

/** Every colour slot's ramp and shade; slot lists run light → dark (checked by `lintRamps`). */
export const RAMP_GROUPS: readonly RampGroup[] = [
  { source: 'skin', slots: [SLOT.skinHi, SLOT.skinMid, SLOT.skinLo], shades: [0, 1, 2] },
  { source: 'hair', slots: [SLOT.hairHi, SLOT.hairMid, SLOT.hairLo], shades: [0, 1, 2] },
  { source: 'shirt', slots: [SLOT.shirtHi, SLOT.shirtMid, SLOT.shirtLo], shades: [0, 1, 2] },
  { source: 'shorts', slots: [SLOT.shortsHi, SLOT.shortsMid, SLOT.shortsLo], shades: [0, 1, 2] },
  { source: 'headband', slots: [SLOT.bandMid, SLOT.bandLo], shades: [1, 2] },
  { source: 'racket', slots: [SLOT.racketHi, SLOT.racketLo], shades: [0, 2] },
  { source: 'neutral', slots: [SLOT.shoeHi, SLOT.shoeLo], shades: [0, 2] },
  { source: 'neutral', slots: [SLOT.strings], shades: [1] },
];

/** Pixel point in cell or grid coordinates (x may be half-way for points on a centre line). */
export interface Pt {
  x: number;
  y: number;
}

/** A palette-indexed grid; (`ax`, `ay`) is the attachment point in grid pixels (may be half-way). */
export interface Part {
  rows: readonly string[];
  ax: number;
  ay: number;
}

/** A torso grid (shirt + shorts) with its limb sockets in grid pixels; the anchor is the pelvis. */
export interface TorsoPart extends Part {
  neck: Pt;
  shoulderL: Pt;
  shoulderR: Pt;
  hipL: Pt;
  hipR: Pt;
}

/** Upper-body turn: chest square to the net, or turned toward the player's left/right. */
export type Twist = 'N' | 'L' | 'R';

/** A grid drawn over the head grid (hair, headband tails), offset (`dx`, `dy`) from its origin. */
export interface Overlay {
  rows: readonly string[];
  dx: number;
  dy: number;
}

/**
 * Shoe grids in screen terms: seen from the heel, from the toe, side-on with the toe left/right,
 * or kicked up behind with the sole toward the camera.
 */
export type ShoeKind = 'heel' | 'toe' | 'sideL' | 'sideR' | 'sole';

/** A shoe grid anchored at the sole contact point, with the ankle (top of the shin) in grid pixels. */
export interface ShoePart extends Part {
  ankle: Pt;
}

const mirrorRows = (rows: readonly string[]): string[] => rows.map((r) => [...r].reverse().join(''));

/**
 * Head grids: an 8 × 8 px head, a 2 px neck and a last outline row that overlaps the torso's top
 * edge (the far view shows the face). Anchored at the bottom centre.
 */
export const HEADS: Record<View, Part> = {
  near: {
    rows: [
      '..####..',
      '.#Ssss#.',
      '#SSsssz#',
      '#Sssssz#',
      '#sssssz#',
      '#sssssz#',
      '#sssszz#',
      '.#sszz#.',
      '..#zz#..',
      '..#zz#..',
      '..####..',
    ],
    ax: 3.5,
    ay: 10,
  },
  far: {
    rows: [
      '..####..',
      '.#SSss#.',
      '#SSsssz#',
      '#Sssssz#',
      '#s#ss#z#',
      '#Sssssz#',
      '#sssszz#',
      '.#sszz#.',
      '..#zz#..',
      '..#zz#..',
      '..####..',
    ],
    ax: 3.5,
    ay: 10,
  },
};

/** Hair style names, indexed by `Look.hairStyle`. */
export const HAIR_STYLES: string[] = ['crop', 'topknot', 'ponytail', 'bob', 'afro'];

/** Hair overlays per style (same order as `HAIR_STYLES`) and view. */
export const HAIR: readonly Record<View, Overlay>[] = [
  // crop
  {
    near: {
      rows: [
        '..####..',
        '.#HHhh#.',
        '#HHhhhn#',
        '#Hhhhhn#',
        '#hhhhnn#',
        '#hhhnnn#',
        '#nn..nn#',
      ],
      dx: 0,
      dy: 0,
    },
    far: {
      rows: [
        '..####..',
        '.#HHhh#.',
        '#HHhhhn#',
        '#h....n#',
      ],
      dx: 0,
      dy: 0,
    },
  },
  // topknot
  {
    near: {
      rows: [
        '..####..',
        '.#HHhn#.',
        '.##hn##.',
        '.#HHhh#.',
        '#HHhhhn#',
        '#Hhhhhn#',
        '#hhhhnn#',
        '#hhhnnn#',
        '#nn..nn#',
      ],
      dx: 0,
      dy: -3,
    },
    far: {
      rows: [
        '..####..',
        '.#HHhn#.',
        '.##hn##.',
        '.#HHhh#.',
        '#HHhhhn#',
        '#Hhhhhn#',
        '#h....n#',
      ],
      dx: 0,
      dy: -3,
    },
  },
  // ponytail
  {
    near: {
      rows: [
        '..####..',
        '.#HHhh#.',
        '#HHhhhn#',
        '#Hhhhhn#',
        '#hhHhnn#',
        '#hhhnnn#',
        '#nnhnnn#',
        '.##hn##.',
        '..#hn#..',
        '..#hn#..',
        '..#nn#..',
        '...##...',
      ],
      dx: 0,
      dy: 0,
    },
    far: {
      rows: [
        '..####....',
        '.#HHhh#...',
        '#HHhhhn#..',
        '#h....n##.',
        '.......#n#',
        '.......#n#',
        '.......#n#',
        '.......#n#',
        '........#.',
      ],
      dx: 0,
      dy: 0,
    },
  },
  // bob
  {
    near: {
      rows: [
        '..######..',
        '.#HHHhhh#.',
        '#HHHhhhhn#',
        '#HHhhhhnn#',
        '#Hhhhhhnn#',
        '#hhhhhnnn#',
        '#hhhhnnnn#',
        '#nhhhnnnn#',
        '.#n#..#n#.',
        '..#....#..',
      ],
      dx: -1,
      dy: 0,
    },
    far: {
      rows: [
        '..######..',
        '.#HHHhhh#.',
        '#HHhhhhhn#',
        '#Hhhhhhhn#',
        '#h......n#',
        '#h......n#',
        '#n......n#',
        '#n#....#n#',
        '.#......#.',
      ],
      dx: -1,
      dy: 0,
    },
  },
  // afro
  {
    near: {
      rows: [
        '..######..',
        '.#HHHhhh#.',
        '#HHHhhhhn#',
        '#HHhhhhhn#',
        '#HhHhhhnn#',
        '#hhhhhhnn#',
        '#hhhhhnnn#',
        '#hhhhnnnn#',
        '.#nnnnnn#.',
        '..######..',
      ],
      dx: -1,
      dy: -1,
    },
    far: {
      rows: [
        '..######..',
        '.#HHHhhh#.',
        '#HHHhhhhn#',
        '#HHhhhhhn#',
        '#Hh....hn#',
        '#h......n#',
        '#h......n#',
        '.#......#.',
      ],
      dx: -1,
      dy: -1,
    },
  },
];

/** Head-grid rows the headband covers (upper row band mid, lower row band shadow). */
export const BAND_ROWS: readonly [number, number] = [2, 3];

/** The headband's knot tails, trailing on the player's right (in head-grid pixels, like hair). */
export const BAND_TAILS: Record<View, Overlay> = {
  near: {
    rows: [
      '.B##...',
      '.bBB#..',
      '..#bB#.',
      '...#bB#',
      '....##.',
    ],
    dx: 5,
    dy: 2,
  },
  far: {
    rows: [
      '...##B.',
      '..#BBb.',
      '.#Bb#..',
      '#Bb#...',
      '.##....',
    ],
    dx: -4,
    dy: 2,
  },
};

/**
 * Torso sockets seen from behind (the player's left shoulder and hip on screen-left): the neck
 * follows the chest when it twists, the hips stay square.
 */
const socketsNear = (neck: number, shoulderL: number, shoulderR: number) => ({
  neck: { x: neck, y: 0 },
  shoulderL: { x: shoulderL, y: 3 },
  shoulderR: { x: shoulderR, y: 3 },
  hipL: { x: 3, y: 11 },
  hipR: { x: 8, y: 11 },
});
/** Torso sockets seen from the front: the player's right shoulder and hip are on screen-left. */
const socketsFar = (neck: number, shoulderR: number, shoulderL: number) => ({
  neck: { x: neck, y: 0 },
  shoulderL: { x: shoulderL, y: 3 },
  shoulderR: { x: shoulderR, y: 3 },
  hipL: { x: 8, y: 11 },
  hipR: { x: 3, y: 11 },
});

const WAIST_ROWS = ['.#ttttttyy#.', '.#ttttttyy#.', '.#ttttyyyy#.'];
const SHORTS_ROWS = [
  '.#qqqqqqqq#.',
  '#PPpppppppq#',
  '#Ppppppppqq#',
  '#Pppq##ppqq#',
  '#Pppq##ppqq#',
  '.####..####.',
];
const torso = (chest: readonly string[], sockets: ReturnType<typeof socketsNear>): TorsoPart => ({
  rows: [...chest, ...WAIST_ROWS, ...SHORTS_ROWS],
  ax: 5.5,
  ay: 14,
  ...sockets,
});

/**
 * Torso grids (shirt over shorts) per view and twist, anchored at the pelvis (bottom centre).
 * A twist shifts the sloped shoulders toward the player's side that turns away; the hips stay square.
 */
export const TORSOS: Record<View, Record<Twist, TorsoPart>> = {
  near: {
    N: torso(
      ['...######...', '..#TTtttt#..', '.#TTttttty#.', '#TTttttttyy#', '#Ttttttttyy#', '#Ttttttttyy#'],
      socketsNear(5.5, 1, 10),
    ),
    L: torso(
      ['....######..', '...#TTtttt#.', '..#TTttttty#', '.#TTtttttyy#', '.#Tttttttyy#', '.#Tttttttyy#'],
      socketsNear(6.5, 2, 10),
    ),
    R: torso(
      ['..######....', '.#TTtttt#...', '#TTttttyy#..', '#Ttttttyyy#.', '#Ttttttyyy#.', '#Ttttttyyy#.'],
      socketsNear(4.5, 1, 9),
    ),
  },
  far: {
    N: torso(
      ['...######...', '..#TTzzTt#..', '.#TTTyyTty#.', '#TTttttttyy#', '#Ttttttttyy#', '#Ttttttttyy#'],
      socketsFar(5.5, 1, 10),
    ),
    L: torso(
      ['..######....', '.#TTzzTt#...', '#TTTyyTty#..', '#Tttttttyy#.', '#Tttttttyy#.', '#Tttttttyy#.'],
      socketsFar(4.5, 1, 9),
    ),
    R: torso(
      ['....######..', '...#TTzzTt#.', '..#TTTyyTty#', '.#TTtttttyy#', '.#Tttttttyy#', '.#Tttttttyy#'],
      socketsFar(6.5, 2, 10),
    ),
  },
};

const SHOE_SIDE_L: ShoePart = {
  rows: [
    '...###.',
    '..#WWW#',
    '.#WWWW#',
    '#wwwww#',
    '.#####.',
  ],
  ax: 3,
  ay: 4,
  ankle: { x: 4, y: 0 },
};

/** Shoe grids by screen kind, anchored at the sole contact point. */
export const SHOES: Record<ShoeKind, ShoePart> = {
  heel: {
    rows: [
      '.###.',
      '#WWW#',
      '#www#',
      '.###.',
    ],
    ax: 2,
    ay: 3,
    ankle: { x: 2, y: 0 },
  },
  toe: {
    rows: [
      '.###.',
      '#WWW#',
      '#Www#',
      '.###.',
    ],
    ax: 2,
    ay: 3,
    ankle: { x: 2, y: 0 },
  },
  sole: {
    rows: [
      '.###.',
      '#www#',
      '#wWw#',
      '#www#',
      '.###.',
    ],
    ax: 2,
    ay: 4,
    ankle: { x: 2, y: 0 },
  },
  sideL: SHOE_SIDE_L,
  sideR: {
    rows: mirrorRows(SHOE_SIDE_L.rows),
    ax: SHOE_SIDE_L.rows[0]!.length - 1 - SHOE_SIDE_L.ax,
    ay: SHOE_SIDE_L.ay,
    ankle: { x: SHOE_SIDE_L.rows[0]!.length - 1 - SHOE_SIDE_L.ankle.x, y: SHOE_SIDE_L.ankle.y },
  },
};

/** Racket pointing straight up, gripped at (`ax`, `ay`). */
const RACKET_UP: Part = {
  rows: [
    '..###..',
    '.#RRR#.',
    '#R:x:R#',
    '#Rx:xR#',
    '#R:x:R#',
    '#Rx:xR#',
    '#R:x:R#',
    '.#RRR#.',
    '..#r#..',
    '..#r#..',
    '..#r#..',
    '..#r#..',
    '..###..',
  ],
  ax: 3,
  ay: 10,
};

/** Racket pointing up and to the right (45°), gripped at (`ax`, `ay`). */
const RACKET_UP_RIGHT: Part = {
  rows: [
    '.......####.',
    '......#RRRR#',
    '.....#R:x:R#',
    '....#R:x:xR#',
    '...#R:x:x:R#',
    '...#Rx:x:R#.',
    '...#R:x:R#..',
    '...#RRRR#...',
    '..#r####....',
    '.#r#........',
    '#r#.........',
    '###.........',
  ],
  ax: 1,
  ay: 10,
};

/** Rotates a part a quarter turn clockwise (the grip point moves with it). */
function rotateCW(p: Part): Part {
  const h = p.rows.length;
  const w = p.rows[0]?.length ?? 0;
  const rows: string[] = [];
  for (let y = 0; y < w; y++) {
    let row = '';
    for (let x = 0; x < h; x++) row += p.rows[h - 1 - x]?.[y] ?? '.';
    rows.push(row);
  }
  return { rows, ax: h - 1 - p.ay, ay: p.ax };
}

/**
 * Racket grids at the 8 screen angles (index k = k·45° counter-clockwise from pointing right),
 * gripped at (`ax`, `ay`). Two are authored; the rest are exact quarter-turn rotations.
 */
export const RACKETS: readonly Part[] = (() => {
  const up = RACKET_UP;
  const upRight = RACKET_UP_RIGHT;
  const right = rotateCW(up);
  const downRight = rotateCW(upRight);
  const down = rotateCW(right);
  const downLeft = rotateCW(downRight);
  const left = rotateCW(down);
  const upLeft = rotateCW(downLeft);
  return [right, upRight, up, upLeft, left, downLeft, down, downRight];
})();

/**
 * Art lint for one grid: equal row lengths, legend-only characters, outline on every opaque pixel
 * that touches the outside (a clear pixel or the grid border), and see-through holes enclosed.
 */
export function lintGrid(name: string, rows: readonly string[]): string[] {
  const w = rows[0]?.length ?? 0;
  const problems: string[] = [];
  rows.forEach((row, y) => {
    if (row.length !== w) problems.push(`${name}: row ${y} has ${row.length} columns, expected ${w}`);
  });
  if (problems.length) return problems;
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (!(ch in LEGEND)) problems.push(`${name}: character '${ch}' at (${x}, ${y}) is not in the legend`);
    });
  });
  if (problems.length) return problems;
  const outside = (x: number, y: number) => rows[y]?.[x] === undefined || rows[y]?.[x] === '.';
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.' || ch === '#') return;
      if (!(outside(x - 1, y) || outside(x + 1, y) || outside(x, y - 1) || outside(x, y + 1))) return;
      problems.push(
        LEGEND[ch] === SLOT.hole
          ? `${name}: see-through pixel (${x}, ${y}) touches the outside`
          : `${name}: edge pixel (${x}, ${y}) is not outline`,
      );
    });
  });
  return problems;
}

/** Art lint for ramp groups: one shade per slot, shades strictly increasing (light → dark). */
export function lintRamps(groups: readonly RampGroup[]): string[] {
  const problems: string[] = [];
  groups.forEach((g, i) => {
    if (g.slots.length !== g.shades.length) {
      problems.push(`ramp ${i} (${g.source}): ${g.slots.length} slots but ${g.shades.length} shades`);
    } else if (g.shades.some((s, j) => !Number.isInteger(s) || s < 0 || (j > 0 && s <= (g.shades[j - 1] ?? -1)))) {
      problems.push(`ramp ${i} (${g.source}): shades ${g.shades.join(',')} are not strictly increasing`);
    }
  });
  return problems;
}

/** Stamps `top` over `base` at (`dx`, `dy`) (clear pixels of `top` keep `base`), growing as needed. */
function stackRows(base: readonly string[], top: readonly string[], dx: number, dy: number): string[] {
  const bw = base[0]?.length ?? 0;
  const tw = top[0]?.length ?? 0;
  const x0 = Math.min(0, dx);
  const y0 = Math.min(0, dy);
  const w = Math.max(bw, dx + tw) - x0;
  const h = Math.max(base.length, dy + top.length) - y0;
  const out: string[][] = Array.from({ length: h }, () => Array<string>(w).fill('.'));
  base.forEach((row, y) => [...row].forEach((ch, x) => (out[y - y0]![x - x0] = ch)));
  top.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch !== '.') out[y + dy - y0]![x + dx - x0] = ch;
    }),
  );
  return out.map((r) => r.join(''));
}

/** Recolours `BAND_ROWS` of a composed head whose head-grid row 0 is composite row `row0`. */
function paintBand(head: readonly string[], row0: number): string[] {
  return head.map((row, y) => {
    const k = BAND_ROWS.indexOf(y - row0);
    if (k < 0) return row;
    return row.replace(/[^.#:]/g, k === 0 ? 'B' : 'b');
  });
}

/**
 * The composed head grid (head + hair + optional headband with its trailing tails) and the
 * composite's origin in head-grid pixels.
 */
export function headRows(view: View, style: number, headband: boolean): { rows: string[]; ox: number; oy: number } {
  const hair = HAIR[style]?.[view];
  if (!hair) throw new Error(`no hair style ${style}`);
  const rows = stackRows(HEADS[view].rows, hair.rows, hair.dx, hair.dy);
  const ox = Math.min(0, hair.dx);
  const oy = Math.min(0, hair.dy);
  if (!headband) return { rows, ox, oy };
  const tails = BAND_TAILS[view];
  const dx = tails.dx - ox;
  const dy = tails.dy - oy;
  return {
    rows: stackRows(paintBand(rows, -oy), tails.rows, dx, dy),
    ox: ox + Math.min(0, dx),
    oy: oy + Math.min(0, dy),
  };
}

/** Runs every art lint over the authored parts, head composites and ramp groups ([] = clean). */
export function lintParts(): string[] {
  const problems: string[] = [];
  for (const view of ['near', 'far'] as const) {
    problems.push(...lintGrid(`head ${view}`, HEADS[view].rows));
    HAIR_STYLES.forEach((style, i) => {
      for (const band of [false, true]) {
        problems.push(...lintGrid(`head ${view} ${style}${band ? ' band' : ''}`, headRows(view, i, band).rows));
      }
    });
    for (const twist of ['N', 'L', 'R'] as const) problems.push(...lintGrid(`torso ${view} ${twist}`, TORSOS[view][twist].rows));
  }
  for (const [kind, shoe] of Object.entries(SHOES)) problems.push(...lintGrid(`shoe ${kind}`, shoe.rows));
  RACKETS.forEach((r, k) => problems.push(...lintGrid(`racket ${k}`, r.rows)));
  problems.push(...lintRamps(RAMP_GROUPS));
  return problems;
}
