import { describe, expect, it } from 'vitest';
import { createMatch, step } from '../../../src/arcade/core/match';
import type { ArcadeConfig, PlayerInput } from '../../../src/arcade/core/types';
import {
  APP_ID, ARCADE_CODEC, BUILD, MAX_INPUTS_PER_MSG, packInput, parseArcadeMsg, PEER_PREFIX, PROTO, unpackInput, type ArcadeMsg,
} from '../../../src/arcade/net/protocol';
import { MAX_SEND_BYTES } from '../../../src/net/codec';

const LOOK = { skin: 1, hairStyle: 2, hair: 3, shirt: 4, shorts: 5, headband: null, racket: 1 };
const HANA = { name: 'Hana', look: LOOK };
const GUS = { name: 'Gus', look: { ...LOOK, headband: 3 } };
const CONFIG: ArcadeConfig = { format: 'tiebreak', deuceRule: 'advantage', surface: 'clay', pace: 'fast' };

/** A match state a few seconds in, with a ball in the air. */
function someState() {
  const s = createMatch(CONFIG, [{ ...HANA, kind: 'human', cpuLevel: null }, { ...GUS, kind: 'human', cpuLevel: null }], 42);
  for (let i = 0; i < 200 || s.flight === null; i++) step(s, [{ mx: 1, my: 0, topspin: i % 50 === 0, slice: false, lob: false }, { mx: 0, my: 1, topspin: i % 50 === 0, slice: false, lob: false }]);
  return s;
}

const wire = (m: ArcadeMsg): ArcadeMsg | null => ARCADE_CODEC.decode(ARCADE_CODEC.encode(m)!.json);

describe('arcade protocol ids', () => {
  it('has its own peer prefix and an app id that carries the build', () => {
    expect(PROTO).toBe(1);
    expect(PEER_PREFIX).toBe('bbtennis-arcade-');
    expect(BUILD).toBe('dev');
    expect(APP_ID).toBe('bbtennis-arcade@dev');
  });
});

describe('packInput / unpackInput', () => {
  it('packs every input into 0..71 and back', () => {
    const seen = new Set<number>();
    for (const mx of [-1, 0, 1] as const) {
      for (const my of [-1, 0, 1] as const) {
        for (let k = 0; k < 8; k++) {
          const i: PlayerInput = { mx, my, topspin: (k & 1) !== 0, slice: (k & 2) !== 0, lob: (k & 4) !== 0 };
          const n = packInput(i);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(71);
          expect(unpackInput(n)).toEqual(i);
          seen.add(n);
        }
      }
    }
    expect(seen.size).toBe(72);
  });
});

