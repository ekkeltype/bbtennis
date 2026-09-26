import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CpuBrain, cpuProfile } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import { TUNING } from '../../src/core/tuning';
import type { GameEvent, PlayerId, PlayerInfo, TurnState, ViewModel } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { DisplayQueue } from '../../src/game/displayQueue';
import { GuestSession } from '../../src/game/guestSession';
import { HostSession, OnlineLifecycle } from '../../src/game/hostSession';
import type { Session } from '../../src/game/session';
import { MAX_SEND_BYTES, msgBytes, type NetMsg } from '../../src/net/protocol';
import { loopbackPair, type Transport } from '../../src/net/transport';
import { FRAME, keyOf, seedWhere, TIEBREAK } from './sessionHelpers';

const LOOK = { skin: 1, hairStyle: 2, hair: 3, shirt: 4, shorts: 5, headband: null, racket: 1 };
const HOST: PlayerInfo = { name: 'Hana', look: LOOK, kind: 'human', cpuLevel: null };
const GUEST: PlayerInfo = { name: 'Gus', look: LOOK, kind: 'remote', cpuLevel: null };

/** A transport that records what it sends, can go silent, and can lose chosen messages. */
interface Tap extends Transport {
  sent: NetMsg[];
  mute: boolean;
  lose: ((m: NetMsg) => boolean) | null;
}

function tap(t: Transport): Tap {
  const x: Tap = {
    sent: [],
    mute: false,
    lose: null,
    send(m) {
      if (x.mute) return;
      x.sent.push(m);
      if (x.lose?.(m) === true) return;
      t.send(m);
    },
    onMessage: (cb) => t.onMessage(cb),
    onClose: (cb) => t.onClose(cb),
    close: () => t.close(),
    get bufferedAmount() {
      return t.bufferedAmount;
    },
  };
  return x;
}

interface Online {
  s: VirtualScheduler;
  host: HostSession;
  guest: GuestSession;
  hostNet: Tap;
  guestNet: Tap;
}

function online(opts: { seed: number; latencyMs?: number; jitterMs?: number }): Online {
  const s = new VirtualScheduler(1000);
  const [a, b] = loopbackPair(s, { latencyMs: opts.latencyMs ?? 80, jitterMs: opts.jitterMs ?? 20, seed: 5 });
  const hostNet = tap(a);
  const guestNet = tap(b);
  const ticker = (ms: number, fn: () => void): (() => void) => s.every(ms, fn);
  const host = new HostSession({ transport: hostNet, config: TIEBREAK, host: HOST, guest: GUEST, seed: opts.seed, scheduler: s, ticker });
  const guest = new GuestSession({ transport: guestNet, scheduler: s, me: { ...GUEST, kind: 'human' }, ticker });
  return { s, host, guest, hostNet, guestNet };
}

/** One side of the match with its scripted typist. */
interface Side {
  name: 'host' | 'guest';
  session: Session;
  me: PlayerId;
  typist: CpuBrain;
  /** The side's latest view model (null before the first frame). */
  vm: ViewModel | null;
  /** How long before the handler runs each key was pressed (its timeStamp lags `now` by this). */
  lateMs?: number;
}

/** The typist's next key and the local time it is due, while the side's own turn runs (it began at now − turnτ). */
function nextKey(x: Side, now: number): { at: number; key: string } | null {
  const vm = x.vm;
  const t = vm === null ? null : vm.liveTurn ?? vm.pub.turn;
  if (vm === null || t === null || t.data.owner !== x.me || !t.started || t.ended) return null;
  const k = x.typist.plan(t)[0];
  return k === undefined ? null : { at: now - vm.turnτ + k.τ, key: k.key };
}

