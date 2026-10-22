import { describe, expect, it } from 'vitest';
import { buildFlight, flightPos } from '../../src/arcade/core/flight';
import { ballAt, createMatch, flightTime, receiverOf, serveClockLeft, step } from '../../src/arcade/core/match';
import { receiveSpot, serveSpot } from '../../src/arcade/core/movement';
import { contactAt, stepSpot } from '../../src/arcade/core/reach';
import { kmhOf, tossZ } from '../../src/arcade/core/shot';
import { ARCADE, DT } from '../../src/arcade/core/tuning';
import { NO_INPUT } from '../../src/arcade/core/types';
import type { ArcadeEvent, ArcadeState, Flight, HitEvent, PlayerId, PlayerInput, Vec2 } from '../../src/arcade/core/types';
import { endSign } from '../../src/core/court';
import { intBelow, seedRng, uniform } from '../../src/core/rng';
import { currentServer, situation } from '../../src/core/scoring';
import { other } from '../../src/core/types';
import type { RngState } from '../../src/core/types';
import {
  CONFIG, IDLE, PLAYERS, forPlayer, hold, matchInSetup, ofType, press, runTicks, runUntil, scriptedServe, serveAce, untilType,
} from './matchHelpers';
import type { Inputs } from './matchHelpers';

/** Seed used throughout; its coin toss goes to player 0. */
const SEED = 1;

/** First tick count after the toss at which the toss is below the drop height (Normal pace). */
function dropTicks(): number {
  let n = 0;
  while (tossZ(n, 'normal') >= ARCADE.serve.dropZ) n++;
  return n;
}

/** First tick ≥ `from` on which `player` standing at `pos` meets flight `f`, or null. */
function contactTickFor(f: Flight, player: PlayerId, pos: Vec2, from: number, serveUnbounced: boolean): number | null {
  for (let n = from; (n - f.hit.tick) * DT < f.tEnd; n++) {
    if (contactAt(player, pos, f, n, serveUnbounced) !== null) return n;
  }
  return null;
}

/** A state in 'rally' with a flight hit by `hitter` on the current tick (a direct set-up). */
function rallyState(hitter: PlayerId, hit: Partial<HitEvent> & Pick<HitEvent, 'contact' | 'target' | 'T'>, hits = 2): ArcadeState {
  const { s } = matchInSetup(SEED);
  const h: HitEvent = { tick: s.tick, player: hitter, type: 'topspin', grade: 'clean', stretch: false, volley: false, power: 1, ...hit };
  s.flight = buildFlight(h);
  s.phase = { kind: 'rally' };
  s.toss = null;
  s.serveClockFrom = null;
  s.point.hits = hits;
  s.point.serveUnbounced = hits === 1;
  return s;
}

/** Every value is a finite number, string, boolean, null, array or plain object. */
function expectJsonSafe(v: unknown, path = 'state'): void {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    expect(Number.isFinite(v), `${path} is finite`).toBe(true);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => expectJsonSafe(x, `${path}[${i}]`));
    return;
  }
  expect(typeof v, `${path} type`).toBe('object');
  expect(Object.getPrototypeOf(v), `${path} is a plain object`).toBe(Object.prototype);
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    expect(x, `${path}.${k} is defined`).not.toBeUndefined();
    expectJsonSafe(x, `${path}.${k}`);
  }
}

function randomInput(rng: RngState): PlayerInput {
  const axis = (): -1 | 0 | 1 => (intBelow(rng, 3) - 1) as -1 | 0 | 1;
  return { mx: axis(), my: axis(), topspin: uniform(rng) < 0.15, slice: uniform(rng) < 0.08, lob: uniform(rng) < 0.05 };
}

describe('intro and set-up', () => {
  it('createMatch starts in the intro, with the coin-toss winner serving first', () => {
    const s = createMatch(CONFIG, PLAYERS, SEED);
    expect(s.phase).toEqual({ kind: 'intro', until: 120 });
    expect(s.tick).toBe(0);
    expect(s.status).toBe('playing');
    expect(s.winner).toBeNull();
    expect(s.flight).toBeNull();
    expect(s.score.gameServer).toBe(s.score.firstServerOfMatch);
    expect(s.score.firstServerOfMatch).toBe(0);
  });

  it('emits coinToss on tick 1 and enters set-up after 120 ticks', () => {
    const s = createMatch(CONFIG, PLAYERS, SEED);
    const intro = runTicks(s, 119);
    expect(s.phase.kind).toBe('intro');
    expect(intro).toEqual([{ tick: 1, type: 'coinToss', winner: s.score.firstServerOfMatch }]);
    const ev = runTicks(s, 1);
    const server = s.score.firstServerOfMatch;
    const receiver = other(server);
    expect(ev).toEqual([{ tick: 120, type: 'setup', server, serveNo: 1, side: 'deuce' }]);
    expect(s.phase).toEqual({ kind: 'setup', since: 120 });
    expect(s.p[server].pos).toEqual(serveSpot(server, 'deuce'));
    expect(s.p[receiver].pos).toEqual(receiveSpot(receiver, 'deuce'));
    expect(s.p[server].vel).toEqual({ x: 0, y: 0 });
    expect(s.serveClockFrom).toBe(120);
    expect(serveClockLeft(s)).toBe(25);
  });

  it('the same seed gives the same coin toss; seeds give both outcomes', () => {
    const tossOf = (seed: number): PlayerId => {
      const s = createMatch(CONFIG, PLAYERS, seed);
      const ev = runTicks(s, 1);
      const c = ofType(ev, 'coinToss')[0]!;
      expect(c.winner).toBe(s.score.firstServerOfMatch);
      return c.winner;
    };
    for (const seed of [1, 2, 3, 42]) expect(tossOf(seed)).toBe(tossOf(seed));
    const winners = new Set(Array.from({ length: 20 }, (_, i) => tossOf(i + 1)));
    expect(winners).toEqual(new Set([0, 1]));
  });
});

