import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArcadeCpu } from '../../src/arcade/core/cpu';
import { createMatch, step } from '../../src/arcade/core/match';
import { NO_INPUT, type ArcadeConfig, type ArcadeState, type Controller, type PlayerInfo, type PlayerInput } from '../../src/arcade/core/types';
import { ArcadeOnlineSession, STALL_MS, type MatchStart } from '../../src/arcade/game/onlineSession';
import { NET, type Rollback } from '../../src/arcade/game/rollback';
import { ARCADE_CODEC, unpackInput, type ArcadeMsg } from '../../src/arcade/net/protocol';
import type { Look, Profile } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { loopbackPair, type Transport } from '../../src/net/channel';

const LOOK = { skin: 1, hairStyle: 2, hair: 3, shirt: 4, shorts: 5, headband: null, racket: 1 };
const HANA = { name: 'Hana', look: LOOK };
const GUS = { name: 'Gus', look: { ...LOOK, shirt: 9 } };
const CONFIG: ArcadeConfig = { format: 'tiebreak', deuceRule: 'advantage', surface: 'hard', pace: 'normal' };
const FRAME_MS = 16;

/** A transport that records what it sends and can hold everything back (a dead or frozen link). */
interface Wire extends Transport<ArcadeMsg> {
  sent: ArcadeMsg[];
  /** While set, messages are held back instead of sent, in order. */
  hold: boolean;
  /** While set, messages are dropped (the side has gone silent). */
  mute: boolean;
  release(): void;
}

function wire(t: Transport<ArcadeMsg>): Wire {
  const held: ArcadeMsg[] = [];
  const w: Wire = {
    sent: [],
    hold: false,
    mute: false,
    send(m) {
      if (w.mute) return;
      w.sent.push(m);
      if (w.hold) held.push(m);
      else t.send(m);
    },
    release() {
      w.hold = false;
      for (const m of held.splice(0)) t.send(m);
    },
    onMessage: (cb) => t.onMessage(cb),
    onClose: (cb) => t.onClose(cb),
    close: () => t.close(),
    get bufferedAmount() {
      return t.bufferedAmount;
    },
  };
  return w;
}

interface Duel {
  s: VirtualScheduler;
  host: ArcadeOnlineSession;
  guest: ArcadeOnlineSession;
  hostNet: Wire;
  guestNet: Wire;
  start: MatchStart;
}

/**
 * Host and guest over a loopback link (`latencyMs` + up to `jitterMs` one way), each played by a CPU
 * reading its own side's (predicted) state. The guest's session starts once the host's `start` has
 * reached it, as the join screen hands it over.
 */
function duel(o: { latencyMs: number; jitterMs: number; seed?: number; levels?: [number, number]; players?: [Profile, Profile] }): Duel {
  const s = new VirtualScheduler(1000);
  const [a, b] = loopbackPair(s, { latencyMs: o.latencyMs, jitterMs: o.jitterMs, seed: 5 }, ARCADE_CODEC);
  const hostNet = wire(a);
  const guestNet = wire(b);
  const ticker = (ms: number, fn: () => void): (() => void) => s.every(ms, fn);
  const seed = o.seed ?? 2026;
  const [l0, l1] = o.levels ?? [10, 12];
  const start: MatchStart = { config: CONFIG, seed, players: o.players ?? [HANA, GUS] };
  let rematchSeed = 7000;
  const host = new ArcadeOnlineSession({
    transport: hostNet,
    scheduler: s,
    controller: new ArcadeCpu(0, l0, seed),
    host: { first: start, seed: () => rematchSeed++ },
    ticker,
  });
  s.advance(o.latencyMs + o.jitterMs + 1);
  const guest = new ArcadeOnlineSession({ transport: guestNet, scheduler: s, controller: new ArcadeCpu(1, l1, seed), host: null, ticker });
  return { s, host, guest, hostNet, guestNet, start };
}

