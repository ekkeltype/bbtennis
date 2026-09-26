import { intBelow, seedRng, uniform } from '../core/rng';
import type { RngState } from '../core/types';
import { packed } from './court';
import { PAL } from './palette';
import { W } from './projection';
import { createLayer, type Layer } from './screen';

/** Where a fan sits: the left column and the row just below the fan's `FAN_W`×`FAN_H` cell. */
export interface Seat { x: number; y: number }

/** Width of one fan's cell, px. */
export const FAN_W = 5;
/** Height of one fan's cell, px (room for arms raised above the head). */
export const FAN_H = 10;

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

const IDLE = 0;
const BOB = 1;
const CHEER_HIGH = 2;
const CHEER_LOW = 3;
/** Crowd animation step (ms): the crowd is recomposed at most once per tick. */
const TICK_MS = 100;
/** Screen rows 0–139 hold the crowd layer. */
const CROWD_H = 140;

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
    const out = new Uint32Array(FAN_W * FAN_H);
    const top = FAN_H - h - lift;
    body.rows.forEach((row, r) => {
      for (let c = 0; c < FAN_W; c++) {
        const ch = row[c]!;
        if (ch !== '.') out[(top + r) * FAN_W + c] = colors[ch]!;
      }
    });
    if (hands !== null) {
      const hand = top - hands;
      for (let r = hand; r < top + body.head; r++) {
        out[r * FAN_W] = r === hand ? colors.s! : colors.c!;
        out[r * FAN_W + FAN_W - 1] = r === hand ? colors.s! : colors.d!;
      }
    }
    return out;
  };
  return [frame(0, null), frame(1, null), frame(1, 2), frame(0, 1)];
}

function makeFans(seats: readonly Seat[]): Fan[] {
  const rng = seedRng(0x5ea75);
  const fans: Fan[] = [];
  for (const seat of seats) {
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

/**
 * A procedural crowd filling `seats` (spec §4.1): each fan gets a seeded body template and palette
 * swap. The returned painter blits the crowd for excitement `crowdExcite` (0–1, the share of fans
 * cheering; NaN counts as 0) at animation clock `t` (ms), recomposing the layer at most once per
 * 100 ms tick and 1/32 excitement step.
 */
export function createCrowd(seats: readonly Seat[]): (ctx: CanvasRenderingContext2D, crowdExcite: number, t: number) => void {
  const fans = makeFans(seats);
  let out: { layer: Layer; img: ImageData; px: Uint32Array; key: string } | null = null;
  return (ctx, crowdExcite, t) => {
    if (!out) {
      const layer = createLayer(W, CROWD_H);
      const img = layer.g.createImageData(W, CROWD_H);
      out = { layer, img, px: new Uint32Array(img.data.buffer), key: '' };
    }
    // Quantised so a smoothly easing excitement recomposes only at 1/32 steps.
    const excite = Number.isFinite(crowdExcite) ? Math.round(Math.min(1, Math.max(0, crowdExcite)) * 32) / 32 : 0;
    const tick = Number.isFinite(t) ? Math.floor(t / TICK_MS) : 0;
    const key = `${tick}|${excite}`;
    if (key !== out.key) {
      out.key = key;
      compose(out.px, fans, tick, excite);
      out.layer.g.putImageData(out.img, 0, 0);
    }
    ctx.drawImage(out.layer.canvas, 0, 0);
  };
}

function compose(px: Uint32Array, fans: readonly Fan[], tick: number, excite: number): void {
  px.fill(0);
  for (const f of fans) {
    const frame = f.frames[pose(f, tick, excite)]!;
    const top = f.y - FAN_H;
    for (let r = 0; r < FAN_H; r++) {
      const y = top + r;
      if (y < 0 || y >= CROWD_H) continue;
      for (let c = 0; c < FAN_W; c++) {
        const v = frame[r * FAN_W + c]!;
        const x = f.x + c;
        if (v !== 0 && x >= 0 && x < W) px[y * W + x] = v;
      }
    }
  }
}