describe('serve rail', () => {
  it('during set-up the server moves only along x and the receiver moves freely', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const receiver = other(server);
    const s0 = { ...s.p[server].pos };
    const r0 = { ...s.p[receiver].pos };
    runTicks(s, 30, () => forPlayer(server, hold({ mx: 1, my: 1 }), hold({ mx: 1, my: 1 })));
    expect(s.phase.kind).toBe('setup');
    expect(s.p[server].pos.y).toBe(s0.y);
    expect(s.p[server].pos.x).not.toBeCloseTo(s0.x, 3);
    expect(s.p[receiver].pos.x).not.toBeCloseTo(r0.x, 3);
    expect(s.p[receiver].pos.y).not.toBeCloseTo(r0.y, 3);
  });
});

describe('toss, drop and serve clock', () => {
  it('a toss with no hit is dropped below dropZ (≈ toss + 83 at Normal) and returns to set-up without a fault', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const from = s.serveClockFrom;
    const ev = runTicks(s, 1, () => forPlayer(server, press('topspin')));
    const tossTick = s.tick;
    expect(ev).toEqual([{ tick: tossTick, type: 'toss', player: server }]);
    expect(s.phase).toEqual({ kind: 'toss', at: tossTick });
    expect(s.toss).toEqual({ tick: tossTick, player: server });
    const rest = runUntil(s, untilType('tossDropped'), IDLE, 200);
    const drop = ofType(rest, 'tossDropped');
    expect(drop).toEqual([{ tick: tossTick + dropTicks(), type: 'tossDropped', player: server }]);
    expect(dropTicks()).toBeGreaterThanOrEqual(83);
    expect(dropTicks()).toBeLessThanOrEqual(84);
    expect(s.phase.kind).toBe('setup');
    expect(s.toss).toBeNull();
    expect(s.point.serveNo).toBe(1);
    expect(ofType(rest, 'call')).toEqual([]);
    expect(s.serveClockFrom).toBe(from);
  });

  it('the ball is drawn above the server during the toss and held otherwise', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    expect(ballAt(s, s.tick * DT)).toBeNull();
    runTicks(s, 1, () => forPlayer(server, press('slice')));
    const tossTick = s.tick;
    runTicks(s, 39);
    const b = ballAt(s, s.tick * DT)!;
    expect(b.x).toBe(s.p[server].pos.x);
    expect(b.y).toBe(s.p[server].pos.y);
    expect(b.z).toBeCloseTo(ARCADE.serve.apexZ, 9);
    const mid = ballAt(s, (tossTick + 10.5) * DT)!;
    expect(mid.z).toBeCloseTo(tossZ(10.5, 'normal'), 9);
  });

  it('the serve clock running out in set-up is a time-violation fault → serve 2', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const from = s.tick;
    const before = runTicks(s, 1499);
    expect(ofType(before, 'call')).toEqual([]);
    expect(serveClockLeft(s)).toBeCloseTo(DT, 9);
    const ev = runTicks(s, 1);
    expect(ev).toEqual([{ tick: from + 1500, type: 'call', call: 'timeViolation', player: server }]);
    expect(s.point.call).toEqual({ call: 'timeViolation', player: server, tick: from + 1500 });
    expect(s.point.serveNo).toBe(2);
    expect(s.phase).toEqual({ kind: 'dead', until: from + 1500 + 72, next: 'setup' });
    expect(serveClockLeft(s)).toBeNull();
    const next = runUntil(s, untilType('setup'));
    expect(ofType(next, 'setup')).toEqual([{ tick: from + 1572, type: 'setup', server, serveNo: 2, side: 'deuce' }]);
    expect(serveClockLeft(s)).toBe(25);
  });

  it('the clock running out while the toss is in the air is a fault, not a hit (Review Focus 4)', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const from = s.tick;
    runTicks(s, 1459);
    const ev = scriptedServe(s, { key: 'topspin', hitDelayTicks: 40 }); // toss at from+1460, hit press at from+1500
    expect(ofType(ev, 'toss')).toEqual([{ tick: from + 1460, type: 'toss', player: server }]);
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(ofType(ev, 'call')).toEqual([{ tick: from + 1500, type: 'call', call: 'timeViolation', player: server }]);
    expect(s.flight).toBeNull();
    expect(s.toss).toBeNull();
    expect(s.point.serveNo).toBe(2);
    expect(s.phase.kind).toBe('dead');
  });

  it('a serve struck before the clock runs out stops it', () => {
    const { s } = matchInSetup(SEED);
    const from = s.tick;
    runTicks(s, 1449);
    const ev = scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 }); // hit at from+1492
    expect(ofType(ev, 'hit').map((e) => e.tick)).toEqual([from + 1492]);
    expect(serveClockLeft(s)).toBeNull();
    const after = runTicks(s, 20);
    expect(ofType(after, 'call')).toEqual([]);
  });
});

