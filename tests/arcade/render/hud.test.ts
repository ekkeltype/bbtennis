import { describe, expect, it } from 'vitest';
import { buildFlight } from '../../../src/arcade/core/flight';
import { createMatch, step } from '../../../src/arcade/core/match';
import { ARCADE, DT } from '../../../src/arcade/core/tuning';
import { NO_INPUT } from '../../../src/arcade/core/types';
import type { ArcadeEvent, ArcadeState, HitEvent } from '../../../src/arcade/core/types';
import { bannerAt, serveClockShown, serveKmhShown } from '../../../src/arcade/render/hud';
import { CONFIG, PLAYERS, forPlayer, matchInSetup, ofType, press, runTicks, runUntil, serveAce, untilType } from '../matchHelpers';

/** Its coin toss goes to player 0 ('ANA'). */
const SEED = 1;
const ticks = (s: number): number => Math.round(s / DT);

/** Aces until a game is won; returns every event and those of the game point. */
function aceAGame(s: ArcadeState): { all: ArcadeEvent[]; last: ArcadeEvent[] } {
  const all: ArcadeEvent[] = [];
  for (let i = 0; i < 8; i++) {
    const last = serveAce(s);
    all.push(...last);
    if (ofType(last, 'game').length > 0) return { all, last };
    all.push(...runUntil(s, (st) => st.phase.kind === 'setup'));
  }
  throw new Error('no game');
}

describe('bannerAt', () => {
  it('announces the coin toss winner during the intro', () => {
    const s = createMatch(CONFIG, PLAYERS, SEED);
    const ev = step(s, [NO_INPUT, NO_INPUT]);
    expect(bannerAt(s, ev)).toMatchObject({ lines: ['ANA TO SERVE'], small: false, startTick: 0, endTick: ticks(ARCADE.flow.intro) });
  });

  it('shows ACE for the call time, then nothing on a plain point', () => {
    const { s } = matchInSetup(SEED);
    const ev = serveAce(s);
    const call = ofType(ev, 'call')[0]!;
    expect(call.call).toBe('ace');
    expect(bannerAt(s, ev)).toEqual({ lines: ['ACE'], startTick: call.tick, endTick: call.tick + ticks(ARCADE.flow.call), small: false });
    ev.push(...runTicks(s, ticks(ARCADE.flow.call)));
    expect(bannerAt(s, ev)).toBeNull();
  });

  it('shows FAULT + NET for a serve into the net', () => {
    const { s } = matchInSetup(SEED);
    const hit: HitEvent = {
      tick: s.tick, player: 0, type: 'serveFlat', grade: 'clean', stretch: false, volley: false, power: 1,
      contact: { x: 0.8, y: -12.2, z: 0.5 }, target: { x: -1, y: 2 }, T: 0.4,
    };
    s.flight = buildFlight(hit);
    expect(s.flight.net).toBe(true);
    s.phase = { kind: 'rally' };
    s.serveClockFrom = null;
    s.point.hits = 1;
    s.point.serveUnbounced = true;
    const ev = runUntil(s, untilType('call'));
    expect(ofType(ev, 'netHit')).toHaveLength(1);
    expect(bannerAt(s, ev)?.lines).toEqual(['FAULT', 'NET']);
  });

  it('shows TIME VIOLATION, then DOUBLE FAULT, when the server never serves', () => {
    const { s } = matchInSetup(SEED);
    const ev = runUntil(s, untilType('call'));
    expect(bannerAt(s, ev)).toMatchObject({ lines: ['TIME VIOLATION'], small: false });
    ev.push(...runUntil(s, untilType('point')));
    expect(bannerAt(s, ev)?.lines).toEqual(['DOUBLE FAULT']);
  });

  it('shows the call, then GAME and the winner\'s name until the dead time ends', () => {
    const { s } = matchInSetup(SEED);
    const { all, last } = aceAGame(s);
    const callTick = ofType(last, 'call')[0]!.tick;
    expect(bannerAt(s, all)?.lines).toEqual(['ACE']);
    all.push(...runTicks(s, ticks(ARCADE.flow.call)));
    const flow = ARCADE.flow;
    expect(bannerAt(s, all)).toEqual({
      lines: ['GAME', 'ANA'], startTick: callTick + ticks(flow.call), endTick: callTick + ticks(flow.call + flow.score + flow.gameBanner), small: false,
    });
  });

  it('shows the situation small after the call', () => {
    const { s } = matchInSetup(SEED);
    const ev = serveAce(s);
    const tick = ofType(ev, 'call')[0]!.tick;
    ev.push({ tick, type: 'situation', text: 'BREAK POINT' });
    ev.push(...runTicks(s, ticks(ARCADE.flow.call)));
    expect(bannerAt(s, ev)).toMatchObject({ lines: ['BREAK POINT'], small: true });
    ev.push(...runTicks(s, ticks(ARCADE.flow.score)));
    expect(bannerAt(s, ev)).toBeNull();
  });
});

describe('HUD readouts', () => {
  it('shows the serve clock only in its last 5 s', () => {
    const { s } = matchInSetup(SEED);
    expect(s.serveClockFrom).toBe(s.tick);
    expect(serveClockShown(s)).toBeNull();
    s.serveClockFrom = s.tick - ticks(ARCADE.serve.clock - 6);
    expect(serveClockShown(s)).toBeNull();
    s.serveClockFrom = s.tick - ticks(ARCADE.serve.clock - 5.5);
    expect(serveClockShown(s)).toBeNull();
    s.serveClockFrom = s.tick - ticks(ARCADE.serve.clock - 5);
    expect(serveClockShown(s)).toBe(5);
    s.serveClockFrom = s.tick - ticks(ARCADE.serve.clock - 0.5);
    expect(serveClockShown(s)).toBe(1);
    s.serveClockFrom = null;
    expect(serveClockShown(s)).toBeNull();
  });

  it('shows the serve speed for 2 s after a serve, then fades it out over 0.5 s', () => {
    const { s } = matchInSetup(SEED);
    const ev = step(s, forPlayer(0, press('topspin')));
    ev.push(...runTicks(s, 38));
    ev.push(...step(s, forPlayer(0, press('slice'))));
    const kmh = Math.round(ofType(ev, 'hit')[0]!.kmh);
    expect(serveKmhShown(s, ev)).toEqual({ kmh, alpha: 1 });
    ev.push(...runTicks(s, ticks(2)));
    expect(serveKmhShown(s, ev)).toEqual({ kmh, alpha: 1 });
    ev.push(...runTicks(s, ticks(0.25)));
    expect(serveKmhShown(s, ev)?.alpha).toBeCloseTo(0.5, 6);
    ev.push(...runTicks(s, ticks(0.25)));
    expect(serveKmhShown(s, ev)).toBeNull();
  });
});
