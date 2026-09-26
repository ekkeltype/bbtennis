import { CELL, type AnimName, type View } from './animations';
import type { Pt, ShoeKind, Twist } from './parts';

/** Screen draw layer of a limb or the racket: behind the torso, over the torso, or over the head. */
export type Layer = 'under' | 'mid' | 'over';

/**
 * One frame of a player in screen space (cell pixels): the pelvis (`root`) and head offsets from
 * the standing skeleton, torso twist, the eight free joints, racket angle (k·45° counter-clockwise
 * from pointing right, gripped by the right hand), draw layers, shoe grids, leg draw order and the
 * sideways shift of hanging hair (`hairSway`, one of `HAIR_SWAYS`).
 */
export interface Pose {
  root: Pt;
  head: Pt;
  hairSway: number;
  twist: Twist;
  elbowL: Pt;
  handL: Pt;
  elbowR: Pt;
  handR: Pt;
  kneeL: Pt;
  footL: Pt;
  kneeR: Pt;
  footR: Pt;
  racket: number;
  layer: { armL: Layer; armR: Layer; racket: Layer };
  shoeL: ShoeKind;
  shoeR: ShoeKind;
  legOrder: readonly ['L', 'R'] | readonly ['R', 'L'];
}

/** Body-space depth: in front of the chest, beside the torso, or behind the back. */
type Depth = 'fore' | 'side' | 'aft';
/** Body-space toe direction: toward the net, toward the player's left/right, or kicked up behind. */
type Toe = 'fwd' | 'left' | 'right' | 'up';

/**
 * A frame in body space: back-view cell coordinates (the player's right is screen-right), depths
 * relative to the torso and toe directions relative to the body. `lead` is the leg nearer the net;
 * `hairSway` shifts hanging hair toward the player's right (+) or left (−).
 */
interface BodyPose {
  root: Pt;
  head: Pt;
  hairSway: number;
  twist: Twist;
  elbowL: Pt;
  handL: Pt;
  elbowR: Pt;
  handR: Pt;
  kneeL: Pt;
  footL: Pt;
  kneeR: Pt;
  footR: Pt;
  racket: number;
  depth: { armL: Depth; armR: Depth; racket: Depth };
  toeL: Toe;
  toeR: Toe;
  lead: 'L' | 'R';
}

type XY = readonly [number, number];
type Limb = readonly [number, number, number, number];

/** Compact authoring form: limbs are [joint x, joint y, end x, end y] (elbow → hand, knee → foot). */
interface Draft {
  root?: XY;
  head?: XY;
  sway?: number;
  twist?: Twist;
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
  racket: number;
  depth?: Partial<BodyPose['depth']>;
  toes?: readonly [Toe, Toe];
  lead?: 'L' | 'R';
}

const pt = (x: number, y: number): Pt => ({ x, y });

function body(d: Draft): BodyPose {
  return {
    root: pt(...(d.root ?? [0, 0])),
    head: pt(...(d.head ?? [0, 0])),
    hairSway: d.sway ?? 0,
    twist: d.twist ?? 'N',
    elbowL: pt(d.armL[0], d.armL[1]),
    handL: pt(d.armL[2], d.armL[3]),
    elbowR: pt(d.armR[0], d.armR[1]),
    handR: pt(d.armR[2], d.armR[3]),
    kneeL: pt(d.legL[0], d.legL[1]),
    footL: pt(d.legL[2], d.legL[3]),
    kneeR: pt(d.legR[0], d.legR[1]),
    footR: pt(d.legR[2], d.legR[3]),
    racket: d.racket,
    depth: { armL: 'side', armR: 'side', racket: 'side', ...d.depth },
    toeL: d.toes?.[0] ?? 'fwd',
    toeR: d.toes?.[1] ?? 'fwd',
    lead: d.lead ?? 'L',
  };
}

/**
 * Body-space frames; `runRight` is derived from `runLeft` (mirrored, racket kept in the right hand).
 * Runs sway hanging hair a pixel: it trails the lateral run and swings with the stride otherwise.
 */