describe('faults', () => {
  /** A rushed flat serve struck on the last tick before the drop (just above dropZ): it hits the net. */
  function netServe(s: ArcadeState): ArcadeEvent[] {
    const ev = scriptedServe(s, { key: 'topspin', hitDelayTicks: dropTicks() - 1 });
    const hit = ofType(ev, 'hit')[0]!;
    expect(hit.hit.grade).toBe('rushed');
    expect(hit.hit.type).toBe('serveFlat');
    expect(hit.hit.contact.z).toBeGreaterThanOrEqual(ARCADE.serve.dropZ);
    expect(hit.hit.contact.z).toBeLessThan(ARCADE.serve.dropZ + 0.05);
    return [...ev, ...runUntil(s, untilType('call'))];
  }

  it('a serve into the net is a fault: netHit, call fault, serve 2', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const ev = netServe(s);
    const types = ev.filter((e) => e.type !== 'toss' && e.type !== 'hit').map((e) => e.type);
    expect(types).toEqual(['netHit', 'call']);
    const net = ofType(ev, 'netHit')[0]!;
    expect(net.at.y).toBe(0);
    expect(ofType(ev, 'call')[0]).toMatchObject({ call: 'fault', player: server });
    expect(s.point.serveNo).toBe(2);
    expect(s.phase).toEqual({ kind: 'dead', until: s.tick + 72, next: 'setup' });
    expect(s.score.points).toEqual([0, 0]);
    expect(s.flight).not.toBeNull(); // kept for drawing
    const next = runUntil(s, untilType('setup'));
    expect(ofType(next, 'setup')[0]).toMatchObject({ server, serveNo: 2, side: 'deuce' });
    expect(s.flight).toBeNull();
  });

  it('a second fault is a double fault: the point goes to the receiver', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const receiver = other(server);
    netServe(s);
    runUntil(s, untilType('setup'));
    const ev = netServe(s);
    const tail = ev.filter((e) => e.type !== 'toss' && e.type !== 'hit');
    expect(tail.map((e) => e.type)).toEqual(['netHit', 'call', 'call', 'point']);
    expect(ofType(tail, 'call').map((e) => [e.call, e.player])).toEqual([['fault', server], ['doubleFault', server]]);
    expect(ofType(tail, 'point')[0]).toMatchObject({ winner: receiver, reason: 'doubleFault' });
    expect(s.score.points[receiver]).toBe(1);
    expect(s.score.points[server]).toBe(0);
    expect(s.stats[server].doubleFaults).toBe(1);
    expect(s.stats[receiver].pointsWon).toBe(1);
    expect(s.point.serveNo).toBe(1);
    expect(s.pointNo).toBe(1);
    const next = runUntil(s, untilType('setup'));
    expect(ofType(next, 'setup')[0]).toMatchObject({ server, serveNo: 1, side: 'ad' });
  });

  it('a time violation on the second serve is a double fault', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const ev = runUntil(s, untilType('point'));
    expect(ofType(ev, 'call').map((e) => e.call)).toEqual(['timeViolation', 'timeViolation', 'doubleFault']);
    expect(ofType(ev, 'point')[0]).toMatchObject({ winner: other(server), reason: 'doubleFault' });
    expect(s.stats[server].doubleFaults).toBe(1);
  });

  it('a serve landing outside the service box is a fault', () => {
    // Player 0 serves from the deuce side deep into player 1's court, beyond the service line.
    const s = rallyState(0, { type: 'serveFlat', contact: { x: 0.8, y: -12.185, z: 2.9 }, target: { x: -2, y: 9 }, T: 0.6 }, 1);
    const ev = runUntil(s, untilType('call'), IDLE, 200);
    expect(ofType(ev, 'bounce')).toEqual([expect.objectContaining({ inCourt: false })]);
    expect(ofType(ev, 'call')[0]).toMatchObject({ call: 'fault', player: currentServer(s.score) });
    expect(s.point.serveNo).toBe(2);
  });
});

