import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receiverSpot, serverSpot } from '../../src/core/court';
import { createScore } from '../../src/core/scoring';
import { ballAt, tossZ } from '../../src/core/trajectory';
import { createTurn, startTurn, turnClock, turnInput } from '../../src/core/turn';
import type {
  BallFlight,
  DisplayPrefs,
  GameEvent,
  Look,
  MatchState,
  Overlay,
  PlayerId,
  PlayerStats,
  Tier,
  TurnState,
  Vec2,
  ViewModel,
} from '../../src/core/types';
import { ballView, BALL_MAX_Z } from '../../src/render/ball';
import { Effects } from '../../src/render/effects';
import { TIER_COLOR } from '../../src/render/palette';
import { PlayerAnimator, type PlayerPose } from '../../src/render/players';
import { project } from '../../src/render/projection';
import type { LeaderMark, RingMark } from '../../src/render/prompts';
import { PAUSE_ICON_RECT, Renderer } from '../../src/render/renderer';
import type { Screen } from '../../src/render/screen';
import type { SpriteSheet } from '../../src/render/sprites/sheet';
import { drawWorld, worldFrame, type WorldFrame } from '../../src/render/world';
import { INSANE_WORD, RALLY_IN, RALLY_OUT, opt, returnData, serveData } from '../core/turnFixtures';

const LOOK: Look = { skin: 1, hairStyle: 2, hair: 3, shirt: 6, shorts: 7, headband: 5, racket: 2 };
const STATS: PlayerStats = {
  pointsWon: 0, aces: 0, doubleFaults: 0, winners: 0, errors: 0, wordsCompleted: 0,
  intervalSum: 0, typingMs: 0, topWpm: 0, correctKeys: 0, wrongKeys: 0, fastestServeKmh: 0,
};
const PREFS: DisplayPrefs = { largeWords: false, reduceEffects: false, showWpm: true };
const OVERLAY: Overlay = {
  paused: false, countdown: null, coach: null, wait: false, unstable: false,
  hintSpace: false, hintFirstLetter: false, focusLost: false, rttMs: null,
};

