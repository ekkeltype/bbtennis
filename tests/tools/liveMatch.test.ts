import { beforeAll, describe, expect, it } from 'vitest';
import { situation } from '../../src/core/scoring';
import { turnViewAt, type PromptView, type TurnView } from '../../src/core/turnView';
import type { Surface, TurnState, ViewModel } from '../../src/core/types';
import { bannerFor } from '../../src/render/hud';
import { worldFrame } from '../../src/render/world';
import {
  LIVE_MOMENTS,
  LIVE_VIEWER,
  liveSetup,
  matchFrames,
  planShots,
  viewAs,
  type LiveFrame,
  type Moment,
  type ShotPlan,
} from '../../tools/art/liveMatch';

const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];
/** Timeout for the steps that play whole live matches (about 0.6 s each when the machine is idle). */
const SLOW_MS = 30_000;

/** The spectator frames of a fresh run of `surface`'s live match at `frames`, keyed by frame index. */
function framesAt(surface: Surface, frames: readonly number[]): Map<number, LiveFrame> {
  const wanted = new Set(frames);
  const last = Math.max(...frames);
  const out = new Map<number, LiveFrame>();
  let i = 0;
  for (const f of matchFrames(liveSetup(surface))) {
    if (wanted.has(i)) out.set(i, f);
    if (i++ >= last) break;
  }
  return out;
}

/** The current turn and its view at the frame's τ, as `vm` shows them. */
function turnOf(vm: ViewModel): { turn: TurnState; view: TurnView } {
  const turn = vm.pub.turn;
  if (turn === null) throw new Error('no current turn');
  return { turn, view: turnViewAt(turn, vm.turnτ) };
}

function activePrompt(view: TurnView): PromptView {
  const p = view.active === null ? undefined : view.prompts[view.active];
  if (p === undefined) throw new Error(`no active prompt in phase ${view.phase}`);
  return p;
}

function lockedLen(p: PromptView): number {
  const word = p.locked === null ? undefined : p.options[p.locked];
  if (word === undefined) throw new Error('prompt not locked');
  return word.len;
}