describe('ace', () => {
  it('a perfect flat serve with the receiver idle: bounce in, ace, dead time, next set-up from the ad side', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const receiver = other(server);
    const ev = scriptedServe(s, { key: 'topspin', hitDelayTicks: 42 });
    const hit = ofType(ev, 'hit')[0]!;
    expect(hit.hit).toMatchObject({ player: server, type: 'serveFlat', grade: 'perfect' });
    expect(hit.kmh).toBe(kmhOf(s.flight!));
    expect(s.stats[server].fastestServeKmh).toBe(hit.kmh);
    expect(s.phase.kind).toBe('rally');
    expect(s.point.hits).toBe(1);
    expect(s.point.serveUnbounced).toBe(true);
    expect(s.p[server].lastSwing).toEqual({ tick: hit.tick, stroke: 'serve', stretch: false });
    expect(receiverOf(s)).toBe(receiver);

    const rest = runUntil(s, untilType('point'));
    expect(rest.map((e) => e.type)).toEqual(['bounce', 'call', 'point']);
    expect(ofType(rest, 'bounce')[0]!.inCourt).toBe(true);
    expect(ofType(rest, 'call')[0]).toMatchObject({ call: 'ace', player: receiver });
    expect(ofType(rest, 'point')[0]).toMatchObject({ winner: server, reason: 'ace' });
    const pointTick = s.tick;
    expect((pointTick - hit.tick) * DT).toBeGreaterThanOrEqual(hit.hit.T);
    expect(s.stats[server].aces).toBe(1);
    expect(s.stats[server].pointsWon).toBe(1);
    expect(s.score.points[server]).toBe(1);
    expect(s.longestRally).toBe(1);
    expect(s.phase).toEqual({ kind: 'dead', until: pointTick + 168, next: 'setup' });
    expect(receiverOf(s)).toBeNull();

    // Dead time: inputs ignored, players walk toward the ad-side spots.
    const spot = serveSpot(server, 'ad');
    const d0 = Math.abs(s.p[server].pos.x - spot.x) + Math.abs(s.p[server].pos.y - spot.y);
    runTicks(s, 30, () => [hold({ mx: 1, my: 1 }), hold({ mx: -1, my: 1 })]);
    const d1 = Math.abs(s.p[server].pos.x - spot.x) + Math.abs(s.p[server].pos.y - spot.y);
    expect(d1).toBeLessThan(d0 + 1e-9);

    const next = runUntil(s, untilType('setup'));
    expect(ofType(next, 'setup')).toEqual([{ tick: pointTick + 168, type: 'setup', server, serveNo: 1, side: 'ad' }]);
    expect(s.p[server].pos).toEqual(serveSpot(server, 'ad'));
    expect(s.p[receiver].pos).toEqual(receiveSpot(receiver, 'ad'));
    expect(s.flight).toBeNull();
  });
});