function matchState(turn: TurnState | null, lastTurn: TurnState | null = null, over: Partial<MatchState> = {}): MatchState {
  return {
    v: 2,
    config: { format: 'short', pace: 'normal', surface: 'clay', wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: [
      { name: 'Alex', look: LOOK, kind: 'human', cpuLevel: null },
      { name: 'Kai', look: { ...LOOK, hairStyle: 4, headband: null }, kind: 'cpu', cpuLevel: 9 },
    ],
    score: createScore('short', 'advantage', 0),
    stats: [{ ...STATS }, { ...STATS }],
    turn,
    lastTurn,
    rallyStrikes: 1,
    longestRally: 0,
    power: [0, 0],
    pointNo: 1,
    status: 'playing',
    winner: null,
    forfeitBy: null,
    nextTurnId: 20,
    nextPromptBase: 100,
    rng: null,
    picker: null,
    ...over,
  };
}

function view(
  pub: MatchState,
  turnτ: number,
  viewer: PlayerId | 'spectator' = 0,
  over: Partial<ViewModel> = {},
): ViewModel {
  return { pub, viewer, turnτ, liveTurn: null, events: [], overlay: OVERLAY, ...over };
}

function typeWord(t: TurnState, word: string, from: number, gap = 100): number {
  [...word].forEach((ch, i) => turnInput(t, ch, from + i * gap));
  return from + (word.length - 1) * gap;
}

/** Serve turn of player 0 at the deuce side, tossed at 2600. */
function tossed(): TurnState {
  const t = createTurn(serveData());
  startTurn(t);
  turnInput(t, 'toss', 2600);
  return t;
}

/** A serve struck with 'ball' at 3100 and the return turn of player 1 it starts. */
function servedBall(): { serve: TurnState; ret: TurnState; flight: BallFlight } {
  const serve = tossed();
  typeWord(serve, 'ball', 2800);
  const o = serve.outcome;
  if (o?.kind !== 'strike') throw new Error('expected a serve strike');
  const ret = createTurn(returnData({ turnId: 8, incoming: o.strike.flight, chase: opt('ball'), isServeReturn: true, n: 0 }));
  startTurn(ret);
  return { serve, ret, flight: o.strike.flight };
}

/** Animator poses for `vm` after a PRE_SERVE frame put everyone on their spots. */
function posesFor(vm: ViewModel): [PlayerPose, PlayerPose] {
  const a = new PlayerAnimator();
  const pre = createTurn(serveData());
  startTurn(pre);
  turnClock(pre, 2600);
  a.update(view(matchState(pre), 2600, vm.viewer), 16);
  return a.update(vm, 16);
}

describe('worldFrame', () => {
  it('draws the viewer\'s live turn at its own τ when there is one, else the public turn at turnτ', () => {
    const live = createTurn(returnData());
    startTurn(live);
    turnClock(live, 1234);
    const pubTurn = createTurn(returnData());
    startTurn(pubTurn);
    const withLive = worldFrame(view(matchState(pubTurn), 50, 1, { liveTurn: live }));
    expect(withLive.turn).toBe(live);
    expect(withLive.τ).toBe(1234);
    expect(withLive.view?.τ).toBe(1234);
    const plain = worldFrame(view(matchState(pubTurn), 50, 1));
    expect(plain.turn).toBe(pubTurn);
    expect(plain.τ).toBe(50);
  });

  it('continues the previous turn past its end by the current turn\'s τ', () => {
    const out = createTurn(returnData({ incoming: RALLY_OUT }));
    startTurn(out);
    turnClock(out, 5000);
    const next = createTurn(serveData({ leadIn: { kind: 'point', ms: 2000, text: ['OUT'] } }));
    startTurn(next);
    const f = worldFrame(view(matchState(next, out), 250));
    expect(f.last?.view.τ).toBe(RALLY_OUT.callT! + 250);
    expect(f.near).toBe(0);
    expect(f.local).toBe(0);
    expect(worldFrame(view(matchState(next, out), 250, 'spectator')).local).toBeNull();
  });
});

describe('drawWorld', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
  afterEach(() => vi.unstubAllGlobals());

  /** Paints the world for viewer 0 with player 0 (near) and player 1 (far) standing at `feet`, `rings` on the ground and `leaders`. */
  function paint(feet: [Vec2, Vec2], rings: RingMark[], leaders: LeaderMark[] = []): { ops: Op[]; sheets: [SpriteSheet, SpriteSheet] } {
    const t = createTurn(serveData());
    startTurn(t);
    turnClock(t, 2600);
    const f = worldFrame(view(matchState(t), 2600, 0));
    const sheet = (): SpriteSheet => ({ canvas: new FakeCanvas(48, 48) as unknown as OffscreenCanvas, frame: () => ({ sx: 0, sy: 0 }) });
    const sheets: [SpriteSheet, SpriteSheet] = [sheet(), sheet()];
    const pose = (p: PlayerId): PlayerPose => ({ feet: feet[p], anim: 'idle', frame: 0, view: p === 0 ? 'near' : 'far', flip: false });
    const { ctx, ops } = opLog();
    drawWorld(ctx, f, { poses: [pose(0), pose(1)], ball: null, rings, leaders, sheets, effects: new Effects(), clockMs: 0, hotTrail: true });
    return { ops, sheets };
  }

  /** Index of the first pixel of `ring` painted in its tier colour, or -1. */
  const firstRingPixel = (ops: Op[], ring: RingMark): number =>
    ops.findIndex(
      (o) =>
        o.name === 'fillRect' && o.style === TIER_COLOR[ring.tier] &&
        Math.abs(Number(o.args[0]) - ring.x) <= 7 && Math.abs(Number(o.args[1]) - ring.y) <= 4,
    );

  const spriteOf = (ops: Op[], sheet: SpriteSheet): number => ops.findIndex((o) => o.name === 'drawImage' && o.args[0] === sheet.canvas);

  it('lets a player whose feet are nearer the camera occlude a ground ring behind them (R33)', () => {
    const near = serverSpot(0, 'deuce');
    const far = receiverSpot(1, 'deuce');
    const at = (p: Vec2, tier: Tier): RingMark => ({ tier, ...project({ ...p, z: 0 }, 0), alpha: 1 });
    // 2 m in front of the near player (toward the net), inside the sprite's 48 px cell on screen.
    const front = at({ x: near.x, y: near.y + 2 }, 'hard');
    const feetY = project({ ...near, z: 0 }, 0).y;
    expect(feetY - front.y).toBeGreaterThan(10);
    expect(feetY - front.y).toBeLessThan(40);
    // 1 m behind the near player, nearer the camera: drawn over the player.
    const behind = at({ x: near.x, y: near.y - 1 }, 'easy');
    const { ops, sheets } = paint([near, far], [front, behind]);
    const nearSprite = spriteOf(ops, sheets[0]);
    const farSprite = spriteOf(ops, sheets[1]);
    expect(nearSprite).toBeGreaterThan(-1);
    expect(farSprite).toBeGreaterThan(-1);
    expect(firstRingPixel(ops, front)).toBeGreaterThan(-1);
    expect(firstRingPixel(ops, front)).toBeLessThan(nearSprite);
    expect(firstRingPixel(ops, front)).toBeGreaterThan(farSprite);
    expect(firstRingPixel(ops, behind)).toBeGreaterThan(nearSprite);
  });

  it('draws the leaders before the players, so a player standing on a leader occludes it (R42)', () => {
    const near = serverSpot(0, 'deuce');
    const far = receiverSpot(1, 'deuce');
    const feet = project({ ...far, z: 0 }, 0);
    // From the far prompt band straight down through the far player to a ring 3 m inside the baseline.
    const ring = project({ x: far.x, y: far.y + 3, z: 0 }, 0);
    const leader: LeaderMark = { points: [{ x: feet.x, y: 38 }, { x: ring.x, y: ring.y }], tier: 'easy', alpha: 1 };
    const faded: LeaderMark = { ...leader, points: [{ x: feet.x + 60, y: 38 }, { x: ring.x + 60, y: ring.y }], alpha: 0 };
    const { ops, sheets } = paint([near, far], [], [leader, faded]);
    const leaderPixels = ops.filter((o) => o.name === 'fillRect' && o.style === TIER_COLOR.easy);
    expect(leaderPixels.length).toBeGreaterThan(20);
    // Only the shown leader: the faded one, 60 px to the right, is skipped.
    const [left, right] = [Math.min(feet.x, ring.x) - 1, Math.max(feet.x, ring.x) + 1];
    expect(leaderPixels.every((o) => Number(o.args[0]) >= left && Number(o.args[0]) <= right && o.alpha === 1)).toBe(true);
    const lastLeaderPixel = ops.lastIndexOf(leaderPixels.at(-1)!);
    expect(lastLeaderPixel).toBeLessThan(spriteOf(ops, sheets[1]));
    expect(lastLeaderPixel).toBeLessThan(spriteOf(ops, sheets[0]));
  });

  it('skips fully faded rings and paints the others at their opacity', () => {
    const near = serverSpot(0, 'deuce');
    const ring = (x: number, alpha: number): RingMark => ({ tier: 'medium', ...project({ x, y: 3, z: 0 }, 0), alpha });
    const shown = ring(-2, 0.5);
    const gone = ring(2, 0);
    const { ops } = paint([near, receiverSpot(1, 'deuce')], [shown, gone]);
    const i = firstRingPixel(ops, shown);
    expect(i).toBeGreaterThan(-1);
    expect(ops[i]!.alpha).toBe(0.5);
    expect(firstRingPixel(ops, gone)).toBe(-1);
  });
});

