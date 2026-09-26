import { describe, expect, it } from 'vitest';
import { VirtualScheduler } from '../../src/game/clock';
import { MAX_SEND_BYTES, type NetMsg } from '../../src/net/protocol';
import { loopbackPair, type Transport } from '../../src/net/transport';

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

  it('reports nothing buffered locally', () => {
    const s = new VirtualScheduler();
    const [a] = loopbackPair(s, { latencyMs: 400, jitterMs: 0, seed: 1 });
    for (let i = 0; i < 100; i++) a.send({ type: 'ping', id: i });
    expect(a.bufferedAmount).toBe(0);
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

  it.each([['x'], ['é']])('throws RangeError for a message over MAX_SEND_BYTES (padded with %j) and sends nothing', (pad) => {
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got: NetMsg[] = [];
    const closes: string[] = [];
    b.onMessage((m) => got.push(m));
    b.onClose((r) => closes.push(r));
    a.onClose((r) => closes.push(r));
    expect(() => a.send(helloOfBytes(MAX_SEND_BYTES + 1, pad))).toThrow(RangeError);
    a.send({ type: 'ping', id: 1 });
    s.advance(100);
    expect(got).toEqual([{ type: 'ping', id: 1 }]);
    expect(closes).toEqual([]);
  });

  it('measures UTF-8 bytes, not characters', () => {
    const s = new VirtualScheduler();
    const [a] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const m = helloOfBytes(MAX_SEND_BYTES + 2, 'é');
    expect(JSON.stringify(m).length).toBeLessThan(MAX_SEND_BYTES);
    expect(() => a.send(m)).toThrow(RangeError);
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