/** Runs both sides' frames every 16 ms (their tickers run too) until `until` holds or `limitMs` passes. */
function play(d: Duel, until: () => boolean, limitMs: number, frames: { host: boolean; guest: boolean } = { host: true, guest: true }): void {
  const end = d.s.now() + limitMs;
  while (!until() && d.s.now() < end) {
    d.s.advance(FRAME_MS);
    if (frames.host) d.host.frame(FRAME_MS);
    if (frames.guest) d.guest.frame(FRAME_MS);
  }
}

const bothOver = (d: Duel) => (): boolean => d.host.over && d.guest.over;

/** Every input `w`'s side sent in match `m`, by tick (ticks 1..inputDelay have none). */
function inputsSent(w: Wire, m: number): Map<number, PlayerInput> {
  const out = new Map<number, PlayerInput>();
  for (const msg of w.sent) if (msg.type === 'in' && msg.m === m) msg.i.forEach((n, k) => out.set(msg.t + k, unpackInput(n)));
  return out;
}

/** The match replayed with plain step() from both sides' sent inputs, to `ticks`. */
function replay(d: Duel, ticks: number, m = 1, seed = d.start.seed): ArcadeState {
  const info = (p: { name: string; look: typeof LOOK }): PlayerInfo => ({ ...p, kind: 'human', cpuLevel: null });
  const s = createMatch(CONFIG, [info(HANA), info(GUS)], seed);
  const i0 = inputsSent(d.hostNet, m);
  const i1 = inputsSent(d.guestNet, m);
  for (let t = 1; t <= ticks; t++) step(s, [i0.get(t) ?? NO_INPUT, i1.get(t) ?? NO_INPUT]);
  return s;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an online match (online spec §3)', () => {
  for (const [latencyMs, jitterMs] of [
    [0, 0],
    [40, 20],
    [120, 40],
  ] as const) {
    it(`at ${latencyMs}±${jitterMs / 2} ms one way: played out, both sides end on the same state, the plain replay of their inputs`, () => {
      const warn = vi.spyOn(console, 'warn');
      const d = duel({ latencyMs, jitterMs });
      play(d, bothOver(d), 15 * 60_000);
      expect(d.host.endReason).toBe('finished');
      expect(d.guest.endReason).toBe('finished');
      const a = d.host.result!;
      const b = d.guest.result!;
      expect(a.status).toBe('over');
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(replay(d, a.tick))).toBe(JSON.stringify(a));
      const hs = d.host.netStats();
      const gs = d.guest.netStats();
      expect(hs.desyncs + gs.desyncs).toBe(0);
      expect(warn).not.toHaveBeenCalled();
      // The two sides hashed the same states at every checkpoint both sent.
      for (const t of Object.keys(hs.sums)) if (gs.sums[Number(t)] !== undefined) expect(gs.sums[Number(t)]).toBe(hs.sums[Number(t)]);
      expect(Object.keys(hs.sums).length).toBeGreaterThan(30);
      if (latencyMs > 0) expect(hs.rollbacks + gs.rollbacks).toBeGreaterThan(0);
      if (latencyMs >= 120) expect(Math.max(hs.maxDepth, gs.maxDepth)).toBeLessThanOrEqual(NET.maxPredict);
    });
  }

  it('the guest plays player 1 and sees its own end; the host plays player 0', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => false, 500);
    expect(d.host.viewer).toBe(0);
    expect(d.guest.viewer).toBe(1);
    expect(d.guest.view?.viewer).toBe(1);
    expect(d.host.view?.overlay).toMatchObject({ paused: false, countdown: null, net: { unstable: false } });
  });

  it('the two clocks stay within a couple of ticks of each other', () => {
    const d = duel({ latencyMs: 80, jitterMs: 30 });
    play(d, () => false, 6000);
    const gap = Math.abs(d.host.netStats().tick - d.guest.netStats().tick);
    expect(gap).toBeLessThanOrEqual(3);
  });
});

