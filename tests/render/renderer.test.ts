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
  TurnState,
  ViewModel,
  WordOption,
} from '../../src/core/types';
import { ballView, BALL_MAX_Z } from '../../src/render/ball';
import { Effects } from '../../src/render/effects';
import { textWidth } from '../../src/render/font';
import { beltColor } from '../../src/render/hud';
import { BANDS } from '../../src/render/layout';
import { PlayerAnimator, type PlayerPose } from '../../src/render/players';
import { project } from '../../src/render/projection';
import { PAUSE_ICON_RECT, Renderer } from '../../src/render/renderer';
import type { Screen } from '../../src/render/screen';
import { promptScene, worldFrame, type PromptScene, type WorldFrame } from '../../src/render/world';
import { CHOICE, RALLY_IN, RALLY_OUT, flight, opt, returnData, serveData } from '../core/turnFixtures';

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
    v: 1,
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

const hidden = (o: WordOption): WordOption => ({ word: '', len: o.len, tier: o.tier, hidden: true });

/** What `redact` does to a serve turn for its opponent: words, targets and typed letters hidden. */
function redactServe(t: TurnState): TurnState {
  const c = JSON.parse(JSON.stringify(t)) as TurnState;
  if (c.data.kind === 'serve') {
    c.data.wordSets = c.data.wordSets.map((s) => ({ ...s, options: s.options.map(hidden), targets: [] }));
  }
  for (const p of c.prompts) p.options = p.options.map(hidden);
  c.log = c.log.map((e) => ('ch' in e ? { ...e, ch: '*' } : e));
  return c;
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

function scene(vm: ViewModel, prefs: DisplayPrefs = PREFS, a?: PlayerAnimator): PromptScene {
  const f = worldFrame(vm);
  const animator = a ?? new PlayerAnimator();
  const poses = animator.step(f, 16);
  return promptScene(f, poses, {
    prefs,
    looks: [vm.pub.players[0].look, vm.pub.players[1].look],
    turnStart: [animator.turnStartFeet(0), animator.turnStartFeet(1)],
    pop: false,
  });
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

describe('promptScene', () => {
  it('stacks the local server\'s serve words above its head with markers and a timing bar', () => {
    const t = tossed();
    turnClock(t, 3000);
    const vm = view(matchState(t), 3000, 0);
    const s = scene(vm);
    expect(s.plates.map((p) => [p.opt.word, p.style])).toEqual([
      ['ball', 'localActive'],
      ['volley', 'localActive'],
      ['tiebreaker', 'localActive'],
    ]);
    // A standing player is 40–45 px tall, so the head top is 39–44 px above the feet anchor row.
    const feetY = Math.round(project({ ...serverSpot(0, 'deuce'), z: 0 }, 0).y);
    const bottom = s.plates[2]!.box.y + s.plates[2]!.box.h;
    expect(bottom).toBeLessThanOrEqual(feetY - 39 - 4);
    expect(bottom).toBeGreaterThanOrEqual(feetY - 44 - 4);
    const targets = serveData().wordSets[0]!.targets;
    expect(s.rings.map((r) => [r.x, r.y])).toEqual(targets.map((p) => [project({ ...p, z: 0 }, 0).x, project({ ...p, z: 0 }, 0).y]));
    expect(s.bar).not.toBeNull();
    expect(s.bar!.grace).toBe(false);
    expect(s.bar!.frac).toBeCloseTo(1 - 400 / 4000, 6);
  });

  it('shows the opponent\'s serve as hidden plates in the far band, without markers or a timing bar', () => {
    const t = tossed();
    typeWord(t, 'vo', 2800);
    turnClock(t, 3000);
    const vm = view(matchState(redactServe(t)), 3000, 1);
    const s = scene(vm);
    expect(s.plates.map((p) => p.style)).toEqual(['hiddenRemote', 'hiddenRemote', 'hiddenRemote']);
    expect(s.plates.every((p) => p.box.y === BANDS.far[0])).toBe(true);
    expect(s.plates[1]).toMatchObject({ typed: 2, locked: true, nameChip: 'Alex', oppColor: beltColor(vm.pub.players[0]) });
    expect(s.plates[0]!.faded).toBeGreaterThan(0);
    expect(s.rings).toEqual([]);
    expect(s.bar).toBeNull();
  });

  it('shows everything in remote style to a spectator', () => {
    const t = tossed();
    turnClock(t, 3000);
    const s = scene(view(matchState(t), 3000, 'spectator'));
    expect(s.plates.map((p) => [p.opt.word, p.style])).toEqual([
      ['ball', 'remote'],
      ['volley', 'remote'],
      ['tiebreaker', 'remote'],
    ]);
    expect(s.bar).toBeNull();
  });

  it('hides every prompt while paused or counting down', () => {
    const t = tossed();
    turnClock(t, 3000);
    const pub = matchState(t);
    for (const overlay of [{ ...OVERLAY, paused: true }, { ...OVERLAY, countdown: 2 }]) {
      const s = scene(view(pub, 3000, 0, { overlay }));
      expect(s.plates).toEqual([]);
      expect(s.rings).toEqual([]);
      expect(s.bar).toBeNull();
    }
  });

  it('anchors the chase plate above the owner\'s head where it stood when the turn began', () => {
    const t = createTurn(returnData({ incoming: flight({ landing: { x: -3.5, y: 9 } }) }));
    startTurn(t);
    const a = new PlayerAnimator();
    const pre = createTurn(serveData());
    startTurn(pre);
    turnClock(pre, 2600);
    a.update(view(matchState(pre), 2600, 1), 16);
    turnInput(t, 'b', 50);
    turnClock(t, 60);
    const first = scene(view(matchState(t), 60, 1), PREFS, a);
    turnInput(t, 'a', 400);
    turnClock(t, 900);
    for (let τ = 76; τ <= 900; τ += 16) a.update(view(matchState(t), τ, 1), 16);
    const later = scene(view(matchState(t), 900, 1), PREFS, a);
    expect(first.plates).toHaveLength(1);
    expect(first.plates[0]).toMatchObject({ style: 'localActive', typed: 1, scale: 1 });
    expect(later.plates[0]!.box).toEqual(first.plates[0]!.box);
    const startX = project({ ...receiverSpot(1, 'deuce'), z: 0 }, 1).x;
    const box = first.plates[0]!.box;
    expect(Math.abs(box.x + (box.w - 1) / 2 - startX)).toBeLessThanOrEqual(1);
    const large = scene(view(matchState(t), 900, 1), { ...PREFS, largeWords: true }, a);
    expect(large.plates[0]).toMatchObject({ scale: 2 });
  });

  it('lays the choice out in the band of the targeted half with rings and leaders, then fades the others after the lock', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const s = scene(view(matchState(t), 500, 1));
    expect(s.plates.map((p) => [p.opt.word, p.style, p.box.y])).toEqual(
      CHOICE.map((w) => [w, 'localActive', BANDS.far[0]]),
    );
    const targets = returnData().choice.targets.map((p) => project({ ...p, z: 0 }, 1));
    expect(s.rings.map((r) => [r.x, r.y])).toEqual(targets.map((p) => [p.x, p.y]));
    expect(s.leaders).toHaveLength(3);
    s.leaders.forEach((l, i) => {
      const box = s.plates[i]!.box;
      expect(l.to).toEqual({ x: targets[i]!.x, y: targets[i]!.y });
      expect(l.from.y).toBe(box.y + box.h);
      expect(l.from.x).toBeGreaterThanOrEqual(box.x);
      expect(l.from.x).toBeLessThan(box.x + box.w);
    });
    const row = s.plates.map((p) => p.box);
    expect(s.bar).toMatchObject({ x: Math.min(...row.map((b) => b.x)) });

    turnInput(t, 'v', 600);
    turnClock(t, 700);
    const locked = scene(view(matchState(t), 700, 1));
    expect(locked.plates.find((p) => p.opt.word === 'volley')).toMatchObject({ locked: true, faded: 0, typed: 1 });
    const other = locked.plates.find((p) => p.opt.word === 'drop')!;
    expect(other.faded).toBeGreaterThan(0);
    expect(other.faded).toBeLessThan(1);
    const box = locked.plates.find((p) => p.opt.word === 'volley')!.box;
    expect(locked.bar).toMatchObject({ x: box.x, w: box.w });
  });

  it('puts the choice in the near band when the targets are on the viewer\'s half', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const s = scene(view(matchState(t), 500, 0));
    expect(s.plates.every((p) => p.box.y > 130)).toBe(true);
    expect(s.plates.every((p) => p.style === 'remote')).toBe(true);
    // One chip per prompt: on the easy (centre) plate until a lock, then on the locked plate.
    expect(s.plates.map((p) => p.nameChip)).toEqual(['Kai', null, null]);
    expect(s.plates[0]!.oppColor).toBe(beltColor(matchState(null).players[1]));
    turnInput(t, 'c', 600);
    turnClock(t, 650);
    const locked = scene(view(matchState(t), 650, 0));
    expect(locked.plates.map((p) => p.nameChip)).toEqual([null, null, 'Kai']);
    expect(s.bar).toBeNull();
  });

  it('turns the timing bar into the grace checker after the contact time', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, RALLY_IN.T + 100);
    const s = scene(view(matchState(t), RALLY_IN.T + 100, 1));
    expect(s.bar?.grace).toBe(true);
    expect(s.bar?.frac).toBeCloseTo(0.75, 6);
  });

  it('flips the opponent\'s hidden serve plate over to reveal the struck word as the return turn begins', () => {
    const { serve, ret } = servedBall();
    const pub = (τ: number): ViewModel => view(matchState(ret, redactServe(serve)), τ, 1);
    const start = scene(pub(0));
    expect(start.flip).toMatchObject({ step: 0 });
    expect(start.flip!.revealed).toMatchObject({ opt: { word: 'ball' }, style: 'remote', typed: 4 });
    expect(start.flip!.hidden).toMatchObject({ style: 'hiddenRemote', typed: 4 });
    expect(scene(pub(120)).flip?.step).toBe(2);
    const after = scene(pub(300));
    expect(after.flip).toBeNull();
    expect(after.plates.map((p) => [p.opt.word, p.style])).toContainEqual(['ball', 'remote']);
    expect(scene(view(matchState(ret, serve), 0, 'spectator')).flip).toBeNull();
  });

  it('labels the first choice row "type a first letter" under the row, clear of the far player', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const vm = view(matchState(t), 500, 1, { overlay: { ...OVERLAY, hintFirstLetter: true } });
    const f = worldFrame(vm);
    const labelW = textWidth('TYPE A FIRST LETTER') + 8;
    for (const x of [-5.5, -3, -1.5, 0, 1.5, 3, 5.5]) {
      const far: PlayerPose = { feet: { x, y: -12.2 }, anim: 'idle', frame: 0, view: 'far', flip: false };
      const near: PlayerPose = { feet: receiverSpot(1, 'deuce'), anim: 'idle', frame: 0, view: 'near', flip: false };
      const s = promptScene(f, [far, near], {
        prefs: PREFS,
        looks: [vm.pub.players[0].look, vm.pub.players[1].look],
        turnStart: [far.feet, near.feet],
        pop: false,
      });
      const hint = s.tags.find((g) => g.kind === 'hint');
      expect(hint).toBeDefined();
      expect(hint!.y).toBeGreaterThanOrEqual(s.bar!.y + 2);
      const left = Math.round(hint!.x - labelW / 2);
      const farX = project({ ...far.feet, z: 0 }, 1).x;
      expect(left + labelW <= farX - 12 || left >= farX + 12).toBe(true);
      expect(left).toBeGreaterThanOrEqual(4);
      expect(left + labelW).toBeLessThanOrEqual(476);
    }
    const locked = createTurn(returnData());
    startTurn(locked);
    typeWord(locked, 'ball', 100);
    turnInput(locked, 'd', 600);
    turnClock(locked, 650);
    const after = scene(view(matchState(locked), 650, 1, { overlay: { ...OVERLAY, hintFirstLetter: true } }));
    expect(after.tags.some((g) => g.kind === 'hint')).toBe(false);
  });

  it('tags the viewer\'s player with WAIT and the server with a SPACE keycap hint', () => {
    const t = createTurn(serveData());
    startTurn(t);
    turnClock(t, 2700);
    const s = scene(view(matchState(t), 2700, 0, { overlay: { ...OVERLAY, wait: true, hintSpace: true } }));
    expect(s.tags.map((g) => g.kind).sort()).toEqual(['space', 'wait']);
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
