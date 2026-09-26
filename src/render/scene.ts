import { COURT, netHeightAt } from '../core/court';
import { intBelow, seedRng, uniform } from '../core/rng';
import type { PlayerId, RngState, Surface } from '../core/types';
import { hex } from './color';
import { FLOOR } from './court';
import { drawText, textWidth } from './font';
import { OUTLINE, PAL, SURFACE_PAL } from './palette';
import { H, W, netScreenY, project, scaleAt, unprojectGround } from './projection';
import { createLayer, type Layer } from './screen';

/**
 * Animated scene inputs: `crowdExcite` 0–1 (the share of the crowd cheering), `umpireLook` where the
 * umpire's head points (−1 far end / up-screen, 0 across the court, +1 near end / down-screen) and
 * `t` the animation clock in milliseconds.
 */
export interface SceneState { crowdExcite: number; umpireLook: -1 | 0 | 1; t: number }

type Rgb = readonly [number, number, number];

const rgbCache = new Map<string, Rgb>();
function rgb(c: string): Rgb {
  let v = rgbCache.get(c);
  if (!v) rgbCache.set(c, (v = hex(c)));
  return v;
}

/** RGBA packed for a little-endian Uint32Array view of ImageData. */
function packed(c: string): number {
  const [r, g, b] = rgb(c);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Ordered-dither threshold in [0, 1) for pixel (x, y). */
const bayer = (x: number, y: number): number => (BAYER4[(y & 3) * 4 + (x & 3)]! + 0.5) / 16;

// ---------------------------------------------------------------------------------------------
// Stadium geometry (screen space; the stadium never rotates). Side stands, walls and aisles are
// described for the left half and mirrored about the centre (column x ↔ 479 − x).

const VPX = W / 2;
const VPY = -80;
/** Row where the line through the vanishing point meeting the left edge at row `e` crosses column `x`. */
const sideRow = (e: number, x: number): number => VPY + ((e - VPY) * (VPX - x)) / VPX;
/** Left-edge row of the line through the vanishing point and point (x, y). */
const sideIntercept = (x: number, y: number): number => VPY + ((y - VPY) * VPX) / (VPX - x);

/** Height of the ad boards and side walls, metres. */
const WALL_H = 1;
/** World depth of the back walls (their foot is screen row `FLOOR.top`). */
const BACK_Y = unprojectGround(VPX, FLOOR.top, 0).y;
/** Top row of the ad boards along the back wall. */
const BOARD_TOP = Math.floor(project({ x: 0, y: BACK_Y, z: WALL_H }, 0).y);
/** First column of the back wall (its left corner; the right corner mirrors it). */
const BOARD_X0 = FLOOR.edge - FLOOR.top;
/** Seat lines of the back stands, top row first. */
const BACK_ROWS = [14, 22, 30, 38, 46, 54];
/** Left-edge intercepts of the side-stand seat lines, top row first. */
const SIDE_ROWS = [44, 54, 64, 74, 84, 94, 104, 114, 124, 134];
const RIM_BACK = 6;
const RIM_SIDE = 36;
/** Centre column of the left corner aisle at row y (it climbs at 45° from the back wall's corner). */
const aisleX = (y: number): number => BOARD_X0 - BOARD_TOP + y;

/** Top row of the left side wall in column x; its foot is the floor edge (row `FLOOR.edge − 1 − x`). */
function sideWallTop(x: number): number {
  const cx = x + 0.5;
  const foot = unprojectGround(cx, FLOOR.edge - cx, 0);
  return project({ x: foot.x, y: foot.y, z: WALL_H }, 0).y;
}

interface StandStyle {
  sky: 'sky' | 'roof';
  edge: string;
  seat: string;
  riser: string;
  walk: string;
  rim: [string, string];
  aisle: [string, string];
  seatBack: string;
  /** Side walls: top highlight, face, panel seam. */
  wall: [string, string, string];
}

const STADIUM: StandStyle = {
  sky: 'sky',
  edge: PAL.grey,
  seat: PAL.slate,
  riser: PAL.shadow,
  walk: PAL.slate,
  rim: [PAL.silver, PAL.grey],
  aisle: [PAL.grey, PAL.slate],
  seatBack: PAL.crowdBlue,
  wall: [PAL.boardGreenHi, PAL.boardGreen, PAL.night],
};

const DOJO: StandStyle = {
  sky: 'roof',
  edge: PAL.woodHi,
  seat: PAL.woodLo,
  riser: PAL.shadow,
  walk: PAL.woodLo,
  rim: [PAL.wood, PAL.woodLo],
  aisle: [PAL.wood, PAL.woodLo],
  seatBack: PAL.woodLo,
  wall: [PAL.woodHi, PAL.woodLo, PAL.shadow],
};

const STYLE: Record<Surface, StandStyle> = { hard: STADIUM, clay: STADIUM, grass: STADIUM, dojo: DOJO };

/** Band colour at `dy` px above a seat line. */
function band(st: StandStyle, dy: number): string {
  if (dy < 1) return st.edge;
  if (dy < 4) return st.seat;
  return st.riser;
}

/** Stand/sky colour of pixel (x, y) in the left half (x < 240), above the walls. */
function standPixel(st: StandStyle, x: number, y: number): string {
  const ax = aisleX(y);
  if (x >= ax + 2) {
    // Back stands.
    if (y < RIM_BACK - 1) return skyPixel(st, x, y);
    if (y < RIM_BACK + 1) return st.rim[y - (RIM_BACK - 1)]!;
    const row = BACK_ROWS.find((r) => r >= y);
    return row === undefined ? st.walk : band(st, row - y);
  }
  const cx = x + 0.5;
  const cy = y + 0.5;
  const rimDy = sideRow(RIM_SIDE, cx) - cy;
  if (rimDy > 2) return skyPixel(st, x, y);
  if (rimDy > 0) return st.rim[rimDy > 1 ? 0 : 1]!;
  if (x > ax - 4) return (y & 1) === 0 ? st.aisle[0] : st.aisle[1];
  const e = sideIntercept(cx, cy);
  const row = SIDE_ROWS.find((r) => r >= e);
  if (row === undefined) return st.walk;
  return band(st, sideRow(row, cx) - cy);
}

function skyPixel(st: StandStyle, x: number, y: number): string {
  if (st.sky === 'sky') return y / 34 > bayer(x, y) ? PAL.skyHorizon : PAL.skyTop;
  // Dojo roof: dark boards with rafters, lighter towards the stands.
  if (y % 9 === 4) return PAL.woodLo;
  return y / 40 > bayer(x, y) ? PAL.shadow : PAL.night;
}

// ---------------------------------------------------------------------------------------------
// Static backdrop: sky/roof, stands, aisles, walls and ad boards (one layer per surface).

const BOARDS: { text: string; body: string; hi: string; ink: string }[] = [
  { text: 'TYPE FAST', body: PAL.boardGreen, hi: PAL.boardGreenHi, ink: PAL.cream },
  { text: 'BLACK BELT', body: PAL.night, hi: PAL.slate, ink: PAL.white },
  { text: 'DOJO CUP', body: PAL.crowdRed, hi: PAL.clayHi, ink: PAL.cream },
];

function paintBase(surface: Surface): Layer {
  const st = STYLE[surface];
  const layer = createLayer(W, H);
  const { g } = layer;
  const img = g.createImageData(W, H);
  const px = new Uint32Array(img.data.buffer);
  const floorFill = packed(SURFACE_PAL[surface].surround[1] ?? SURFACE_PAL[surface].surround[0]!);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < VPX; x++) {
      let c: number;
      if (y >= FLOOR.top && x >= FLOOR.edge - y) c = floorFill; // covered by the court layer
      else if (y >= BOARD_TOP && x >= BOARD_X0) c = packed(st.wall[1]);
      else if (y >= Math.ceil(sideWallTop(x)) && x < BOARD_X0) c = packed(st.wall[1]);
      else c = packed(standPixel(st, x, y));
      px[y * W + x] = c;
      px[y * W + (W - 1 - x)] = c;
    }
  }
  g.putImageData(img, 0, 0);
  paintSeats(g, st);
  paintSideWalls(g, st);
  paintBoards(g);
  return layer;
}

