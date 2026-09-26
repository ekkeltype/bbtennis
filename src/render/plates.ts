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
const PIPS: Record<Tier, number> = { easy: 1, medium: 2, hard: 3 };

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

function drawPips(ctx: CanvasRenderingContext2D, tier: Tier, x: number, y: number, s: 1 | 2, color: string): void {
  const n = PIPS[tier];
  const top = CELL_Y + Math.floor((FONT.cellH - (3 * n - 1)) / 2);
  for (let i = 0; i < n; i++) rect(ctx, x + PIP_X * s, y + (top + 3 * i) * s, 2 * s, 2 * s, color);
}

/**
 * White or dark text, whichever contrasts more with `bg`: ≥ 4.5:1 on `PLATE.fill`, `PAL.grey` and
 * every `RAMPS.cloth` shade (worst case red mid, 4.53:1). Pure white, not the plates' near-white,
 * because near-white misses 4.5:1 on mid-luminance cloth (blue mid, red mid, orange lo).
 */
function readableOn(bg: string): string {
  return contrastRatio(PAL.white, bg) >= contrastRatio(PLATE.outline, bg) ? PAL.white : PLATE.outline;
}

/**
 * A tab with the owner's first 3 letters on `color` (belt colour, or the plate fill) that shares one
 * stroke with the plate at (x, y), `plateW` wide: above its left end, or, when that would reach the
 * HUD band (a plate in the far prompt band), beside it with the tops aligned, on the side away from
 * the screen centre unless that would leave x 4–476. The far server stands near the centre, so the
 * tab stays out of its serve row's toss gap; it never hangs below the plate, onto the far player. A
 * tab dark enough for white text gets a light rim on its free sides so it stays visible over dark ground.
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
  const text = [...name].slice(0, CHIP_LETTERS).join('').toUpperCase();
  const w = textWidth(text, s) + 4 * s;
  const h = CHIP_H * s;
  const ink = readableOn(color);
  const above = y - h + s >= CHIP_MIN_Y;
  const fitsLeft = x - w + s >= CHIP_X.min;
  const fitsRight = x + plateW - s + w <= CHIP_X.max;
  const left = x + (plateW - 1) / 2 <= CHIP_X.centre ? fitsLeft : !fitsRight;
  const cx = above ? x : left ? x - w + s : x + plateW - s;
  const cy = above ? y - h + s : y;
  frame(ctx, cx, cy, w, h, s, ink === PAL.white ? CHIP_RIM : PLATE.outline);
  // The edge lying on the plate's stroke stays dark.
  if (above) rect(ctx, cx, y, w, s, PLATE.outline);
  else rect(ctx, left ? x : cx, cy, s, h, PLATE.outline);
  rect(ctx, cx + s, cy + s, w - 2 * s, h - 2 * s, color);
  drawText(ctx, text, cx + 2 * s, cy + s, ink, s);
}

/**
 * Draws one word plate (spec §4.2) into `p.box`, pixel-exact. Local-active: tier outline with a dark
 * 1 px halo outside the box, typed letters in the tier's typed shade (`TIER_TYPED`), remaining ones
 * near-white, inverse cursor block; a wrong key flashes the fill light grey for 80 ms (letters turn
 * dark) and shakes the plate by up to 2 px unless `reduceEffects`. Remote: grey outline, 70 % fill,
 * no cursor, typed letters in the typed shade. Hidden remote: tier outline, a dim dot per letter,
 * typed letters as 3×5 tier blocks. Remote plates shake on a wrong key but never flash. The name
 * chip is painted in `oppColor` with white or dark text, above the plate or, in the far prompt band,
 * beside it; a dark chip gets a light rim. Every plate has 1/2/3 tier pips and a 1 px dark stroke;
 * red is never used. Canvas state is restored afterwards.
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
  if (!local) ctx.globalAlpha = opacity * REMOTE_FILL_ALPHA;
  rect(ctx, x + 2 * s, y + 2 * s, w - 4 * s, h - 4 * s, flash ? PLATE.flash : PLATE.fill);
  ctx.globalAlpha = opacity;
  drawPips(ctx, p.opt.tier, x, y, s, flash ? PLATE.fill : tier);
  drawLetters(ctx, p, x, y, flash);
  if (p.nameChip !== null) drawNameChip(ctx, p.nameChip, p.oppColor ?? PLATE.fill, x, y, w, s);
  ctx.restore();
}

/**
 * Ground-ring bitmaps (13×7, centred on the target, flattened like the ground plane): easy circle,
 * medium diamond, hard 4-point star. `#` is tier ink; the 1 px near-black outline is derived.
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

/** Whole-pixel points of the line from (x0, y0) to (x1, y1), both ends included (Bresenham). */
function linePixels(x0: number, y0: number, x1: number, y1: number): Offsets {
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

/**
 * Draws the leader joining a choice plate to its ground ring (spec §4.2): a 1 px tier-coloured line
 * from `from` (the plate end) towards the ring centre `to` (the point given to `drawTierRing`),
 * outlined 1 px in near-black and stopping where it meets the ring's outline, so the ring stays clean
 * whichever is drawn first. Draw it before the plate so the plate covers its top end.
 */
export function drawLeader(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  tier: Tier,
): void {
  const tx = Math.round(to.x);
  const ty = Math.round(to.y);
  const { keepOut } = RINGS[tier];
  const pixels = linePixels(Math.round(from.x), Math.round(from.y), tx, ty).filter(
    ([x, y]) => !keepOut.has(key(x - tx, y - ty)),
  );
  for (const [x, y] of pixels) rect(ctx, x - 1, y - 1, 3, 3, OUTLINE);
  for (const [x, y] of pixels) rect(ctx, x, y, 1, 1, TIER_COLOR[tier]);
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
