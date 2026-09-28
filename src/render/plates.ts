import type { Tier, WordOption } from '../core/types';
import { contrastRatio } from './color';
import { drawText, FONT, textWidth } from './font';
import type { PlateBox } from './layout';
import { OUTLINE, PAL, PLATE, TIER_COLOR, TIER_TYPED } from './palette';

/**
 * How a plate is shown (spec §4.2): the local typist's active prompt, the opponent's visible word,
 * or the opponent's hidden serve word (dots that turn into blocks as letters are typed).
 */
export type PlateStyle = 'localActive' | 'remote' | 'hiddenRemote';

/**
 * Everything needed to draw one plate. `typed` counts correct letters; `locked` marks the option
 * being typed; `faded` runs 0 (shown) → 1 (gone), multiplying the canvas opacity; `lastWrongAgeMs`
 * is the time since the last wrong key (null = none); `isNextCursor` shows the inverse block on the
 * next letter; `showInitialBlock` marks the first letter of an unlocked option; `nameChip` is the
 * owner's name for a tab (first 3 letters, in capitals); `oppColor` is the owner's belt colour, painted
 * behind the name chip (null = dark chip): any `RAMPS.cloth` shade (a human's belt is their headband
 * or shirt ramp) or `PAL.grey` keeps the chip text at ≥ 4.5:1; it must be `#RRGGBB`, other formats
 * throw; `scale` 2 redraws the plate at double size.
 */
export interface PlateDraw {
  box: PlateBox;
  opt: WordOption;
  typed: number;
  locked: boolean;
  faded: number;
  style: PlateStyle;
  lastWrongAgeMs: number | null;
  isNextCursor: boolean;
  showInitialBlock: boolean;
  nameChip: string | null;
  oppColor: string | null;
  scale: 1 | 2;
  reduceEffects: boolean;
}

/** Wrong-key flash and shake length (spec §4.2). */
const WRONG_MS = 80;
/** Horizontal shake offsets over the wrong-key window, in buffer pixels. */
const SHAKE = [2, -2, 1, -1];
const REMOTE_FILL_ALPHA = 0.7;
const PIPS: Record<Tier, number> = { easy: 1, medium: 2, hard: 3, insane: 4 };

/**
 * Plate geometry at 1× (spec §4.2, width 6n + 11, height 16): 1 px dark stroke, 1 px tier outline,
 * 1 px pad, a 2 px pip column, 2 px pad, then one 6×10 cell per letter from (7, 3), 2 px pad right.
 */
const CELL_X = 7;
const CELL_Y = 3;
const PIP_X = 3;
/** Hidden letters: a 1 px dot in the middle of the x-height body, typed ones a 3×5 block over it. */
const DOT = { x: 2, y: 5 };
const BLOCK = { x: 1, y: 3, w: 3, h: 5 };
/** Name chip: stroke, pad, capitals (glyph rows 1–7), pad, stroke. */
const CHIP_H = 11;
const CHIP_LETTERS = 3;
/** First row below the HUD band (spec §4.1, `BANDS.far[0]`); a chip above the plate may not start higher. */
const CHIP_MIN_Y = 22;
/** The plate area's x range (spec §4.2, x 4–476) and centre, which a chip beside a plate faces away from. */
const CHIP_X = { min: 4, max: 476, centre: 240 };
/** 1 px rim of a chip dark enough for white text: ≥ 3:1 against that chip and against dark ground. */
const CHIP_RIM = PAL.mist;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function rect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** A `t`-px border just inside the rectangle, leaving the middle untouched. */
function frame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
  color: string,
): void {
  rect(ctx, x, y, w, t, color);
  rect(ctx, x, y + h - t, w, t, color);
  rect(ctx, x, y + t, t, h - 2 * t, color);
  rect(ctx, x + w - t, y + t, t, h - 2 * t, color);
}

/** Letter colours: `ink` for the glyph, `paper` for an inverse block behind it (null = plate fill). */
interface LetterLook { ink: string; paper: string | null }