describe('rally', () => {
  it('a receiver committed 30 ticks early in the path returns the serve perfectly; the idle server loses to a winner', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const receiver = other(server);
    scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 });
    const f = s.flight!;
    const hitTick = s.tick;
    const bounceTick = hitTick + Math.ceil(f.bounces[0]!.t / DT);
    const ball = flightPos(f, (bounceTick + 12 - hitTick) * DT);
    const pos = { x: ball.x + 0.5, y: ball.y };
    s.p[receiver].pos = pos; // stands in the path (direct set-up)
    const contactTick = contactTickFor(f, receiver, pos, hitTick + 1, true)!;
    expect(contactTick).toBeGreaterThan(hitTick + 31);

    runTicks(s, contactTick - 30 - 1 - hitTick);
    const commitEv = runTicks(s, 1, () => forPlayer(receiver, press('topspin')));
    expect(ofType(commitEv, 'commit')).toEqual([{ tick: contactTick - 30, type: 'commit', player: receiver, shot: 'topspin' }]);
    const ev = runUntil(s, untilType('hit'));
    const hit = ofType(ev, 'hit')[0]!;
    expect(hit.tick).toBe(contactTick);
    expect(hit.hit).toMatchObject({ player: receiver, type: 'topspin', grade: 'perfect', volley: false });
    expect(ofType(ev, 'bounce')[0]).toMatchObject({ inCourt: true });
    expect(s.flight!.hit).toEqual(hit.hit);
    expect(endSign(server) * s.flight!.hit.target.y).toBeLessThan(0); // toward the server's half
    expect(s.point.hits).toBe(2);
    expect(s.point.serveUnbounced).toBe(false);
    expect(s.p[receiver].commit).toBeNull();
    expect(s.p[receiver].lastSwing).toMatchObject({ tick: contactTick });
    expect(s.stats[receiver].hits).toBe(1);
    expect(s.stats[receiver].perfectHits).toBe(1);
    expect(receiverOf(s)).toBe(server);

    const end = runUntil(s, untilType('point'));
    expect(ofType(end, 'bounce')[0]).toMatchObject({ inCourt: true });
    expect(ofType(end, 'call')[0]).toMatchObject({ call: 'winner', player: server });
    expect(ofType(end, 'point')[0]).toMatchObject({ winner: receiver, reason: 'winner' });
    expect(s.stats[receiver].winners).toBe(1);
    expect(s.stats[server].aces).toBe(0);
    expect(s.longestRally).toBe(2);
  });

  it('a rally ball bouncing outside the court is out: the hitter loses and makes an error', () => {
    const s = rallyState(0, { contact: { x: 0, y: -11, z: 1 }, target: { x: 6, y: 8 }, T: 1.0 });
    const ev = runUntil(s, untilType('point'), IDLE, 200);
    expect(ev.map((e) => e.type)).toEqual(['bounce', 'call', 'point']);
    expect(ofType(ev, 'bounce')[0]).toEqual({ tick: s.flight!.hit.tick + 60, type: 'bounce', at: { x: 6, y: 8 }, inCourt: false });
    expect(ofType(ev, 'call')[0]).toMatchObject({ call: 'out', player: 0 });
    expect(ofType(ev, 'point')[0]).toMatchObject({ winner: 1, reason: 'out' });
    expect(s.stats[0].errors).toBe(1);
    expect(s.stats[1].pointsWon).toBe(1);
    expect(s.stats[1].winners).toBe(0);
  });

  it('a rally ball into the net: the hitter loses and makes an error', () => {
    const s = rallyState(0, { contact: { x: 0, y: -11, z: 0.3 }, target: { x: 0, y: 8 }, T: 0.5 });
    expect(s.flight!.net).toBe(true);
    const ev = runUntil(s, untilType('point'), IDLE, 200);
    expect(ev.map((e) => e.type)).toEqual(['netHit', 'call', 'point']);
    expect(ofType(ev, 'call')[0]).toMatchObject({ call: 'net', player: 0 });
    expect(ofType(ev, 'point')[0]).toMatchObject({ winner: 1, reason: 'net' });
    expect(s.stats[0].errors).toBe(1);
  });

  it('the serve return must bounce: a receiver on the path before the bounce does not hit it there', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const receiver = other(server);
    scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 });
    const f = s.flight!;
    const hitTick = s.tick;
    const bounceT = f.bounces[0]!.t;
    const netT = f.netT!;
    const ball = flightPos(f, (netT + bounceT) / 2);
    const pos = { x: ball.x + 0.3, y: ball.y };
    expect(Math.abs(pos.y)).toBeGreaterThan(1);
    // The same spot would volley a rally ball.
    const volleyTick = contactTickFor(f, receiver, pos, hitTick + 1, false)!;
    expect((volleyTick - hitTick) * DT).toBeLessThan(bounceT);
    s.p[receiver].pos = pos;
    const ev = runUntil(s, (st, e) => st.phase.kind === 'dead' || e.some((x) => x.type === 'hit'), (st) =>
      forPlayer(receiver, st.tick === hitTick ? press('topspin') : NO_INPUT));
    expect(ofType(ev, 'commit')).toHaveLength(1);
    const hits = ofType(ev, 'hit');
    for (const h of hits) expect((h.tick - hitTick) * DT).toBeGreaterThanOrEqual(bounceT);
    const firstBounce = ev.findIndex((e) => e.type === 'bounce');
    expect(firstBounce).toBeGreaterThanOrEqual(0);
    if (hits.length > 0) expect(ev.indexOf(hits[0]!)).toBeGreaterThan(firstBounce);
  });

  /**
   * A slow, high kick serve by player 0 (deuce side) landing 0.95 tick before a tick boundary, with
   * player 1 committed and standing on the bounce point: on the first tick after the bounce the ball
   * is already back above minZ, so a contact exists on the bounce tick (direct set-up).
   */
  function kickOnto(target: Vec2): { s: ArcadeState; f: Flight; bounceTick: number } {
    const s = rallyState(0, { type: 'serveKick', contact: { x: 0.8, y: -12.185, z: 3 }, target, T: 89.05 / 60 }, 1);
    const f = s.flight!;
    const bounceTick = f.hit.tick + Math.ceil(f.bounces[0]!.t / DT);
    const ball = flightPos(f, (bounceTick - f.hit.tick) * DT);
    const pos = { x: ball.x, y: ball.y };
    expect(contactAt(1, pos, f, bounceTick, true)).not.toBeNull(); // the scenario is real
    expect(contactTickFor(f, 1, pos, f.hit.tick + 1, true)).toBe(bounceTick);
    s.p[1].pos = pos;
    return { s, f, bounceTick };
  }

  it('a serve that bounced out of the box is a fault even if the receiver meets it on the bounce tick', () => {
    const { s, f, bounceTick } = kickOnto({ x: -2, y: 7.5 });
    const ev = runUntil(s, (st) => st.phase.kind === 'dead', (st) => forPlayer(1, st.tick === f.hit.tick ? press('topspin') : NO_INPUT), 200);
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(ofType(ev, 'bounce')).toEqual([expect.objectContaining({ tick: bounceTick, inCourt: false })]);
    expect(ofType(ev, 'call')[0]).toMatchObject({ call: 'fault', player: 0 });
    expect(s.point.serveNo).toBe(2);
  });

  it('a serve that bounced in on the contact tick is reported, then returned', () => {
    const { s, f, bounceTick } = kickOnto({ x: -2, y: 5.5 });
    const ev = runUntil(s, untilType('hit'), (st) => forPlayer(1, st.tick === f.hit.tick ? press('topspin') : NO_INPUT), 200);
    expect(ev.map((e) => [e.type, e.tick])).toEqual([['commit', f.hit.tick + 1], ['bounce', bounceTick], ['hit', bounceTick]]);
    expect(ofType(ev, 'bounce')[0]!.inCourt).toBe(true);
  });

  it('a high ball near the net is smashed whatever key committed it, as a volley', () => {
    const s = rallyState(0, { type: 'lob', contact: { x: 0, y: -10, z: 1 }, target: { x: 0, y: 9 }, T: 1.6 });
    s.p[1].pos = { x: 0.5, y: 5 };
    const ev = runUntil(s, (st, e) => st.phase.kind === 'dead' || e.some((x) => x.type === 'hit'), (st) =>
      forPlayer(1, st.tick === st.flight!.hit.tick ? press('lob') : NO_INPUT), 200);
    const hit = ofType(ev, 'hit')[0]!;
    expect(hit.hit).toMatchObject({ player: 1, type: 'smash', volley: true });
    expect(hit.hit.contact.z).toBeGreaterThan(ARCADE.reach.smashZ);
    expect(s.p[1].lastSwing).toMatchObject({ stroke: 'smash' });
  });
});