describe('parseArcadeMsg', () => {
  it('round-trips every message through the codec', () => {
    const s = someState();
    const msgs: ArcadeMsg[] = [
      { type: 'hello', proto: 1, app: APP_ID, name: 'Gus', look: LOOK },
      { type: 'welcome', proto: 1, hostProfile: HANA, config: CONFIG },
      { type: 'reject', reason: 'in-match', proto: 1, app: APP_ID },
      { type: 'lobby', config: CONFIG, ready: [true, false] },
      { type: 'ready', on: true },
      { type: 'start', m: 1, config: CONFIG, seed: 123456789, players: [HANA, GUS] },
      { type: 'in', m: 1, t: 3, i: [0, 71, 40], adv: -2 },
      { type: 'sum', m: 2, t: 60, h: 0xffffffff },
      { type: 'state', m: 1, t: s.tick, s },
      { type: 'ping', id: 4 },
      { type: 'pong', id: 4 },
      { type: 'rematch', want: true },
      { type: 'forfeit', m: 1, t: s.tick, s },
      { type: 'leave' },
    ];
    // Compared as JSON: the wire keeps every value but the sign of a zero (a state's -0 arrives as 0).
    for (const m of msgs) expect(JSON.stringify(wire(m))).toBe(JSON.stringify(m));
  });

  it('a whole match state stays well under the size cap', () => {
    const s = someState();
    expect(ARCADE_CODEC.bytes({ type: 'state', m: 1, t: s.tick, s })).toBeLessThan(MAX_SEND_BYTES / 4);
  });

  it('drops unknown types and bad fields', () => {
    const bad: unknown[] = [
      null,
      [],
      { type: 'nope' },
      { type: 'hello', proto: 1, app: 'x', name: 3, look: LOOK },
      { type: 'welcome', proto: 1, hostProfile: HANA, config: { ...CONFIG, pace: 'warp' } },
      { type: 'reject', reason: 'busy', proto: 1, app: 'x' },
      { type: 'lobby', config: CONFIG, ready: [true] },
      { type: 'start', m: 0, config: CONFIG, seed: 1, players: [HANA, GUS] },
      { type: 'start', m: 1, config: CONFIG, seed: 1.5, players: [HANA, GUS] },
      { type: 'start', m: 1, config: CONFIG, seed: 1, players: [HANA] },
      { type: 'in', m: 1, t: 0, i: [1], adv: 0 },
      { type: 'in', m: 1, t: 1, i: [], adv: 0 },
      { type: 'in', m: 1, t: 1, i: [72], adv: 0 },
      { type: 'in', m: 1, t: 1, i: [1.5], adv: 0 },
      { type: 'in', m: 1, t: 1, i: new Array(MAX_INPUTS_PER_MSG + 1).fill(0), adv: 0 },
      { type: 'in', m: 1, t: 1, i: [1], adv: 0.5 },
      { type: 'sum', m: 1, t: 60, h: -1 },
      { type: 'sum', m: 1, t: 60, h: 2 ** 32 },
      { type: 'state', m: 1, t: 1, s: { v: 2 } },
      { type: 'forfeit' },
      { type: 'ping', id: 'a' },
      { type: 'rematch', want: 'yes' },
    ];
    for (const raw of bad) expect(parseArcadeMsg(raw)).toBeNull();
  });

  it('a state with a broken part is dropped, whatever part (a modified host must not wedge the guest)', () => {
    const s = someState();
    const flight = s.flight ?? { hit: { tick: 1, player: 0, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1, contact: { x: 0, y: 0, z: 1 }, target: { x: 0, y: 1 }, T: 1 }, segments: [{ t0: 0, p0: { x: 0, y: 0, z: 1 }, v0: { x: 0, y: 1, z: 1 }, a: { x: 0, y: 0, z: -9 } }], bounces: [], netT: null, net: false, tEnd: 2, tGone: 3 };
    const good = { ...s, flight };
    expect(parseArcadeMsg({ type: 'state', m: 1, t: good.tick, s: good })).not.toBeNull();
    const broken: unknown[] = [
      { ...good, tick: -1 },
      { ...good, players: [good.players[0]] },
      { ...good, players: [{ ...good.players[0], kind: 'robot' }, good.players[1]] },
      { ...good, phase: { kind: 'warmup' } },
      { ...good, phase: { kind: 'dead', until: 5, next: 'later' } },
      { ...good, p: [good.p[0], { ...good.p[1], pos: { x: 'a', y: 0 } }] },
      { ...good, p: [good.p[0], { ...good.p[1], commit: { shot: 'drive', tick: 3, step: null } }] },
      { ...good, p: [{ ...good.p[0], lastSwing: { tick: 1, stroke: 'kick', stretch: false } }, good.p[1]] },
      { ...good, flight: { ...flight, hit: null } },
      { ...good, flight: { ...flight, hit: { ...flight.hit, player: 5 } } },
      { ...good, flight: { ...flight, segments: [] } },
      { ...good, flight: { ...flight, segments: [{ t0: 0, p0: { x: 0, y: 0 }, v0: { x: 0, y: 0, z: 0 }, a: { x: 0, y: 0, z: 0 } }] } },
      { ...good, flight: { ...flight, bounces: new Array(17).fill({ t: 1, at: { x: 0, y: 0 } }) } },
      { ...good, toss: { tick: 3, player: 5 } },
      { ...good, point: { ...good.point, serveNo: 3 } },
      { ...good, point: { ...good.point, call: { call: 'let', player: 0, tick: 1 } } },
      { ...good, score: { ...good.score, gameServer: 7 } },
      { ...good, score: { ...good.score, games: [1] } },
      { ...good, score: { ...good.score, setGames: [[6, 1.5]] } },
      { ...good, stats: [good.stats[0], { ...good.stats[1], hits: -1 }] },
      { ...good, serveClockFrom: 'soon' },
      { ...good, winner: 2 },
      { ...good, rng: { hits: [], match: good.rng.match } },
      { ...good, rng: { hits: [good.rng.hits[0], { a: 1, b: 2, c: 3 }], match: good.rng.match } },
      { ...good, status: 'paused' },
    ];
    for (const b of broken) expect(parseArcadeMsg({ type: 'state', m: 1, t: (b as { tick: number }).tick, s: b }), JSON.stringify(b).slice(0, 80)).toBeNull();
  });

  it('a state whose numbers run out of bounds is dropped: nothing the sim scans can run long (I1)', () => {
    const s = someState();
    const flight = s.flight!;
    expect(flight).not.toBeNull();
    const out: unknown[] = [
      { ...s, flight: { ...flight, tEnd: 1e9 } },
      { ...s, flight: { ...flight, tGone: 21 } },
      { ...s, flight: { ...flight, netT: -1 } },
      { ...s, flight: { ...flight, hit: { ...flight.hit, T: 1e6 } } },
      { ...s, flight: { ...flight, hit: { ...flight.hit, tick: s.tick + 1 } } },
      { ...s, flight: { ...flight, hit: { ...flight.hit, power: 1e3 } } },
      { ...s, flight: { ...flight, segments: [{ ...flight.segments[0]!, t0: 1e7 }] } },
      { ...s, flight: { ...flight, segments: [{ ...flight.segments[0]!, v0: { x: 1e5, y: 0, z: 0 } }] } },
      { ...s, flight: { ...flight, bounces: [{ t: 99, at: { x: 0, y: 0 } }] } },
      { ...s, p: [{ ...s.p[0], pos: { x: 1e6, y: 0 } }, s.p[1]] },
      { ...s, p: [s.p[0], { ...s.p[1], vel: { x: 0, y: -1e4 } }] },
      { ...s, p: [{ ...s.p[0], commit: { shot: 'topspin', tick: s.tick + 5, step: null } }, s.p[1]] },
      { ...s, phase: { kind: 'dead', until: s.tick + 1e6, next: 'setup' } },
      { ...s, phase: { kind: 'setup', since: s.tick + 1 } },
      { ...s, serveClockFrom: s.tick + 1 },
      { ...s, score: { ...s.score, points: [1e7, 0] } },
      { ...s, stats: [{ ...s.stats[0], fastestServeKmh: 1e9 }, s.stats[1]] },
    ];
    for (const b of out) expect(parseArcadeMsg({ type: 'state', m: 1, t: s.tick, s: b }), JSON.stringify(b).slice(0, 60)).toBeNull();
  });

  it('old ticks are fine: a last swing from minutes ago, a call from a long point (no lower bound)', () => {
    const s = someState();
    s.tick += 20_000;
    s.p[1].lastSwing = { tick: 3, stroke: 'forehand', stretch: false };
    s.point.call = { call: 'ace', player: 1, tick: 5 };
    if (s.flight) s.flight = { ...s.flight, hit: { ...s.flight.hit, tick: s.tick - 30 } };
    if (s.phase.kind === 'rally') s.serveClockFrom = null;
    expect(parseArcadeMsg({ type: 'state', m: 1, t: s.tick, s })).not.toBeNull();
  });

  it('a state or forfeit whose state is for another tick than it says is dropped', () => {
    const s = someState();
    expect(parseArcadeMsg({ type: 'state', m: 1, t: s.tick + 1, s })).toBeNull();
    expect(parseArcadeMsg({ type: 'forfeit', m: 1, t: s.tick - 1, s })).toBeNull();
  });

  it('sanitizes names and clamps looks, in hello, start and a state', () => {
    const hello = parseArcadeMsg({ type: 'hello', proto: 1, app: APP_ID, name: 'Gus<b>', look: { ...LOOK, skin: 99, headband: -4 } });
    expect(hello).toMatchObject({ name: 'Gus?b?', look: { skin: 5, headband: 0 } });
    const start = parseArcadeMsg({ type: 'start', m: 1, config: CONFIG, seed: 1, players: [{ name: '', look: LOOK }, GUS] });
    expect(start?.type === 'start' && start.players[0].name).toBe('PLAYER');
    const s = someState();
    const state = parseArcadeMsg({ type: 'state', m: 1, t: s.tick, s: { ...s, players: [{ ...s.players[0], name: 'a\u0000b' }, s.players[1]] } });
    expect(state?.type === 'state' && state.s.players[0].name).toBe('a?b');
  });

  it('drops extra fields', () => {
    expect(parseArcadeMsg({ type: 'ready', on: false, extra: 1 })).toEqual({ type: 'ready', on: false });
  });
});