function letterLook(p: PlateDraw, i: number, typed: number, flash: boolean): LetterLook {
  const tier = TIER_COLOR[p.opt.tier];
  const ink = i < typed ? TIER_TYPED[p.opt.tier] : PLATE.text;
  if (p.style === 'remote') return { ink, paper: null };
  // While the fill flashes light grey every glyph turns dark, and the cursor inverts to dark.
  if (p.isNextCursor && i === typed) {
    return flash ? { ink: PLATE.flash, paper: PLATE.fill } : { ink: PLATE.fill, paper: PLATE.text };
  }
  if (p.showInitialBlock && !p.locked && typed === 0 && i === 0) return { ink: PLATE.fill, paper: tier };
  if (flash) return { ink: PLATE.fill, paper: null };
  return { ink, paper: null };
}

function drawLetters(ctx: CanvasRenderingContext2D, p: PlateDraw, x: number, y: number, flash: boolean): void {
  const s = p.scale;
  const len = p.opt.len;
  const typed = Math.min(len, Math.max(0, p.typed));
  for (let i = 0; i < len; i++) {
    const cx = x + (CELL_X + FONT.cellW * i) * s;
    const cy = y + CELL_Y * s;
    if (p.style === 'hiddenRemote') {
      if (i < typed) rect(ctx, cx + BLOCK.x * s, cy + BLOCK.y * s, BLOCK.w * s, BLOCK.h * s, TIER_COLOR[p.opt.tier]);
      else rect(ctx, cx + DOT.x * s, cy + DOT.y * s, s, s, PLATE.dim);
      continue;
    }
    const look = letterLook(p, i, typed, flash);
    if (look.paper) rect(ctx, cx, cy, FONT.cellW * s, FONT.cellH * s, look.paper);
    drawText(ctx, p.opt.word[i] ?? '?', cx, cy, look.ink, s);
  }
}

/**
 * The tier's pips in the 2 px pip column: 1–3 square 2×2 pips, or for insane 4 bars of 2×1 so the
 * column (7 px) stays clear of the tier outline; 1 px apart, centred on the letter cells.
 */
function drawPips(ctx: CanvasRenderingContext2D, tier: Tier, x: number, y: number, s: 1 | 2, color: string): void {
  const n = PIPS[tier];
  const pipH = n > 3 ? 1 : 2;
  const step = pipH + 1;
  const top = CELL_Y + Math.floor((FONT.cellH - (step * n - 1)) / 2);
  for (let i = 0; i < n; i++) rect(ctx, x + PIP_X * s, y + (top + step * i) * s, 2 * s, pipH * s, color);
}

/**
 * White or dark text, whichever contrasts more with `bg`: ≥ 4.5:1 on `PLATE.fill`, `PAL.grey` and
 * every `RAMPS.cloth` shade (worst case red mid, 4.53:1). Pure white, not the plates' near-white,
 * because near-white misses 4.5:1 on mid-luminance cloth (blue mid, red mid, orange lo).
 */
function readableOn(bg: string): string {
  return contrastRatio(PAL.white, bg) >= contrastRatio(PLATE.outline, bg) ? PAL.white : PLATE.outline;
}

/** A name chip's rectangle in buffer pixels, the scale it is drawn at and where it hangs off its plate. */
export interface ChipBox { x: number; y: number; w: number; h: number; scale: 1 | 2; side: 'above' | 'left' | 'right' }

const chipLabel = (name: string): string => [...name].slice(0, CHIP_LETTERS).join('').toUpperCase();

/**
 * Where a plate at (x, y), `plateW` wide and drawn at scale `s`, hangs the name chip of `name`: a tab
 * sharing one stroke with the plate, above its left end, or, when that would reach the HUD band (a
 * plate in the far prompt band), beside it with the tops aligned, on the side away from the screen
 * centre. There it shrinks to 1× when a tab at the plate's scale would leave x 4–476 (a long locked
 * word at 2×), and only when neither fits does it take the other side. The far server stands near
 * the centre (x ≈ 229 or 251 for `TUNING.positions.serverX` 0.8 m), so the tab stays out of its serve
 * row's toss gap at 1× and 2×; it never hangs below the plate, onto the far player.
 */
