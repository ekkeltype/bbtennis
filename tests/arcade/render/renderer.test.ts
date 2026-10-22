import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArcadeCpu } from '../../../src/arcade/core/cpu';
import { buildFlight, flightPos } from '../../../src/arcade/core/flight';
import { DT } from '../../../src/arcade/core/tuning';
import type { ArcadeConfig, ArcadeEvent, ArcadeState, HitEvent, PlayerId, Vec3 } from '../../../src/arcade/core/types';
import { ArcadeSession, type ArcadeView } from '../../../src/arcade/game/session';
import { poseAt } from '../../../src/arcade/render/animator';
import { drawArcadeHud } from '../../../src/arcade/render/hud';
import { ArcadeRenderer, ballViewAt, chargeBar } from '../../../src/arcade/render/renderer';
import type { Look, PlayerInfo } from '../../../src/core/types';
import { BALL_MAX_Z } from '../../../src/render/ballPaint';
import type { Screen } from '../../../src/render/screen';
import { buildSheet } from '../../../src/render/sprites/sheet';
import { matchInSetup, runUntil, untilType } from '../matchHelpers';

const LOOK_A: Look = { skin: 1, hairStyle: 2, hair: 3, shirt: 6, shorts: 7, headband: 5, racket: 2 };
const LOOK_B: Look = { skin: 3, hairStyle: 4, hair: 1, shirt: 2, shorts: 1, headband: null, racket: 0 };
const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'Kai', look: LOOK_A, kind: 'cpu', cpuLevel: 6 },
  { name: 'Mira', look: LOOK_B, kind: 'cpu', cpuLevel: 9 },
];
const NO_OVERLAY = { paused: false, countdown: null };

/** One recorded context call: its name, arguments and the fill style it ran under. */
interface Op { name: string; args: unknown[]; style: string }