function paintSeats(g: CanvasRenderingContext2D, st: StandStyle): void {
  g.fillStyle = st.seatBack;
  for (const seat of SEATS) g.fillRect(seat.x + 1, seat.y - 3, 3, 2);
}

function paintSideWalls(g: CanvasRenderingContext2D, st: StandStyle): void {
  const [hi, face, seamColor] = st.wall;
  for (let x = 0; x < BOARD_X0; x++) {
    const top = Math.ceil(sideWallTop(x));
    const foot = FLOOR.edge - 1 - x;
    // World depth at this column's two edges, for panel seams every 3 m.
    const y0 = unprojectGround(x, FLOOR.edge - x, 0).y;
    const y1 = unprojectGround(x + 1, foot, 0).y;
    const seam = Math.floor(y0 / 3) !== Math.floor(y1 / 3);
    for (const col of [x, W - 1 - x]) {
      g.fillStyle = seam ? seamColor : face;
      g.fillRect(col, top, 1, foot - top + 1);
      g.fillStyle = hi;
      g.fillRect(col, top, 1, 1);
      g.fillStyle = OUTLINE;
      g.fillRect(col, foot, 1, 1);
    }
  }
}

function paintBoards(g: CanvasRenderingContext2D): void {
  const x0 = BOARD_X0;
  const span = W - 2 * x0;
  BOARDS.forEach((b, i) => {
    const l = x0 + Math.round((span * i) / BOARDS.length);
    const r = x0 + Math.round((span * (i + 1)) / BOARDS.length);
    g.fillStyle = b.body;
    g.fillRect(l, BOARD_TOP, r - l, FLOOR.top - BOARD_TOP);
    g.fillStyle = b.hi;
    g.fillRect(l, BOARD_TOP, r - l, 1);
    g.fillStyle = OUTLINE;
    g.fillRect(l, FLOOR.top - 1, r - l, 1);
    if (i > 0) g.fillRect(l, BOARD_TOP, 1, FLOOR.top - BOARD_TOP);
    const tx = l + Math.floor((r - l - textWidth(b.text)) / 2);
    drawText(g, b.text, tx + 1, BOARD_TOP + 4, OUTLINE);
    drawText(g, b.text, tx, BOARD_TOP + 3, b.ink);
  });
}

