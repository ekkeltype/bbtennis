import { CELL, frameIndex, type AnimName, type View } from './animations';
import { HEADS, LEGEND, RACKETS, SHOES, SLOT, TORSOS, headRows, type Part, type Pt, type SlotId } from './parts';
import { posesFor, type Layer, type Pose } from './poses';

const W = CELL.w;
const H = CELL.h;
/** Pelvis position of the standing skeleton (the torso anchor with a zero root offset). */
const PELVIS: Pt = { x: 23.5, y: 30 };

/** Draw-order owners, used to put contour lines where a limb crosses something drawn earlier. */
const OWNER = { torso: 1, head: 2, armL: 3, armR: 4, legL: 5, legR: 6, racket: 7, shoe: 8 } as const;
type Owner = (typeof OWNER)[keyof typeof OWNER];

/** A 48×48 slot buffer plus who drew each pixel. */
class Canvas {
  readonly slot = new Uint8Array(W * H);
  readonly owner = new Uint8Array(W * H);

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < W && y < H;
  }

  get(x: number, y: number): number {
    return this.inside(x, y) ? (this.slot[y * W + x] ?? SLOT.clear) : SLOT.clear;
  }

  set(x: number, y: number, slot: SlotId, owner: Owner): void {
    if (!this.inside(x, y)) return;
    this.slot[y * W + x] = slot;
    this.owner[y * W + x] = owner;
  }

  /** Stamps a grid with its origin at (ox, oy); see-through holes only fill clear pixels. */
  stamp(rows: readonly string[], ox: number, oy: number, owner: Owner): void {
    rows.forEach((row, gy) => {
      [...row].forEach((ch, gx) => {
        const slot = LEGEND[ch] ?? SLOT.clear;
        if (slot === SLOT.clear) return;
        if (slot === SLOT.hole && this.get(ox + gx, oy + gy) !== SLOT.clear) return;
        this.set(ox + gx, oy + gy, slot, owner);
      });
    });
  }
}

/** Grid origin that puts a part's anchor on `at`. */
const origin = (p: Part, at: Pt): Pt => ({ x: Math.round(at.x - p.ax), y: Math.round(at.y - p.ay) });

/** Integer points of the segment a → b (Bresenham), both ends included. */
function linePoints(a: Pt, b: Pt): Pt[] {
  const pts: Pt[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push({ x, y });
    if (x === b.x && y === b.y) return pts;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/** A limb segment, 3 (upper) or 2 (lower) px wide; `tone(j, n)` gives [mid, shadow] slots for point j of n. */
interface Segment {
  a: Pt;
  b: Pt;
  width: 2 | 3;
  tone: (j: number, n: number) => readonly [SlotId, SlotId];
}

/** A point that is exempt from contour lines against one owner (a joint where a limb attaches). */
interface Joint {
  at: Pt;
  owner: Owner;
  radius: number;
}

const SKIN = [SLOT.skinMid, SLOT.skinLo] as const;
const SHIRT = [SLOT.shirtMid, SLOT.shirtLo] as const;
const SHORTS = [SLOT.shortsMid, SLOT.shortsLo] as const;
const SOCK = [SLOT.shoeHi, SLOT.shoeLo] as const;
/** Points of the upper arm drawn as sleeve and of the thigh drawn as shorts leg. */
const SLEEVE = 3;
const SHORTS_LEG = 4;
/** Points at the bottom of the shin drawn as sock. */
const SOCK_LEN = 2;

/**
 * Draws a procedural limb (spec §4.1): segments with a 2-tone ramp, shadow on the lower-right
 * side (light from the upper left), ending in a 2×2 hand when `hand` is given. Where it crosses
 * pixels drawn earlier by another owner, those pixels become outline, except near its joints.
 */
function drawLimb(c: Canvas, segments: readonly Segment[], owner: Owner, joints: readonly Joint[], hand?: Pt): void {
  const px = new Map<number, SlotId>();
  const put = (x: number, y: number, slot: SlotId) => {
    if (c.inside(x, y)) px.set(y * W + x, slot);
  };
  for (const s of segments) {
    const pts = linePoints(s.a, s.b);
    const steep = Math.abs(s.b.y - s.a.y) >= Math.abs(s.b.x - s.a.x);
    const [ox, oy] = steep ? [1, 0] : [0, 1];
    pts.forEach((p, j) => {
      const [mid, lo] = s.tone(j, pts.length);
      if (s.width === 3) put(p.x - ox, p.y - oy, mid);
      put(p.x, p.y, mid);
      put(p.x + ox, p.y + oy, lo);
    });
  }
  // Single-pixel spurs (at most one same-limb neighbour) at bends and tips read as jaggies.
  const spurs = [...px.keys()].filter(
    (i) => [i - 1, i + 1, i - W, i + W].filter((n) => px.has(n) && Math.abs((n % W) - (i % W)) <= 1).length <= 1,
  );
  for (const i of spurs) px.delete(i);
  if (hand) {
    put(hand.x, hand.y, SLOT.skinHi);
    put(hand.x + 1, hand.y, SLOT.skinMid);
    put(hand.x, hand.y + 1, SLOT.skinMid);
    put(hand.x + 1, hand.y + 1, SLOT.skinLo);
  }
  const contour: number[] = [];
  for (const i of px.keys()) {
    const x = i % W;
    const y = (i - x) / W;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      const n = ny * W + nx;
      if (!c.inside(nx, ny) || px.has(n)) continue;
      const other = c.owner[n] ?? 0;
      const slot = c.slot[n] ?? SLOT.clear;
      if (other === 0 || other === owner || slot === SLOT.outline || slot === SLOT.hole) continue;
      if (joints.some((j) => j.owner === other && Math.hypot(nx - j.at.x, ny - j.at.y) <= j.radius)) continue;
      contour.push(n);
    }
  }
  for (const n of contour) c.slot[n] = SLOT.outline;
  for (const [i, slot] of px) {
    const x = i % W;
    c.set(x, (i - x) / W, slot, owner);
  }
}

/** Turns every clear pixel touching a non-outline opaque pixel into outline (4-neighbour silhouette). */
function outlinePass(c: Canvas): void {
  const add: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (c.get(x, y) !== SLOT.clear) continue;
      const touches = [c.get(x - 1, y), c.get(x + 1, y), c.get(x, y - 1), c.get(x, y + 1)].some(
        (s) => s !== SLOT.clear && s !== SLOT.outline && s !== SLOT.hole,
      );
      if (touches) add.push(y * W + x);
    }
  }
  for (const i of add) c.slot[i] = SLOT.outline;
}

