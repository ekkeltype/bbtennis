import { describe, expect, it } from 'vitest';
import { rallyTargets, receiverSpot, serverSpot } from '../../src/core/court';
import { createScore } from '../../src/core/scoring';
import { stanceFor } from '../../src/core/trajectory';
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
import { clamp } from '../../src/core/util';
import { textWidth } from '../../src/render/font';
import { beltColor } from '../../src/render/hud';
import { BANDS, layoutServeFar, layoutServeNear } from '../../src/render/layout';
import type { PlateDraw } from '../../src/render/plates';
import { PlayerAnimator, type PlayerPose } from '../../src/render/players';
import { project } from '../../src/render/projection';
import { drawPrompts, headHeight, promptScene, type PromptScene } from '../../src/render/prompts';
import { worldFrame } from '../../src/render/world';
import { CHOICE, CHOICE_4, INSANE_WORD, RALLY_IN, flight, opt, returnData, serveData } from '../core/turnFixtures';

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
  };
}

function view(
  pub: MatchState,
  turnτ: number,
  viewer: PlayerId | 'spectator' = 0,
  over: Partial<ViewModel> = {},
): ViewModel {
  return { pub, viewer, turnτ, liveTurn: null, early: null, events: [], overlay: OVERLAY, ...over };
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

  it("redraws the local server's locked word at 2× away from the toss column with Large words, the timing bar under it", () => {
    const t = tossed();
    typeWord(t, 'vo', 2800);
    turnClock(t, 3000);
    const s = scene(view(matchState(t), 3000, 0), { ...PREFS, largeWords: true });
    const feet = project({ ...serverSpot(0, 'deuce'), z: 0 }, 0);
    const want = layoutServeNear([4, 6, 10], feet.x, Math.round(feet.y) - headHeight(LOOK, 'near'), 1);
    expect(s.plates.map((p) => [p.opt.word, p.box, p.scale])).toEqual([
      ['ball', want[0], 1],
      ['volley', want[1], 2],
      ['tiebreaker', want[2], 1],
    ]);
    expect(s.bar).toMatchObject({ x: want[1]!.x, y: want[1]!.y + 32 + 2, w: want[1]!.w });
  });

  it("redraws the opponent's locked hidden serve word at 2× away from the toss gap with Large words, and flips it over in that box", () => {
    const { serve, ret } = servedBall();
    const large = { ...PREFS, largeWords: true };
    const feetX = project({ ...serverSpot(0, 'deuce'), z: 0 }, 1).x;
    const want = layoutServeFar([4, 6, 10], feetX, 0);
    // 'bal' typed, the strike 100 ms away.
    const toss = scene(view(matchState(redactServe(serve)), 3050, 1), large);
    const hiddenPlates = want.map((b, i) => ['hiddenRemote', b, i === 0 ? 2 : 1]);
    expect(toss.plates.map((p) => [p.style, p.box, p.scale])).toEqual(hiddenPlates);
    const flip = scene(view(matchState(ret, redactServe(serve)), 0, 1), large).flip;
    expect(flip?.hidden).toMatchObject({ box: want[0], scale: 2 });
    expect(flip?.revealed).toMatchObject({ box: want[0], scale: 2, opt: { word: 'ball' } });
    const held = scene(view(matchState(ret, redactServe(serve)), 300, 1), large).plates.find((p) => p.opt.word === 'ball');
    expect(held).toMatchObject({ box: want[0], scale: 2, style: 'remote' });
    const small = scene(view(matchState(ret, redactServe(serve)), 0, 1)).flip?.revealed;
    expect(small).toMatchObject({ box: layoutServeFar([4, 6, 10], feetX)[0], scale: 1 });
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

  it('stacks the near typist\'s choice beside the spot they will hit from, easy on top, side leaders to the rings (choice-stack spec §2–3)', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const a = new PlayerAnimator();
    scene(view(matchState(t), 350, 1), PREFS, a);
    const s = scene(view(matchState(t), 500, 1), PREFS, a);
    expect(s.plates.map((p) => [p.opt.word, p.style])).toEqual(CHOICE.map((w) => [w, 'localActive']));
    const stack = s.plates.map((p) => p.box);
    stack.slice(1).forEach((b, i) => expect(b.y).toBe(stack[i]!.y + 16 + 3));
    // The hitting spot is where the chase runs the player to (stanceFor); the stack's bottom is level
    // with the head top there, its widest plate 25 px to the court-centre side of the feet.
    const spot = stanceFor(returnData().incoming.contact, 1, a.turnStartFeet(1)).feet;
    const feet = project({ ...spot, z: 0 }, 1);
    const headTop = Math.round(feet.y) - headHeight(matchState(t).players[1].look, 'near');
    const bottom = stack.at(-1)!;
    expect(bottom.y + bottom.h).toBe(headTop);
    const feetX = Math.round(feet.x);
    if (feetX <= 240) expect(bottom.x).toBe(feetX + 25);
    else expect(bottom.x + bottom.w - 1).toBe(feetX - 25);
    const column = bottom.x + (bottom.w - 1) / 2;
    for (const b of stack) expect(b.x + (b.w - 1) / 2).toBe(column);

    const targets = returnData().choice.targets.map((p) => project({ ...p, z: 0 }, 1));
    expect(s.rings.map((r) => [r.x, r.y])).toEqual(targets.map((p) => [p.x, p.y]));
    const sides = s.leaders.map((l, i) => {
      const b = stack[i]!;
      const from = l.points[0]!;
      expect(from.y).toBe(b.y + 8);
      expect([b.x - 2, b.x + b.w + 1]).toContain(from.x);
      expect(l.points.at(-1)).toEqual({ x: Math.round(targets[i]!.x), y: Math.round(targets[i]!.y) });
      return from.x < b.x ? 'left' : 'right';
    });
    const mediumLeft = targets[1]!.x < targets[2]!.x;
    expect(sides[1]).toBe(mediumLeft ? 'left' : 'right');
    expect(sides[2]).toBe(mediumLeft ? 'right' : 'left');
    expect(s.bar).toMatchObject({ x: Math.min(...stack.map((b) => b.x)), y: bottom.y + bottom.h + 2 });

    turnInput(t, 'v', 600);
    turnClock(t, 700);
    const locked = scene(view(matchState(t), 700, 1), PREFS, a);
    const volley = locked.plates.find((p) => p.opt.word === 'volley')!;
    expect(volley).toMatchObject({ locked: true, faded: 0, typed: 1 });
    expect(volley.box).toEqual(stack[1]);
    const other = locked.plates.find((p) => p.opt.word === 'drop')!;
    expect(other.faded).toBeGreaterThan(0);
    expect(other.faded).toBeLessThan(1);
    expect(locked.bar).toMatchObject({ x: volley.box.x, w: volley.box.w, y: volley.box.y + volley.box.h + 2 });
  });

  it('stacks player 0\'s choice for a spectator too: remote plates, the name chip on the top plate', () => {
    const t = createTurn(returnData({ owner: 0, striker: 1, choice: { options: CHOICE.map(opt), targets: rallyTargets(1, 1), m: 1 } }));
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const s = scene(view(matchState(t), 500, 'spectator'));
    expect(s.plates.map((p) => p.style)).toEqual(['remote', 'remote', 'remote']);
    expect(s.plates.map((p) => p.nameChip)).toEqual(['Alex', null, null]);
    const ys = s.plates.map((p) => p.box.y);
    expect(ys).toEqual([ys[0]!, ys[0]! + 19, ys[0]! + 38]);
    s.leaders.forEach((l, i) => {
      const b = s.plates[i]!.box;
      expect([b.x - 2, b.x + b.w + 1]).toContain(l.points[0]!.x);
    });
    expect(s.bar).toBeNull();
  });

  it('fades the unchosen options with their rings and leaders out fully within 200 ms of the lock', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnInput(t, 'v', 600);
    turnClock(t, 800);
    for (const τ of [800, 1000]) {
      const s = scene(view(matchState(t), τ, 1));
      const shown = s.plates.filter((p) => p.faded < 1).map((p) => p.opt.word);
      expect(shown, `τ ${τ}`).toEqual(['volley']);
      expect(s.rings.filter((r) => r.alpha > 0)).toHaveLength(1);
      expect(s.leaders.filter((l) => l.alpha > 0)).toHaveLength(1);
      expect(s.rings.every((r) => r.alpha === 0 || r.alpha === 1)).toBe(true);
    }
  });

  it('fades the completed chase plate out within 100 ms, its timing bar moving to the choice stack', () => {
    const t = createTurn(returnData());
    startTurn(t);
    const done = typeWord(t, 'ball', 100);
    turnClock(t, done + 100);
    const chaseAt = (τ: number): { chase: PlateDraw | undefined; s: PromptScene } => {
      const s = scene(view(matchState(t), τ, 1));
      return { chase: s.plates.find((p) => p.opt.word === 'ball' && p.faded < 1), s };
    };
    expect(chaseAt(done - 50).chase).toMatchObject({ typed: 3, faded: 0 });
    const fading = chaseAt(done + 50);
    expect(fading.chase).toMatchObject({ typed: 4, faded: 0.5, style: 'localActive' });
    const row = fading.s.plates.filter((p) => CHOICE.includes(p.opt.word)).map((p) => p.box);
    expect(row).toHaveLength(3);
    expect(fading.s.bar).toMatchObject({ x: Math.min(...row.map((b) => b.x)) });
    expect(chaseAt(done + 100).chase).toBeUndefined();
  });

  it('stacks the far typist\'s choice beside the spot they will hit from, easy at the bottom, the name chip on the top plate', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const a = new PlayerAnimator();
    scene(view(matchState(t), 350, 0), PREFS, a);
    const s = scene(view(matchState(t), 500, 0), PREFS, a);
    expect(s.plates.every((p) => p.style === 'remote')).toBe(true);
    const boxes = s.plates.map((p) => p.box);
    // Easy (option 0) at the bottom, the widest on top, 3 px apart.
    boxes.slice(1).forEach((b, i) => expect(b.y).toBe(boxes[i]!.y - 19));
    // The top plate starts level with the far player's head top at the hitting spot, 25 px to the
    // court-centre side of their feet.
    const spot = stanceFor(returnData().incoming.contact, 1, a.turnStartFeet(1)).feet;
    const feet = project({ ...spot, z: 0 }, 0);
    const top = boxes.at(-1)!;
    expect(top.y).toBe(Math.round(feet.y) - headHeight(matchState(t).players[1].look, 'far'));
    const feetX = Math.round(feet.x);
    if (feetX <= 240) expect(top.x).toBe(feetX + 25);
    else expect(top.x + top.w - 1).toBe(feetX - 25);
    // Side leaders down to the rings on the viewer's half.
    const targets = returnData().choice.targets.map((p) => project({ ...p, z: 0 }, 0));
    s.leaders.forEach((l, i) => {
      const b = boxes[i]!;
      expect([b.x - 2, b.x + b.w + 1]).toContain(l.points[0]!.x);
      expect(l.points.at(-1)).toEqual({ x: Math.round(targets[i]!.x), y: Math.round(targets[i]!.y) });
    });
    // One chip per prompt: on the top plate until a lock, then on the locked plate.
    expect(s.plates.map((p) => p.nameChip)).toEqual([null, null, 'Kai']);
    expect(s.plates[2]!.oppColor).toBe(beltColor(matchState(null).players[1]));
    expect(s.bar).toBeNull();
    turnInput(t, 'd', 600);
    turnClock(t, 650);
    const locked = scene(view(matchState(t), 650, 0), PREFS, a);
    expect(locked.plates.map((p) => p.nameChip)).toEqual(['Kai', null, null]);
  });

  it('Large words: the far typist\'s locked plate doubles up and away from the player, keeping its bottom edge', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const a = new PlayerAnimator();
    // The bottom plate: growing up from there stays clear of the plate area's top edge.
    const before = scene(view(matchState(t), 500, 0), PREFS, a).plates.find((p) => p.opt.word === 'drop')!.box;
    turnInput(t, 'd', 600);
    turnClock(t, 650);
    const big = scene(view(matchState(t), 650, 0), { ...PREFS, largeWords: true }, a).plates.find((p) => p.scale === 2)!;
    expect(big.opt.word).toBe('drop');
    expect(big.box.y + big.box.h).toBe(before.y + before.h);
    const feetX = Math.round(project({ ...stanceFor(returnData().incoming.contact, 1, a.turnStartFeet(1)).feet, z: 0 }, 0).x);
    if (feetX <= 240) expect(big.box.x).toBe(before.x);
    else expect(big.box.x + big.box.w).toBe(before.x + before.w);
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

  it('ends the revealed serve plate within 100 ms of the chase word, so it never meets the choice stack', () => {
    const { serve, ret } = servedBall();
    const done = typeWord(ret, 'ball', 100);
    turnClock(ret, done + 100);
    const revealed = (τ: number): PlateDraw | undefined =>
      scene(view(matchState(ret, redactServe(serve)), τ, 1)).plates.find((p) => p.style === 'remote' && p.faded < 1);
    expect(revealed(done - 50)).toMatchObject({ opt: { word: 'ball' }, faded: 0, nameChip: 'Alex' });
    expect(revealed(done + 50)).toMatchObject({ opt: { word: 'ball' }, faded: 0.5 });
    expect(revealed(done + 100)).toBeUndefined();
  });

  it('puts "type a first letter" centred on the stack, 2 px above its top plate, inside x 4–476', () => {
    const t = createTurn(returnData());
    startTurn(t);
    typeWord(t, 'ball', 100);
    turnClock(t, 500);
    const vm = view(matchState(t), 500, 1, { overlay: { ...OVERLAY, hintFirstLetter: true } });
    const f = worldFrame(vm);
    const labelW = textWidth('TYPE A FIRST LETTER') + 8;
    for (const x of [-5.8, -3, 0, 3, 5.8]) {
      const far: PlayerPose = { feet: { x: 0, y: -12.2 }, anim: 'idle', frame: 0, view: 'far', flip: false };
      const near: PlayerPose = { feet: { x, y: 12.2 }, anim: 'idle', frame: 0, view: 'near', flip: false };
      const s = promptScene(f, [far, near], {
        prefs: PREFS,
        looks: [vm.pub.players[0].look, vm.pub.players[1].look],
        turnStart: [far.feet, near.feet],
        pop: false,
      });
      const top = s.plates[0]!.box;
      const hint = s.tags.find((g) => g.kind === 'hint');
      expect(hint, `x ${x}`).toBeDefined();
      expect(hint!.y).toBe(top.y - 2 - 11);
      const centre = clamp(top.x + (top.w - 1) / 2, 4 + labelW / 2, 476 - labelW / 2);
      expect(Math.abs(hint!.x - centre)).toBeLessThanOrEqual(0.5);
      const left = Math.round(hint!.x - labelW / 2);
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

describe('promptScene with the insane option (power-meter spec §6)', () => {
  /** Player 1's return at a full meter, `chase` typed from 100 ms, 100 ms apart. */
  function fullMeterReturn(chase: string): TurnState {
    const t = createTurn(returnData({ power: 4, choice: CHOICE_4 }));
    startTurn(t);
    typeWord(t, chase, 100);
    return t;
  }

  it('shows 4 choice rings and leaders while the meter is full', () => {
    const s = scene(view({ ...matchState(fullMeterReturn('ball')), power: [0, 4] }, 600, 1));
    expect(s.rings.map((r) => r.tier)).toEqual(['easy', 'medium', 'hard', 'insane']);
    expect(s.leaders).toHaveLength(4);
    expect(s.plates.map((p) => p.box.w)).toEqual([35, 47, 71, 95]);
    s.plates.slice(1).forEach((p, i) => expect(p.box.y).toBe(s.plates[i]!.box.y + 19));
  });

  it('after a chase slip shows 3, though 4 targets were pre-picked', () => {
    const s = scene(view({ ...matchState(fullMeterReturn('bzall')), power: [0, 4] }, 700, 1));
    expect(s.rings.map((r) => r.tier)).toEqual(['easy', 'medium', 'hard']);
    expect(s.leaders).toHaveLength(3);
    expect(s.plates).toHaveLength(3);
    s.leaders.forEach((l, i) => expect(l.tier).toBe(s.plates[i]!.opt.tier));
  });

  it('Large words: a locked insane word at 2× (14 letters: 190 px) stays inside x 4–476', () => {
    const t = fullMeterReturn('ball');
    typeWord(t, 'ph', 600);
    const s = scene(view({ ...matchState(t), power: [0, 4] }, 800, 1), { ...PREFS, largeWords: true });
    const big = s.plates.filter((p: PlateDraw) => p.scale === 2);
    expect(big).toHaveLength(1);
    expect(big[0]!.box.w).toBe(190);
    expect(big[0]!.box.x).toBeGreaterThanOrEqual(4);
    expect(big[0]!.box.x + big[0]!.box.w).toBeLessThanOrEqual(476);
  });

  it('Large words: the locked plate doubles away from the player and the rings, and its leader leaves the doubled box', () => {
    const t = fullMeterReturn('ball');
    const a = new PlayerAnimator();
    const before = scene(view({ ...matchState(t), power: [0, 4] }, 550, 1), PREFS, a).plates.find((p) => p.opt.word === INSANE_WORD)!.box;
    typeWord(t, 'ph', 600);
    const s = scene(view({ ...matchState(t), power: [0, 4] }, 800, 1), { ...PREFS, largeWords: true }, a);
    const big = s.plates.find((p) => p.scale === 2)!;
    expect(big.opt.word).toBe(INSANE_WORD);
    // The rings are above: it keeps its top edge and grows down, beside the player.
    expect(big.box.y).toBe(before.y);
    // It keeps the edge facing the player and grows away from them.
    const feetX = Math.round(project({ ...stanceFor(returnData().incoming.contact, 1, a.turnStartFeet(1)).feet, z: 0 }, 1).x);
    if (feetX <= 240) expect(big.box.x).toBe(before.x);
    else expect(big.box.x + big.box.w).toBe(before.x + before.w);
    const from = s.leaders[3]!.points[0]!;
    expect([big.box.x - 2, big.box.x + big.box.w + 1]).toContain(from.x);
    expect(from.y).toBe(big.box.y + 16);
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

  it('leaves the ground rings and the leaders to the world pass, which draws them under the players (R33, R42)', () => {
    const ring = { tier: 'hard' as const, x: 200, y: 180, alpha: 1 };
    const leader = { points: [{ x: 150, y: 150 }, { x: ring.x, y: ring.y }], tier: ring.tier, alpha: 1 };
    const { ctx, rects } = recordingContext();
    drawPrompts(ctx, { ...empty(), rings: [ring], leaders: [leader] });
    expect(rects).toEqual([]);
  });

  it('draws fading plates first, under the unlocked options, and the locked word last', () => {
    const plate = (x: number, locked: boolean, faded: number): PlateDraw => ({
      box: { x, y: 40, w: 35, h: 16, option: 0 },
      opt: { word: '', len: 4, tier: 'easy', hidden: true },
      typed: 0,
      locked,
      faded,
      style: 'hiddenRemote',
      lastWrongAgeMs: null,
      isNextCursor: false,
      showInitialBlock: false,
      nameChip: null,
      oppColor: null,
      scale: 1,
      reduceEffects: false,
    });
    const { ctx, rects } = recordingContext();
    drawPrompts(ctx, { ...empty(), plates: [plate(200, true, 0), plate(100, false, 0), plate(10, true, 0.5)] });
    const first = (x: number): number => rects.findIndex((r) => r.x >= x && r.x < x + 35);
    expect(first(10)).toBeGreaterThanOrEqual(0);
    expect(first(10)).toBeLessThan(first(100));
    expect(first(100)).toBeLessThan(first(200));
  });
});
