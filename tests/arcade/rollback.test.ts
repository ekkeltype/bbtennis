import { describe, expect, it } from 'vitest';
import { ArcadeCpu } from '../../src/arcade/core/cpu';
import { createMatch, step } from '../../src/arcade/core/match';
import { NO_INPUT, type ArcadeEvent, type ArcadeState, type PlayerId, type PlayerInput } from '../../src/arcade/core/types';
import { NET, Rollback, stateHash } from '../../src/arcade/game/rollback';
import { seedRng, intBelow } from '../../src/core/rng';
import { currentServer } from '../../src/core/scoring';
import { CONFIG, PLAYERS } from './matchHelpers';

const D = NET.inputDelay;

/** A recorded CPU-vs-CPU match: each player's input per tick (none for ticks 1..D), its events and the state after each tick's JSON at checkpoints. */
interface Recording { inputs: [PlayerInput[], PlayerInput[]]; events: ArcadeEvent[]; final: ArcadeState; ticks: number }

/** Plays `ticks` ticks of CPU (Brown) vs CPU (Black) with plain step(), recording both players' inputs; ticks 1..D have none, as online. */
function record(seed: number, ticks: number): Recording {
  const s = createMatch(CONFIG, PLAYERS, seed);
  const cpus = [new ArcadeCpu(0, 9, seed), new ArcadeCpu(1, 12, seed)] as const;
  const inputs: [PlayerInput[], PlayerInput[]] = [[NO_INPUT], [NO_INPUT]];
  const events: ArcadeEvent[] = [];
  for (let t = 1; t <= ticks; t++) {
    const i0 = t <= D ? NO_INPUT : cpus[0].input(s);
    const i1 = t <= D ? NO_INPUT : cpus[1].input(s);
    inputs[0][t] = i0;
    inputs[1][t] = i1;
    events.push(...step(s, [i0, i1]));
  }
  return { inputs, events, final: s, ticks };
}

const json = (e: ArcadeEvent): string => JSON.stringify(e);

/**
 * Replays `rec` on one Rollback side (`local`): its own inputs as if sampled live (tick n + D's input at
 * step n) and the opponent's true inputs delivered late, `lag()` ticks behind, in batches of `batch()`.
 */
function replay(rec: Recording, local: PlayerId, lag: () => number, batch: () => number): { rb: Rollback; shown: ArcadeEvent[] } {
  const rb = new Rollback(createMatch(CONFIG, PLAYERS, SEED), local);
  const remote = local === 0 ? 1 : 0;
  const shown: ArcadeEvent[] = [];
  let delivered: number = D;
  const deliver = (upTo: number): void => {
    while (delivered < Math.min(upTo, rec.ticks)) {
      const first = delivered + 1;
      const last = Math.min(upTo, rec.ticks, first + batch() - 1);
      shown.push(...rb.receive(first, rec.inputs[remote].slice(first, last + 1)));
      delivered = last;
    }
  };
  for (let n = 1; n <= rec.ticks; n++) {
    deliver(n - lag());
    while (!rb.canStep()) deliver(delivered + 1);
    shown.push(...rb.step(n + D <= rec.ticks ? rec.inputs[local][n + D]! : NO_INPUT));
  }
  deliver(rec.ticks);
  return { rb, shown };
}

const SEED = 20261023;
const REC = record(SEED, 3600);

