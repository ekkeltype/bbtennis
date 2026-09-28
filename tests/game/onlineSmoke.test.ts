import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CpuBrain, cpuProfile } from '../../src/core/cpu';
import { Engine } from '../../src/core/engine';
import { redact } from '../../src/core/redact';
import { TUNING } from '../../src/core/tuning';
import type { GameEvent, PlayerId, PlayerInfo, PublicState, TurnState, ViewModel } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { DisplayQueue } from '../../src/game/displayQueue';
import { GuestSession } from '../../src/game/guestSession';
import { FrameFit, HostSession } from '../../src/game/hostSession';
import { KeyRate, LobbyLink, OnlineLifecycle, Scoreboards, STALL_MS, TICK_MS, TransportSwitch } from '../../src/game/onlineLink';
import type { Session } from '../../src/game/session';
import { MAX_SEND_BYTES, msgBytes, type NetMsg } from '../../src/net/protocol';
import { loopbackPair, type Transport } from '../../src/net/transport';
import { FRAME, keyOf, seedWhere, TIEBREAK } from './sessionHelpers';

const LOOK = { skin: 1, hairStyle: 2, hair: 3, shirt: 4, shorts: 5, headband: null, racket: 1 };
const HOST: PlayerInfo = { name: 'Hana', look: LOOK, kind: 'human', cpuLevel: null };
const GUEST: PlayerInfo = { name: 'Gus', look: LOOK, kind: 'remote', cpuLevel: null };

type FrameMsg = Extract<NetMsg, { type: 'frame' }>;

/** A transport that records what it sends (and when), can go silent, lose chosen messages or hold them back. */
interface Tap extends Transport {
  sent: NetMsg[];
  /** Local time each message of `sent` was sent at. */
  sentAt: number[];
  mute: boolean;
  lose: ((m: NetMsg) => boolean) | null;
  /** Messages it matches are kept back, in order, until `release`. */
  hold: ((m: NetMsg) => boolean) | null;
  /** Sends the messages kept back and stops holding. */
  release(): void;
}