export function nameChipBox(name: string, x: number, y: number, plateW: number, s: 1 | 2): ChipBox {
  const text = chipLabel(name);
  const w = (k: 1 | 2): number => textWidth(text, k) + 4 * k;
  const h = CHIP_H * s;
  if (y - h + s >= CHIP_MIN_Y) return { x, y: y - h + s, w: w(s), h, scale: s, side: 'above' };
  const fits = (side: 'left' | 'right', k: 1 | 2): boolean =>
    side === 'left' ? x - w(k) + k >= CHIP_X.min : x + plateW - k + w(k) <= CHIP_X.max;
  const away = x + (plateW - 1) / 2 <= CHIP_X.centre ? 'left' : 'right';
  const [side, k]: ['left' | 'right', 1 | 2] = fits(away, s)
    ? [away, s]
    : fits(away, 1)
      ? [away, 1]
      : [away === 'left' ? 'right' : 'left', s];
  return { x: side === 'left' ? x - w(k) + k : x + plateW - k, y, w: w(k), h: CHIP_H * k, scale: k, side };
}

/**
 * The tab with the owner's first 3 letters on `color` (belt colour, or the plate fill) where
 * `nameChipBox` puts it. A tab dark enough for white text gets a light rim on its free sides so it
 * stays visible over dark ground.
 */
function drawNameChip(
  ctx: CanvasRenderingContext2D,
  name: string,
  color: string,
  x: number,
  y: number,
  plateW: number,
  s: 1 | 2,
): void {
  const c = nameChipBox(name, x, y, plateW, s);
  const k = c.scale;
  const ink = readableOn(color);
  frame(ctx, c.x, c.y, c.w, c.h, k, ink === PAL.white ? CHIP_RIM : PLATE.outline);
  // The edge lying on the plate's stroke stays dark.
  if (c.side === 'above') rect(ctx, c.x, y, c.w, k, PLATE.outline);
  else rect(ctx, c.side === 'left' ? x : c.x, c.y, k, c.h, PLATE.outline);
  rect(ctx, c.x + k, c.y + k, c.w - 2 * k, c.h - 2 * k, color);
  drawText(ctx, chipLabel(name), c.x + 2 * k, c.y + k, ink, k);
}

/**
 * Draws one word plate (spec §4.2) into `p.box`, pixel-exact. Local-active: tier outline with a dark
 * 1 px halo outside the box, typed letters in the tier's typed shade (`TIER_TYPED`), remaining ones
 * near-white, inverse cursor block; a wrong key flashes the fill light grey for 80 ms (letters turn
 * dark) and shakes the plate by up to 2 px unless `reduceEffects`. Remote: grey outline, 70 % fill,
 * no cursor, typed letters in the typed shade. Hidden remote: tier outline, opaque fill (its dots
 * must read over the crowd), a dim dot per letter, typed letters as 3×5 tier blocks. Remote plates
 * shake on a wrong key but never flash. The name chip is painted in `oppColor` with white or dark
 * text, above the plate or, in the far prompt band, beside it; a dark chip gets a light rim. Every
 * plate has 1/2/3/4 tier pips and a 1 px dark stroke; red is never used. Canvas state is restored
 * afterwards.
 */
export function drawPlate(ctx: CanvasRenderingContext2D, p: PlateDraw): void {
  const alpha = 1 - clamp01(p.faded);
  if (alpha <= 0) return;
  const s = p.scale;
  const age = p.lastWrongAgeMs;
  const wrong = age !== null && age >= 0 && age < WRONG_MS;
  const shake = wrong && !p.reduceEffects ? (SHAKE[Math.floor((age * SHAKE.length) / WRONG_MS)] ?? 0) : 0;
  const local = p.style === 'localActive';
  const flash = local && wrong;
  const tier = TIER_COLOR[p.opt.tier];
  const x = p.box.x + shake;
  const { y, w, h } = p.box;

  ctx.save();
  const opacity = ctx.globalAlpha * alpha;
  ctx.globalAlpha = opacity;
  if (local) frame(ctx, x - s, y - s, w + 2 * s, h + 2 * s, s, PLATE.halo);
  frame(ctx, x, y, w, h, s, PLATE.outline);
  frame(ctx, x + s, y + s, w - 2 * s, h - 2 * s, s, p.style === 'remote' ? PLATE.dim : tier);
  if (p.style === 'remote') ctx.globalAlpha = opacity * REMOTE_FILL_ALPHA;
  rect(ctx, x + 2 * s, y + 2 * s, w - 4 * s, h - 4 * s, flash ? PLATE.flash : PLATE.fill);
  ctx.globalAlpha = opacity;
  drawPips(ctx, p.opt.tier, x, y, s, flash ? PLATE.fill : tier);
  drawLetters(ctx, p, x, y, flash);
  if (p.nameChip !== null) drawNameChip(ctx, p.nameChip, p.oppColor ?? PLATE.fill, x, y, w, s);
  ctx.restore();
}