// ---------------------------------------------------------------------------------------------
// Crowd: 8 body templates, palette-swapped per fan, 4 frames (idle, bob, cheer high, cheer low).

interface Body { rows: string[]; head: number }

/** h hair, s skin, c shirt, d shirt shade, a accent (hat/scarf), k sunglasses. */
const BODIES: Body[] = [
  { rows: ['.hhh.', '.sss.', '.sss.', 'ccccd', 'ccccd', 'ccccd'], head: 3 },
  { rows: ['.hhh.', 'hsssh', 'hsssh', 'hcccd', 'ccccd', 'ccccd'], head: 3 },
  { rows: ['.aaa.', 'aaaaa', '.sss.', '.sss.', 'ccccd', 'ccccd', 'ccccd'], head: 4 },
  { rows: ['.sss.', 'hsssh', '.sss.', 'ccccd', 'ccccd', 'ccccd'], head: 3 },
  { rows: ['hhhhh', 'hhhhh', 'hsssh', '.sss.', 'ccccd', 'ccccd', 'ccccd'], head: 4 },
  { rows: ['..h..', '.hhh.', '.sss.', '.sss.', 'ccccd', 'ccccd', 'ccccd'], head: 4 },
  { rows: ['.hhh.', '.sss.', '.sss.', '.ccd.', '.ccd.'], head: 3 },
  { rows: ['.hhh.', '.kkk.', '.sss.', 'aaaaa', 'ccccd', 'ccccd'], head: 3 },
];

