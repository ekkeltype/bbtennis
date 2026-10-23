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

/** A short match state, a few seconds in. */
function someState() {
  const s = createMatch(CONFIG, [{ ...HANA, kind: 'human', cpuLevel: null }, { ...GUS, kind: 'human', cpuLevel: null }], 42);
  for (let i = 0; i < 200; i++) step(s, [{ mx: 1, my: 0, topspin: i % 50 === 0, slice: false, lob: false }, { mx: 0, my: 1, topspin: false, slice: false, lob: false }]);
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
      { type: 'forfeit' },
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
      { type: 'ping', id: 'a' },
      { type: 'rematch', want: 'yes' },
    ];
    for (const raw of bad) expect(parseArcadeMsg(raw)).toBeNull();
  });

  it('a state with a broken part is dropped', () => {
    const s = someState();
    const broken = [
      { ...s, tick: -1 },
      { ...s, players: [s.players[0]] },
      { ...s, phase: { kind: 'warmup' } },
      { ...s, p: [s.p[0], { ...s.p[1], pos: { x: 'a', y: 0 } }] },
      { ...s, flight: { hit: null } },
      { ...s, rng: { hits: [], match: s.rng.match } },
      { ...s, status: 'paused' },
    ];
    for (const b of broken) expect(parseArcadeMsg({ type: 'state', m: 1, t: 1, s: b })).toBeNull();
  });

  it('sanitizes names and clamps looks, in hello, start and a state', () => {
    const hello = parseArcadeMsg({ type: 'hello', proto: 1, app: APP_ID, name: 'Gus<b>', look: { ...LOOK, skin: 99, headband: -4 } });
    expect(hello).toMatchObject({ name: 'Gus?b?', look: { skin: 5, headband: 0 } });
    const start = parseArcadeMsg({ type: 'start', m: 1, config: CONFIG, seed: 1, players: [{ name: '', look: LOOK }, GUS] });
    expect(start?.type === 'start' && start.players[0].name).toBe('PLAYER');
    const s = someState();
    const state = parseArcadeMsg({ type: 'state', m: 1, t: 1, s: { ...s, players: [{ ...s.players[0], name: 'a\u0000b' }, s.players[1]] } });
    expect(state?.type === 'state' && state.s.players[0].name).toBe('a?b');
  });

  it('drops extra fields', () => {
    expect(parseArcadeMsg({ type: 'ready', on: false, extra: 1 })).toEqual({ type: 'ready', on: false });
  });
});
