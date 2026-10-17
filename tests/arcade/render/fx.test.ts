import { describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../../src/arcade/core/match';
import type { ArcadeEvent, ArcadeState, HitEvent } from '../../../src/arcade/core/types';
import type { ArcadeView } from '../../../src/arcade/game/session';
import { ArcadeFx } from '../../../src/arcade/render/fx';
import { Effects } from '../../../src/render/effects';
import { CONFIG, PLAYERS } from '../matchHelpers';

const HIT: HitEvent = {
  tick: 10, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1,
  contact: { x: 1, y: -11, z: 1 }, target: { x: 0, y: 8 }, T: 1,
};

function state(surface: ArcadeState['config']['surface'] = 'clay'): ArcadeState {
  return createMatch({ ...CONFIG, surface }, PLAYERS, 1);
}

function view(s: ArcadeState, events: ArcadeEvent[], overlay: ArcadeView['overlay'] = { paused: false, countdown: null }): ArcadeView {
  return { state: s, t: s.tick / 60, events, viewer: 0, overlay };
}

const hit = (over: Partial<HitEvent> = {}): ArcadeEvent => ({ tick: 10, type: 'hit', hit: { ...HIT, ...over }, kmh: 100 });

describe('ArcadeFx', () => {
  it('throws one spark at the contact for a hit', () => {
    const effects = new Effects();
    const spark = vi.spyOn(effects, 'spark');
    const shake = vi.spyOn(effects, 'startShake');
    new ArcadeFx(effects).consume(view(state(), [hit()]), false, 16);
    expect(spark).toHaveBeenCalledTimes(1);
    expect(spark).toHaveBeenCalledWith(HIT.contact, false);
    expect(shake).not.toHaveBeenCalled();
  });

  it('leaves one mark for a bounce on clay, and setup clears the marks', () => {
    const effects = new Effects();
    const fx = new ArcadeFx(effects);
    const s = state('clay');
    fx.consume(view(s, [{ tick: 20, type: 'bounce', at: { x: 1, y: 8 }, inCourt: true }]), false, 16);
    expect(effects.clayMarks).toEqual([{ x: 1, y: 8 }]);
    fx.consume(view(s, [{ tick: 90, type: 'setup', server: 0, serveNo: 1, side: 'deuce' }]), false, 16);
    expect(effects.clayMarks).toHaveLength(0);
  });

  it('puffs without a mark on hard', () => {
    const effects = new Effects();
    const puff = vi.spyOn(effects, 'bouncePuff');
    new ArcadeFx(effects).consume(view(state('hard'), [{ tick: 20, type: 'bounce', at: { x: 1, y: 8 }, inCourt: false }]), true, 16);
    expect(puff).toHaveBeenCalledWith({ x: 1, y: 8 }, 'hard', true);
    expect(effects.clayMarks).toHaveLength(0);
  });

  it('shakes on an ace, a winner and a smash, never with reduce effects', () => {
    for (const reduce of [false, true]) {
      const effects = new Effects();
      const shake = vi.spyOn(effects, 'startShake');
      const fx = new ArcadeFx(effects);
      const s = state();
      fx.consume(view(s, [{ tick: 30, type: 'point', winner: 0, reason: 'ace' }]), reduce, 16);
      fx.consume(view(s, [{ tick: 40, type: 'point', winner: 1, reason: 'winner' }]), reduce, 16);
      fx.consume(view(s, [hit({ type: 'smash' })]), reduce, 16);
      fx.consume(view(s, [{ tick: 50, type: 'point', winner: 1, reason: 'out' }]), reduce, 16);
      expect(shake).toHaveBeenCalledTimes(reduce ? 0 : 3);
    }
  });

  it('cheers 0.7 on a point and holds 0.45 through a rally of 6 hits until the next set-up', () => {
    const effects = new Effects();
    const fx = new ArcadeFx(effects);
    const s = state();
    fx.consume(view(s, [{ tick: 30, type: 'point', winner: 0, reason: 'out' }]), false, 16);
    expect(effects.crowdExcite).toBeCloseTo(0.7 - 0.3 * 0.016, 6);
    fx.consume(view(s, []), false, 5000);
    expect(effects.crowdExcite).toBe(0);
    fx.consume(view(s, [hit(), hit(), hit(), hit(), hit()]), false, 16);
    expect(effects.crowdExcite).toBe(0);
    fx.consume(view(s, [hit()]), false, 16);
    fx.consume(view(s, []), false, 5000);
    expect(effects.crowdExcite).toBe(0.45);
    fx.consume(view(s, [{ tick: 90, type: 'setup', server: 0, serveNo: 1, side: 'deuce' }]), false, 5000);
    expect(effects.crowdExcite).toBe(0);
  });

  it('throws confetti on the match', () => {
    const effects = new Effects();
    new ArcadeFx(effects).consume(view(state(), [{ tick: 30, type: 'match', winner: 0 }]), false, 16);
    expect(effects.confetti).toBeGreaterThan(20);
  });

  it('kicks up run dust every 110 ms while a player runs at 4 m/s or more, but not while paused', () => {
    const effects = new Effects();
    const dust = vi.spyOn(effects, 'runDust');
    const fx = new ArcadeFx(effects);
    const s = state('hard');
    s.p[0].vel = { x: 4, y: 0 };
    s.p[1].vel = { x: 3.9, y: 0 };
    for (let i = 0; i < 10; i++) fx.consume(view(s, []), false, 50);
    expect(dust).toHaveBeenCalledTimes(4);
    expect(dust.mock.calls.every(([at]) => at.x === s.p[0].pos.x && at.y === s.p[0].pos.y)).toBe(true);
    for (let i = 0; i < 10; i++) fx.consume(view(s, [], { paused: true, countdown: null }), false, 50);
    expect(dust).toHaveBeenCalledTimes(4);
  });

  it('advances the effects every frame', () => {
    const effects = new Effects();
    const advance = vi.spyOn(effects, 'advance');
    new ArcadeFx(effects).consume(view(state(), []), true, 16);
    expect(advance).toHaveBeenCalledWith(16, true);
  });
});