const BODY: Record<Exclude<AnimName, 'runRight'>, BodyPose[]> = {
  idle: [
    body({ armL: [16, 24, 17, 29], armR: [31, 24, 30, 29], legL: [21, 36, 20, 46], legR: [26, 36, 27, 46], racket: 1 }),
    body({
      root: [0, 1], armL: [16, 25, 17, 30], armR: [31, 25, 30, 30],
      legL: [21, 37, 20, 46], legR: [26, 37, 27, 46], racket: 1,
    }),
  ],
  runLeft: [
    body({
      twist: 'L', lead: 'R', toes: ['left', 'left'], sway: 1,
      armL: [16, 21, 13, 23], armR: [30, 23, 31, 27],
      legL: [18, 35, 16, 46], legR: [28, 35, 31, 44], racket: 1,
    }),
    body({
      twist: 'L', lead: 'R', toes: ['left', 'left'], root: [0, 1], sway: 1,
      armL: [16, 23, 14, 26], armR: [30, 24, 31, 28],
      legL: [19, 37, 19, 46], legR: [26, 36, 29, 42], racket: 1,
    }),
    body({
      twist: 'L', lead: 'R', toes: ['left', 'left'], root: [0, -1],
      armL: [17, 23, 17, 27], armR: [30, 22, 31, 26],
      legL: [21, 36, 22, 46], legR: [23, 34, 25, 41], racket: 1,
    }),
    body({
      twist: 'L', lead: 'R', toes: ['left', 'left'], sway: 1,
      armL: [18, 23, 20, 27], armR: [30, 22, 30, 26], depth: { armL: 'aft' },
      legL: [28, 35, 31, 44], legR: [18, 35, 16, 46], racket: 1,
    }),
    body({
      twist: 'L', lead: 'R', toes: ['left', 'left'], root: [0, 1], sway: 1,
      armL: [18, 24, 19, 28], armR: [30, 23, 31, 27], depth: { armL: 'aft' },
      legL: [26, 36, 29, 42], legR: [19, 37, 19, 46], racket: 1,
    }),
    body({
      twist: 'L', lead: 'R', toes: ['left', 'left'], root: [0, -1],
      armL: [17, 23, 17, 27], armR: [30, 23, 31, 27],
      legL: [23, 34, 25, 41], legR: [21, 36, 22, 46], racket: 1,
    }),
  ],
  runToward: [
    body({
      sway: -1,
      armL: [17, 23, 19, 21], armR: [31, 21, 30, 25], depth: { armL: 'fore', armR: 'aft' },
      legL: [21, 36, 21, 46], legR: [26, 35, 27, 43], toes: ['fwd', 'up'], racket: 1,
    }),
    body({
      root: [0, -1],
      armL: [17, 22, 17, 26], armR: [30, 22, 30, 26],
      legL: [21, 35, 21, 45], legR: [26, 36, 26, 44], racket: 1,
    }),
    body({
      sway: 1,
      armL: [16, 21, 17, 25], armR: [30, 23, 28, 21], depth: { armL: 'aft', armR: 'fore', racket: 'fore' },
      legL: [21, 35, 20, 43], legR: [26, 36, 26, 46], toes: ['up', 'fwd'], racket: 2,
    }),
    body({
      root: [0, -1],
      armL: [17, 22, 17, 26], armR: [30, 22, 30, 26],
      legL: [21, 36, 21, 44], legR: [26, 35, 26, 45], racket: 1,
    }),
  ],
  runAway: [
    body({
      sway: 1,
      armL: [15, 23, 13, 26], armR: [32, 23, 33, 26], legL: [20, 36, 19, 43], legR: [26, 36, 27, 46], racket: 1,
    }),
    body({
      root: [0, 1], armL: [15, 24, 14, 28], armR: [32, 24, 33, 28],
      legL: [20, 37, 20, 46], legR: [27, 37, 27, 46], racket: 1,
    }),
    body({
      sway: -1,
      armL: [15, 23, 13, 26], armR: [32, 23, 33, 26], legL: [21, 36, 20, 46], legR: [27, 36, 28, 43], racket: 1,
    }),
    body({
      root: [0, 1], armL: [15, 24, 14, 28], armR: [32, 24, 33, 28],
      legL: [20, 37, 20, 46], legR: [27, 37, 27, 46], racket: 1,
    }),
  ],
  forehand: [
    body({
      twist: 'R', root: [0, 1], depth: { armL: 'fore', racket: 'aft' },
      armL: [24, 21, 27, 21], armR: [32, 21, 35, 22],
      legL: [20, 37, 19, 46], legR: [27, 37, 28, 46], racket: 2,
    }),
    body({
      twist: 'R', root: [0, 1], depth: { armL: 'fore' },
      armL: [22, 22, 25, 23], armR: [32, 24, 34, 28],
      legL: [20, 37, 19, 46], legR: [27, 37, 28, 46], racket: 7,
    }),
    body({
      root: [0, 1], depth: { armL: 'fore' },
      armL: [17, 22, 20, 24], armR: [32, 22, 35, 24],
      legL: [20, 37, 19, 46], legR: [27, 37, 28, 46], racket: 0,
    }),
    body({
      twist: 'L', depth: { armR: 'fore', racket: 'aft' },
      armL: [17, 23, 18, 27], armR: [24, 19, 19, 17],
      legL: [20, 36, 19, 46], legR: [27, 37, 28, 45], racket: 3, toes: ['fwd', 'left'],
    }),
  ],
  backhand: [
    body({
      twist: 'L', root: [0, 1], depth: { armR: 'fore', racket: 'aft' },
      armL: [16, 22, 15, 25], armR: [22, 22, 16, 25],
      legL: [20, 37, 19, 46], legR: [27, 37, 28, 46], racket: 3,
    }),
    body({
      twist: 'L', root: [0, 1], depth: { armR: 'fore' },
      armL: [16, 23, 14, 28], armR: [21, 23, 15, 28],
      legL: [20, 37, 19, 46], legR: [27, 37, 28, 46], racket: 5,
    }),
    body({
      root: [0, 1], depth: { armR: 'fore' },
      armL: [15, 22, 12, 24], armR: [20, 22, 13, 24],
      legL: [20, 37, 19, 46], legR: [27, 37, 28, 46], racket: 4,
    }),
    body({
      twist: 'R', depth: { armL: 'fore', racket: 'aft' },
      armL: [24, 18, 30, 15], armR: [31, 18, 31, 15],
      legL: [20, 37, 19, 45], legR: [27, 36, 28, 46], racket: 1, toes: ['right', 'fwd'],
    }),
  ],
  serve: [
    body({
      twist: 'R',
      armL: [17, 13, 17, 8], armR: [31, 23, 32, 27],
      legL: [21, 36, 20, 46], legR: [26, 36, 27, 46], racket: 7,
    }),
    body({
      twist: 'R', root: [0, 2], depth: { racket: 'aft' },
      armL: [17, 14, 17, 9], armR: [33, 19, 33, 14],
      legL: [20, 38, 20, 46], legR: [27, 38, 27, 46], racket: 3,
    }),
    body({
      root: [0, -1],
      armL: [18, 24, 20, 27], armR: [30, 15, 29, 11],
      legL: [21, 35, 21, 45], legR: [26, 35, 26, 45], racket: 2, depth: { armL: 'fore' },
    }),
    body({
      twist: 'L', root: [0, 1], depth: { armR: 'fore', armL: 'fore' },
      armL: [17, 23, 19, 27], armR: [22, 25, 17, 30],
      legL: [20, 37, 20, 46], legR: [27, 37, 28, 45], racket: 5,
    }),
  ],
  stretch: [
    body({
      root: [2, 3], armL: [16, 23, 12, 22], armR: [33, 24, 36, 25],
      legL: [20, 39, 16, 46], legR: [32, 38, 34, 46], racket: 0, toes: ['fwd', 'right'],
    }),
    body({
      root: [2, 4], armL: [16, 24, 12, 24], armR: [33, 26, 35, 30],
      legL: [20, 40, 16, 46], legR: [32, 39, 34, 46], racket: 7, toes: ['fwd', 'right'],
    }),
  ],
  celebrate: [
    body({
      armL: [15, 22, 16, 18], armR: [31, 16, 30, 12],
      legL: [21, 36, 20, 46], legR: [26, 36, 27, 46], racket: 2,
    }),
    body({
      root: [0, -2], armL: [15, 20, 16, 16], armR: [31, 14, 30, 11],
      legL: [21, 34, 20, 44], legR: [26, 34, 27, 44], racket: 1,
    }),
  ],
  dejected: [
    body({
      root: [0, 1], head: [0, 2],
      armL: [18, 26, 18, 32], armR: [30, 26, 31, 32],
      legL: [21, 37, 21, 46], legR: [26, 37, 26, 46], racket: 7,
    }),
    body({
      root: [0, 1], head: [1, 2],
      armL: [18, 26, 18, 32], armR: [30, 26, 31, 32],
      legL: [21, 37, 21, 46], legR: [26, 37, 26, 46], racket: 7,
    }),
  ],
};