describe('ballView', () => {
  it('follows the incoming flight of a return turn', () => {
    const t = createTurn(returnData());
    startTurn(t);
    turnClock(t, 700);
    const f = worldFrame(view(matchState(t), 700));
    const b = ballView(f, posesFor(view(matchState(t), 700)));
    expect(b).toMatchObject({ kind: 'air', alpha: 1 });
    if (b?.kind !== 'air') throw new Error('air ball expected');
    expect(b.pos).toEqual(ballAt(RALLY_IN, 700));
    expect(b.trail.length).toBeGreaterThan(0);
  });

  it('caps the drawn height at 6 m', () => {
    const high: BallFlight = { ...RALLY_IN, h: 12 };
    const t = createTurn(returnData({ incoming: high }));
    startTurn(t);
    turnClock(t, 900);
    const b = ballView(worldFrame(view(matchState(t), 900)), posesFor(view(matchState(t), 900)));
    if (b?.kind !== 'air') throw new Error('air ball expected');
    expect(ballAt(high, 900).z).toBeGreaterThan(BALL_MAX_Z);
    expect(b.pos.z).toBe(BALL_MAX_Z);
  });

  it('fades an OUT ball out over 300 ms after its call, through the next lead-in', () => {
    const out = createTurn(returnData({ incoming: RALLY_OUT }));
    startTurn(out);
    turnClock(out, 5000);
    const next = createTurn(serveData({ leadIn: { kind: 'point', ms: 2000, text: ['OUT'] } }));
    startTurn(next);
    const at = (τ: number): ReturnType<typeof ballView> => {
      const vm = view(matchState(next, out), τ);
      return ballView(worldFrame(vm), posesFor(vm));
    };
    const b = at(150);
    if (b?.kind !== 'air') throw new Error('air ball expected');
    expect(b.alpha).toBeCloseTo(0.5, 6);
    expect(b.pos).toEqual(ballAt(RALLY_OUT, RALLY_OUT.callT! + 150));
    expect(at(300)).toBeNull();
    expect(at(1500)).toBeNull();
  });

  it('keeps the ball in the server\'s hand before the toss and on the toss arc after it', () => {
    const t = tossed();
    const preVm = view(matchState(t), 2550);
    expect(ballView(worldFrame(preVm), posesFor(preVm))).toEqual({ kind: 'held', player: 0 });
    turnClock(t, 3600);
    const vm = view(matchState(t), 3600);
    const b = ballView(worldFrame(vm), posesFor(vm));
    if (b?.kind !== 'air') throw new Error('air ball expected');
    expect(b.pos.z).toBeCloseTo(tossZ(1000, 2000), 9);
    expect(b.pos.y).toBeCloseTo(serverSpot(0, 'deuce').y, 9);
    expect(Math.abs(b.pos.x - serverSpot(0, 'deuce').x)).toBeLessThan(0.5);
  });

  it('holds the ball for the first serve of the match during the intro', () => {
    const t = createTurn(serveData());
    startTurn(t);
    const vm = view(matchState(t), 500);
    expect(ballView(worldFrame(vm), posesFor(vm))).toEqual({ kind: 'held', player: 0 });
  });

  it('starts the served ball from the strike point when the return turn begins', () => {
    const { serve, ret, flight: f } = servedBall();
    const vm = view(matchState(ret, serve), 0, 1);
    const b = ballView(worldFrame(vm), posesFor(vm));
    if (b?.kind !== 'air') throw new Error('air ball expected');
    expect(b.pos).toEqual(ballAt(f, 0));
  });

  it('switches to the outgoing flight once the receiver strikes', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    typeWord(t, 'drop', 600);
    turnClock(t, RALLY_IN.T + 150);
    const o = t.outcome;
    if (o?.kind !== 'strike') throw new Error('expected a strike');
    const vm = view(matchState(t), RALLY_IN.T + 150);
    const b = ballView(worldFrame(vm), posesFor(vm));
    if (b?.kind !== 'air') throw new Error('air ball expected');
    expect(b.pos).toEqual(ballAt(o.strike.flight, 150));
  });
});