describe('presses', () => {
  /** A kick serve in the air toward the receiver; returns the hit tick. */
  function serveInAir(seed = SEED): { s: ArcadeState; server: PlayerId; receiver: PlayerId; hitTick: number } {
    const { s } = matchInSetup(seed);
    const server = currentServer(s.score);
    scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 });
    return { s, server, receiver: other(server), hitTick: s.tick };
  }

  it('two shot keys pressed on one tick commit topspin (Review Focus 3)', () => {
    const a = serveInAir();
    const ev = runTicks(a.s, 1, () => forPlayer(a.receiver, press(['topspin', 'lob'])));
    expect(ofType(ev, 'commit')).toEqual([{ tick: a.hitTick + 1, type: 'commit', player: a.receiver, shot: 'topspin' }]);
    expect(a.s.p[a.receiver].commit).toMatchObject({ shot: 'topspin', tick: a.hitTick + 1 });

    const b = serveInAir();
    runTicks(b.s, 1, () => forPlayer(b.receiver, press(['lob', 'slice'])));
    expect(b.s.p[b.receiver].commit?.shot).toBe('slice');

    const c = serveInAir();
    runTicks(c.s, 1, () => forPlayer(c.receiver, press(['lob', 'slice', 'topspin'])));
    expect(c.s.p[c.receiver].commit?.shot).toBe('topspin');
  });

  it('two keys on the serve hit tick: topspin wins, so the serve is flat', () => {
    const { s } = matchInSetup(SEED);
    const ev = scriptedServe(s, { key: ['lob', 'topspin', 'slice'], tossKey: ['slice', 'lob'], hitDelayTicks: 42 });
    expect(ofType(ev, 'hit')[0]!.hit.type).toBe('serveFlat');
  });

  it('pressing slice after topspin switches the shot and keeps the commit tick', () => {
    const a = serveInAir();
    const ev = runTicks(a.s, 6, (st) => forPlayer(a.receiver, st.tick === a.hitTick ? press('topspin') : st.tick === a.hitTick + 4 ? press('slice') : NO_INPUT));
    expect(ofType(ev, 'commit')).toHaveLength(1);
    expect(a.s.p[a.receiver].commit).toMatchObject({ shot: 'slice', tick: a.hitTick + 1 });
  });

  it('a key held since before the set-up, never pressed again, does not commit', () => {
    const a = serveInAir();
    a.s.p[a.receiver].held = { topspin: true, slice: false, lob: false };
    const ev = runTicks(a.s, 5, () => forPlayer(a.receiver, press('topspin')));
    expect(ofType(ev, 'commit')).toEqual([]);
    expect(a.s.p[a.receiver].commit).toBeNull();
  });

  it("the hitter's press while their own ball flies waits for the return, without committing", () => {
    const a = serveInAir();
    const ev = runTicks(a.s, 10, (st) => forPlayer(a.server, st.tick === a.hitTick + 3 ? press('slice') : st.tick === a.hitTick + 6 ? press('lob') : NO_INPUT));
    expect(ofType(ev, 'commit')).toEqual([]);
    expect(a.s.p[a.server].commit).toBeNull();
    expect(a.s.p[a.server].pending).toBe('lob'); // the latest press
  });

  it('a pending press commits on the first tick the ball comes that way, charging from there', () => {
    const s = rallyState(1, { contact: { x: 0, y: 11, z: 1 }, target: { x: 0, y: -9 }, T: 1.0 });
    const hitTick = s.tick;
    s.p[0].pending = 'lob';
    const ev = runTicks(s, 1);
    expect(ofType(ev, 'commit')).toEqual([{ tick: hitTick + 1, type: 'commit', player: 0, shot: 'lob' }]);
    expect(s.p[0].commit).toMatchObject({ shot: 'lob', tick: hitTick + 1 });
    expect(s.p[0].pending).toBeNull();
  });

  it('a receiver press during the set-up or toss commits on the first tick after the serve', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const receiver = other(server);
    const setupTick = s.tick;
    const ev = scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42, receiver: (st) => (st.tick === setupTick + 20 ? press('slice') : NO_INPUT) });
    const hitTick = s.tick;
    expect(ofType(ev, 'commit')).toEqual([]);
    expect(s.p[receiver].pending).toBe('slice');
    const next = runTicks(s, 1);
    expect(ofType(next, 'commit')).toEqual([{ tick: hitTick + 1, type: 'commit', player: receiver, shot: 'slice' }]);
  });

  it("presses are forgotten at the player's own hit and when the point ends", () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 });
    expect(s.p[server].pending).toBeNull(); // the toss and serve presses are the server's own
    runTicks(s, 1, () => forPlayer(server, press('slice')));
    expect(s.p[server].pending).toBe('slice');
    runUntil(s, (st) => st.phase.kind === 'dead', IDLE, 400);
    expect(s.p[server].pending).toBeNull();
  });
});

