import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualScheduler } from '../../src/game/clock';
import { MAX_SEND_BYTES, type NetMsg } from '../../src/net/protocol';
import { MAX_HELD_BYTES, MAX_HELD_MESSAGES, loopbackPair, type Transport } from '../../src/net/transport';

const utf8 = new TextEncoder();

/** A hello whose JSON is exactly `bytes` UTF-8 bytes, its name padded with `pad` (a 1- or 2-byte character). */
function helloOfBytes(bytes: number, pad = 'x'): Extract<NetMsg, { type: 'hello' }> {
  const m: Extract<NetMsg, { type: 'hello' }> = {
    type: 'hello', proto: 1, app: 'bbtennis', name: '', look: { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 },
  };
  const room = bytes - utf8.encode(JSON.stringify(m)).byteLength;
  const width = utf8.encode(pad).byteLength;
  m.name = pad.repeat(Math.floor(room / width)) + 'x'.repeat(room % width);
  expect(utf8.encode(JSON.stringify(m)).byteLength).toBe(bytes);
  return m;
}

/** A frame whose JSON is exactly `bytes` UTF-8 bytes; its event text keeps that size through parseMsg. */
function frameOfBytes(bytes: number): Extract<NetMsg, { type: 'frame' }> {
  const ev = { turn: 1, τ: 0, type: 'situation' as const, text: '' };
  const m = { type: 'frame' as const, turn: 1, τ: 0, ev: [ev] };
  ev.text = 'x'.repeat(bytes - utf8.encode(JSON.stringify(m)).byteLength);
  expect(utf8.encode(JSON.stringify(m)).byteLength).toBe(bytes);
  return m;
}

const HELD_WARNING = '[bbt] held messages over the cap, dropping the rest';

afterEach(() => {
  vi.restoreAllMocks();
});

interface Arrival { id: number; at: number }

/** Records ping ids and arrival times received by `t`. */
function record(s: VirtualScheduler, t: Transport): Arrival[] {
  const got: Arrival[] = [];
  t.onMessage((m) => {
    if (m.type === 'ping') got.push({ id: m.id, at: s.now() });
  });
  return got;
}

/** Sends pings 0..n-1 from `t`, `gapMs` apart; returns their send times. */
function sendPings(s: VirtualScheduler, t: Transport, n: number, gapMs: number): number[] {
  const sentAt: number[] = [];
  for (let id = 0; id < n; id++) {
    sentAt.push(s.now());
    t.send({ type: 'ping', id });
    s.advance(gapMs);
  }
  return sentAt;
}