const SKINS = [PAL.skinLight, PAL.skinLight, PAL.clayDust, PAL.woodHi, PAL.skinDark, PAL.woodLo];
const HAIRS = [PAL.ink, PAL.night, PAL.woodLo, PAL.clayDeep, PAL.gold, PAL.silver, PAL.shadow, PAL.woodLo];
const SHIRTS: [string, string][] = [
  [PAL.crowdRed, PAL.clayDeep],
  [PAL.crowdBlue, PAL.hardLo],
  [PAL.crowdPurple, PAL.slate],
  [PAL.gold, PAL.clayLo],
  [PAL.cream, PAL.silver],
  [PAL.white, PAL.mist],
  [PAL.tierSky, PAL.hard],
  [PAL.boardGreenHi, PAL.boardGreen],
  [PAL.grassHi, PAL.grassLo],
  [PAL.clayHi, PAL.clayLo],
  [PAL.grey, PAL.slate],
  [PAL.hardHi, PAL.hardLo],
];
const ACCENTS = [PAL.white, PAL.crowdRed, PAL.gold, PAL.tierSky, PAL.cream, PAL.crowdBlue, PAL.boardGreenHi];

const CELL_W = 5;
const CELL_H = 10;
const IDLE = 0;
const BOB = 1;
const CHEER_HIGH = 2;
const CHEER_LOW = 3;
/** Crowd animation step (ms): the crowd is recomposed at most once per tick. */
const TICK_MS = 100;

interface Seat { x: number; y: number }
/**
 * A seated fan: frames [idle, bob, cheer high, cheer low] as packed 5×10 pixels; cheers when the
 * excitement exceeds `calm`; `phase`/`beat` (ticks) time the arm pumping; bobs every `fidget` ticks (0 never).
 */
interface Fan extends Seat {
  frames: Uint32Array[];
  calm: number;
  phase: number;
  beat: number;
  fidget: number;
}

function pick<T>(rng: RngState, arr: readonly T[]): T {
  return arr[intBelow(rng, arr.length)]!;
}

function fanFrames(body: Body, colors: Record<string, number>): Uint32Array[] {
  const h = body.rows.length;
  const frame = (lift: number, hands: number | null): Uint32Array => {
    const out = new Uint32Array(CELL_W * CELL_H);
    const top = CELL_H - h - lift;
    body.rows.forEach((row, r) => {
      for (let c = 0; c < CELL_W; c++) {
        const ch = row[c]!;
        if (ch !== '.') out[(top + r) * CELL_W + c] = colors[ch]!;
      }
    });
    if (hands !== null) {
      const hand = top - hands;
      for (let r = hand; r < top + body.head; r++) {
        out[r * CELL_W] = r === hand ? colors.s! : colors.c!;
        out[r * CELL_W + CELL_W - 1] = r === hand ? colors.s! : colors.d!;
      }
    }
    return out;
  };
  return [frame(0, null), frame(1, null), frame(1, 2), frame(0, 1)];
}

/** Left-column grid positions for a row of 5-px seats, `phase` staggering rows against each other. */
function gridFrom(lo: number, hi: number, phase: number): number[] {
  const xs: number[] = [];
  for (let x = lo + ((((phase - lo) % CELL_W) + CELL_W) % CELL_W); x <= hi; x += CELL_W) xs.push(x);
  return xs;
}

function layoutSeats(): Seat[] {
  const seats: Seat[] = [];
  BACK_ROWS.forEach((y, i) => {
    const lo = aisleX(y) + 1;
    for (const x of gridFrom(lo, W - CELL_W - lo, i * 2)) seats.push({ x, y });
  });
  SIDE_ROWS.forEach((e, j) => {
    for (const x of gridFrom(-CELL_W + 1, VPX, j * 3)) {
      const y = Math.round(sideRow(e, x + CELL_W / 2));
      const clearOfAisle = x + CELL_W - 1 < aisleX(y - CELL_H) - 3;
      const aboveWall = y <= sideWallTop(x + CELL_W - 1);
      if (!clearOfAisle || !aboveWall) continue;
      seats.push({ x, y }, { x: W - CELL_W - x, y });
    }
  });
  return seats.sort((a, b) => a.y - b.y || a.x - b.x);
}

const SEATS: Seat[] = layoutSeats();

function makeFans(): Fan[] {
  const rng = seedRng(0x5ea75);
  const fans: Fan[] = [];
  for (const seat of SEATS) {
    if (uniform(rng) < 0.07) continue;
    const [shirt, shade] = pick(rng, SHIRTS);
    const colors = {
      h: packed(pick(rng, HAIRS)),
      s: packed(pick(rng, SKINS)),
      c: packed(shirt),
      d: packed(shade),
      a: packed(pick(rng, ACCENTS)),
      k: packed(PAL.ink),
    };
    fans.push({
      ...seat,
      frames: fanFrames(pick(rng, BODIES), colors),
      calm: 0.04 + uniform(rng) * 0.95,
      phase: intBelow(rng, 16),
      beat: 3 + intBelow(rng, 2),
      fidget: uniform(rng) < 0.45 ? 6 + intBelow(rng, 10) : 0,
    });
  }
  return fans;
}