describe('planted', () => {
  /** A deep rally ball to player 1 standing `lateral` m beside its path near its baseline; returns the state. */
  function incoming(lateral: number): ArcadeState {
    const s = rallyState(0, { contact: { x: 0, y: -12, z: 1 }, target: { x: 0, y: 9 }, T: 1.0 });
    const b = flightPos(s.flight!, 73 * DT);
    s.p[1].pos = { x: b.x + lateral, y: b.y };
    return s;
  }

  it('the commit sets the step target from stepSpot on the commit tick', () => {
    const s = incoming(1.2);
    const pos = { ...s.p[1].pos };
    runTicks(s, 1, () => forPlayer(1, press('topspin')));
    expect(s.p[1].commit!.step).toEqual(stepSpot(1, pos, s.flight!, s.tick, false));
  });

  it('a committed player ignores the direction keys and steps to the target', () => {
    const run = (mx: -1 | 0 | 1): Vec2 => {
      const s = incoming(1.3);
      runTicks(s, 1, () => forPlayer(1, press('topspin')));
      const from = { ...s.p[1].pos };
      const to = s.p[1].commit!.step!;
      expect(Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2)).toBeGreaterThan(0.4);
      runTicks(s, 40, () => forPlayer(1, hold({ mx, my: 1 })));
      expect(s.p[1].commit).not.toBeNull(); // still waiting for the ball
      expect(s.p[1].pos.x).toBeCloseTo(to.x, 2);
      expect(s.p[1].pos.y).toBeCloseTo(to.y, 2);
      return s.p[1].pos;
    };
    expect(run(-1)).toEqual(run(1));
  });

  it('a player committed far from the ball steps stepMax toward it and lets it pass', () => {
    const s = incoming(3.5);
    runTicks(s, 1, () => forPlayer(1, press('topspin')));
    const from = { ...s.p[1].pos };
    const ev = runUntil(s, untilType('point'), (st) => forPlayer(1, hold({ mx: 1 })), 400);
    expect(ofType(ev, 'hit')).toEqual([]);
    expect(ofType(ev, 'point')[0]).toMatchObject({ winner: 0, reason: 'winner' });
    const moved = Math.sqrt((s.p[1].pos.x - from.x) ** 2 + (s.p[1].pos.y - from.y) ** 2);
    expect(moved).toBeLessThanOrEqual(ARCADE.plant.stepMax + 1e-9);
  });

  it('an uncommitted player still runs freely', () => {
    const s = incoming(3.5);
    const x0 = s.p[1].pos.x;
    runTicks(s, 30, () => forPlayer(1, hold({ mx: 1 })));
    expect(Math.abs(s.p[1].pos.x - x0)).toBeGreaterThan(2);
  });
});