/** Mirror column for pixel x across the cell's centre line. */
const mirrorX = (x: number): number => CELL.w - 1 - x;
const mirrorPt = (p: Pt): Pt => pt(mirrorX(p.x), p.y);
/** Racket angle index mirrored left ↔ right. */
const mirrorAngle = (k: number): number => (12 - k) % 8;
const TWIST_MIRROR: Record<Twist, Twist> = { N: 'N', L: 'R', R: 'L' };
const TOE_MIRROR: Record<Toe, Toe> = { fwd: 'fwd', left: 'right', right: 'left', up: 'up' };

/**
 * The same movement toward the other side: joints mirrored and swapped left ↔ right, so the
 * racket stays in the right hand; it keeps its screen angle, still pointing away from the body.
 */
function mirrorSwap(p: BodyPose): BodyPose {
  return {
    root: pt(-p.root.x, p.root.y),
    head: pt(-p.head.x, p.head.y),
    hairSway: -p.hairSway,
    twist: TWIST_MIRROR[p.twist],
    elbowL: mirrorPt(p.elbowR),
    handL: mirrorPt(p.handR),
    elbowR: mirrorPt(p.elbowL),
    handR: mirrorPt(p.handL),
    kneeL: mirrorPt(p.kneeR),
    footL: mirrorPt(p.footR),
    kneeR: mirrorPt(p.kneeL),
    footR: mirrorPt(p.footL),
    racket: p.racket,
    depth: { armL: p.depth.armR, armR: p.depth.armL, racket: p.depth.racket },
    toeL: TOE_MIRROR[p.toeR],
    toeR: TOE_MIRROR[p.toeL],
    lead: p.lead === 'L' ? 'R' : 'L',
  };
}