describe('a link that stops (online spec §3.2, §3.5)', () => {
  it('a hidden tab (no frames) keeps both sides moving on its ticker (Review Focus 2)', () => {
    const d = duel({ latencyMs: 40, jitterMs: 10 });
    play(d, () => false, 2000);
    const before = [d.host.netStats().tick, d.guest.netStats().tick];
    play(d, () => false, 3000, { host: true, guest: false });
    const after = [d.host.netStats().tick, d.guest.netStats().tick];
    expect(after[0]! - before[0]!).toBeGreaterThan(170);
    expect(after[1]! - before[1]!).toBeGreaterThan(170);
    expect(d.host.netStats().stalls).toBe(0);
  });

  it('a frozen link stalls the other side (CONNECTION UNSTABLE after 1 s), and play goes on when it thaws', () => {
    const d = duel({ latencyMs: 40, jitterMs: 10 });
    play(d, () => false, 3000);
    d.guestNet.hold = true;
    play(d, () => false, 300);
    const stalledAt = d.host.netStats().tick;
    play(d, () => false, STALL_MS + 200);
    expect(d.host.netStats().tick).toBe(stalledAt);
    expect(d.host.view?.overlay.net?.unstable).toBe(true);
    d.guestNet.release();
    play(d, () => false, 1000);
    expect(d.host.netStats().tick).toBeGreaterThan(stalledAt + 30);
    expect(d.host.view?.overlay.net?.unstable).toBe(false);
    play(d, bothOver(d), 15 * 60_000);
    expect(JSON.stringify(d.guest.result)).toBe(JSON.stringify(d.host.result));
  });

  it('8 s of silence is a disconnect', () => {
    const d = duel({ latencyMs: 20, jitterMs: 0 });
    play(d, () => false, 2000);
    d.guestNet.mute = true;
    play(d, () => d.host.over, 10_000);
    expect(d.host.endReason).toBe('disconnect');
    expect(d.host.opponentGone).toBe('disconnect');
    expect(d.host.mayRematch).toBe(false);
  });
});