describe('game and match', () => {
  it('four straight aces win a game: game event, games [1, 0], the server changes, situations as core/scoring says', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    expect(server).toBe(0);
    for (let i = 0; i < 4; i++) {
      if (i > 0) runUntil(s, untilType('setup'));
      const ev = serveAce(s);
      expect(ofType(ev, 'point')).toEqual([{ tick: s.tick, type: 'point', winner: server, reason: 'ace' }]);
      const sit = situation(s.score);
      expect(ofType(ev, 'situation').map((e) => e.text)).toEqual(sit === null ? [] : [sit]);
      expect(ofType(ev, 'game')).toEqual(i === 3 ? [{ tick: s.tick, type: 'game', winner: server }] : []);
      const last = ev.slice(ev.findIndex((e) => e.type === 'call'));
      expect(last.map((e) => e.type)).toEqual(['call', 'point', ...(i === 3 ? ['game'] : []), ...(sit === null ? [] : ['situation'])]);
      if (i === 3) expect(s.phase).toEqual({ kind: 'dead', until: s.tick + 288, next: 'setup' });
    }
    expect(s.score.games).toEqual([1, 0]);
    expect(s.stats[0].aces).toBe(4);
    const next = runUntil(s, untilType('setup'));
    expect(ofType(next, 'setup')[0]).toMatchObject({ server: 1, serveNo: 1, side: 'deuce' });
  });

  it('situation events follow core/scoring (BREAK POINT at 0–40)', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = runUntil(s, untilType('point')); // double fault by the clock
      seen.push(...ofType(ev, 'situation').map((e) => e.text));
      if (i < 2) runUntil(s, untilType('setup'));
    }
    expect(s.score.points[other(server)]).toBe(3);
    expect(seen).toEqual(['BREAK POINT']);
  });

  it('a tiebreak match ends: match event, status over, then step is a no-op after overHold', () => {
    const { s } = matchInSetup(SEED, { ...CONFIG, format: 'tiebreak' });
    const a = currentServer(s.score);
    const all: ArcadeEvent[] = [];
    // a wins every point: aces on its serve, double faults (serve clock) on the other's.
    for (let i = 0; i < 20 && s.status === 'playing'; i++) {
      if (s.phase.kind !== 'setup') all.push(...runUntil(s, untilType('setup')));
      all.push(...(currentServer(s.score) === a ? serveAce(s) : runUntil(s, untilType('point'))));
    }
    expect(ofType(all, 'match')).toEqual([{ tick: s.tick, type: 'match', winner: a }]);
    expect(ofType(all, 'set')).toEqual([{ tick: s.tick, type: 'set', winner: a }]);
    expect(s.status).toBe('over');
    expect(s.winner).toBe(a);
    expect(s.score.setsWon[a]).toBe(1);
    expect(ofType(all, 'point')).toHaveLength(7);
    expect(ofType(all, 'situation').map((e) => e.text)).toContain('MATCH POINT');
    const last = all.slice(all.findIndex((e) => e.type === 'point' && e.tick === s.tick));
    expect(last.map((e) => e.type)).toEqual(['point', 'game', 'set', 'match']);
    expect(s.phase).toEqual({ kind: 'dead', until: s.tick + 288, next: 'over' });

    const overAt = s.tick + 288;
    runUntil(s, (st) => st.phase.kind === 'over');
    expect(s.tick).toBe(overAt);
    expect(s.phase).toEqual({ kind: 'over', since: overAt });
    runTicks(s, 179);
    expect(s.tick).toBe(overAt + 179);
    expect(step(s, [press('topspin'), press('topspin')])).toEqual([]);
    expect(s.tick).toBe(overAt + 180);
    const frozen = JSON.stringify(s);
    expect(step(s, [press('slice'), hold({ mx: 1 })])).toEqual([]);
    expect(step(s, [NO_INPUT, NO_INPUT])).toEqual([]);
    expect(JSON.stringify(s)).toBe(frozen);
  });
});

describe('queries', () => {
  it('flightTime, ballAt and receiverOf follow the live flight', () => {
    const { s } = matchInSetup(SEED);
    const server = currentServer(s.score);
    expect(flightTime(s, s.tick * DT)).toBeNull();
    expect(receiverOf(s)).toBeNull();
    scriptedServe(s, { key: 'lob', tossKey: 'topspin', hitDelayTicks: 42 });
    const f = s.flight!;
    const t = (s.tick + 3.25) * DT;
    expect(flightTime(s, t)).toBeCloseTo(3.25 * DT, 12);
    expect(ballAt(s, t)).toEqual(flightPos(f, t - f.hit.tick * DT));
    expect(receiverOf(s)).toBe(other(server));
    expect(ballAt(s, f.hit.tick * DT + f.tGone + 0.01)).toBeNull();
  });
});

describe('determinism', () => {
  it('a recorded 600-tick input script replays identically, and the state round-trips through JSON', () => {
    const rng = seedRng(99);
    const script: Inputs[] = [];
    let held: Inputs = [NO_INPUT, NO_INPUT];
    for (let i = 0; i < 600; i++) {
      if (i % 6 === 0) held = [randomInput(rng), randomInput(rng)];
      script.push(held);
    }
    const run = (): { s: ArcadeState; ev: ArcadeEvent[] } => {
      const s = createMatch(CONFIG, PLAYERS, 7);
      const ev: ArcadeEvent[] = [];
      for (const inp of script) ev.push(...step(s, inp));
      return { s, ev };
    };
    const a = run();
    const b = run();
    expect(a.ev).toEqual(b.ev);
    expect(a.s).toEqual(b.s);
    expect(ofType(a.ev, 'hit').length).toBeGreaterThan(0);
    expectJsonSafe(a.s);
    expect(JSON.stringify(JSON.parse(JSON.stringify(a.s)))).toBe(JSON.stringify(a.s));

    // A JSON copy steps on exactly like the original.
    const copy = JSON.parse(JSON.stringify(a.s)) as ArcadeState;
    const more = script.slice(0, 300);
    const e1 = more.flatMap((inp) => step(a.s, inp));
    const e2 = more.flatMap((inp) => step(copy, inp));
    expect(e2).toEqual(e1);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(a.s));
  });
});