/** Composes one frame into a 48×48 slot buffer (row-major), independent of colours. */
export function composeFrame(anim: AnimName, view: View, i: number, hairStyle: number, headband: boolean): Uint8Array {
  const pose = posesFor(anim, view)[frameIndex(anim, i)];
  if (!pose) throw new Error(`no pose ${anim} ${view} ${i}`);
  const c = new Canvas();
  const torso = TORSOS[view][pose.twist];
  const t = origin(torso, { x: PELVIS.x + pose.root.x, y: PELVIS.y + pose.root.y });
  const socket = (s: Pt): Pt => ({ x: t.x + s.x, y: t.y + s.y });

  const drawRacket = () => {
    const r = RACKETS[pose.racket];
    if (!r) throw new Error(`no racket angle ${pose.racket}`);
    const o = origin(r, pose.handR);
    c.stamp(r.rows, o.x, o.y, OWNER.racket);
  };
  const drawArm = (side: 'L' | 'R') => {
    const shoulder = socket(side === 'L' ? torso.shoulderL : torso.shoulderR);
    const elbow = side === 'L' ? pose.elbowL : pose.elbowR;
    const hand = side === 'L' ? pose.handL : pose.handR;
    const joints: Joint[] = [{ at: shoulder, owner: OWNER.torso, radius: 2.5 }];
    if (side === 'R') joints.push({ at: hand, owner: OWNER.racket, radius: 2 });
    drawLimb(
      c,
      [
        { a: shoulder, b: elbow, width: 3, tone: (j) => (j < SLEEVE ? SHIRT : SKIN) },
        { a: elbow, b: hand, width: 2, tone: () => SKIN },
      ],
      side === 'L' ? OWNER.armL : OWNER.armR,
      joints,
      hand,
    );
  };
  const drawLeg = (side: 'L' | 'R') => {
    const hip = socket(side === 'L' ? torso.hipL : torso.hipR);
    const knee = side === 'L' ? pose.kneeL : pose.kneeR;
    const foot = side === 'L' ? pose.footL : pose.footR;
    const shoe = SHOES[side === 'L' ? pose.shoeL : pose.shoeR];
    const o = origin(shoe, foot);
    const ankle = { x: o.x + shoe.ankle.x, y: o.y + shoe.ankle.y };
    drawLimb(
      c,
      [
        { a: hip, b: knee, width: 3, tone: (j) => (j < SHORTS_LEG ? SHORTS : SKIN) },
        { a: knee, b: ankle, width: 2, tone: (j, n) => (j >= n - SOCK_LEN ? SOCK : SKIN) },
      ],
      side === 'L' ? OWNER.legL : OWNER.legR,
      [{ at: hip, owner: OWNER.torso, radius: 2.5 }],
    );
    c.stamp(shoe.rows, o.x, o.y, OWNER.shoe);
  };
  const drawLayer = (layer: Layer) => {
    if (pose.layer.racket === layer) drawRacket();
    if (pose.layer.armL === layer) drawArm('L');
    if (pose.layer.armR === layer) drawArm('R');
  };

  drawLayer('under');
  for (const side of pose.legOrder) drawLeg(side);
  c.stamp(torso.rows, t.x, t.y, OWNER.torso);
  drawLayer('mid');
  const head = HEADS[view];
  const neck = socket(torso.neck);
  const h = origin(head, { x: neck.x + pose.head.x, y: neck.y + pose.head.y });
  const composed = headRows(view, hairStyle, headband);
  c.stamp(composed.rows, h.x + composed.ox, h.y + composed.oy, OWNER.head);
  drawLayer('over');
  outlinePass(c);
  return c.slot;
}