/** Frames both sides every FRAME ms, pressing each typist's keys at their planned times, until both are over. */
function play(s: VirtualScheduler, sides: Side[], limitMs: number, onFrame?: (x: Side, vm: ViewModel) => void): void {
  const end = s.now() + limitMs;
  const frameAll = (): void => {
    for (const x of sides) {
      const vm = x.session.frame(FRAME);
      x.vm = vm;
      onFrame?.(x, vm);
    }
  };
  frameAll();
  while (!sides.every((x) => x.session.over) && s.now() < end) {
    let first: { x: Side; at: number; key: string } | null = null;
    for (const x of sides) {
      const k = nextKey(x, s.now());
      if (k !== null && k.at <= s.now() + FRAME && (first === null || k.at < first.at)) first = { x, ...k };
    }
    if (first !== null) {
      if (first.at > s.now()) s.advance(first.at - s.now());
      first.x.session.key(keyOf(first.key), s.now() - (first.x.lateMs ?? 0));
    } else {
      s.advance(FRAME);
    }
    frameAll();
  }
}

/** The two sides: the host typing at level 6 (45 WPM), the guest at level 7 (51 WPM). */
function sides(o: Online, lateMs = 0): Side[] {
  return [
    { name: 'host', session: o.host, me: 0, typist: new CpuBrain(0, cpuProfile(6), 11), vm: null, lateMs },
    { name: 'guest', session: o.guest, me: 1, typist: new CpuBrain(1, cpuProfile(7), 12), vm: null, lateMs },
  ];
}

