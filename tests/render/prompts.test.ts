import { describe, expect, it } from 'vitest';
import { receiverSpot, serverSpot } from '../../src/core/court';
import { createScore } from '../../src/core/scoring';
import { createTurn, startTurn, turnClock, turnInput } from '../../src/core/turn';
import type {
  DisplayPrefs,
  Look,
  MatchState,
  Overlay,
  PlayerId,
  PlayerStats,
  TurnState,
  ViewModel,
  WordOption,
} from '../../src/core/types';
import { textWidth } from '../../src/render/font';
import { beltColor } from '../../src/render/hud';
import { BANDS, layoutServeNear } from '../../src/render/layout';
import { TIER_COLOR } from '../../src/render/palette';
import { PlayerAnimator, type PlayerPose } from '../../src/render/players';
import { project } from '../../src/render/projection';
import { drawPrompts, headHeight, promptScene, type PromptScene } from '../../src/render/prompts';
import { worldFrame } from '../../src/render/world';
import { CHOICE, RALLY_IN, flight, opt, returnData, serveData } from '../core/turnFixtures';

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

function matchState(turn: TurnState | null, lastTurn: TurnState | null = null): MatchState {
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
function servedBall(): { serve: TurnState; ret: TurnState } {
  const serve = tossed();
  typeWord(serve, 'ball', 2800);
  const o = serve.outcome;
  if (o?.kind !== 'strike') throw new Error('expected a serve strike');
  const ret = createTurn(returnData({ turnId: 8, incoming: o.strike.flight, chase: opt('ball'), isServeReturn: true, n: 0 }));
  startTurn(ret);
  return { serve, ret };
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

describe('promptScene', () => {
  it('lays out the local server\'s serve words at its head with markers and a timing bar', () => {
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
    const feet = project({ ...serverSpot(0, 'deuce'), z: 0 }, 0);
    const lift = headHeight(LOOK, 'near');
    expect(lift).toBeGreaterThanOrEqual(39);
    expect(lift).toBeLessThanOrEqual(44);
    expect(s.plates.map((p) => p.box)).toEqual(layoutServeNear([4, 6, 10], feet.x, Math.round(feet.y) - lift));
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

/** A 2D context stand-in that records every filled rectangle with its fill style. */
function recordingContext(): { ctx: CanvasRenderingContext2D; rects: { x: number; y: number; style: string }[] } {
  const rects: { x: number; y: number; style: string }[] = [];
  const state: Record<string, unknown> = {
    fillStyle: '#000000',
    globalAlpha: 1,
    fillRect(x: number, y: number) {
      rects.push({ x, y, style: String(state.fillStyle) });
    },
  };
  const ctx = new Proxy(state, {
    get: (t, key: string) => (key in t ? t[key] : () => undefined),
    set: (t, key: string, value) => {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, rects };
}

describe('drawPrompts', () => {
  const empty = (): PromptScene => ({ plates: [], rings: [], leaders: [], bar: null, flip: null, pops: [], tags: [] });

  it('leaves the ground rings to the depth-sorted world pass and keeps the leaders on top (R33)', () => {
    const ring = { tier: 'hard' as const, x: 200, y: 180, alpha: 1 };
    const { ctx, rects } = recordingContext();
    drawPrompts(ctx, { ...empty(), rings: [ring] });
    expect(rects).toEqual([]);
    const leader = { from: { x: 150, y: 150 }, to: { x: ring.x, y: ring.y }, tier: ring.tier, alpha: 1 };
    drawPrompts(ctx, { ...empty(), rings: [ring], leaders: [leader] });
    const alone = recordingContext();
    drawPrompts(alone.ctx, { ...empty(), leaders: [leader] });
    expect(alone.rects.filter((r) => r.style === TIER_COLOR.hard).length).toBeGreaterThan(20);
    // Exactly the leader's pixels: nothing of the ring.
    expect(rects).toEqual(alone.rects);
  });
});