describe('loopbackPair delivery', () => {
  it('delivers in send order with latency in [latencyMs, latencyMs + jitterMs] both ways', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 150, jitterMs: 30, seed: 1 });
    const atB = record(s, b);
    const atA = record(s, a);
    const sentAB = sendPings(s, a, 50, 7);
    const sentBA = sendPings(s, b, 50, 3);
    s.advance(1000);
    for (const [got, sent] of [[atB, sentAB], [atA, sentBA]] as const) {
      expect(got.map((g) => g.id)).toEqual(sent.map((_, i) => i));
      for (const g of got) {
        const delay = g.at - sent[g.id]!;
        expect(delay).toBeGreaterThanOrEqual(150);
        expect(delay).toBeLessThanOrEqual(180);
      }
    }
  });

  it('keeps order when jitter is far larger than the gap between messages', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 0, jitterMs: 400, seed: 99 });
    const got = record(s, b);
    const sent = sendPings(s, a, 200, 1);
    s.advance(1000);
    expect(got.map((g) => g.id)).toEqual(sent.map((_, i) => i));
    for (let i = 1; i < got.length; i++) expect(got[i]!.at).toBeGreaterThanOrEqual(got[i - 1]!.at);
  });

  it('without jitter every message takes exactly the latency', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 40, jitterMs: 0, seed: 5 });
    const got = record(s, b);
    sendPings(s, a, 5, 10);
    s.advance(100);
    expect(got.map((g) => g.at)).toEqual([40, 50, 60, 70, 80]);
  });

  it('never delivers synchronously, even with zero latency', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 0, jitterMs: 0, seed: 5 });
    const got = record(s, b);
    a.send({ type: 'ping', id: 1 });
    expect(got).toEqual([]);
    s.advance(0);
    expect(got).toEqual([{ id: 1, at: 0 }]);
  });

  it('is deterministic for a seed and varies with the seed', () => {
    const arrivals = (seed: number): number[] => {
      const s = new VirtualScheduler();
      const [a, b] = loopbackPair(s, { latencyMs: 100, jitterMs: 50, seed });
      const got = record(s, b);
      sendPings(s, a, 20, 100);
      s.advance(500);
      return got.map((g) => g.at);
    };
    expect(arrivals(3)).toEqual(arrivals(3));
    expect(arrivals(3)).not.toEqual(arrivals(4));
  });

  it('delivers a validated copy of what was sent, to every listener', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const first: NetMsg[] = [];
    const second: NetMsg[] = [];
    b.onMessage((m) => first.push(m));
    b.onMessage((m) => second.push(m));
    const msg: NetMsg = { type: 'hello', proto: 1, app: 'bbtennis', name: '<b>Bo</b>', look: { skin: 9, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 } };
    a.send(msg);
    msg.proto = 2;
    s.advance(10);
    expect(first).toEqual([{ ...msg, proto: 1, name: '?b?Bo??b?', look: { ...msg.look, skin: 5 } }]);
    expect(second).toEqual(first);
    expect(first[0]).not.toBe(msg);
  });

  it('drops messages that fail validation and keeps delivering the rest', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got: NetMsg[] = [];
    b.onMessage((m) => got.push(m));
    a.send({ type: 'clock', turn: 3, τ: Number.NaN });
    a.send({ type: 'input', seq: 0, turn: 3, k: 'QQ', τ: 5 });
    a.send({ type: 'clock', turn: 3, τ: 50 });
    s.advance(10);
    expect(got).toEqual([{ type: 'clock', turn: 3, τ: 50 }]);
  });

  it(`delivers a message of exactly MAX_SEND_BYTES (${MAX_SEND_BYTES}) UTF-8 bytes`, () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got: NetMsg[] = [];
    b.onMessage((m) => got.push(m));
    a.send(helloOfBytes(MAX_SEND_BYTES));
    s.advance(10);
    expect(got).toHaveLength(1);
  });

  it.each([['x'], ['é']])('drops a message over MAX_SEND_BYTES (padded with %j) with a warning and keeps the channel', (pad) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got: NetMsg[] = [];
    const closes: string[] = [];
    b.onMessage((m) => got.push(m));
    b.onClose((r) => closes.push(r));
    a.onClose((r) => closes.push(r));
    a.send(helloOfBytes(MAX_SEND_BYTES + 1, pad));
    expect(warn.mock.calls).toEqual([['[bbt] frame too big', MAX_SEND_BYTES + 1]]);
    a.send({ type: 'ping', id: 1 });
    s.advance(100);
    expect(got).toEqual([{ type: 'ping', id: 1 }]);
    expect(closes).toEqual([]);
  });

  it('measures UTF-8 bytes, not characters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got = record(s, b);
    const m = helloOfBytes(MAX_SEND_BYTES + 2, 'é');
    expect(JSON.stringify(m).length).toBeLessThan(MAX_SEND_BYTES);
    a.send(m);
    s.advance(100);
    expect(got).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('a dropped message does not disturb the seeded delays of the others', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const arrivals = (withOversized: boolean): number[] => {
      const s = new VirtualScheduler();
      const [a, b] = loopbackPair(s, { latencyMs: 20, jitterMs: 50, seed: 6 });
      const got = record(s, b);
      for (let id = 0; id < 10; id++) {
        if (withOversized && id === 3) a.send(helloOfBytes(MAX_SEND_BYTES + 1));
        a.send({ type: 'ping', id });
        s.advance(5);
      }
      s.advance(200);
      return got.map((g) => g.at);
    };
    expect(arrivals(true)).toEqual(arrivals(false));
  });

  it.each([
    { latencyMs: -1, jitterMs: 0 },
    { latencyMs: 0, jitterMs: -5 },
    { latencyMs: Number.NaN, jitterMs: 0 },
    { latencyMs: 0, jitterMs: Number.POSITIVE_INFINITY },
  ])('rejects a bad latency model %j', (opts) => {
    expect(() => loopbackPair(new VirtualScheduler(), { ...opts, seed: 1 })).toThrow(RangeError);
  });
});

describe('loopbackPair encoding work', () => {
  it('measures the UTF-8 size of a message once per send', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got: NetMsg[] = [];
    b.onMessage((m) => got.push(m));
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');
    a.send({ type: 'ping', id: 1 });
    const encodes = encode.mock.calls.length;
    encode.mockRestore();
    s.advance(10);
    expect(encodes).toBe(1);
    expect(got).toEqual([{ type: 'ping', id: 1 }]);
  });

  it.each(['locally', 'by the other end'])('a send on an end closed %s encodes nothing, even an oversized one', (how) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    if (how === 'locally') a.close();
    else b.close();
    s.advance(10);
    const big = helloOfBytes(MAX_SEND_BYTES + 1);
    const stringify = vi.spyOn(JSON, 'stringify');
    a.send(big);
    const stringifies = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(stringifies).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(a.bufferedAmount).toBe(0);
  });
});