describe('Effects', () => {
  const pointEvent = (reason: 'ace' | 'winner' | 'out'): GameEvent => ({ turn: 9, τ: 0, type: 'point', winner: 0, reason });

  function frameWith(events: GameEvent[], over: Partial<MatchState> = {}): WorldFrame {
    const t = createTurn(serveData());
    startTurn(t);
    return worldFrame(view(matchState(t, null, over), 100, 0, { events }));
  }

  it('shakes the screen by up to 2 px on an ACE or WINNER only, never with reduce effects', () => {
    const poses = posesFor(view(matchState(createTurn(serveData())), 0));
    for (const reason of ['ace', 'winner'] as const) {
      const fx = new Effects();
      fx.update(frameWith([pointEvent(reason)]), poses, 16, false);
      const s = fx.shake();
      expect(Math.max(Math.abs(s.x), Math.abs(s.y))).toBe(2);
      for (let i = 0; i < 40; i++) fx.update(frameWith([]), poses, 16, false);
      expect(fx.shake()).toEqual({ x: 0, y: 0 });
      const calm = new Effects();
      calm.update(frameWith([pointEvent(reason)]), poses, 16, true);
      expect(calm.shake()).toEqual({ x: 0, y: 0 });
    }
    const out = new Effects();
    out.update(frameWith([pointEvent('out')]), poses, 16, false);
    expect(out.shake()).toEqual({ x: 0, y: 0 });
  });

  it('cheers points and leaves clay marks until the next point', () => {
    const poses = posesFor(view(matchState(createTurn(serveData())), 0));
    const fx = new Effects();
    const before = fx.crowdExcite;
    fx.update(frameWith([{ turn: 8, τ: 1800, type: 'bounce', at: { x: 1, y: 9 }, inCourt: true }]), poses, 16, false);
    expect(fx.clayMarks).toEqual([{ x: 1, y: 9 }]);
    fx.update(frameWith([pointEvent('winner')]), poses, 16, false);
    expect(fx.crowdExcite).toBeGreaterThan(before);
    fx.update(frameWith([], { pointNo: 2 }), poses, 16, false);
    expect(fx.clayMarks).toEqual([]);
  });

  it('cheers the strike that returns an insane shot, and no other strike (choice-stack spec §4)', () => {
    const poses = posesFor(view(matchState(createTurn(serveData())), 0));
    const strikeIn = (turn: number): GameEvent => ({
      turn, τ: 0, type: 'strike', player: 1, word: 'drop', tier: 'easy', kmh: 100, isServe: false, stretch: false, forehand: true,
    });
    for (const [chase, cheers] of [[INSANE_WORD, true], ['volley', false]] as const) {
      const t = createTurn(returnData({ chase: opt(chase) }));
      const fx = new Effects();
      fx.update(worldFrame(view(matchState(t), 0, 0, { events: [strikeIn(8)] })), poses, 16, false);
      if (cheers) expect(fx.crowdExcite, chase).toBeGreaterThanOrEqual(0.69);
      else expect(fx.crowdExcite, chase).toBe(0);
    }
  });

  it('throws confetti when the match is won', () => {
    const poses = posesFor(view(matchState(createTurn(serveData())), 0));
    const fx = new Effects();
    expect(fx.confetti).toBe(0);
    fx.update(frameWith([{ turn: 9, τ: 0, type: 'match', winner: 0 }]), poses, 16, false);
    expect(fx.confetti).toBeGreaterThan(20);
  });
});