const NEAR_LAYER: Record<Depth, Layer> = { fore: 'under', side: 'mid', aft: 'over' };
const FAR_LAYER: Record<Depth, Layer> = { fore: 'over', side: 'mid', aft: 'under' };
const NEAR_SHOE: Record<Toe, ShoeKind> = { fwd: 'heel', left: 'sideL', right: 'sideR', up: 'sole' };
const FAR_SHOE: Record<Toe, ShoeKind> = { fwd: 'toe', left: 'sideR', right: 'sideL', up: 'toe' };

/** Projects a body-space frame into a view: the far (front) view mirrors it and reverses depth. */
function toView(p: BodyPose, view: View): Pose {
  const far = view === 'far';
  const layer = far ? FAR_LAYER : NEAR_LAYER;
  const shoe = far ? FAR_SHOE : NEAR_SHOE;
  const at = far ? mirrorPt : (q: Pt) => q;
  const leadFirst = p.lead === 'L' ? (['L', 'R'] as const) : (['R', 'L'] as const);
  const leadLast = p.lead === 'L' ? (['R', 'L'] as const) : (['L', 'R'] as const);
  return {
    root: pt(far ? -p.root.x : p.root.x, p.root.y),
    head: pt(far ? -p.head.x : p.head.x, p.head.y),
    hairSway: far ? -p.hairSway : p.hairSway,
    twist: p.twist,
    elbowL: at(p.elbowL),
    handL: at(p.handL),
    elbowR: at(p.elbowR),
    handR: at(p.handR),
    kneeL: at(p.kneeL),
    footL: at(p.footL),
    kneeR: at(p.kneeR),
    footR: at(p.footR),
    racket: far ? mirrorAngle(p.racket) : p.racket,
    layer: { armL: layer[p.depth.armL], armR: layer[p.depth.armR], racket: layer[p.depth.racket] },
    shoeL: shoe[p.toeL],
    shoeR: shoe[p.toeR],
    legOrder: far ? leadLast : leadFirst,
  };
}

function bodyFrames(anim: AnimName, view: View): BodyPose[] {
  if (anim === 'runLeft' || anim === 'runRight') {
    // runLeft is authored toward the player's left, which is screen-left only from behind.
    const towardPlayersLeft = (anim === 'runLeft') === (view === 'near');
    return towardPlayersLeft ? BODY.runLeft : BODY.runLeft.map(mirrorSwap);
  }
  return BODY[anim];
}

const cache = new Map<string, readonly Pose[]>();

/** The screen-space pose table of an animation in a view (one pose per frame). */
export function posesFor(anim: AnimName, view: View): readonly Pose[] {
  const key = `${anim}:${view}`;
  let poses = cache.get(key);
  if (!poses) {
    poses = bodyFrames(anim, view).map((p) => toView(p, view));
    cache.set(key, poses);
  }
  return poses;
}