describe('loopbackPair listeners added late', () => {
  it('holds messages that arrive before the first listener and hands them to it in order', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    a.send({ type: 'ping', id: 1 });
    a.send({ type: 'ping', id: 2 });
    s.advance(50);
    const first: NetMsg[] = [];
    const second: NetMsg[] = [];
    b.onMessage((m) => first.push(m));
    expect(first).toEqual([{ type: 'ping', id: 1 }, { type: 'ping', id: 2 }]);
    b.onMessage((m) => second.push(m));
    a.send({ type: 'ping', id: 3 });
    s.advance(10);
    expect(first.map((m) => m.type === 'ping' && m.id)).toEqual([1, 2, 3]);
    expect(second).toEqual([{ type: 'ping', id: 3 }]);
  });

  it('reports a remote close to the first close listener added after it, after the held messages', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    a.send({ type: 'leave' });
    a.close();
    s.advance(50);
    const log: string[] = [];
    b.onMessage((m) => log.push(m.type));
    b.onClose((r) => log.push(`close:${r}`));
    b.onClose((r) => log.push(`late:${r}`));
    expect(log).toEqual(['leave', 'close:closed']);
  });

  it('releases a held close only after the held messages, even when onClose is added first', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    a.send({ type: 'reject', reason: 'full', proto: 1, app: 'bbtennis' });
    a.send({ type: 'leave' });
    a.close();
    s.advance(50);
    const log: string[] = [];
    b.onClose((r) => log.push(`close:${r}`));
    expect(log).toEqual([]);
    b.onMessage((m) => log.push(m.type));
    expect(log).toEqual(['reject', 'leave', 'close:closed']);
  });

  it('holds back a close that arrives while messages wait for their first listener', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const log: string[] = [];
    b.onClose((r) => log.push(`close:${r}`));
    a.send({ type: 'leave' });
    a.close();
    s.advance(50);
    expect(log).toEqual([]);
    b.onMessage((m) => log.push(m.type));
    expect(log).toEqual(['leave', 'close:closed']);
  });

  it('reports a held close to every close listener added before it was released, and to no later one', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    a.send({ type: 'leave' });
    a.close();
    s.advance(50);
    const log: string[] = [];
    b.onClose((r) => log.push(`first:${r}`));
    b.onClose((r) => log.push(`second:${r}`));
    b.onMessage((m) => log.push(m.type));
    b.onClose((r) => log.push(`late:${r}`));
    expect(log).toEqual(['leave', 'first:closed', 'second:closed']);
  });

  it(`holds at most MAX_HELD_MESSAGES (${MAX_HELD_MESSAGES}) messages and drops later ones with a single warning`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const ping = (id: number): NetMsg => ({ type: 'ping', id });
    for (let id = 0; id < MAX_HELD_MESSAGES; id++) a.send(ping(id));
    s.advance(10);
    expect(warn).not.toHaveBeenCalled();
    for (let id = MAX_HELD_MESSAGES; id < 100; id++) a.send(ping(id));
    s.advance(10);
    const heldBytes = Array.from({ length: MAX_HELD_MESSAGES }, (_, id) => utf8.encode(JSON.stringify(ping(id))).byteLength)
      .reduce((sum, n) => sum + n, 0);
    expect(warn.mock.calls).toEqual([[HELD_WARNING, MAX_HELD_MESSAGES, heldBytes]]);
    const got = record(s, b);
    a.send(ping(100));
    s.advance(10);
    expect(got.map((g) => g.id)).toEqual([...Array.from({ length: MAX_HELD_MESSAGES }, (_, id) => id), 100]);
  });

  it(`holds messages up to exactly MAX_HELD_BYTES (${MAX_HELD_BYTES}) UTF-8 bytes of JSON`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const frames = [frameOfBytes(MAX_SEND_BYTES), frameOfBytes(MAX_SEND_BYTES), frameOfBytes(MAX_HELD_BYTES - 2 * MAX_SEND_BYTES)];
    for (const f of frames) a.send(f);
    s.advance(10);
    expect(warn).not.toHaveBeenCalled();
    a.send({ type: 'ping', id: 1 });
    s.advance(10);
    expect(warn.mock.calls).toEqual([[HELD_WARNING, 3, MAX_HELD_BYTES]]);
    const got: NetMsg[] = [];
    b.onMessage((m) => got.push(m));
    expect(got).toEqual(frames);
  });

  it('after the first dropped message drops every later one until a listener is added, so the held ones are a prefix', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const kept = [frameOfBytes(MAX_SEND_BYTES), frameOfBytes(MAX_SEND_BYTES)];
    for (const f of kept) a.send(f);
    a.send(frameOfBytes(2000));
    a.send({ type: 'ping', id: 1 });
    s.advance(10);
    expect(warn).toHaveBeenCalledOnce();
    const got: NetMsg[] = [];
    b.onMessage((m) => got.push(m));
    a.send({ type: 'ping', id: 2 });
    s.advance(10);
    expect(got).toEqual([...kept, { type: 'ping', id: 2 }]);
  });

  it('drops held messages on a local close', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    a.send({ type: 'ping', id: 1 });
    s.advance(50);
    b.close();
    const got: NetMsg[] = [];
    b.onMessage((m) => got.push(m));
    expect(got).toEqual([]);
  });

  it('stops handing over held messages once the listener closes the transport', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    a.send({ type: 'hello', proto: 2, app: 'bbtennis', name: 'Old', look: { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 } });
    a.send({ type: 'ready', on: true });
    s.advance(50);
    const got: string[] = [];
    b.onMessage((m) => {
      got.push(m.type);
      if (m.type === 'hello') b.close();
    });
    expect(got).toEqual(['hello']);
  });
});