/** Frame of fan `f` at animation `tick`: cheering (arms pumping) above its calm threshold, else idle with an occasional bob. */
function pose(f: Fan, tick: number, excite: number): number {
  const step = tick + f.phase;
  if (excite > f.calm) return (step % f.beat) * 2 < f.beat ? CHEER_HIGH : CHEER_LOW;
  if (f.fidget > 0 && step % f.fidget === 0) return BOB;
  return IDLE;
}

const CROWD_H = 140;

interface Crowd { fans: Fan[]; layer: Layer; img: ImageData; px: Uint32Array; key: string }
let crowd: Crowd | null = null;

function crowdLayer(s: SceneState): Layer {
  if (!crowd) {
    const layer = createLayer(W, CROWD_H);
    const img = layer.g.createImageData(W, CROWD_H);
    crowd = { fans: makeFans(), layer, img, px: new Uint32Array(img.data.buffer), key: '' };
  }
  // Quantised so a smoothly easing excitement recomposes only at 1/32 steps.
  const excite = Number.isFinite(s.crowdExcite) ? Math.round(Math.min(1, Math.max(0, s.crowdExcite)) * 32) / 32 : 0;
  const tick = Number.isFinite(s.t) ? Math.floor(s.t / TICK_MS) : 0;
  const key = `${tick}|${excite}`;
  if (key === crowd.key) return crowd.layer;
  crowd.key = key;
  const { px } = crowd;
  px.fill(0);
  for (const f of crowd.fans) {
    const frame = f.frames[pose(f, tick, excite)]!;
    const top = f.y - CELL_H;
    for (let r = 0; r < CELL_H; r++) {
      const y = top + r;
      if (y < 0 || y >= CROWD_H) continue;
      for (let c = 0; c < CELL_W; c++) {
        const v = frame[r * CELL_W + c]!;
        const x = f.x + c;
        if (v !== 0 && x >= 0 && x < W) px[y * W + x] = v;
      }
    }
  }
  crowd.layer.g.putImageData(crowd.img, 0, 0);
  return crowd.layer;
}

// ---------------------------------------------------------------------------------------------
// Dojo lanterns: paper lanterns hanging from the roof, in front of the stands.

const LANTERN = ['..ooo..', '.orrro.', 'occgcco', 'ocgggco', 'ocgggco', 'occgcco', '.orrro.', '..ooo..'];

function paintLanterns(): Layer {
  const layer = createLayer(W, H);
  const { g } = layer;
  const [, paper, red, glow] = SURFACE_PAL.dojo.accent;
  const colors: Record<string, string> = { o: OUTLINE, r: red!, c: paper!, g: glow! };
  const hang = (x: number, drop: number): void => {
    g.fillStyle = OUTLINE;
    g.fillRect(x + 3, 0, 1, drop);
    LANTERN.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        const ch = row[c]!;
        if (ch === '.') continue;
        g.fillStyle = colors[ch]!;
        g.fillRect(x + c, drop + r, 1, 1);
      }
    });
  };
  for (let i = 0; i < 8; i++) hang(69 + i * 48, 1 + (i % 2) * 2);
  // Down the side stands, each lantern hanging just above the stands' rim.
  for (const x of [4, 22, 40]) {
    const drop = Math.floor(sideRow(RIM_SIDE, x + 3.5)) - 1 - LANTERN.length;
    hang(x, drop);
    hang(W - LANTERN[0]!.length - x, drop);
  }
  return layer;
}

const bases = new Map<Surface, Layer>();
let lanterns: Layer | null = null;