/**
 * Ground-ring bitmaps (13×7, centred on the target, flattened like the ground plane): easy circle,
 * medium diamond, hard 4-point star, insane 8-point burst. `#` is tier ink; the 1 px near-black
 * outline is derived.
 */
const RING_ART: Record<Tier, string[]> = {
  easy: [
    '...#######...',
    '.##.......##.',
    '#...........#',
    '#...........#',
    '#...........#',
    '.##.......##.',
    '...#######...',
  ],
  medium: [
    '......#......',
    '....##.##....',
    '..##.....##..',
    '##.........##',
    '..##.....##..',
    '....##.##....',
    '......#......',
  ],
  // Four separate points (arrowheads above and below, bars left and right) around an open centre,
  // so it never reads as the closed diamond when yellow and vermillion look alike (deutan).
  hard: [
    '......#......',
    '.....###.....',
    '.............',
    '####.....####',
    '.............',
    '.....###.....',
    '......#......',
  ],
  // Eight separate rays (vertical, horizontal and diagonal) around an open centre: never the 4-point star.
  insane: [
    '..#...#...#..',
    '...#..#..#...',
    '.............',
    '###.......###',
    '.............',
    '...#..#..#...',
    '..#...#...#..',
  ],
};

type Offsets = [dx: number, dy: number][];

const key = (dx: number, dy: number): string => `${dx},${dy}`;

/** Every offset within 1 px (8 neighbours) of `cells`, the cells included. */
function grow(cells: Offsets): Set<string> {
  const out = new Set<string>();
  for (const [dx, dy] of cells) {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) out.add(key(dx + i, dy + j));
  }
  return out;
}

/**
 * A ring bitmap as offsets from its centre: `ink`, its 8-neighbour `outline`, and `keepOut`, the
 * filled shape grown by 1 px, where a leader must not put a pixel so its outline never touches the
 * ring's ink or inside.
 */
function ringShape(art: string[]): { ink: Offsets; outline: Offsets; keepOut: Set<string> } {
  const cy = (art.length - 1) / 2;
  const cx = ((art[0]?.length ?? 1) - 1) / 2;
  const ink: Offsets = [];
  const filled: Offsets = [];
  art.forEach((row, y) => {
    const first = row.indexOf('#');
    const last = row.lastIndexOf('#');
    for (let x = first; first >= 0 && x <= last; x++) {
      filled.push([x - cx, y - cy]);
      if (row[x] === '#') ink.push([x - cx, y - cy]);
    }
  });
  const inked = new Set(ink.map(([dx, dy]) => key(dx, dy)));
  const outline = [...grow(ink)]
    .filter((k) => !inked.has(k))
    .map((k) => k.split(',').map(Number) as [number, number]);
  return { ink, outline, keepOut: grow(filled) };
}

const RINGS: Record<Tier, ReturnType<typeof ringShape>> = {
  easy: ringShape(RING_ART.easy),
  medium: ringShape(RING_ART.medium),
  hard: ringShape(RING_ART.hard),
  insane: ringShape(RING_ART.insane),
};

/**
 * Draws the ground ring of a target (spec §4.2) centred on screen point (sx, sy): easy circle,
 * medium diamond (one closed line), hard 4-point star (four separate points around an open centre),
 * 1 px tier ink with a 1 px near-black outline.
 */
export function drawTierRing(ctx: CanvasRenderingContext2D, tier: Tier, sx: number, sy: number): void {
  const x = Math.round(sx);
  const y = Math.round(sy);
  const ring = RINGS[tier];
  for (const [dx, dy] of ring.outline) rect(ctx, x + dx, y + dy, 1, 1, OUTLINE);
  for (const [dx, dy] of ring.ink) rect(ctx, x + dx, y + dy, 1, 1, TIER_COLOR[tier]);
}

/**
 * Longest leader walked, in pixels along either axis: an on-screen plate and an on-screen ring are
 * never farther apart than the 480 px buffer width.
 */
const MAX_LEADER = 1024;