describe('loopbackPair bufferedAmount', () => {
  const bytes = (m: NetMsg): number => utf8.encode(JSON.stringify(m)).byteLength;

  it('is the UTF-8 bytes of the JSON of the messages still in flight, falling as each arrives', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 100, jitterMs: 0, seed: 1 });
    const m0: NetMsg = { type: 'ping', id: 0 };
    const m1: NetMsg = { type: 'hello', proto: 1, app: 'bbtennis', name: 'Zoë🎾', look: { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 } };
    const m2: NetMsg = { type: 'clock', turn: 2, τ: 1500.25 };
    expect(a.bufferedAmount).toBe(0);
    a.send(m0);
    s.advance(10);
    a.send(m1);
    s.advance(10);
    a.send(m2);
    expect(bytes(m1)).toBeGreaterThan(JSON.stringify(m1).length);
    expect(a.bufferedAmount).toBe(bytes(m0) + bytes(m1) + bytes(m2));
    expect(b.bufferedAmount).toBe(0);
    s.advance(80);
    expect(a.bufferedAmount).toBe(bytes(m1) + bytes(m2));
    s.advance(10);
    expect(a.bufferedAmount).toBe(bytes(m2));
    s.advance(10);
    expect(a.bufferedAmount).toBe(0);
  });

  it('tracks each direction on its own sending end', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 50, jitterMs: 20, seed: 3 });
    for (let id = 0; id < 5; id++) a.send({ type: 'ping', id });
    b.send({ type: 'pong', id: 1 });
    expect(a.bufferedAmount).toBe(5 * bytes({ type: 'ping', id: 0 }));
    expect(b.bufferedAmount).toBe(bytes({ type: 'pong', id: 1 }));
    s.advance(70);
    expect([a.bufferedAmount, b.bufferedAmount]).toEqual([0, 0]);
  });

  it('does not count a message dropped as too big', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a] = loopbackPair(s, { latencyMs: 50, jitterMs: 0, seed: 1 });
    a.send(helloOfBytes(MAX_SEND_BYTES + 1));
    expect(a.bufferedAmount).toBe(0);
    a.send(helloOfBytes(MAX_SEND_BYTES));
    expect(a.bufferedAmount).toBe(MAX_SEND_BYTES);
  });

  it('keeps counting messages sent before a close until they arrive, even at a closed receiver', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 50, jitterMs: 0, seed: 1 });
    a.send({ type: 'leave' });
    a.close();
    b.close();
    expect(a.bufferedAmount).toBe(bytes({ type: 'leave' }));
    s.advance(50);
    expect(a.bufferedAmount).toBe(0);
  });
});

describe('loopbackPair close', () => {
  it('propagates to the other side after the messages sent before it', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 100, jitterMs: 20, seed: 8 });
    const log: string[] = [];
    b.onMessage((m) => log.push(m.type));
    b.onClose((reason) => log.push(`close:${reason}`));
    a.send({ type: 'forfeit' });
    a.send({ type: 'leave' });
    a.close();
    s.advance(99);
    expect(log).toEqual([]);
    s.advance(100);
    expect(log).toEqual(['forfeit', 'leave', 'close:closed']);
  });

  it('does not report a local close to the closing side', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const closes: string[] = [];
    a.onClose((r) => closes.push(`a:${r}`));
    b.onClose((r) => closes.push(`b:${r}`));
    a.close();
    a.close();
    s.advance(100);
    b.close();
    s.advance(100);
    expect(closes).toEqual(['b:closed']);
  });

  it('stops traffic both ways once closed', () => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const atA = record(s, a);
    const atB = record(s, b);
    a.send({ type: 'ping', id: 0 });
    b.send({ type: 'ping', id: 0 });
    s.advance(10);
    b.send({ type: 'ping', id: 1 });
    a.close();
    a.send({ type: 'ping', id: 2 });
    s.advance(50);
    b.send({ type: 'ping', id: 3 });
    s.advance(50);
    expect(atA.map((g) => g.id)).toEqual([0]);
    expect(atB.map((g) => g.id)).toEqual([0]);
  });
});