/**
 * Paints the stadium behind the court: dithered sky (or the dojo's roof and paper lanterns), shaded
 * stands with a procedural, animated crowd, ad boards and side walls. The stadium is the same for
 * every viewer. Static parts are painted once per surface; the crowd is recomposed at most every
 * 100 ms of `s.t`, bobbing when idle and raising arms for the `s.crowdExcite` share of fans.
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D, surface: Surface, s: SceneState): void {
  let base = bases.get(surface);
  if (!base) bases.set(surface, (base = paintBase(surface)));
  ctx.drawImage(base.canvas, 0, 0);
  ctx.drawImage(crowdLayer(s).canvas, 0, 0);
  if (surface === 'dojo') ctx.drawImage((lanterns ??= paintLanterns()).canvas, 0, 0);
}

// ---------------------------------------------------------------------------------------------
// Net: posts, tape, 50 % checker mesh, centre strap and a dithered shadow on the court.

/** Screen rows 108–139 hold the net layer (post caps to shadow). */
const NET_TOP = 108;
const NET_H = 32;

function paintNet(surface: Surface, end: PlayerId): Layer {
  const layer = createLayer(W, NET_H);
  const { g } = layer;
  const foot = Math.floor(netScreenY());
  const px = scaleAt(0, end);
  const put = (c: string, x: number, y: number, w = 1, h = 1): void => {
    g.fillStyle = c;
    g.fillRect(x, y - NET_TOP, w, h);
  };
  const posts = [-COURT.postX, COURT.postX].map((x) => Math.floor(project({ x, y: 0, z: 0 }, end).x));
  const [left, right] = [Math.min(...posts), Math.max(...posts)];
  const strap = Math.floor(project({ x: 0, y: 0, z: 0 }, end).x);
  for (let x = left + 2; x <= right - 2; x++) {
    const wx = unprojectGround(x + 0.5, foot + 0.5, end).x;
    const top = Math.floor(netScreenY() - netHeightAt(wx) * px);
    put(SURFACE_PAL[surface].lines, x, top);
    put(PAL.silver, x, top + 1);
    for (let y = top + 2; y <= foot; y++) {
      if (x === strap) put(PAL.mist, x, y);
      else if (((x + y) & 1) === 0) put(OUTLINE, x, y);
    }
    // Shadow on the ground in front of the net: the surface's darkest shade, solid then 50 %.
    const ramp = Math.abs(wx) <= COURT.doublesHalfWidth ? SURFACE_PAL[surface].court : SURFACE_PAL[surface].surround;
    const shade = ramp[ramp.length - 1]!;
    put(shade, x, foot + 1);
    if (((x + foot) & 1) === 1) put(shade, x, foot + 2);
  }
  const postTop = Math.floor(netScreenY() - COURT.netPostH * px);
  for (const x of [left, right]) {
    put(OUTLINE, x - 2, postTop - 1, 5, foot - postTop + 3);
    put(PAL.boardGreenHi, x - 1, postTop, 1, foot - postTop + 1);
    put(PAL.boardGreen, x, postTop, 2, foot - postTop + 1);
    put(PAL.silver, x - 1, postTop - 1, 3, 1);
  }
  return layer;
}

const nets = new Map<string, Layer>();

/**
 * Paints the net across the court for `viewer`: posts, white tape following the sag from 1.07 m
 * at the posts to 0.914 m at the centre strap, a 50 % checker-dithered mesh and its shadow on the
 * court. Cached per (surface, viewer end).
 */
export function drawNet(ctx: CanvasRenderingContext2D, surface: Surface, viewer: PlayerId | 'spectator'): void {
  const end: PlayerId = viewer === 1 ? 1 : 0;
  const key = `${surface}:${end}`;
  let net = nets.get(key);
  if (!net) nets.set(key, (net = paintNet(surface, end)));
  ctx.drawImage(net.canvas, 0, NET_TOP);
}

// ---------------------------------------------------------------------------------------------
// Umpire on a high chair beside the screen-right net post, head turning towards the ball.