describe('the end of a match (online spec §3.6)', () => {
  it('a forfeit ends it on both sides at once, naming who forfeited (Review Focus 4)', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => false, 3000);
    d.guest.forfeit();
    expect(d.guest.over).toBe(true);
    expect(d.guest.forfeitBy).toBe(1);
    play(d, () => d.host.over, 1000);
    expect(d.host.endReason).toBe('forfeit');
    expect(d.host.forfeitBy).toBe(1);
    expect(d.host.result).not.toBeNull();
  });

  it('both screens show the same Results after a forfeit, wherever it falls, even 120 ms apart', () => {
    for (let k = 0; k < 12; k++) {
      const d = duel({ latencyMs: 120, jitterMs: 40, seed: 300 + k });
      play(d, () => false, 2000 + k * 731);
      (k % 2 === 0 ? d.host : d.guest).forfeit();
      play(d, bothOver(d), 2000);
      expect(d.host.endReason).toBe('forfeit');
      expect(d.guest.endReason).toBe('forfeit');
      expect(JSON.stringify(d.guest.result), `forfeit ${k}`).toBe(JSON.stringify(d.host.result));
      // Later inputs change nothing on show.
      const shown = JSON.stringify(d.host.result);
      play(d, () => false, 500);
      expect(JSON.stringify(d.host.result)).toBe(shown);
      d.host.dispose();
      d.guest.dispose();
    }
  });

  it('a forfeit once the match is decided does nothing: its Results come as played out', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => d.host.view?.state.status === 'over', 15 * 60_000);
    d.host.forfeit();
    expect(d.host.over).toBe(false);
    expect(d.hostNet.sent.some((m) => m.type === 'forfeit')).toBe(false);
    play(d, bothOver(d), 10_000);
    expect(d.host.endReason).toBe('finished');
    expect(d.guest.endReason).toBe('finished');
  });

  it('an opponent who leaves once the match is decided does not undo it: played out, with the departure noted (Review Focus 4)', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => d.host.view?.state.status === 'over' && d.guest.view?.state.status === 'over', 15 * 60_000);
    play(d, () => false, 500);
    expect(d.host.over).toBe(false); // the 3 s celebration is still on
    d.guest.leave();
    play(d, () => d.host.over, 1000);
    expect(d.host.endReason).toBe('finished');
    expect(d.host.opponentGone).toBe('left');
    expect(d.host.result?.status).toBe('over');
    expect(d.host.result?.winner).not.toBeNull();
    expect(d.host.mayRematch).toBe(false);
  });

  it('a player who leaves mid-match ends it for the other as left; leaving twice tells once', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => false, 2000);
    d.host.leave();
    d.host.leave();
    expect(d.hostNet.sent.filter((m) => m.type === 'leave')).toHaveLength(1);
    play(d, () => d.guest.over, 1000);
    expect(d.guest.endReason).toBe('left');
    expect(d.guest.opponentGone).toBe('left');
  });

  it('rematch: once both ask, the host starts match 2 on a new seed and both play it out alike (Review Focus 5)', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => false, 3000);
    d.host.forfeit();
    play(d, bothOver(d), 1000);
    expect(d.guest.mayRematch).toBe(true);
    d.guest.rematch();
    play(d, () => false, 200);
    expect(d.host.over).toBe(true);
    d.host.rematch();
    play(d, () => !d.guest.over, 1000);
    expect(d.host.over).toBe(false);
    expect(d.guest.over).toBe(false);
    const start2 = d.hostNet.sent.filter((m) => m.type === 'start');
    expect(start2.map((m) => m.type === 'start' && [m.m, m.seed])).toEqual([[1, 2026], [2, 7000]]);
    play(d, bothOver(d), 15 * 60_000);
    expect(d.host.endReason).toBe('finished');
    expect(JSON.stringify(d.guest.result)).toBe(JSON.stringify(d.host.result));
    expect(JSON.stringify(replay(d, d.host.result!.tick, 2, 7000))).toBe(JSON.stringify(d.host.result));
  });

  it('no rematch once the opponent has gone', () => {
    const d = duel({ latencyMs: 20, jitterMs: 0 });
    play(d, () => false, 2000);
    d.host.forfeit();
    play(d, bothOver(d), 1000);
    d.host.leave();
    play(d, () => d.guest.opponentGone !== null, 1000);
    expect(d.guest.mayRematch).toBe(false);
    d.guest.rematch();
    expect(d.guestNet.sent.some((m) => m.type === 'rematch')).toBe(false);
  });

  it('inputs of the old match that arrive after a rematch began are ignored', () => {
    const d = duel({ latencyMs: 30, jitterMs: 0 });
    play(d, () => false, 2000);
    d.host.forfeit();
    play(d, bothOver(d), 1000);
    d.host.rematch();
    d.guest.rematch();
    play(d, () => !d.guest.over, 1000);
    play(d, () => false, 3000);
    const g = d.guest as unknown as { rb: Rollback; receive(m: ArcadeMsg): void };
    const last = g.rb.lastRemote;
    // Old-match inputs that would continue match 2's are not taken…
    g.receive({ type: 'in', m: 1, t: last + 1, i: [36, 36, 36], adv: 0 });
    expect(g.rb.lastRemote).toBe(last);
    // …while the same with match 2's number would be.
    g.receive({ type: 'in', m: 2, t: last + 1, i: [36, 36, 36], adv: 0 });
    expect(g.rb.lastRemote).toBe(last + 3);
  });
});