/**
 * Whole-pixel points of the line from (x0, y0) to (x1, y1), both ends included (Bresenham). Empty for
 * an end that is not a finite whole pixel, which the walk would never reach, and for a line longer
 * than `MAX_LEADER`, which could only come from a malformed target (a peer's bad data).
 */
function linePixels(x0: number, y0: number, x1: number, y1: number): Offsets {
  if (![x0, y0, x1, y1].every(Number.isInteger)) return [];
  if (Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) > MAX_LEADER) return [];
  const out: Offsets = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    out.push([x, y]);
    if (x === x1 && y === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += stepX;
    }
    if (e2 <= dx) {
      err += dx;
      y += stepY;
    }
  }
}

/** A screen point in buffer pixels (unrounded; leaders round each end). */
export interface Pt { x: number; y: number }

/**
 * The ink pixels of a leader along `points`, a polyline from a plate to the ring centre (the last
 * point), each pixel once: every segment walked between rounded ends (`linePixels`), minus the ring's
 * keep-out around the last point. Empty for fewer than 2 points, an end that is not a finite whole
 * pixel once rounded, or a segment longer than `MAX_LEADER` (a malformed peer target).
 */
export function leaderPixels(points: readonly Pt[], tier: Tier): [x: number, y: number][] {
  if (points.length < 2) return [];
  const ends = points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ends.length; i++) {
    const a = ends[i]!;
    const b = ends[i + 1]!;
    const seg = linePixels(a.x, a.y, b.x, b.y);
    if (seg.length === 0) return [];
    out.push(...(i === 0 ? seg : seg.slice(1)));
  }
  const ring = ends[ends.length - 1]!;
  const { keepOut } = RINGS[tier];
  return out.filter(([x, y]) => !keepOut.has(key(x - ring.x, y - ring.y)));
}

/**
 * Draws a leader joining a choice plate to its ground ring (spec §4.2, choice-stack spec §3): a 1 px
 * tier-coloured polyline through `points`, outlined 1 px in near-black and stopping where it meets the
 * outline of the ring centred on the last point, so the ring stays clean whichever is drawn first.
 * Draw it before the plate so the plate covers its start. Nothing is drawn for a malformed path
 * (`leaderPixels`).
 */
export function drawLeaderPath(ctx: CanvasRenderingContext2D, points: readonly Pt[], tier: Tier): void {
  const pixels = leaderPixels(points, tier);
  for (const [x, y] of pixels) rect(ctx, x - 1, y - 1, 3, 3, OUTLINE);
  for (const [x, y] of pixels) rect(ctx, x, y, 1, 1, TIER_COLOR[tier]);
}

/** A straight leader from `from` (the plate end) to the ring centre `to`: `drawLeaderPath` with two points. */
export function drawLeader(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, tier: Tier): void {
  drawLeaderPath(ctx, [from, to], tier);
}

/**
 * True when offset (dx, dy) from a `tier` ring's centre lies in its keep-out: the filled ring grown
 * by 1 px, where no pixel of another ring's leader may go (choice-stack spec §3).
 */
export function inRingKeepOut(tier: Tier, dx: number, dy: number): boolean {
  return RINGS[tier].keepOut.has(key(dx, dy));
}

/** Grace-window checker cell size: the bar's full 2 px height, and 2 px wide. */
const CHECKER = 2;

/**
 * Draws the 2 px timing bar (spec §4.2) with its top-left at (x, y): a near-black track `w` px long,
 * outlined 1 px all round, filled white from the left for the remaining fraction `frac` (0–1). In
 * the grace window the filled part becomes a white/near-black checker of 2×2 px cells counted from the
 * bar's left end (white first), so it survives Fit-mode downscaling and holds still as the bar shrinks.
 */
export function drawTimingBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  frac: number,
  grace: boolean,
): void {
  const bx = Math.round(x);
  const by = Math.round(y);
  const bw = Math.round(w);
  const filled = Math.round(bw * clamp01(frac));
  rect(ctx, bx - 1, by - 1, bw + 2, 4, OUTLINE);
  if (!grace) {
    rect(ctx, bx, by, filled, 2, PAL.white);
    return;
  }
  for (let i = 0; i < filled; i += 2 * CHECKER) rect(ctx, bx + i, by, Math.min(CHECKER, filled - i), 2, PAL.white);
}
