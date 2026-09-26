import { COURT, netHeightAt } from '../core/court';
import type { PlayerId, Surface } from '../core/types';
import { FLOOR, checker, packed, paintGrid } from './court';
import { FAN_H, FAN_W, createCrowd, type Seat } from './crowd';
import { drawText, textWidth } from './font';
import { OUTLINE, PAL, SURFACE_PAL } from './palette';
import { H, W, netScreenY, project, scaleAt, unprojectGround } from './projection';
import { cachedLayer, createLayer, layersPerEnd, type Layer } from './screen';
import { paintChairShadow } from './umpire';

export { drawUmpire } from './umpire';

/**
 * Animated scene inputs: `crowdExcite` 0–1 (the share of the crowd cheering), `umpireLook` where the
 * umpire's head points (−1 far end / up-screen, 0 across the court, +1 near end / down-screen) and
 * `t` the animation clock in milliseconds.
 */
export interface SceneState { crowdExcite: number; umpireLook: -1 | 0 | 1; t: number }

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
// Seats: 5-px fan cells along every seat line, rows staggered, clear of the aisles and side walls.

/** Left-column grid positions for a row of 5-px seats, `phase` staggering rows against each other. */
function gridFrom(lo: number, hi: number, phase: number): number[] {
  const xs: number[] = [];
  for (let x = lo + ((((phase - lo) % FAN_W) + FAN_W) % FAN_W); x <= hi; x += FAN_W) xs.push(x);
  return xs;
}

function layoutSeats(): Seat[] {
  const seats: Seat[] = [];
  BACK_ROWS.forEach((y, i) => {
    const lo = aisleX(y) + 1;
    for (const x of gridFrom(lo, W - FAN_W - lo, i * 2)) seats.push({ x, y });
  });
  SIDE_ROWS.forEach((e, j) => {
    for (const x of gridFrom(-FAN_W + 1, VPX, j * 3)) {
      const y = Math.round(sideRow(e, x + FAN_W / 2));
      const clearOfAisle = x + FAN_W - 1 < aisleX(y - FAN_H) - 3;
      const aboveWall = y <= sideWallTop(x + FAN_W - 1);
      if (!clearOfAisle || !aboveWall) continue;
      seats.push({ x, y }, { x: W - FAN_W - x, y });
    }
  });
  return seats.sort((a, b) => a.y - b.y || a.x - b.x);
}

const SEATS: Seat[] = layoutSeats();

// ---------------------------------------------------------------------------------------------
// Dojo lanterns: paper lanterns hanging from the roof, in front of the stands.

const LANTERN = ['..ooo..', '.orrro.', 'occgcco', 'ocgggco', 'ocgggco', 'occgcco', '.orrro.', '..ooo..'];

function paintLanterns(): Layer {
  const layer = createLayer(W, H);
  const { g } = layer;
  const [, paper, red, glow] = SURFACE_PAL.dojo.accent;
  const legend: Record<string, string> = { o: OUTLINE, r: red!, c: paper!, g: glow! };
  const hang = (x: number, drop: number): void => {
    g.fillStyle = OUTLINE;
    g.fillRect(x + 3, 0, 1, drop);
    paintGrid(g, LANTERN, legend, x, drop);
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
let drawCrowd: ReturnType<typeof createCrowd> | null = null;

/**
 * Paints the stadium behind the court: dithered sky (or the dojo's roof and paper lanterns), shaded
 * stands with a procedural, animated crowd, ad boards and side walls. The stadium is the same for
 * every viewer. Static parts are painted once per surface; the crowd is recomposed at most every
 * 100 ms of `s.t`, bobbing when idle and raising arms for the `s.crowdExcite` share of fans.
 */
export function drawBackdrop(ctx: CanvasRenderingContext2D, surface: Surface, s: SceneState): void {
  ctx.drawImage(cachedLayer(bases, surface, () => paintBase(surface)).canvas, 0, 0);
  (drawCrowd ??= createCrowd(SEATS))(ctx, s.crowdExcite, s.t);
  if (surface === 'dojo') ctx.drawImage((lanterns ??= paintLanterns()).canvas, 0, 0);
}

// ---------------------------------------------------------------------------------------------
// Net: posts, tape, 50 % checker mesh, centre strap and its shadow on the court; the umpire chair's shadow.

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
      else if (checker(x, y)) put(OUTLINE, x, y);
    }
    // Shadow on the ground in front of the net: the surface's darkest shade, solid then 50 %.
    const ramp = Math.abs(wx) <= COURT.doublesHalfWidth ? SURFACE_PAL[surface].court : SURFACE_PAL[surface].surround;
    const shade = ramp[ramp.length - 1]!;
    put(shade, x, foot + 1);
    if (!checker(x, foot)) put(shade, x, foot + 2);
  }
  const postTop = Math.floor(netScreenY() - COURT.netPostH * px);
  for (const x of [left, right]) {
    put(OUTLINE, x - 2, postTop - 1, 5, foot - postTop + 3);
    put(PAL.boardGreenHi, x - 1, postTop, 1, foot - postTop + 1);
    put(PAL.boardGreen, x, postTop, 2, foot - postTop + 1);
    put(PAL.silver, x - 1, postTop - 1, 3, 1);
  }
  paintChairShadow(g, surface, -NET_TOP);
  return layer;
}

const netLayer = layersPerEnd(paintNet);

/**
 * Paints the net across the court for `viewer`: posts, white tape following the sag from 1.07 m
 * at the posts to 0.914 m at the centre strap, a 50 % checker-dithered mesh and its shadow on the
 * court, plus the ground shadow of the umpire's chair beside the post (the chair itself is
 * `drawUmpire`'s, painted over it). Cached per (surface, viewer end).
 */
export function drawNet(ctx: CanvasRenderingContext2D, surface: Surface, viewer: PlayerId | 'spectator'): void {
  ctx.drawImage(netLayer(surface, viewer).canvas, 0, NET_TOP);
}