describe('Rollback: late opponent inputs change nothing but the opponent (Review Focus 1)', () => {
  it('the recording has real play in it', () => {
    expect(REC.events.filter((e) => e.type === 'hit').length).toBeGreaterThan(20);
    expect(REC.events.filter((e) => e.type === 'point').length).toBeGreaterThan(3);
  });

  for (const local of [0, 1] as const) {
    it(`player ${local}: with inputs up to 12 ticks late in odd batches, the final state is the plain run's`, () => {
      const r = seedRng(local + 5);
      const { rb } = replay(REC, local, () => intBelow(r, 13), () => 1 + intBelow(r, 7));
      expect(rb.tick).toBe(REC.ticks);
      expect(rb.confirmed).toBe(REC.ticks);
      expect(rb.state).toEqual(REC.final);
      expect(rb.stats.rollbacks).toBeGreaterThan(10);
      expect(rb.stats.maxDepth).toBeLessThanOrEqual(NET.maxPredict);
    });
  }

  it('every event of the plain run is shown, and none twice', () => {
    const r = seedRng(9);
    const { shown } = replay(REC, 0, () => intBelow(r, 13), () => 1 + intBelow(r, 4));
    const seen = new Map<string, number>();
    for (const e of shown) seen.set(json(e), (seen.get(json(e)) ?? 0) + 1);
    for (const e of REC.events) expect(seen.get(json(e)), json(e)).toBeGreaterThanOrEqual(1);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it('with inputs on time it never rolls back and shows exactly the plain run\'s events', () => {
    const { rb, shown } = replay(REC, 1, () => 0, () => 1);
    expect(rb.stats.rollbacks).toBe(0);
    expect(shown.map(json)).toEqual(REC.events.map(json));
  });
});

describe('Rollback: prediction and the window', () => {
  it('stalls once 15 ticks would be predicted, and goes on when inputs come', () => {
    const rb = new Rollback(createMatch(CONFIG, PLAYERS, SEED), 0);
    let n = 0;
    while (rb.canStep()) {
      rb.step(NO_INPUT);
      n++;
    }
    expect(rb.tick).toBe(D + NET.maxPredict);
    expect(n).toBe(rb.tick);
    rb.receive(D + 1, [NO_INPUT, NO_INPUT]);
    expect(rb.canStep()).toBe(true);
  });

  it("predicts the opponent's last input: a held shot key stays held, so no press is invented", () => {
    // Find a seed where player 1 serves first, then let it toss with one press and go silent.
    let seed = 1;
    while (currentServer(createMatch(CONFIG, PLAYERS, seed).score) !== 1) seed++;
    const rb = new Rollback(createMatch(CONFIG, PLAYERS, seed), 0);
    const SETUP = 130;
    const remote: PlayerInput[] = [];
    for (let t = D + 1; t <= SETUP; t++) remote.push(NO_INPUT);
    remote.push({ ...NO_INPUT, topspin: true });
    rb.receive(D + 1, remote);
    const events: ArcadeEvent[] = [];
    while (rb.canStep()) events.push(...rb.step(NO_INPUT));
    expect(events.filter((e) => e.type === 'toss')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'hit')).toHaveLength(0);
    expect(rb.state.p[1].held.topspin).toBe(true);
  });

  it('keeps snapshots only for predicted ticks and inputs only for the last 10 s', () => {
    const r = seedRng(3);
    const { rb } = replay(REC, 0, () => intBelow(r, 13), () => 1 + intBelow(r, 7));
    const inner = rb as unknown as { snaps: Map<number, unknown>; used: Map<number, unknown>; shown: Map<number, unknown>; localIn: Map<number, unknown>; remoteIn: Map<number, unknown> };
    expect(inner.snaps.size).toBe(0);
    expect(inner.used.size).toBe(0);
    expect(inner.shown.size).toBe(0);
    expect(inner.localIn.size).toBeLessThanOrEqual(NET.keepTicks + D + 1);
    expect(inner.remoteIn.size).toBeLessThanOrEqual(NET.keepTicks + 1);
  });

  it('keeps inputs that arrive past a gap until the gap fills, and skips ticks it already has', () => {
    const rb = new Rollback(createMatch(CONFIG, PLAYERS, SEED), 0);
    const right = { ...NO_INPUT, mx: 1 as const };
    expect(rb.receive(D + 3, [right, right])).toEqual([]);
    expect(rb.receive(D + 1, [])).toEqual([]);
    expect(rb.lastRemote).toBe(D);
    rb.receive(D + 1, [NO_INPUT, NO_INPUT]);
    expect(rb.lastRemote).toBe(D + 4);
    // A repeat of known ticks changes nothing: the first input of a tick stands.
    rb.receive(D + 1, [right, right, NO_INPUT, NO_INPUT, right]);
    expect(rb.lastRemote).toBe(D + 5);
    const inner = rb as unknown as { remoteIn: Map<number, PlayerInput> };
    expect(inner.remoteIn.get(D + 1)).toEqual(NO_INPUT);
    expect(inner.remoteIn.get(D + 3)).toEqual(right);
  });

  it('out-of-order batches still end on the plain run\'s state', () => {
    const rb = new Rollback(createMatch(CONFIG, PLAYERS, SEED), 1);
    const r = seedRng(31);
    let sent: number = D;
    const queue: { first: number; inputs: PlayerInput[] }[] = [];
    for (let n = 1; n <= REC.ticks; n++) {
      // Batches of 1–3 ticks, 4 ticks behind; now and then two swap places on the way.
      while (sent < Math.min(n - 4, REC.ticks)) {
        const first = sent + 1;
        const last = Math.min(first + intBelow(r, 3), REC.ticks);
        queue.push({ first, inputs: REC.inputs[0].slice(first, last + 1) });
        sent = last;
      }
      if (queue.length >= 2 && intBelow(r, 4) === 0) queue.splice(0, 2, queue[1]!, queue[0]!);
      while (queue.length > 1) {
        const b = queue.shift()!;
        rb.receive(b.first, b.inputs);
      }
      while (!rb.canStep()) {
        const b = queue.shift();
        if (b === undefined) break;
        rb.receive(b.first, b.inputs);
      }
      rb.step(n + D <= REC.ticks ? REC.inputs[1][n + D]! : NO_INPUT);
    }
    for (const b of queue) rb.receive(b.first, b.inputs);
    if (sent < REC.ticks) rb.receive(sent + 1, REC.inputs[0].slice(sent + 1, REC.ticks + 1));
    expect(rb.confirmed).toBe(REC.ticks);
    expect(rb.state).toEqual(REC.final);
  });

  it('hands out its own inputs once each, from tick D + 1', () => {
    const rb = new Rollback(createMatch(CONFIG, PLAYERS, SEED), 1);
    expect(rb.takeLocal()).toBeNull();
    const a = { ...NO_INPUT, mx: 1 as const };
    rb.step(a);
    rb.step(NO_INPUT);
    expect(rb.takeLocal()).toEqual({ first: D + 1, inputs: [a, NO_INPUT] });
    expect(rb.takeLocal()).toBeNull();
  });
});

/** Two sides playing the recording to each other over a lossless link `delay()` ticks long each way. */
function duel(rec: Recording, delay: () => number, tamper?: (guest: Rollback) => void) {
  const sides = [new Rollback(createMatch(CONFIG, PLAYERS, SEED), 0), new Rollback(createMatch(CONFIG, PLAYERS, SEED), 1)] as const;
  type Packet = { at: number; first: number; inputs: PlayerInput[] } | { at: number; sum: { tick: number; hash: number } };
  const wires: [Packet[], Packet[]] = [[], []];
  const mismatches: number[][] = [[], []];
  for (let n = 1; n <= rec.ticks + 30; n++) {
    for (const p of [0, 1] as const) {
      const rb = sides[p];
      const inbox = wires[p];
      while (inbox.length > 0 && inbox[0]!.at <= n) {
        const m = inbox.shift()!;
        if ('first' in m) rb.receive(m.first, m.inputs);
        else rb.noteRemoteSum(m.sum.tick, m.sum.hash);
      }
      if (n <= rec.ticks && rb.canStep()) rb.step(rb.tick + 1 + D <= rec.ticks ? rec.inputs[p][rb.tick + 1 + D]! : NO_INPUT);
      if (p === 1 && n === 900) tamper?.(rb);
      const out = wires[p === 0 ? 1 : 0];
      const at = Math.max(n + delay(), out.at(-1)?.at ?? 0);
      const mine = rb.takeLocal();
      if (mine) out.push({ at, first: mine.first, inputs: mine.inputs });
      for (const sum of rb.takeSums()) out.push({ at, sum });
      mismatches[p]!.push(...rb.takeMismatches());
    }
  }
  return { sides, mismatches };
}

describe('Rollback: two sides', () => {
  it('end on the same state as the plain run, with matching hashes, at 2–9 ticks of latency', () => {
    const r = seedRng(11);
    const { sides, mismatches } = duel(REC, () => 2 + intBelow(r, 8));
    for (const rb of sides) {
      expect(rb.tick).toBe(REC.ticks);
      expect(rb.state).toEqual(REC.final);
    }
    expect(mismatches).toEqual([[], []]);
  });

  it('a corrupted side is found at the next checkpoint and repaired by adopting the other side\'s confirmed state', () => {
    const r = seedRng(12);
    // A lasting difference (stats are never reset), in the live state and every kept snapshot, as a sim bug would make it.
    const { sides, mismatches } = duel(REC, () => 3 + intBelow(r, 4), (guest) => {
      const snaps = (guest as unknown as { snaps: Map<number, ArcadeState> }).snaps;
      for (const s of [guest.state, ...snaps.values()]) s.stats[1].hits += 7;
    });
    expect(mismatches[0]!.length).toBeGreaterThan(0);
    expect(mismatches[1]!.length).toBeGreaterThan(0);
    expect(sides[1].state).not.toEqual(REC.final);
    // The host's confirmed state, adopted by the guest, puts it back on the plain run.
    const host = sides[0];
    const { tick, state } = host.confirmedState();
    expect(tick).toBe(REC.ticks);
    sides[1].adopt(tick, state);
    expect(sides[1].state).toEqual(REC.final);
  });
});

describe('Rollback: adopt', () => {
  it('re-simulates from the adopted tick with the inputs it has, showing only events after its confirmed tick', () => {
    const r = seedRng(21);
    const { rb } = replay(REC, 0, () => intBelow(r, 10), () => 1 + intBelow(r, 3));
    // Take the plain run's state at tick 2400 and let the replayed side adopt it: it must land on the final state again.
    const s = createMatch(CONFIG, PLAYERS, SEED);
    for (let t = 1; t <= 2400; t++) step(s, [REC.inputs[0][t]!, REC.inputs[1][t]!]);
    const shown = rb.adopt(2400, structuredClone(s));
    expect(rb.state).toEqual(REC.final);
    expect(shown).toEqual([]);
  });

  it('keeps the live state object (renderers key on it)', () => {
    const r = seedRng(22);
    const { rb } = replay(REC, 1, () => intBelow(r, 10), () => 2);
    const live = rb.state;
    rb.adopt(rb.tick, structuredClone(REC.final));
    expect(rb.state).toBe(live);
  });

  it('a state for a tick not reached yet is adopted on reaching it', () => {
    const rb = new Rollback(createMatch(CONFIG, PLAYERS, SEED), 1);
    const s = createMatch(CONFIG, PLAYERS, SEED);
    for (let t = 1; t <= 2; t++) step(s, [NO_INPUT, NO_INPUT]);
    s.p[0].pos.x = 1.25;
    expect(rb.adopt(2, s)).toEqual([]);
    expect(rb.tick).toBe(0);
    rb.step(NO_INPUT);
    rb.step(NO_INPUT);
    expect(rb.state.p[0].pos.x).toBe(1.25);
  });
});

describe('stateHash', () => {
  it('is the same for equal states and differs for a moved player', () => {
    const a = createMatch(CONFIG, PLAYERS, SEED);
    const b = structuredClone(a);
    expect(stateHash(a)).toBe(stateHash(b));
    b.p[0].pos.x += 1e-9;
    expect(stateHash(a)).not.toBe(stateHash(b));
    expect(stateHash(a)).toBeGreaterThanOrEqual(0);
    expect(stateHash(a)).toBeLessThanOrEqual(0xffffffff);
  });
});