describe('live match moments', () => {
  let plans: ShotPlan[];
  /** Player 0's view at each moment's capture frame, by moment name. */
  const seen = new Map<string, ViewModel>();
  let frames: Map<number, LiveFrame>;

  beforeAll(() => {
    plans = planShots(liveSetup('hard'), LIVE_MOMENTS);
    frames = framesAt('hard', plans.flatMap((p) => [p.at - 1, p.at, p.from - 1, p.from].filter((i) => i >= 0)));
    for (const p of plans) seen.set(p.moment.name, viewAs(frames.get(p.at)!.vm, LIVE_VIEWER));
  }, SLOW_MS);

  const shot = (name: string): ViewModel => {
    const vm = seen.get(name);
    if (vm === undefined) throw new Error(`no shot named ${name}`);
    return vm;
  };

  it('plans the seven moments of the brief, in its order, all seen by player 0', () => {
    expect(plans.map((p) => p.moment.name)).toEqual(['toss', 'chase', 'stack', 'choice', 'point', 'hidden', 'matchpoint']);
    expect(LIVE_VIEWER).toBe(0);
    for (const vm of seen.values()) expect(vm.viewer).toBe(0);
  });

  it('finds every moment on every surface, on the same frames (the surface is cosmetic)', () => {
    const frameNos = (ps: readonly ShotPlan[]): number[][] => ps.map((p) => [p.at, p.from]);
    const hard = frameNos(plans);
    for (const s of SURFACES.filter((s) => s !== 'hard')) expect(frameNos(planShots(liveSetup(s), LIVE_MOMENTS))).toEqual(hard);
  }, SLOW_MS);

  it('a replay reaches each moment on its planned frame and not one frame earlier', () => {
    for (const p of plans) {
      expect(p.moment.shows(frames.get(p.at)!)).toBe(true);
      if (p.at > 0) expect(p.moment.shows(frames.get(p.at - 1)!)).toBe(false);
    }
  });

  it('starts each render window at the first frame of the point before the moment (frame 0 in the first point)', () => {
    for (const p of plans) {
      const point = frames.get(p.at)!.vm.pub.pointNo;
      expect(frames.get(p.from)!.vm.pub.pointNo).toBe(Math.max(0, point - 1));
      if (p.from > 0) expect(frames.get(p.from - 1)!.vm.pub.pointNo).toBe(point - 2);
      else expect(point).toBeLessThanOrEqual(1);
    }
  });

  it('toss: player 0 serves, the ball is up and at least half of the locked word is typed, words visible to them', () => {
    const { turn, view } = turnOf(shot('toss'));
    expect(turn.data.kind).toBe('serve');
    expect(turn.data.owner).toBe(0);
    expect(view.phase).toBe('toss');
    const p = activePrompt(view);
    expect(p.kind).toBe('serve');
    expect(p.options.every((o) => o.word.length === o.len && o.hidden === undefined)).toBe(true);
    expect(p.typed * 2).toBeGreaterThanOrEqual(lockedLen(p));
    expect(p.typed).toBeLessThan(lockedLen(p));
  });

  it('hidden: player 1 serves and player 0 sees only hidden serve plates with the typed count', () => {
    const { turn, view } = turnOf(shot('hidden'));
    expect(turn.data.kind).toBe('serve');
    expect(turn.data.owner).toBe(1);
    expect(view.phase).toBe('toss');
    const p = activePrompt(view);
    expect(p.options.every((o) => o.word === '' && o.hidden === true)).toBe(true);
    expect(p.typed * 2).toBeGreaterThanOrEqual(lockedLen(p));
    expect(p.typed).toBeLessThan(lockedLen(p));
  });

  it('chase: player 0 chases a ball still in flight, the chase word at least half typed', () => {
    const vm = shot('chase');
    const { turn, view } = turnOf(vm);
    if (turn.data.kind !== 'return') throw new Error('not a return turn');
    expect(turn.data.owner).toBe(0);
    expect(view.phase).toBe('chase');
    const p = activePrompt(view);
    expect(p.kind).toBe('chase');
    expect(p.typed * 2).toBeGreaterThanOrEqual(lockedLen(p));
    expect(p.typed).toBeLessThan(lockedLen(p));
    expect(vm.turnτ).toBeLessThan(turn.data.incoming.T);
  });

  it('stack: player 0\'s choice prompt, shown for at least 150 ms and not locked yet', () => {
    const vm = shot('stack');
    const { turn, view } = turnOf(vm);
    expect(turn.data.owner).toBe(0);
    expect(view.phase).toBe('choice');
    const p = activePrompt(view);
    expect(p.kind).toBe('choice');
    expect(p.locked).toBeNull();
    expect(vm.turnτ - p.shownAt).toBeGreaterThanOrEqual(150);
  });

  it('choice: player 0 has locked a choice word and typed at least half of it', () => {
    const { turn, view } = turnOf(shot('choice'));
    expect(turn.data.owner).toBe(0);
    expect(view.phase).toBe('choice');
    const p = activePrompt(view);
    expect(p.kind).toBe('choice');
    expect(p.locked).not.toBeNull();
    expect(p.typed * 2).toBeGreaterThanOrEqual(lockedLen(p));
    expect(p.completedAt).toBeNull();
  });

  it('point: a point call lead-in, the HUD showing the call banner slid in and not fading', () => {
    const vm = shot('point');
    const { turn, view } = turnOf(vm);
    if (turn.data.kind !== 'serve') throw new Error('not a serve turn');
    expect(view.phase).toBe('leadIn');
    expect(turn.data.leadIn.kind).toBe('point');
    const banner = bannerFor(worldFrame(vm));
    expect(['ACE!', 'WINNER', 'OUT', 'NET', 'DOUBLE FAULT']).toContain(banner?.lines[0]?.text);
    expect(banner?.ageMs).toBeGreaterThanOrEqual(750);
    expect(banner?.leftMs).toBeGreaterThanOrEqual(250);
  });

  it('matchpoint: PRE_SERVE at MATCH POINT, before the toss, the banner fully in', () => {
    const vm = shot('matchpoint');
    const { turn, view } = turnOf(vm);
    if (turn.data.kind !== 'serve') throw new Error('not a serve turn');
    expect(view.phase).toBe('preServe');
    expect(view.prompts).toEqual([]);
    expect(situation(vm.pub.score)).toBe('MATCH POINT');
    const banner = bannerFor(worldFrame(vm));
    expect(banner?.lines.map((l) => l.text)).toEqual(['MATCH POINT']);
    expect(banner?.ageMs).toBeGreaterThanOrEqual(300);
  });
});

describe('planShots', () => {
  const toss = LIVE_MOMENTS[0]!;
  const never: Moment = { name: 'never', label: 'never happens', shows: () => false };
  let tossAt: number;

  beforeAll(() => {
    tossAt = planShots(liveSetup('hard'), [toss])[0]!.at;
  });

  it('throws after maxFrames frames, naming only the moments it did not find', () => {
    expect(() => planShots(liveSetup('hard'), [toss, never], tossAt + 1)).toThrow(
      `live match (hard): no never within ${tossAt + 1} frames`,
    );
  });

  it('looks at exactly the first maxFrames frames', () => {
    expect(planShots(liveSetup('hard'), [toss], tossAt + 1).map((p) => p.at)).toEqual([tossAt]);
    expect(() => planShots(liveSetup('hard'), [toss], tossAt)).toThrow(`live match (hard): no toss within ${tossAt} frames`);
  });
});

describe('viewAs', () => {
  it('redacts the spectator view for a player without changing the spectator view', () => {
    const [plan] = planShots(liveSetup('hard'), LIVE_MOMENTS.filter((m) => m.name === 'hidden'));
    const f = framesAt('hard', [plan!.at]).get(plan!.at)!;
    const before = JSON.stringify(f.vm);
    const mine = viewAs(f.vm, 1);
    const theirs = viewAs(f.vm, 0);
    expect(JSON.stringify(f.vm)).toBe(before);
    expect(mine.viewer).toBe(1);
    expect(activePrompt(turnOf(mine).view).options.every((o) => o.word.length === o.len)).toBe(true);
    expect(activePrompt(turnOf(theirs).view).options.every((o) => o.hidden === true)).toBe(true);
    expect(theirs.events).toEqual(f.vm.events);
    expect(theirs.turnτ).toBe(f.vm.turnτ);
  });
});
