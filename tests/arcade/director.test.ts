import { describe, expect, it, vi } from 'vitest';
import { ArcadeDirector } from '../../src/arcade/audio/director';
import { createMatch } from '../../src/arcade/core/match';
import type { ArcadeEvent, HitEvent } from '../../src/arcade/core/types';
import type { ArcadeView } from '../../src/arcade/game/session';
import { umpireCall } from '../../src/core/scoring';
import type { PlayerId } from '../../src/core/types';
import { CONFIG, PLAYERS } from './matchHelpers';

const state = createMatch(CONFIG, PLAYERS, 1);

function hitEv(over: Partial<HitEvent> = {}, player: PlayerId = 0): ArcadeEvent {
  const hit: HitEvent = {
    tick: 10, player, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 0.5,
    contact: { x: 3, y: -8, z: 1 }, target: { x: 0, y: 8 }, T: 1, ...over,
  };
  return { tick: 10, type: 'hit', hit, kmh: 100 };
}

function setup(viewer: PlayerId | 'spectator' = 0) {
  const play = vi.fn();
  const say = vi.fn();
  const d = new ArcadeDirector({ play }, { say }, { surface: () => 'clay', viewer: () => viewer });
  const run = (events: ArcadeEvent[], age: (e: ArcadeEvent) => number = () => 0) =>
    d.consume({ state, t: 0, events, viewer, overlay: { paused: false, countdown: null } } as ArcadeView, age);
  return { play, say, run };
}

describe('ArcadeDirector', () => {
  it('plays hit for an ordinary hit, panned by contact x over 6 m', () => {
    const { play, run } = setup();
    run([hitEv()]);
    expect(play).toHaveBeenCalledWith('hit', { pan: 0.5 });
  });

  it('plays hitHard for a perfect hit, a smash or power >= 0.9', () => {
    for (const over of [{ grade: 'perfect' as const, power: 0.5 }, { type: 'smash' as const, power: 0.5 }, { power: 0.9 }]) {
      const { play, run } = setup();
      run([hitEv(over)]);
      expect(play.mock.calls[0]?.[0]).toBe('hitHard');
    }
    const { play, run } = setup();
    run([hitEv({ power: 0.89 })]);
    expect(play.mock.calls[0]?.[0]).toBe('hit');
  });

  it('flips the pan for viewer 1 and clamps it', () => {
    const { play, run } = setup(1);
    run([hitEv({ contact: { x: 9, y: 0, z: 1 } })]);
    expect(play).toHaveBeenCalledWith('hit', { pan: -1 });
  });

  it('plays bounce with the surface and netHit', () => {
    const { play, run } = setup();
    run([{ tick: 1, type: 'bounce', at: { x: -3, y: 5 }, inCourt: true }, { tick: 1, type: 'netHit', at: { x: 0, y: 0, z: 1 } }]);
    expect(play).toHaveBeenCalledWith('bounce', { surface: 'clay', pan: -0.5 });
    expect(play).toHaveBeenCalledWith('netHit');
  });

  it('says Ace and then the score call in one utterance', () => {
    const { say, run } = setup();
    run([{ tick: 5, type: 'call', call: 'ace', player: 1 }, { tick: 5, type: 'point', winner: 0, reason: 'ace' }]);
    const score = umpireCall(state.score, [PLAYERS[0].name, PLAYERS[1].name], 0);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(`Ace. ${score}`, 0);
  });

  it('says the most important call of a frame, and Net', () => {
    const a = setup();
    a.run([{ tick: 5, type: 'call', call: 'out', player: 0 }, { tick: 5, type: 'call', call: 'doubleFault', player: 0 }]);
    expect(a.say).toHaveBeenCalledWith('Double fault', 0);
    const b = setup();
    b.run([{ tick: 5, type: 'call', call: 'net', player: 0 }]);
    expect(b.say).toHaveBeenCalledWith('Net', 0);
  });

  it('announces the match', () => {
    const { say, run } = setup();
    run([{ tick: 5, type: 'point', winner: 1, reason: 'winner' }, { tick: 5, type: 'match', winner: 1 }]);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0]?.[0]).toBe('Game, set and match, BEN');
  });

  it('reacts with the crowd like the typing director', () => {
    const own = setup(0);
    own.run([{ tick: 1, type: 'point', winner: 0, reason: 'winner' }]);
    expect(own.play).toHaveBeenCalledWith('applause');
    const polite = setup(0);
    polite.run([{ tick: 1, type: 'point', winner: 1, reason: 'ace' }]);
    expect(polite.play).toHaveBeenCalledWith('applause', { gain: 0.5 });
    const ooh = setup(0);
    ooh.run([{ tick: 1, type: 'point', winner: 1, reason: 'doubleFault' }]);
    expect(ooh.play).toHaveBeenCalledWith('ooh');
  });

  it('drops events older than 300 ms and passes the age to the umpire', () => {
    const old = setup();
    old.run([hitEv(), { tick: 5, type: 'call', call: 'out', player: 0 }], () => 400);
    expect(old.play).not.toHaveBeenCalled();
    expect(old.say).not.toHaveBeenCalled();
    const fresh = setup();
    fresh.run([{ tick: 5, type: 'call', call: 'out', player: 0 }], () => 250);
    expect(fresh.say).toHaveBeenCalledWith('Out', 250);
  });
});