/** o outline, G/g chair green, b/B blazer, c/C trousers and shirt, s/S skin, h hair, k shoes. */
const CHAIR = [
  '..........................',
  '..........................',
  '..................ooo.....',
  '..................oGo.....',
  '..................oGo.....',
  '..................oGo.....',
  '..................oGo.....',
  '.........ooooooo..oGo.....',
  '........obbbccbbo.oGo.....',
  '.......obbbbcbbbBooGo.....',
  '.......obbbbbbbbBooGo.....',
  '.......obbbbbbbbBooGo.....',
  '......obbbbbbbbbBooGo.....',
  '......obboobbbbbBooGo.....',
  '.....osbbbbboobbBooGo.....',
  '....oSsoooooccbbBooGo.....',
  '....ooocccccccccCooGo.....',
  '.....occcccccccccCoGo.....',
  '.....occoooooooooooGoo....',
  '.....occoGGGGGGGGGGGGGo...',
  '.....occogggggggggggggo...',
  '.....occoooooooooooooooo..',
  '.....occo.oGo.....oGo.....',
  '.....occo.oGo.....oGo.....',
  '.....occo.oGo.....oGo.....',
  '....okkko.oGo.....oGo.....',
  '...okkkkooGGooooooGGo.....',
  '...oooooGGGGGGGGGGGGo.....',
  '........oooGoooooooGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGooooooooGo....',
  '..........oGGGGGGGGGGo....',
  '..........oGooooooooGo....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGooooooooGo....',
  '..........oGGGGGGGGGGo....',
  '..........oGooooooooGo....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '..........oGo.....oGo.....',
  '.........oGGGo...oGGGo....',
  '.........ooooo...ooooo....',
];

/** Head frames 7×8 (placed with the chin row on the collar): far end, across the court, near end. */
const HEADS: Record<-1 | 0 | 1, string[]> = {
  [-1]: ['.ooooo.', 'ohhhhho', 'ohhhhho', 'ohhhhho', 'oShhhho', 'osShhho', '.oSSho.', '..oso..'],
  [0]: ['.ooooo.', 'ohhhhho', 'osshhho', 'oksshho', 'osssSho', '.osSSho', '..oSSo.', '..oso..'],
  [1]: ['.ooooo.', 'ohhhhho', 'ohssshh', 'oskskho', 'osssSho', 'oossSho', '..oSSo.', '..oso..'],
};
const HEAD_AT = { x: 9, y: 0 };

const UMPIRE_COLORS: Record<string, string> = {
  o: OUTLINE,
  G: PAL.boardGreenHi,
  g: PAL.boardGreen,
  b: PAL.crowdBlue,
  B: PAL.hardLo,
  c: PAL.cream,
  C: PAL.silver,
  s: PAL.skinLight,
  S: PAL.clayDust,
  h: PAL.slate,
  k: PAL.ink,
};

/** World x of the umpire chair (beside the right-hand net post as the stadium camera sees it). */
const UMPIRE_X = 7.9;
/** Column of `CHAIR` that stands on `UMPIRE_X`. */
const CHAIR_ANCHOR = 12;

function paintGrid(g: CanvasRenderingContext2D, rows: string[], x0: number, y0: number): void {
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c]!;
      if (ch === '.') continue;
      g.fillStyle = UMPIRE_COLORS[ch]!;
      g.fillRect(x0 + c, y0 + r, 1, 1);
    }
  });
}

const umpires = new Map<-1 | 0 | 1, Layer>();

function umpireFrame(look: -1 | 0 | 1): Layer {
  let layer = umpires.get(look);
  if (layer) return layer;
  layer = createLayer(CHAIR[0]!.length, CHAIR.length);
  paintGrid(layer.g, CHAIR, 0, 0);
  paintGrid(layer.g, HEADS[look], HEAD_AT.x, HEAD_AT.y);
  umpires.set(look, layer);
  return layer;
}

/**
 * Paints the umpire on the high chair beside the screen-right net post (the stadium does not rotate
 * with the viewer), head turned per `s.umpireLook`. Three cached frames; one blit per call.
 */
export function drawUmpire(ctx: CanvasRenderingContext2D, s: SceneState): void {
  const look: -1 | 0 | 1 = s.umpireLook === -1 || s.umpireLook === 1 ? s.umpireLook : 0;
  const frame = umpireFrame(look);
  const foot = project({ x: UMPIRE_X, y: 0, z: 0 }, 0);
  ctx.drawImage(frame.canvas, Math.floor(foot.x) - CHAIR_ANCHOR, Math.floor(foot.y) - CHAIR.length + 1);
}