/** Frames both sessions every FRAME ms for `ms`. */
function run(o: Online, ms: number): void {
  const end = o.s.now() + ms;
  while (o.s.now() < end) {
    o.s.advance(Math.min(FRAME, end - o.s.now()));
    o.host.frame(FRAME);
    o.guest.frame(FRAME);
  }
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('online sessions: a full match over a lossy-latency loopback', () => {
  it.each([
    ['the guest', seedWhere(1)],
    ['the host', seedWhere(0)],
  ])('Host and Guest with scripted typists play a Tiebreak to the end (%s serves first): no desync, every message within the size cap', (_first, seed) => {
    const o = online({ seed });
    const all = sides(o);
    const seen: Record<'host' | 'guest', GameEvent[]> = { host: [], guest: [] };
    const lastτ = new Map<string, { turn: number; τ: number }>();
    let guestRanOwnTurn = false;
    play(o.s, all, 40 * 60 * 1000, (x, vm) => {
      seen[x.name].push(...vm.events);
      expect(Number.isFinite(vm.turnτ) && vm.turnτ >= 0).toBe(true);
      expect(vm.viewer).toBe(x.me);
      // Within one displayed turn, τ never goes back.
      const turn = vm.pub.turn?.data.turnId ?? -1;
      const prev = lastτ.get(x.name);
      if (prev !== undefined && prev.turn === turn) expect(vm.turnτ).toBeGreaterThanOrEqual(prev.τ);
      lastτ.set(x.name, { turn, τ: vm.turnτ });
      if (x.name === 'guest' && vm.liveTurn !== null) guestRanOwnTurn = true;
    });

    expect(o.host.over).toBe(true);
    expect(o.guest.over).toBe(true);
    expect(o.host.endReason).toBe('finished');
    expect(o.guest.endReason).toBe('finished');
    expect(guestRanOwnTurn).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    const h = o.host.result!;
    const g = o.guest.result!;
    expect(h.status).toBe('over');
    expect(g.status).toBe('over');
    expect(g.winner).toBe(h.winner);
    expect(g.score).toEqual(h.score);
    expect(g.stats).toEqual(h.stats);
    expect(h.stats[0].wordsCompleted).toBeGreaterThan(0);
    expect(h.stats[1].wordsCompleted).toBeGreaterThan(0);
    const points = h.stats[0].pointsWon + h.stats[1].pointsWon;
    expect(points).toBeGreaterThanOrEqual(7);
    for (const side of ['host', 'guest'] as const) {
      expect(seen[side].filter((e) => e.type === 'point')).toHaveLength(points);
      expect(seen[side].filter((e) => e.type === 'match')).toHaveLength(1);
      expect(seen[side].filter((e) => e.type === 'coinToss')).toHaveLength(1);
    }
    // Both players see the same events, each once: the guest's own turns from its runner, the rest from the host.
    const sorted = (events: GameEvent[]): string[] => events.map((e) => JSON.stringify(e)).sort();
    expect(sorted(seen.guest)).toEqual(sorted(seen.host));

    const frames = o.hostNet.sent.filter((m) => m.type === 'frame');
    expect(frames.length).toBeGreaterThan(500);
    for (const m of [...o.hostNet.sent, ...o.guestNet.sent]) expect(msgBytes(m)).toBeLessThanOrEqual(MAX_SEND_BYTES);
    expect(o.guestNet.sent.some((m) => m.type === 'input')).toBe(true);
    expect(o.guestNet.sent.some((m) => m.type === 'clock')).toBe(true);
  }, 120000);
});

describe('online sessions: desync', () => {
  it('when the host\'s result of a guest turn differs, the guest warns "[bbt] desync", shows the host\'s version and plays on', () => {
    const o = online({ seed: seedWhere(1) });
    // The guest's toss never reaches the host: the guest serves locally, the host's copy runs out of serve clock.
    let lost = false;
    o.guestNet.lose = (m) => {
      if (lost || m.type !== 'input' || m.k !== 'toss') return false;
      lost = true;
      return true;
    };
    const all = sides(o);
    let adopted: TurnState | null = null;
    let ownAgain = false;
    play(o.s, all, 60000, (x, vm) => {
      if (x.name !== 'guest') return;
      const t1 = [vm.pub.turn, vm.pub.lastTurn].find((t) => t?.data.turnId === 1 && t.outcome?.kind === 'fault');
      if (t1 !== undefined && adopted === null) adopted = t1;
      if (adopted !== null && vm.liveTurn !== null) ownAgain = true;
    });
    expect(lost).toBe(true);
    expect(warn).toHaveBeenCalledWith('[bbt] desync', expect.objectContaining({ turn: 1 }));
    const call = warn.mock.calls.find((c) => c[0] === '[bbt] desync')!;
    expect(call[1]).toMatchObject({ guest: { kind: 'strike' }, host: { kind: 'fault' } });
    expect(adopted).not.toBeNull();
    expect(ownAgain).toBe(true);
  }, 60000);
});

describe('online sessions: late key timestamps', () => {
  it('a guest key stamped before its last clock is clamped the same way on both machines: no desync', () => {
    const o = online({ seed: 8 });
    let points = 0;
    play(o.s, sides(o, 12), 90000, (x, vm) => {
      if (x.name === 'host') points += vm.events.filter((e) => e.type === 'point').length;
    });
    expect(points).toBeGreaterThanOrEqual(2);
    expect(o.guestNet.sent.filter((m) => m.type === 'input').length).toBeGreaterThan(20);
    expect(warn).not.toHaveBeenCalled();
  }, 60000);
});

describe('online sessions: turn hand-over', () => {
  it('the guest starts its own turn only after playing the host\'s turn before it to its end', () => {
    const o = online({ seed: seedWhere(0) });
    const shownAt = new Map<number, number>();
    let checked = false;
    let prev: ViewModel | null = null;
    play(o.s, sides(o), 60000, (x, vm) => {
      if (x.name !== 'guest' || checked) return;
      const id = vm.pub.turn?.data.turnId;
      if (id !== undefined && !shownAt.has(id)) shownAt.set(id, o.s.now());
      if (prev !== null && prev.liveTurn === null && vm.liveTurn !== null) {
        const last = vm.pub.lastTurn!;
        expect(last.data.owner).toBe(0);
        expect(prev.pub.turn?.data.turnId).toBe(last.data.turnId);
        // τ_play runs at most 10 % fast, so showing the host's turn up to its end took at least endτ / 1.1.
        const ownStart = o.s.now() - vm.turnτ;
        expect(ownStart - shownAt.get(last.data.turnId)!).toBeGreaterThanOrEqual(last.outcome!.endτ / 1.1 - FRAME);
        expect(vm.turnτ).toBeLessThanOrEqual(FRAME);
        checked = true;
      }
      prev = vm;
    });
    expect(checked).toBe(true);
  }, 60000);
});

describe('online sessions: link', () => {
  it('measures the round trip with ping/pong every 2 s', () => {
    const o = online({ seed: 1, latencyMs: 70, jitterMs: 0 });
    run(o, 2500);
    expect(o.host.frame(FRAME).overlay.rttMs).toBe(140);
    expect(o.guest.frame(FRAME).overlay.rttMs).toBe(140);
  });

  it('marks the link unstable after 3 s of silence and ends the match as a disconnect after 8 s', () => {
    // The guest serves first, so it sends clocks every 50 ms until it goes silent.
    const o = online({ seed: seedWhere(1) });
    run(o, 1000);
    o.guestNet.mute = true;
    run(o, 2900);
    expect(o.host.frame(FRAME).overlay.unstable).toBe(false);
    run(o, 300);
    expect(o.host.frame(FRAME).overlay.unstable).toBe(true);
    expect(o.host.over).toBe(false);
    run(o, 5000);
    expect(o.host.endReason).toBe('disconnect');
    expect(o.host.over).toBe(true);
    expect(o.host.result?.status).toBe('playing');
  });

  it('a transport close ends the match at once as a disconnect', () => {
    const o = online({ seed: 1 });
    run(o, 1000);
    o.guestNet.close();
    run(o, 200);
    expect(o.host.endReason).toBe('disconnect');
    expect(o.host.over).toBe(true);
  });

  it('a leave ends the match on the other side with the "left" reason', () => {
    const o = online({ seed: 1 });
    run(o, 1000);
    o.guest.leave();
    expect(o.guest.endReason).toBe('left');
    run(o, 200);
    expect(o.host.endReason).toBe('left');
    expect(o.host.over).toBe(true);
    expect(o.host.opponentGone).toBe('left');
  });

  it('dispose sends leave, stops the ticker and closes the transport', () => {
    const o = online({ seed: 1 });
    run(o, 1000);
    o.host.dispose();
    const sent = o.hostNet.sent.length;
    expect(o.hostNet.sent[sent - 1]).toEqual({ type: 'leave' });
    run(o, 3000);
    expect(o.hostNet.sent.length).toBe(sent);
    expect(o.guest.endReason).toBe('left');
  });

  it('never pauses: pause() and resume() leave the clocks running', () => {
    const o = online({ seed: seedWhere(0) });
    run(o, 500);
    o.host.pause();
    const a = o.host.frame(FRAME).turnτ;
    run(o, 500);
    const b = o.host.frame(FRAME);
    o.host.resume();
    expect(b.turnτ).toBeGreaterThan(a + 400);
    expect(b.overlay.paused).toBe(false);
  });
});

describe('online sessions: a transport with messages or a close already waiting', () => {
  /** A loopback pair on its own scheduler at 20 ms, and the ticker the sessions run on. */
  function pair(): { s: VirtualScheduler; a: Transport; b: Transport; ticker: (ms: number, fn: () => void) => () => void } {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    return { s, a, b, ticker: (ms, fn) => s.every(ms, fn) };
  }

  it('a HostSession built after the guest already closed ends at once as a disconnect, and stays ended', () => {
    const { s, a, b, ticker } = pair();
    b.close();
    s.advance(100);
    const host = new HostSession({ transport: a, config: TIEBREAK, host: HOST, guest: GUEST, seed: 1, scheduler: s, ticker });
    expect(host.endReason).toBe('disconnect');
    expect(host.opponentGone).toBe('disconnect');
    expect(host.over).toBe(true);
    for (let t = 0; t < 10000; t += 250) {
      s.advance(250);
      host.frame(250);
    }
    expect(host.endReason).toBe('disconnect');
    expect(host.over).toBe(true);
    expect(host.frame(FRAME).overlay.unstable).toBe(false);
  });

  it('a HostSession built after the guest sent clocks, an input and a forfeit, then closed, applies them in order without throwing', () => {
    const { s, a, b, ticker } = pair();
    b.send({ type: 'clock', turn: 1, τ: 0 });
    b.send({ type: 'input', seq: 0, turn: 1, k: 'toss', τ: 200 });
    b.send({ type: 'clock', turn: 1, τ: 400 });
    b.send({ type: 'forfeit' });
    b.close();
    s.advance(100);
    // The guest serves first, so turn 1 is the guest's.
    const h = new HostSession({ transport: a, config: TIEBREAK, host: HOST, guest: GUEST, seed: seedWhere(1), scheduler: s, ticker });
    expect(h.endReason).toBe('forfeit');
    expect(h.opponentGone).toBe('disconnect');
    expect(h.over).toBe(true);
    const r = h.result!;
    expect(r.forfeitBy).toBe(1);
    expect(r.winner).toBe(0);
    // The guest's first turn was started by its first clock and clocked to its last one.
    expect(r.lastTurn?.data.turnId).toBe(1);
    expect(r.lastTurn?.started).toBe(true);
    expect(r.lastTurn?.τ).toBe(400);
  });

  it('a GuestSession built after the host sent start, frames and leave, then closed, shows the host and ends as "left"', () => {
    const { s, a, b, ticker } = pair();
    const host = new HostSession({ transport: a, config: TIEBREAK, host: HOST, guest: GUEST, seed: 1, scheduler: s, ticker });
    s.advance(100);
    host.dispose();
    s.advance(100);
    const guest = new GuestSession({ transport: b, scheduler: s, me: { ...GUEST, kind: 'human' }, ticker });
    expect(guest.endReason).toBe('left');
    expect(guest.opponentGone).toBe('left');
    expect(guest.over).toBe(true);
    const vm = guest.frame(FRAME);
    expect(vm.pub.players[0].name).toBe(HOST.name);
    expect(vm.pub.status).toBe('playing');
  });
});

describe('online sessions: forfeit and rematch', () => {
  it('a side that has left never starts a rematch, even when the other side wants one', () => {
    const o = online({ seed: 1 });
    run(o, 3000);
    o.host.forfeit();
    run(o, 300);
    o.guest.rematch();
    run(o, 300);
    o.host.leave();
    o.host.rematch();
    run(o, 300);
    expect(o.host.endReason).toBe('forfeit');
    expect(o.host.over).toBe(true);
    expect(o.hostNet.sent.filter((m) => m.type === 'start')).toHaveLength(1);
  });

  it('a host forfeit ends the match for both at once with the forfeit reason', () => {
    const o = online({ seed: 1 });
    run(o, 3000);
    o.host.forfeit();
    expect(o.host.over).toBe(true);
    expect(o.host.endReason).toBe('forfeit');
    expect(o.host.result?.forfeitBy).toBe(0);
    expect(o.host.result?.winner).toBe(1);
    run(o, 300);
    expect(o.guest.over).toBe(true);
    expect(o.guest.endReason).toBe('forfeit');
    expect(o.guest.result?.forfeitBy).toBe(0);
    expect(o.guest.result?.winner).toBe(1);
  });

  it('a guest forfeit ends the match for both with the guest as the one who forfeits', () => {
    const o = online({ seed: 1 });
    run(o, 3000);
    o.guest.forfeit();
    expect(o.guest.over).toBe(true);
    expect(o.guest.result?.forfeitBy).toBe(1);
    expect(o.guest.result?.winner).toBe(0);
    run(o, 300);
    expect(o.host.endReason).toBe('forfeit');
    expect(o.host.result?.forfeitBy).toBe(1);
    expect(o.host.result?.winner).toBe(0);
  });

  it('starts a new match (fresh seed) once both want a rematch', () => {
    const o = online({ seed: 1 });
    run(o, 3000);
    const firstWords = o.host.frame(FRAME).pub.turn?.data;
    o.host.forfeit();
    run(o, 300);
    o.host.rematch();
    run(o, 500);
    expect(o.host.over).toBe(true);
    o.guest.rematch();
    run(o, 500);
    for (const x of [o.host, o.guest]) {
      expect(x.over).toBe(false);
      expect(x.endReason).toBeNull();
      const vm = x.frame(FRAME);
      expect(vm.pub.status).toBe('playing');
      expect(vm.pub.pointNo).toBe(0);
      expect(vm.pub.turn?.data.turnId).toBe(1);
    }
    expect(JSON.stringify(o.host.frame(FRAME).pub.turn?.data)).not.toBe(JSON.stringify(firstWords));
  });
});

describe('online sessions: key rate', () => {
  /** Runs until the guest's own first serve turn is in PRE_SERVE, then returns it. */
  function guestServing(o: Online): TurnState {
    for (let i = 0; i < 1000; i++) {
      run(o, FRAME);
      const t = o.guest.frame(FRAME).liveTurn;
      if (t !== null && t.phase === 'preServe') return t;
    }
    throw new Error('the guest never reached PRE_SERVE');
  }

  it('the guest ignores its own keys beyond 30 per second', () => {
    const o = online({ seed: seedWhere(1) });
    guestServing(o);
    const before = o.guestNet.sent.filter((m) => m.type === 'input').length;
    o.guest.key({ kind: 'toss' }, o.s.now());
    for (let i = 0; i < 40; i++) {
      o.s.advance(10);
      o.guest.key(keyOf('z'), o.s.now());
    }
    expect(o.guestNet.sent.filter((m) => m.type === 'input').length - before).toBe(30);
  });

  it('the host ignores guest inputs beyond 30 per second of the guest\'s turn clock', () => {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    const ticker = (ms: number, fn: () => void): (() => void) => s.every(ms, fn);
    const seed = seedWhere(1);
    const host = new HostSession({ transport: a, config: TIEBREAK, host: HOST, guest: GUEST, seed, scheduler: s, ticker });
    // The guest's first serve words, as the host's engine picks them: a first letter locks the easy word.
    const data = new Engine({ config: TIEBREAK, players: [HOST, GUEST], seed }).state.turn!.data;
    const initial = data.kind === 'serve' ? data.wordSets[0]!.options[0]!.word.charAt(0) : '';
    expect(initial).toMatch(/^[a-z]$/);
    b.onMessage(() => {});
    const typed: GameEvent[] = [];
    const advance = (ms: number): void => {
      for (let t = 0; t < ms; t += FRAME) {
        s.advance(FRAME);
        typed.push(...host.frame(FRAME).events.filter((e) => e.type === 'lock' || e.type === 'keyOk' || e.type === 'keyBad'));
      }
    };
    b.send({ type: 'clock', turn: 1, τ: 0 });
    b.send({ type: 'clock', turn: 1, τ: 2600 });
    b.send({ type: 'input', seq: 0, turn: 1, k: 'toss', τ: 2600 });
    b.send({ type: 'input', seq: 1, turn: 1, k: initial, τ: 2601 });
    // Every later letter is a key on the locked word (right or wrong): 38 more, 10 ms apart.
    for (let i = 0; i < 38; i++) b.send({ type: 'input', seq: i + 2, turn: 1, k: 'z', τ: 2611 + i * 10 });
    b.send({ type: 'clock', turn: 1, τ: 3200 });
    advance(5000);
    expect(typed).toHaveLength(29);
  });

  it('drops stale guest messages (another turn id)', () => {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    const ticker = (ms: number, fn: () => void): (() => void) => s.every(ms, fn);
    const host = new HostSession({ transport: a, config: TIEBREAK, host: HOST, guest: GUEST, seed: seedWhere(1), scheduler: s, ticker });
    b.onMessage(() => {});
    b.send({ type: 'clock', turn: 7, τ: 0 });
    b.send({ type: 'clock', turn: 7, τ: 3000 });
    for (let t = 0; t < 1000; t += FRAME) {
      s.advance(FRAME);
      host.frame(FRAME);
    }
    expect(host.frame(FRAME).pub.turn?.started).toBe(false);
    expect(host.frame(FRAME).turnτ).toBe(0);
  });
});

describe('OnlineLifecycle: the shared start and end of an online match', () => {
  function lifecycle(): { s: VirtualScheduler; b: Transport; life: OnlineLifecycle; ticks: () => number } {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    const queue = new DisplayQueue(s.now());
    const got: NetMsg[] = [];
    let n = 0;
    b.send({ type: 'forfeit' });
    s.advance(50);
    const life = new OnlineLifecycle({ transport: a, scheduler: s, message: (m) => got.push(m), display: () => queue });
    // Nothing is taken from the transport before open: the forfeit that came first is still held.
    expect(got).toEqual([]);
    life.open((ms, fn) => s.every(ms, fn), () => n++);
    expect(got).toEqual([{ type: 'forfeit' }]);
    return { s, b, life, ticks: () => n };
  }

  it('open hands over what arrived earlier, then ticks every 50 ms until dispose', () => {
    const { s, life, ticks } = lifecycle();
    s.advance(200);
    expect(ticks()).toBe(4);
    life.dispose();
    s.advance(200);
    expect(ticks()).toBe(4);
    expect(life.disposed).toBe(true);
    expect(life.playing).toBe(false);
  });

  it('a new match keeps a lost opponent as the reason; a lost opponent is over at once with no rematch', () => {
    const { s, b, life } = lifecycle();
    life.reset();
    expect(life.reason).toBeNull();
    expect(life.playing).toBe(true);
    b.close();
    s.advance(100);
    expect(life.reason).toBe('disconnect');
    life.reset();
    expect(life.reason).toBe('disconnect');
    expect(life.over).toBe(true);
    expect(life.showing).toBe(false);
    expect(life.mayRematch).toBe(false);
  });

  it('the first reason stays; a forfeit allows a rematch until this side leaves, and a new match after leaving stays "left"', () => {
    const { life } = lifecycle();
    life.settle(1);
    life.settle(null);
    expect(life.reason).toBe('forfeit');
    expect(life.over).toBe(true);
    expect(life.mayRematch).toBe(true);
    life.leave();
    expect(life.reason).toBe('forfeit');
    expect(life.mayRematch).toBe(false);
    life.reset();
    expect(life.reason).toBe('left');
  });
});

describe('online sessions: views', () => {
  it('the host sees its own first turn live and the guest sees it in playback, never past the host-confirmed τ', () => {
    const o = online({ seed: seedWhere(0) });
    let maxConfirmed = 0;
    const confirmedAt = (): number => {
      for (const m of o.hostNet.sent) if (m.type === 'frame' && m.turn === 1) maxConfirmed = Math.max(maxConfirmed, m.τ);
      return maxConfirmed;
    };
    for (let i = 0; i < 150; i++) {
      run(o, FRAME);
      const g = o.guest.frame(FRAME);
      if (g.pub.turn?.data.turnId === 1) expect(g.turnτ).toBeLessThanOrEqual(confirmedAt());
    }
    const h = o.host.frame(FRAME);
    const g = o.guest.frame(FRAME);
    expect(h.viewer).toBe(0);
    expect(g.viewer).toBe(1);
    expect(h.turnτ).toBeCloseTo(150 * FRAME, 6);
    expect(g.turnτ).toBeGreaterThan(h.turnτ - 400);
    expect(g.turnτ).toBeLessThan(h.turnτ);
    expect(g.pub.players[0].name).toBe(HOST.name);
    // The host's serve words are hidden from the guest.
    const sets = g.pub.turn?.data.kind === 'serve' ? g.pub.turn.data.wordSets : [];
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) for (const w of set.options) expect(w.word).toBe('');
    expect(TUNING.leadIn.introMs).toBeGreaterThan(150 * FRAME);
  });
});