function tap(t: Transport, s: VirtualScheduler): Tap {
  const held: NetMsg[] = [];
  const x: Tap = {
    sent: [],
    sentAt: [],
    mute: false,
    lose: null,
    hold: null,
    send(m) {
      if (x.mute) return;
      x.sent.push(m);
      x.sentAt.push(s.now());
      if (x.lose?.(m) === true) return;
      if (x.hold?.(m) === true) held.push(m);
      else t.send(m);
    },
    release() {
      x.hold = null;
      for (const m of held.splice(0)) t.send(m);
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
  const hostNet = tap(a, s);
  const guestNet = tap(b, s);
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
  // A late-stamped key pressed at the turn's very start would be stamped before it and dropped (spec §5.2);
  // a rally chase can start at τ 0 now (its early keys, never pressed here, lie before the strike).
  return k === undefined ? null : { at: now - vm.turnτ + Math.max(k.τ, x.lateMs ?? 0), key: k.key };
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
    // The host serves first and shows its own turn throughout (no stalled playback), so only the
    // heartbeat can make the link unstable. The guest is heard only through pings and pongs.
    const o = online({ seed: seedWhere(0), latencyMs: 80, jitterMs: 0 });
    run(o, 3500);
    o.guestNet.mute = true;
    const lastHeard = o.guestNet.sentAt.at(-1)! + 80;
    run(o, lastHeard + 2900 - o.s.now());
    expect(o.host.frame(FRAME).overlay.unstable).toBe(false);
    run(o, 300);
    expect(o.host.frame(FRAME).overlay.unstable).toBe(true);
    expect(o.host.frame(FRAME).pub.turn?.data.owner).toBe(0);
    expect(o.host.over).toBe(false);
    run(o, lastHeard + 7900 - o.s.now());
    expect(o.host.endReason).toBeNull();
    run(o, 200);
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

  it('open is idempotent: a second open starts no second tick, and dispose stops the only one', () => {
    const { s, life, ticks } = lifecycle();
    let again = 0;
    life.open((ms, fn) => s.every(ms, fn), () => again++);
    s.advance(200);
    expect(ticks()).toBe(4);
    expect(again).toBe(0);
    life.dispose();
    s.advance(200);
    expect(ticks()).toBe(4);
    expect(again).toBe(0);
  });
});

describe('KeyRate: at most 30 keys per second of a turn clock', () => {
  it('allows 30 keys in any second of a turn, starting afresh with each turn', () => {
    const r = new KeyRate();
    const allowed = (turn: number, from: number, n: number, step: number): number =>
      Array.from({ length: n }, (_, i) => r.allow(turn, from + i * step)).filter(Boolean).length;
    expect(allowed(1, 0, 40, 10)).toBe(30);
    // (τ − 1 s, τ] at τ = 1000 no longer holds the key at 0, so one more fits.
    expect(r.allow(1, 1000)).toBe(true);
    expect(r.allow(1, 1000)).toBe(false);
    expect(allowed(2, 0, 40, 10)).toBe(30);
  });

  it('counts a key at the highest τ counted this turn when its own τ is lower: decreasing τ never bypasses the limit', () => {
    const r = new KeyRate();
    const allowed = Array.from({ length: 100 }, (_, i) => r.allow(1, 5000 - i * 40)).filter(Boolean).length;
    expect(allowed).toBe(30);
    // Time moves on from the highest τ counted, not from the lowest one sent.
    expect(r.allow(1, 5999)).toBe(false);
    expect(r.allow(1, 6000)).toBe(true);
  });
});

describe('online sessions: frames', () => {
  it('the host never sends a second frame of the same state at one moment (a tick whose step already sent one sends no other)', () => {
    const o = online({ seed: seedWhere(0) });
    play(o.s, sides(o), 20000);
    const seen = new Set<string>();
    let frames = 0;
    o.hostNet.sent.forEach((m, i) => {
      if (m.type !== 'frame') return;
      frames++;
      const key = `${o.hostNet.sentAt[i]} ${JSON.stringify({ ...m, ev: undefined })}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    });
    expect(frames).toBeGreaterThan(100);
  }, 60000);

  it('a frame over the size cap keeps only the last 200 entries of lastTurn\'s log, with one warning ever', () => {
    const state = redact(new Engine({ config: TIEBREAK, players: [HOST, GUEST], seed: 1 }).state, 1);
    const frameWithLog = (entries: number): FrameMsg => {
      const last = structuredClone(state.turn!);
      last.log = Array.from({ length: entries }, (_, i) => ({ τ: i + 0.123456789, k: 'ok', prompt: 1, ch: 'a' }));
      return { type: 'frame', turn: 1, τ: 0, s: { ...structuredClone(state), lastTurn: last } };
    };
    const fit = new FrameFit();
    const big = frameWithLog(900);
    expect(msgBytes(big)).toBeGreaterThan(MAX_SEND_BYTES);
    const tail = big.s!.lastTurn!.log.slice(-200);
    fit.fit(big);
    expect(big.s!.lastTurn!.log).toEqual(tail);
    expect(msgBytes(big)).toBeLessThanOrEqual(MAX_SEND_BYTES);
    expect(warn).toHaveBeenCalledOnce();
    const again = frameWithLog(1000);
    fit.fit(again);
    expect(again.s!.lastTurn!.log).toHaveLength(200);
    expect(warn).toHaveBeenCalledOnce();
    // A frame within the cap keeps its whole log, however long.
    const small = frameWithLog(300);
    expect(msgBytes(small)).toBeLessThanOrEqual(MAX_SEND_BYTES);
    fit.fit(small);
    expect(small.s!.lastTurn!.log).toHaveLength(300);
  });
});

describe('online sessions: stalled confirmations (spec §5.3)', () => {
  /** Frames both sessions every FRAME ms for `ms`; the local time `side` first showed "Connection unstable…", or null. */
  function unstableFrom(o: Online, side: 'host' | 'guest', ms: number): number | null {
    const end = o.s.now() + ms;
    let first: number | null = null;
    while (o.s.now() < end) {
      o.s.advance(Math.min(FRAME, end - o.s.now()));
      const views = { host: o.host.frame(FRAME), guest: o.guest.frame(FRAME) };
      if (first === null && views[side].overlay.unstable) first = o.s.now();
    }
    return first;
  }

  /** When the last of the first `n` messages `net` sent that `pick` matches arrived on the other side (a fixed one-way `latencyMs`). */
  function lastArrival(net: Tap, n: number, latencyMs: number, pick: (m: NetMsg) => boolean): number {
    let at = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) if (pick(net.sent[i]!)) at = Math.max(at, net.sentAt[i]! + latencyMs);
    return at;
  }

  it('the guest shows "Connection unstable…" 1 s after the host\'s confirmations stop while its playback of the host\'s turn holds, though pings still flow; it clears when they come again', () => {
    const o = online({ seed: seedWhere(0), latencyMs: 80, jitterMs: 0 });
    run(o, 3000);
    const vm = o.guest.frame(FRAME);
    expect(vm.pub.turn?.data.owner).toBe(0);
    expect(vm.pub.turn?.ended).toBe(false);
    expect(vm.overlay.unstable).toBe(false);
    const isFrame = (m: NetMsg): boolean => m.type === 'frame';
    const n = o.hostNet.sent.length;
    o.hostNet.hold = isFrame;
    const from = unstableFrom(o, 'guest', 2500);
    const last = lastArrival(o.hostNet, n, 80, isFrame);
    expect(from).not.toBeNull();
    expect(from!).toBeGreaterThanOrEqual(last + STALL_MS);
    expect(from!).toBeLessThanOrEqual(last + STALL_MS + 2 * FRAME);
    // Not the 3 s heartbeat: the host kept pinging.
    expect(o.hostNet.sent.slice(n).some((m) => m.type === 'ping')).toBe(true);
    expect(o.host.frame(FRAME).overlay.unstable).toBe(false);
    o.hostNet.release();
    run(o, 300);
    expect(o.guest.frame(FRAME).overlay.unstable).toBe(false);
  });

  it('the host shows it 1 s after the guest\'s clocks stop during the guest\'s turn, though the guest still answers pings', () => {
    const o = online({ seed: seedWhere(1), latencyMs: 80, jitterMs: 0 });
    run(o, 3000);
    const vm = o.host.frame(FRAME);
    expect(vm.pub.turn?.data.owner).toBe(1);
    expect(vm.pub.turn?.ended).toBe(false);
    expect(vm.overlay.unstable).toBe(false);
    const isClock = (m: NetMsg): boolean => m.type === 'clock' || m.type === 'input';
    const n = o.guestNet.sent.length;
    o.guestNet.hold = isClock;
    const from = unstableFrom(o, 'host', 2500);
    const last = lastArrival(o.guestNet, n, 80, isClock);
    expect(from).not.toBeNull();
    expect(from!).toBeGreaterThanOrEqual(last + STALL_MS);
    expect(from!).toBeLessThanOrEqual(last + STALL_MS + 2 * FRAME);
    expect(o.guestNet.sent.slice(n).some((m) => m.type === 'pong')).toBe(true);
    o.guestNet.release();
    run(o, 300);
    expect(o.host.frame(FRAME).overlay.unstable).toBe(false);
  });
});

describe('online sessions: confirmation-only frames (spec §5.3)', () => {
  /** A state as the frame rule compares it: the turn clocks left out. */
  const clockless = (s: PublicState): string =>
    JSON.stringify({ ...s, turn: s.turn && { ...s.turn, τ: 0 }, lastTurn: s.lastTurn && { ...s.lastTurn, τ: 0 } });

  it('the host sends s only when the state changed since the last s it sent (always with events); every other frame is a bare {type, turn, τ} confirmation', () => {
    const o = online({ seed: seedWhere(0) });
    // 30 s: rally balls fly longer since early typing (early-typing spec §3), so events come more slowly.
    play(o.s, sides(o), 30000);
    const frames = o.hostNet.sent.filter((m): m is FrameMsg => m.type === 'frame');
    let last: string | null = null;
    let confirmations = 0;
    let unchanged = 0;
    for (const f of frames) {
      if (f.ev !== undefined) expect(f.s).toBeDefined();
      if (f.s === undefined) {
        confirmations++;
        expect(Object.keys(f).sort()).toEqual(['turn', 'type', 'τ']);
        continue;
      }
      const now = clockless(f.s);
      if (f.ev === undefined && now === last) unchanged++;
      last = now;
    }
    expect(unchanged).toBe(0);
    // Most frames only confirm the clock: typing and deadlines change the state a few times a second.
    expect(confirmations).toBeGreaterThan(frames.length / 2);
    expect(frames.length - confirmations).toBeGreaterThan(50);
  }, 60000);

  it('while over 16 KB wait to be sent, a confirmation still goes out every 50 ms tick of the host\'s turn', () => {
    // The host serves first; its first turn's intro runs with no events for a while.
    const o = online({ seed: seedWhere(0), latencyMs: 20, jitterMs: 0 });
    let backlog = 0;
    Object.defineProperty(o.hostNet, 'bufferedAmount', { get: () => backlog });
    run(o, 500);
    backlog = 17 * 1024;
    const from = o.hostNet.sent.length;
    run(o, 1000);
    const frames = o.hostNet.sent.slice(from).filter((m): m is FrameMsg => m.type === 'frame');
    expect(frames.length).toBeGreaterThanOrEqual(19);
    expect(frames.every((f) => f.s === undefined && f.turn === 1)).toBe(true);
    expect(frames.map((f) => f.τ)).toEqual([...frames.map((f) => f.τ)].sort((x, y) => x - y));
  });

  it('while over 16 KB wait to be sent, a changed state without events waits (with no confirmation of it) until the backlog clears', () => {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    const hostNet = tap(a, s);
    let backlog = 17 * 1024;
    Object.defineProperty(hostNet, 'bufferedAmount', { get: () => backlog });
    b.onMessage(() => {});
    // The guest serves first, so nothing happens on the host until the guest's turn starts.
    const host = new HostSession({ transport: hostNet, config: TIEBREAK, host: HOST, guest: GUEST, seed: seedWhere(1), scheduler: s, ticker: (ms, fn) => s.every(ms, fn) });
    const frames = (): FrameMsg[] => hostNet.sent.filter((m): m is FrameMsg => m.type === 'frame');
    for (let t = 0; t < 1000; t += FRAME) {
      s.advance(FRAME);
      host.frame(FRAME);
    }
    expect(hostNet.sent.map((m) => m.type)).toEqual(['start']);
    backlog = 0;
    s.advance(50);
    expect(frames()).toHaveLength(1);
    expect(frames()[0]!.s?.turn?.data.turnId).toBe(1);
  });

  it('the guest takes a frame without s as a clock confirmation only: its playback follows it, and events in it are not taken', () => {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    const guest = new GuestSession({ transport: b, scheduler: s, me: { ...GUEST, kind: 'human' }, ticker: (ms, fn) => s.every(ms, fn) });
    a.onMessage(() => {});
    const engine = new Engine({ config: TIEBREAK, players: [HOST, GUEST], seed: seedWhere(0) });
    const ev = engine.start(0);
    a.send({ type: 'frame', turn: 1, τ: 0, ev, s: redact(engine.state, 1) });
    for (let τ = 50; τ <= 1000; τ += 50) {
      s.advance(50);
      guest.frame(50);
      a.send({ type: 'frame', turn: 1, τ });
    }
    s.advance(50);
    let vm = guest.frame(50);
    expect(vm.pub.turn?.data.turnId).toBe(1);
    expect(vm.turnτ).toBeGreaterThan(500);
    expect(vm.turnτ).toBeLessThanOrEqual(1000);
    a.send({ type: 'frame', turn: 1, τ: 1000, ev: [{ turn: 1, τ: 100, type: 'situation', text: 'MATCH POINT' }] });
    s.advance(50);
    vm = guest.frame(50);
    expect(vm.events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('Scoreboards: the scoreboard each displayed turn carries', () => {
  it('shows the front entry\'s scoreboard as it was when noted, as the view\'s own copy; with no front the view keeps its own', () => {
    const state = new Engine({ config: TIEBREAK, players: [HOST, GUEST], seed: 1 }).state;
    const entry = new DisplayQueue(0).push(state.turn!, true);
    const boards = new Scoreboards();
    boards.note(entry, state);
    state.score.points = [3, 1];
    state.stats[0].pointsWon = 3;
    state.status = 'over';
    state.pointNo = 4;
    state.rallyStrikes = 5;
    state.power = [3, 4];
    const pub = redact(state, 0);
    boards.show(pub, entry);
    expect(pub.score.points).toEqual([0, 0]);
    expect(pub.stats[0].pointsWon).toBe(0);
    expect(pub.status).toBe('playing');
    // The point number (clay marks clear with it) and the rally counter wait for the display too.
    expect(pub.pointNo).toBe(0);
    expect(pub.rallyStrikes).toBe(0);
    // The power meters wait for the display too, so a lost point never empties a meter early.
    expect(pub.power).toEqual([0, 0]);
    pub.score.points[0] = 9;
    const again = redact(state, 0);
    boards.show(again, entry);
    expect(again.score.points).toEqual([0, 0]);
    const latest = redact(state, 0);
    boards.show(latest, null);
    expect(latest.score.points).toEqual([3, 1]);
    expect(latest.status).toBe('over');
    expect(latest.power).toEqual([3, 4]);
  });
});

describe('online sessions: the scoreboard follows the display', () => {
  it('each side\'s score and point number change only as the display reaches the next point call, and its stats, status and rally count only between turns (spec §3.1)', () => {
    const o = online({ seed: seedWhere(1) });
    const last = new Map<string, { turn: number | null; score: string; rest: string; rally: number }>();
    let scoreChanges = 0;
    let rallyChanges = 0;
    play(o.s, sides(o), 90000, (x, vm) => {
      const t = vm.pub.turn;
      const turn = t?.data.turnId ?? null;
      const rally = vm.pub.rallyStrikes;
      const score = JSON.stringify([vm.pub.score, vm.pub.pointNo]);
      const rest = JSON.stringify([vm.pub.stats, vm.pub.status, rally]);
      // From the first displayed turn on (the guest shows a waiting placeholder before it).
      const prev = last.get(x.name);
      if (prev !== undefined && prev.turn !== null && prev.rally !== rally) rallyChanges++;
      if (prev !== undefined && prev.turn !== null && prev.score !== score) {
        scoreChanges++;
        expect(turn).not.toBe(prev.turn);
        // The new score shows with the next serve's point call, or once the last turn has been shown.
        expect(t === null || (t.data.kind === 'serve' && t.data.leadIn.kind === 'point')).toBe(true);
      }
      if (prev !== undefined && prev.turn !== null && prev.rest !== rest) expect(turn).not.toBe(prev.turn);
      if (turn !== null || prev !== undefined) last.set(x.name, { turn, score, rest, rally });
    });
    expect(scoreChanges).toBeGreaterThanOrEqual(4);
    expect(rallyChanges).toBeGreaterThanOrEqual(4);
  }, 120000);
});

/** Frames both sessions until the guest's own running turn passes `done`, and returns it. */
function guestTurnUntil(o: Online, done: (t: TurnState) => boolean, limitMs = 20000): TurnState {
  for (let ms = 0; ms < limitMs; ms += FRAME) {
    run(o, FRAME);
    const t = o.guest.frame(FRAME).liveTurn;
    if (t !== null && done(t)) return t;
  }
  throw new Error('the guest\'s turn never got there');
}

describe('online sessions: a guest toss waits for its word set', () => {
  it('a toss pressed before the next serve word set has arrived is held, then applied and sent when it arrives (spec §5.3)', () => {
    const o = online({ seed: seedWhere(1) });
    guestTurnUntil(o, (t) => t.phase === 'preServe');
    // The host's frames, which bring the spare word sets it adds after each catch, are held back.
    o.hostNet.hold = (m) => m.type === 'frame';
    // Two tosses with no typing: each ends in a catch, using up the current set and then the spare.
    for (const n of [1, 2]) {
      o.guest.key({ kind: 'toss' }, o.s.now());
      guestTurnUntil(o, (t) => t.phase === 'preServe' && t.setIndex === n);
    }
    const sets = (): number => {
      const d = o.guest.frame(FRAME).liveTurn?.data;
      return d?.kind === 'serve' ? d.wordSets.length : 0;
    };
    const tosses = (): number => o.guestNet.sent.filter((m) => m.type === 'input' && m.k === 'toss').length;
    expect(sets()).toBe(2);
    expect(tosses()).toBe(2);
    o.guest.key({ kind: 'toss' }, o.s.now());
    run(o, 300);
    expect(o.guest.frame(FRAME).liveTurn?.phase).toBe('preServe');
    expect(tosses()).toBe(2);
    o.hostNet.release();
    run(o, 300);
    expect(sets()).toBeGreaterThanOrEqual(3);
    expect(tosses()).toBe(3);
    expect(o.guest.frame(FRAME).liveTurn?.phase).toBe('toss');
    // The host's engine applied the same three tosses at the same τ.
    run(o, 300);
    const tossτ = (t: TurnState | null | undefined): number[] => (t?.log ?? []).filter((e) => e.k === 'toss').map((e) => e.τ);
    const mine = tossτ(o.guest.frame(FRAME).liveTurn);
    expect(mine).toHaveLength(3);
    expect(tossτ(o.host.frame(FRAME).pub.turn)).toEqual(mine);
    expect(warn).not.toHaveBeenCalled();
  }, 60000);

  it('a toss pressed after the catch has ended but before a tick or frame moved the guest\'s runner out of it waits for the missing set too: both machines toss once, at the same τ', () => {
    const o = online({ seed: seedWhere(1) });
    guestTurnUntil(o, (t) => t.phase === 'preServe');
    o.hostNet.hold = (m) => m.type === 'frame';
    o.guest.key({ kind: 'toss' }, o.s.now());
    guestTurnUntil(o, (t) => t.phase === 'preServe' && t.setIndex === 1);
    o.guest.key({ kind: 'toss' }, o.s.now());
    // The second toss is caught; the set after it is the host's new spare, which the held frames carry.
    const caught = guestTurnUntil(o, (t) => t.phase === 'catch' && t.setIndex === 1);
    const d = caught.data;
    if (d.kind !== 'serve' || caught.catchAt === null) throw new Error('not a caught serve');
    expect(d.wordSets).toHaveLength(2);
    const start = o.s.now() - o.guest.frame(FRAME).turnτ;
    const catchEnd = start + caught.catchAt + d.catchMs;
    // Both sessions tick every 50 ms from 1000 (and each tick clocks the guest's runner): press between the
    // catch's end and the next tick, with no frame in between, so the runner still says 'catch'.
    const nextTick = 1000 + TICK_MS * (Math.floor((catchEnd - 1000) / TICK_MS) + 1);
    expect(nextTick - catchEnd).toBeGreaterThan(1);
    o.s.advance((catchEnd + nextTick) / 2 - o.s.now());
    const tosses = (): number => o.guestNet.sent.filter((m) => m.type === 'input' && m.k === 'toss').length;
    o.guest.key({ kind: 'toss' }, o.s.now());
    expect(tosses()).toBe(2);
    run(o, 300);
    expect(o.guest.frame(FRAME).liveTurn?.phase).toBe('preServe');
    expect(tosses()).toBe(2);
    o.hostNet.release();
    run(o, 300);
    expect(tosses()).toBe(3);
    expect(o.guest.frame(FRAME).liveTurn?.phase).toBe('toss');
    run(o, 300);
    const tossτ = (t: TurnState | null | undefined): number[] => (t?.log ?? []).filter((e) => e.k === 'toss').map((e) => e.τ);
    const mine = tossτ(o.guest.frame(FRAME).liveTurn);
    expect(mine).toHaveLength(3);
    expect(tossτ(o.host.frame(FRAME).pub.turn)).toEqual(mine);
    expect(warn).not.toHaveBeenCalled();
  }, 60000);
});

describe('online sessions: a malformed frame from the host', () => {
  it('the guest drops a frame whose turn or lastTurn is malformed, with one warning, and takes the next good frame', () => {
    const s = new VirtualScheduler(1000);
    const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 0, seed: 1 });
    const guest = new GuestSession({ transport: b, scheduler: s, me: { ...GUEST, kind: 'human' }, ticker: (ms, fn) => s.every(ms, fn) });
    a.onMessage(() => {});
    const state = redact(new Engine({ config: TIEBREAK, players: [HOST, GUEST], seed: 1 }).state, 1);
    const turn = state.turn!;
    const bad: unknown[] = [
      { ...state, turn: { data: 'serve' } },
      { ...state, turn: { ...turn, prompts: null } },
      { ...state, turn: { ...turn, log: {} } },
      { ...state, turn: { ...turn, data: { ...turn.data, owner: 7 } } },
      { ...state, turn: { ...turn, data: { ...turn.data, turnId: 1.5 } } },
      { ...state, turn: { ...turn, data: { ...turn.data, kind: 'volley' } } },
      { ...state, lastTurn: 5 },
    ];
    for (const x of bad) a.send({ type: 'frame', turn: 1, τ: 0, s: x as PublicState });
    expect(() => s.advance(100)).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('[bbt]');
    let vm = guest.frame(FRAME);
    expect(vm.pub.turn).toBeNull();
    expect(vm.pub.players[0].name).toBe('');
    a.send({ type: 'frame', turn: 1, τ: 0, s: state });
    s.advance(100);
    vm = guest.frame(FRAME);
    expect(vm.pub.turn?.data.turnId).toBe(1);
    expect(vm.pub.players[0].name).toBe(HOST.name);
  });
});

describe('TransportSwitch: one transport handed from the lobby to the match', () => {
  function pair(): { s: VirtualScheduler; a: Transport; b: Transport; toB: NetMsg[] } {
    const s = new VirtualScheduler(0);
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const toB: NetMsg[] = [];
    b.onMessage((m) => toB.push(m));
    return { s, a, b, toB };
  }

  it('the first channel gets what arrived earlier; after next() it hears and sends nothing, and the new one gets `first`, then the rest', () => {
    const { s, a, b, toB } = pair();
    b.send({ type: 'ready', on: true });
    s.advance(20);
    const sw = new TransportSwitch(a);
    const lobby = sw.current;
    const heard: NetMsg[] = [];
    lobby.onMessage((m) => heard.push(m));
    expect(heard).toEqual([{ type: 'ready', on: true }]);
    lobby.send({ type: 'ping', id: 1 });
    s.advance(20);
    expect(toB).toEqual([{ type: 'ping', id: 1 }]);

    const match = sw.next([{ type: 'rematch', want: true }]);
    expect(sw.current).toBe(match);
    b.send({ type: 'forfeit' });
    s.advance(20);
    const got: NetMsg[] = [];
    match.onMessage((m) => got.push(m));
    expect(got).toEqual([{ type: 'rematch', want: true }, { type: 'forfeit' }]);
    expect(heard).toHaveLength(1);
    // The old channel can neither send nor close the transport the match now uses.
    lobby.send({ type: 'ping', id: 2 });
    lobby.close();
    match.send({ type: 'pong', id: 9 });
    s.advance(20);
    expect(toB).toEqual([{ type: 'ping', id: 1 }, { type: 'pong', id: 9 }]);
  });

  it('a close reaches the current channel, and a channel made after the close is told too', () => {
    const { s, a, b } = pair();
    const sw = new TransportSwitch(a);
    const closes: string[] = [];
    sw.current.onClose((r) => closes.push(`lobby ${r}`));
    b.close();
    s.advance(20);
    expect(closes).toEqual(['lobby closed']);
    sw.next().onClose((r) => closes.push(`match ${r}`));
    expect(closes).toEqual(['lobby closed', 'match closed']);
  });
});

describe('LobbyLink: the lobby\'s heartbeat until the match takes over', () => {
  it('measures the round trip, hears the other side leave, and after handOver neither sends nor hears', () => {
    const s = new VirtualScheduler(0);
    const [a, b] = loopbackPair(s, { latencyMs: 30, jitterMs: 0, seed: 1 });
    const hostHeard: NetMsg[] = [];
    const gone: string[] = [];
    const host = new LobbyLink(a, s, { message: (m) => hostHeard.push(m), gone: (why) => gone.push(why) });
    const guest = new LobbyLink(b, s, { message: () => {}, gone: () => {} });
    host.open();
    guest.open();
    s.advance(2100);
    expect(host.rttMs).toBe(60);
    guest.send({ type: 'ready', on: true });
    s.advance(50);
    expect(hostHeard).toEqual([{ type: 'ready', on: true }]);

    const match = host.handOver();
    const got: NetMsg[] = [];
    match.onMessage((m) => got.push(m));
    guest.send({ type: 'ready', on: false });
    s.advance(50);
    expect(hostHeard).toHaveLength(1);
    expect(got).toEqual([{ type: 'ready', on: false }]);
    // The handed-over lobby link pings no more; the guest's link keeps pinging the match's channel.
    s.advance(4000);
    expect(got.filter((m) => m.type === 'pong')).toEqual([]);
    expect(got.some((m) => m.type === 'ping')).toBe(true);
    guest.close();
    s.advance(50);
    expect(gone).toEqual([]);
    expect(got.at(-1)).toEqual({ type: 'leave' });
  });

  it('takes nothing before open, then what arrived earlier; reports the other side leaving once', () => {
    const s = new VirtualScheduler(0);
    const [a, b] = loopbackPair(s, { latencyMs: 30, jitterMs: 0, seed: 1 });
    const gone: string[] = [];
    const heard: NetMsg[] = [];
    const guest = new LobbyLink(b, s, { message: () => {}, gone: () => {} });
    guest.open();
    guest.send({ type: 'ready', on: true });
    s.advance(100);
    const host = new LobbyLink(a, s, { message: (m) => heard.push(m), gone: (why) => gone.push(why) });
    expect(heard).toEqual([]);
    host.open();
    expect(heard).toEqual([{ type: 'ready', on: true }]);
    guest.close();
    s.advance(100);
    s.advance(10000);
    expect(gone).toEqual(['left']);
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
