import { clamp } from '../core/util';
import { layoutChoiceStack, PLATE_AREA, stackHeight, type PlateBox } from './layout';
import type { Pt } from './plates';

// Choice stacks and their side leaders (choice-stack spec §2–3).

/**
 * Which way a stack's rings lie: 'up' for the near typist (rings on the far half, above the stack),
 * 'down' for the far typist (rings on the near half, below it). A 'down' stack is the 'up' stack
 * mirrored top to bottom (`flipBox`, `flipPt`), so easy sits at its bottom, nearest the rings.
 */
export type Facing = 'up' | 'down';

/** Mirrors the plate area top to bottom: rows 22–265 map onto themselves, row r to row 287 − r. */
const FLIP = PLATE_AREA.top + PLATE_AREA.bottom;

function flipBox(b: PlateBox): PlateBox {
  return { ...b, y: FLIP - (b.y + b.h) };
}

function flipPt(p: Pt): Pt {
  return { x: p.x, y: FLIP - 1 - p.y };
}

/** Lanes on one side are this far apart: 1 px ink with a 1 px outline each side, then 1 px of court. */
const LANE_GAP = 4;
/** A leader starts this far outside its plate's edge, past the 1 px halo. */
const START_OUT = 2;
/** The innermost lane turns this far above the stack's top edge; each lane farther out turns `LANE_GAP` higher. */
const TURN_GAP = 4;
/** The stack's top edge stays at least this far below the lowest ring centre. */
const RING_CLEAR = 8;
/** Column shifts tried to fit the stack and its leaders inside the plate area. */
const FIT_TRIES = 4;

/** `points` without any point equal to the one before it. */
function compact(points: Pt[]): Pt[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
}

/**
 * The side leaders of a choice stack (choice-stack spec §3): one polyline per plate from the middle row
 * of one of its sides, 2 px out, to its ring centre `rings[i]` (whole pixels, option order). Medium and
 * insane leave from medium's side of the screen (medium's ring relative to hard's), hard from the other
 * and easy from the side its ring is on relative to `columnX` (hard's side when exactly on it). Plates
 * are taken top to bottom on each side. A ring farther out than both the plate's start and every lane
 * or column used above it on that side gets a direct route: along the plate's row to the ring's x, then
 * up. Otherwise the leader runs out to a lane (the start, or 4 px beyond the previous lane or column),
 * up to 4 px above the stack's top plus 4 px per lane already turned on that side, then straight to the
 * ring. With a pyramid stack and the tier rings' fixed left-to-right order, no two routes meet and none
 * crosses another plate (tests/render/leaders.test.ts). A 'down' stack is routed mirrored: "above"
 * becomes "below" throughout.
 */
export function routeStackLeaders(
  boxes: readonly PlateBox[],
  rings: readonly Pt[],
  columnX: number,
  facing: Facing = 'up',
): Pt[][] {
  if (facing === 'down') {
    return routeStackLeaders(boxes.map(flipBox), rings.map(flipPt), columnX).map((r) => r.map(flipPt));
  }
  if ((boxes.length !== 3 && boxes.length !== 4) || rings.length !== boxes.length) {
    throw new Error(`routeStackLeaders needs 3 or 4 plates and a ring each, got ${boxes.length} and ${rings.length}`);
  }
  const medium: -1 | 1 = rings[1]!.x < rings[2]!.x ? -1 : 1;
  const sideOf = (i: number): -1 | 1 => {
    if (i === 2) return medium === 1 ? -1 : 1;
    if (i !== 0) return medium;
    const x = rings[0]!.x;
    if (x === columnX) return medium === 1 ? -1 : 1;
    return x < columnX ? -1 : 1;
  };
  const top = Math.min(...boxes.map((b) => b.y));
  const routes: Pt[][] = [];
  for (const side of [-1, 1] as const) {
    let edge: number | null = null;
    let lanes = 0;
    boxes.forEach((b, i) => {
      if (sideOf(i) !== side) return;
      const start = { x: side < 0 ? b.x - START_OUT : b.x + b.w - 1 + START_OUT, y: b.y + b.h / 2 };
      const inner = edge === null ? start.x : side < 0 ? Math.min(start.x, edge - LANE_GAP) : Math.max(start.x, edge + LANE_GAP);
      const ring = { x: rings[i]!.x, y: rings[i]!.y };
      if (side * (ring.x - inner) >= 0) {
        routes[i] = compact([start, { x: ring.x, y: start.y }, ring]);
        edge = ring.x;
      } else {
        const turn = top - TURN_GAP - LANE_GAP * lanes++;
        routes[i] = compact([start, { x: inner, y: start.y }, { x: inner, y: turn }, ring]);
        edge = inner;
      }
    });
  }
  return routes;
}

/** A placed choice stack: its plates, their leader routes and the column it ended up on. */
export interface PlacedStack { boxes: PlateBox[]; routes: Pt[][]; columnX: number }

/** Pixels to move the stack right (+) or left (−) so its plates and leaders fit x 4–476; 0 when they fit. */
function fitShift(boxes: readonly PlateBox[], routes: readonly Pt[][]): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of boxes) {
    lo = Math.min(lo, b.x);
    hi = Math.max(hi, b.x + b.w);
  }
  // Every point but the ring (always well inside), widened by the 1 px outline.
  for (const r of routes) {
    for (const p of r.slice(0, -1)) {
      lo = Math.min(lo, p.x - 1);
      hi = Math.max(hi, p.x + 2);
    }
  }
  if (lo < PLATE_AREA.left) return PLATE_AREA.left - lo;
  return hi > PLATE_AREA.right ? PLATE_AREA.right - hi : 0;
}

/**
 * A choice stack for `lens` (choice-stack spec §2), placed beside the hitting spot (`besideColumn`):
 * centred on `columnX`. Facing 'up' (the near typist), the last plate (easy on top) ends at `edgeY` and
 * the stack moves down if needed so its top stays 8 px below the lowest of `rings` (whole-pixel ring
 * centres, one per option). Facing 'down' (the far typist) it is mirrored: easy at the bottom, the top
 * plate starting at `edgeY`, moving up to stay 8 px above the highest ring. Kept inside y 22–266, and
 * shifted sideways as one unit with its leaders until they fit x 4–476 (the plates alone as a last
 * resort, which the leader tests show never happens).
 */
export function placeChoiceStack(
  lens: number[],
  columnX: number,
  edgeY: number,
  rings: readonly Pt[],
  facing: Facing = 'up',
): PlacedStack {
  if (facing === 'down') {
    const s = placeChoiceStack(lens, columnX, FLIP - Math.round(edgeY), rings.map(flipPt));
    return { boxes: s.boxes.map(flipBox), routes: s.routes.map((r) => r.map(flipPt)), columnX: s.columnX };
  }
  const bottomY = edgeY;
  const h = stackHeight(lens.length);
  const lowest = Math.max(...rings.map((r) => r.y));
  const bottom = clamp(Math.max(Math.round(bottomY), lowest + RING_CLEAR + h), PLATE_AREA.top + h, PLATE_AREA.bottom);
  let column = columnX;
  for (let k = 0; k < FIT_TRIES; k++) {
    const boxes = layoutChoiceStack(lens, column, bottom);
    const routes = routeStackLeaders(boxes, rings, column);
    const dx = fitShift(boxes, routes);
    if (dx === 0) return { boxes, routes, columnX: column };
    column += dx;
  }
  column += fitShift(layoutChoiceStack(lens, column, bottom), []);
  const boxes = layoutChoiceStack(lens, column, bottom);
  return { boxes, routes: routeStackLeaders(boxes, rings, column), columnX: column };
}