describe('profiles and hidden tabs', () => {
  it('a host whose stored look has another key order and an extra key still hashes the states the guest does', () => {
    const odd = { name: 'Hana', look: { racket: 1, shorts: 5, shirt: 4, hair: 3, hairStyle: 2, skin: 1, headband: null, extra: 9 } as unknown as Look };
    const warn = vi.spyOn(console, 'warn');
    const d = duel({ latencyMs: 40, jitterMs: 10, players: [odd, GUS] });
    play(d, () => false, 8000);
    expect(d.host.netStats().desyncs + d.guest.netStats().desyncs).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(Object.keys(d.host.view!.state.players[0].look)).toEqual(['skin', 'hairStyle', 'hair', 'shirt', 'shorts', 'headband', 'racket']);
  });

  it('back from a hidden spell, the first frame does not replay the backlog: only the last 300 ms of events, and the current call\'s', () => {
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => false, 2000);
    play(d, () => false, 30_000, { host: true, guest: false });
    const waiting = (d.guest as unknown as { events: unknown[] }).events.length;
    expect(waiting).toBeLessThan(300);
    const v = d.guest.frame(16);
    const call = v.state.point.call?.tick;
    expect(v.events.every((e) => e.tick > v.state.tick - 18 || e.tick === call)).toBe(true);
  });
});

describe('a state the sim cannot run (online spec §4, a modified host)', () => {
  it('ends the match on that side as a lost link, keeps the page working, and tells the opponent', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = duel({ latencyMs: 30, jitterMs: 10 });
    play(d, () => false, 3000);
    const g = d.guest as unknown as { rb: Rollback; receive(m: ArcadeMsg): void };
    const before = JSON.stringify(g.rb.state);
    // Past the protocol's checks (say a hole in them): a toss by a player who does not exist.
    const { tick, state } = g.rb.confirmedState();
    state.phase = { kind: 'toss', at: tick };
    state.toss = { tick, player: 5 as 0 };
    g.receive({ type: 'state', m: 1, t: tick, s: state });
    expect(d.guest.endReason).toBe('disconnect');
    expect(error).toHaveBeenCalledWith('[bbt] online: the match failed', expect.anything());
    expect(JSON.stringify(g.rb.state)).toBe(before);
    expect(() => d.guest.frame(16)).not.toThrow();
    expect(d.guest.result?.tick).toBeLessThanOrEqual(g.rb.state.tick);
    play(d, () => d.host.over, 1000);
    expect(d.host.endReason).toBe('left');
  });
});

describe('a desync (online spec §3.4)', () => {
  it('is found by the hashes and repaired by the host\'s state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = duel({ latencyMs: 40, jitterMs: 10 });
    play(d, () => false, 4000);
    // A lasting difference on the guest's side (stats are never reset), in its live state and every kept snapshot.
    const rb = (d.guest as unknown as { rb: { state: ArcadeState; snaps: Map<number, ArcadeState> } }).rb;
    for (const st of [rb.state, ...rb.snaps.values()]) st.stats[0].hits += 5;
    play(d, bothOver(d), 15 * 60_000);
    expect(d.host.netStats().desyncs + d.guest.netStats().desyncs).toBeGreaterThan(0);
    expect(d.hostNet.sent.some((m) => m.type === 'state')).toBe(true);
    expect(JSON.stringify(d.guest.result)).toBe(JSON.stringify(d.host.result));
    expect(warn).toHaveBeenCalledWith('[bbt] desync at tick', expect.any(String));
  });
});

describe('without the host\'s start', () => {
  it('a guest whose transport brings no start ends at once as a disconnect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 }, ARCADE_CODEC);
    const idle: Controller = { input: () => NO_INPUT };
    const guest = new ArcadeOnlineSession({ transport: b, scheduler: s, controller: idle, host: null, ticker: (ms, fn) => s.every(ms, fn) });
    expect(guest.over).toBe(true);
    expect(guest.endReason).toBe('disconnect');
    expect(guest.frame(16).state.tick).toBe(0);
    expect(warn).toHaveBeenCalledWith('[bbt] online: no start from the host');
  });
});