/** A 2D context stand-in that accepts every call and records what was drawn. */
function fakeContext(canvas: { width: number; height: number }): CanvasRenderingContext2D {
  const calls: string[] = [];
  const target: Record<string, unknown> = {
    canvas,
    calls,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  };
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      return (...args: unknown[]) => {
        calls.push(key);
        void args;
      };
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** One recorded context call: its name, arguments, and the fill style and opacity at the time. */
interface Op { name: string; args: unknown[]; style: string; alpha: number }

/** A 2D context stand-in that records every call in order, with the fill style and alpha it ran under. */
function opLog(): { ctx: CanvasRenderingContext2D; ops: Op[] } {
  const ops: Op[] = [];
  const state: Record<string, unknown> = { fillStyle: '#000000', globalAlpha: 1, canvas: { width: 480, height: 270 } };
  const stack: Record<string, unknown>[] = [];
  const ctx = new Proxy(state, {
    get(t, key: string) {
      if (key in t) return t[key];
      return (...args: unknown[]) => {
        if (key === 'save') stack.push({ fillStyle: t.fillStyle, globalAlpha: t.globalAlpha });
        if (key === 'restore') Object.assign(t, stack.pop() ?? {});
        ops.push({ name: key, args, style: String(t.fillStyle), alpha: Number(t.globalAlpha) });
      };
    },
    set(t, key: string, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}

class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext(): CanvasRenderingContext2D {
    return fakeContext(this);
  }
}

describe('Renderer', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
  afterEach(() => vi.unstubAllGlobals());

  function fakeScreen(): { screen: Screen; present: ReturnType<typeof vi.fn>; calls: string[] } {
    const buf = fakeContext(new FakeCanvas(480, 270));
    const present = vi.fn();
    const screen = { buf, present } as unknown as Screen;
    return { screen, present, calls: (buf as unknown as { calls: string[] }).calls };
  }

  it('re-exports the pause icon rectangle', () => {
    expect(PAUSE_ICON_RECT.w).toBeGreaterThan(0);
  });

  it('composes and presents one frame per draw across serve, rally, point and match end, for every viewer', () => {
    const { serve, ret } = servedBall();
    typeWord(ret, 'ball', 200);
    turnClock(ret, 900);
    const out = createTurn(returnData({ incoming: RALLY_OUT }));
    startTurn(out);
    turnClock(out, 5000);
    const lead = createTurn(serveData({ leadIn: { kind: 'point', ms: 2000, text: ['OUT', 'GAME ALEX'] } }));
    startTurn(lead);
    const frames: ViewModel[] = [
      view(matchState(serve), 1000),
      view(matchState(serve), 3000, 1),
      view(matchState(ret, serve), 0, 1, { events: [{ turn: 7, τ: 3100, type: 'strike', player: 0, word: 'ball', tier: 'easy', kmh: 150, isServe: true, stretch: false, forehand: true }] }),
      view(matchState(ret, serve), 900, 0),
      view(matchState(lead, out), 300, 'spectator', { events: [{ turn: 8, τ: 1800, type: 'point', winner: 0, reason: 'winner' }] }),
      view(matchState(lead, out), 2600, 0, { overlay: { ...OVERLAY, paused: true, unstable: true, rttMs: 48, coach: 'Press SPACE to toss the ball' } }),
      view(matchState(lead, out), 2700, 0, { overlay: { ...OVERLAY, countdown: 3, focusLost: true } }),
      view(matchState(null, out, { status: 'over', winner: 0 }), 0, 0, { events: [{ turn: 8, τ: 1800, type: 'match', winner: 0 }] }),
    ];
    for (const surface of ['hard', 'clay', 'grass', 'dojo'] as const) {
      const { screen, present, calls } = fakeScreen();
      const r = new Renderer(screen);
      frames.forEach((vm, i) => {
        const pub = { ...vm.pub, config: { ...vm.pub.config, surface } };
        r.draw({ ...vm, pub }, { ...PREFS, reduceEffects: i % 2 === 0, largeWords: i % 3 === 0 }, 16);
        expect(present).toHaveBeenCalledTimes(i + 1);
      });
      expect(calls.filter((c) => c === 'drawImage').length).toBeGreaterThan(frames.length * 4);
    }
  });

  it('uses setLooks over the players\' own looks', () => {
    const { screen, present } = fakeScreen();
    const r = new Renderer(screen);
    r.setLooks([{ ...LOOK, shirt: 1 }, { ...LOOK, shirt: 2 }]);
    const t = createTurn(serveData());
    startTurn(t);
    r.draw(view(matchState(t), 100), PREFS, 16);
    expect(present).toHaveBeenCalledTimes(1);
  });
});