/** A 2D context stand-in that accepts every call and records it, in order, with the fill style at the time. */
function opContext(canvas: { width: number; height: number }, ops: Op[] = []): CanvasRenderingContext2D & { ops: Op[] } {
  const state: Record<string, unknown> = {
    canvas,
    ops,
    fillStyle: '#000000',
    globalAlpha: 1,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy(state, {
    get(t, key: string) {
      if (key in t) return t[key];
      return (...args: unknown[]) => ops.push({ name: key, args, style: String(t.fillStyle) });
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D & { ops: Op[] };
}

class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): CanvasRenderingContext2D {
    return opContext(this);
  }
}

/** A screen whose buffer records every call; `frames` holds each presented frame's calls. */
function fakeScreen(): { screen: Screen; frames: Op[][] } {
  const buf = opContext(new FakeCanvas(480, 270));
  const frames: Op[][] = [];
  const present = vi.fn(() => {
    frames.push(buf.ops.splice(0));
  });
  return { screen: { buf, present } as unknown as Screen, frames };
}

function cpuSession(viewer: PlayerId | 'spectator', seed = 5): ArcadeSession {
  const config: ArcadeConfig = { format: 'short', deuceRule: 'advantage', surface: 'clay', pace: 'normal' };
  return new ArcadeSession({ config, players: PLAYERS, seed, controllers: [new ArcadeCpu(0, 6, seed), new ArcadeCpu(1, 9, seed)], viewer });
}

/** Index of the first drawImage from `source` in a frame's calls. */
const drawnAt = (ops: Op[], source: unknown): number => ops.findIndex((o) => o.name === 'drawImage' && o.args[0] === source);

/** A rally state with player 1's straight deep topspin coming at player 0. */
function rally(): ArcadeState {
  const { s } = matchInSetup(1);
  const hit: HitEvent = {
    tick: s.tick, player: 1, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1,
    contact: { x: 0, y: 11, z: 1 }, target: { x: 0, y: -6 }, T: 1,
  };
  s.flight = buildFlight(hit);
  s.phase = { kind: 'rally' };
  s.serveClockFrom = null;
  s.point.hits = 2;
  return s;
}

const view = (s: ArcadeState, viewer: PlayerId | 'spectator', events: ArcadeEvent[] = [], t = s.tick * DT): ArcadeView => ({
  state: s, t, events, viewer, overlay: NO_OVERLAY,
});

beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterEach(() => vi.unstubAllGlobals());

describe('ArcadeRenderer', () => {
  it('draws 120 frames of a CPU-vs-CPU match for every viewer, near player after far player', () => {
    for (const viewer of [0, 1, 'spectator'] as const) {
      const { screen, frames } = fakeScreen();
      const r = new ArcadeRenderer(screen);
      r.setLooks([LOOK_A, LOOK_B]);
      const session = cpuSession(viewer);
      let hits = 0;
      for (let i = 0; i < 120; i++) {
        const v = session.frame(100);
        hits += v.events.filter((e) => e.type === 'hit').length;
        r.draw(v, { reduceEffects: i % 2 === 0 }, 100);
      }
      expect(frames).toHaveLength(120);
      expect(hits).toBeGreaterThan(2);
      const sheets = [buildSheet(LOOK_A).canvas, buildSheet(LOOK_B).canvas];
      const near = viewer === 1 ? 1 : 0;
      for (const ops of frames) {
        const nearAt = drawnAt(ops, sheets[near]);
        const farAt = drawnAt(ops, sheets[1 - near]);
        expect(farAt).toBeGreaterThanOrEqual(0);
        expect(nearAt).toBeGreaterThan(farAt);
      }
    }
  });

  it('wears the players\' own looks until setLooks swaps them', () => {
    const s = rally();
    const { screen, frames } = fakeScreen();
    const r = new ArcadeRenderer(screen);
    r.draw(view(s, 0), { reduceEffects: false }, 16);
    const own = buildSheet(s.players[0].look).canvas;
    expect(drawnAt(frames[0]!, own)).toBeGreaterThanOrEqual(0);
    r.setLooks([LOOK_A, LOOK_B]);
    r.draw(view(s, 0), { reduceEffects: false }, 16);
    expect(drawnAt(frames[1]!, buildSheet(LOOK_A).canvas)).toBeGreaterThanOrEqual(0);
    expect(drawnAt(frames[1]!, own)).toBe(-1);
  });

  it('draws a white 12×2 charge bar for the local player in the perfect window', () => {
    const s = rally();
    s.p[0].commit = { shot: 'topspin', tick: s.tick - 33, step: null };
    const { screen, frames } = fakeScreen();
    const r = new ArcadeRenderer(screen);
    r.draw(view(s, 0), { reduceEffects: false }, 16);
    const bar = (ops: Op[], style: string): boolean => ops.some((o) => o.name === 'fillRect' && o.args[2] === 12 && o.args[3] === 2 && o.style === style);
    expect(bar(frames[0]!, '#FFFFFF')).toBe(true);
    r.draw(view(s, 'spectator'), { reduceEffects: false }, 16);
    expect(bar(frames[1]!, '#FFFFFF')).toBe(false);
  });

  it('pops PERFECT for 500 ms over the local player after their perfect hit only', () => {
    const s = rally();
    const perfect = (player: PlayerId, grade: HitEvent['grade'] = 'perfect'): ArcadeEvent => ({
      tick: s.tick, type: 'hit', kmh: 90,
      hit: { ...s.flight!.hit, player, grade, tick: s.tick },
    });
    const images = (viewer: PlayerId | 'spectator', events: ArcadeEvent[], later = 0): number => {
      const { screen, frames } = fakeScreen();
      const r = new ArcadeRenderer(screen);
      r.draw(view(s, viewer, events), { reduceEffects: true }, 0);
      if (later > 0) r.draw(view(s, viewer, [], s.tick * DT + later), { reduceEffects: true }, 0);
      return frames.at(-1)!.filter((o) => o.name === 'drawImage').length;
    };
    const base = images(0, []);
    // Seven glyphs, each with its drop shadow.
    expect(images(0, [perfect(0)]) - base).toBe(14);
    expect(images(0, [perfect(1)])).toBe(base);
    expect(images(0, [perfect(0, 'clean')])).toBe(base);
    expect(images('spectator', [perfect(0)])).toBe(images('spectator', []));
    expect(images(0, [perfect(0)], 0.49) - images(0, [], 0.49)).toBe(14);
    expect(images(0, [perfect(0)], 0.51)).toBe(images(0, [], 0.51));
  });
});

describe('chargeBar', () => {
  it('fills with the charge while the local player is committed, white in the perfect window', () => {
    const s = rally();
    expect(chargeBar(s, 0)).toBeNull();
    s.p[0].commit = { shot: 'slice', tick: s.tick - 15, step: null };
    expect(chargeBar(s, 0)?.charge).toBeCloseTo(0.5, 9);
    expect(chargeBar(s, 0)?.perfect).toBe(false);
    s.p[0].commit = { shot: 'slice', tick: s.tick - 30, step: null };
    expect(chargeBar(s, 0)).toEqual({ charge: 1, perfect: true });
    s.p[0].commit = { shot: 'slice', tick: s.tick - 40, step: null };
    expect(chargeBar(s, 0)).toEqual({ charge: 1, perfect: false });
    expect(chargeBar(s, 1)).toBeNull();
    expect(chargeBar(s, 'spectator')).toBeNull();
  });
});

describe('ballViewAt', () => {
  it('puts the ball in the server\'s hand at set-up', () => {
    const { s } = matchInSetup(1);
    const poses = [poseAt(s, 0, s.tick * DT, 0), poseAt(s, 1, s.tick * DT, 0)] as const;
    expect(ballViewAt(s, s.tick * DT, poses, 0, true)).toEqual({ kind: 'held', player: 0 });
  });

  it("keeps the ball in the server's hand after a time violation, and after the double fault it makes", () => {
    const { s } = matchInSetup(1);
    const at = (): ReturnType<typeof ballViewAt> => {
      const poses = [poseAt(s, 0, s.tick * DT, 0), poseAt(s, 1, s.tick * DT, 0)] as const;
      return ballViewAt(s, s.tick * DT, poses, 0, true);
    };
    runUntil(s, untilType('call'));
    expect(s.phase.kind).toBe('dead');
    expect(s.point.call?.call).toBe('timeViolation');
    expect(at()).toEqual({ kind: 'held', player: 0 });
    runUntil(s, untilType('point'));
    expect(s.point.call?.call).toBe('doubleFault');
    expect(at()).toEqual({ kind: 'held', player: 0 });
  });

  it('caps the drawn ball and its trail at BALL_MAX_Z', () => {
    const s = rally();
    const f = buildFlight({ ...s.flight!.hit, type: 'lob', target: { x: 0, y: -8 }, T: 2.6 });
    s.flight = f;
    const t = f.hit.tick * DT + 1.25;
    expect(flightPos(f, 1.25 - 0.032).z).toBeGreaterThan(BALL_MAX_Z + 1);
    const poses = [poseAt(s, 0, t, 0), poseAt(s, 1, t, 0)] as const;
    const ball = ballViewAt(s, t, poses, 0, true);
    if (ball?.kind !== 'air') throw new Error('no ball');
    expect(ball.pos.z).toBe(BALL_MAX_Z);
    expect(ball.trail.map((q) => q.z)).toEqual([BALL_MAX_Z, BALL_MAX_Z]);
  });

  it('flies at the flight position with a two-sample trail, then fades over 300 ms after tEnd until tGone', () => {
    const s = rally();
    // A short topspin: its second bounce (tEnd) comes inside the surround, so it rolls on to tGone.
    const f = buildFlight({ ...s.flight!.hit, target: { x: 0, y: -3 }, T: 0.9 });
    s.flight = f;
    expect(f.tGone).toBeGreaterThan(f.tEnd + 0.1);
    const t0 = f.hit.tick * DT;
    const poses = [poseAt(s, 0, t0, 0), poseAt(s, 1, t0, 0)] as const;
    const mid = ballViewAt(s, t0 + 0.5, poses, 0, true);
    expect(mid).toMatchObject({ kind: 'air', alpha: 1, hot: false });
    const near = (a: Vec3 | undefined, b: Vec3): void => {
      for (const k of ['x', 'y', 'z'] as const) expect(a?.[k]).toBeCloseTo(b[k], 9);
    };
    if (mid?.kind !== 'air') throw new Error('no ball');
    near(mid.pos, flightPos(f, 0.5));
    expect(mid.trail).toHaveLength(2);
    near(mid.trail[0], flightPos(f, 0.5 - 0.016));
    near(mid.trail[1], flightPos(f, 0.5 - 0.032));
    const plain = ballViewAt(s, t0 + 0.5, poses, 0, false);
    expect(plain?.kind === 'air' && plain.trail).toHaveLength(0);
    expect(ballViewAt(s, t0 + f.tEnd, poses, 0, true)).toMatchObject({ alpha: 1 });
    const fading = ballViewAt(s, t0 + f.tEnd + 0.1, poses, 0, true);
    expect(fading?.kind === 'air' && fading.alpha).toBeCloseTo(2 / 3, 6);
    expect(ballViewAt(s, t0 + f.tGone + 0.01, poses, 0, true)).toBeNull();
  });

  it('starts the trail at the hit, not before it', () => {
    const s = rally();
    const t0 = s.flight!.hit.tick * DT;
    const poses = [poseAt(s, 0, t0, 0), poseAt(s, 1, t0, 0)] as const;
    const early = ballViewAt(s, t0 + 0.02, poses, 0, true);
    expect(early?.kind === 'air' && early.trail).toHaveLength(1);
  });
});

describe('drawArcadeHud', () => {
  it('draws nothing for a spectator and the HUD for a player', () => {
    const s = rally();
    const ops: Op[] = [];
    const ctx = opContext({ width: 480, height: 270 }, ops);
    drawArcadeHud(ctx, view(s, 'spectator'), [], 0);
    expect(ops).toHaveLength(0);
    drawArcadeHud(ctx, { ...view(s, 0), overlay: { paused: false, countdown: 3 } }, [], 0);
    expect(ops.length).toBeGreaterThan(20);
  });
});
