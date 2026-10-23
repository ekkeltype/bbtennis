import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualScheduler } from '../../src/game/clock';
import { loopbackPair, MAX_HELD_MESSAGES, REMOTE_CLOSED, type Transport } from '../../src/net/channel';
import { jsonCodec, MAX_SEND_BYTES } from '../../src/net/codec';

/** A toy protocol: notes with a short text, and pads of any size. */
type Toy = { type: 'note'; text: string } | { type: 'pad'; fill: string };

function parseToy(raw: unknown): Toy | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.type === 'note' && typeof r.text === 'string' && r.text.length <= 20) return { type: 'note', text: r.text };
  if (r.type === 'pad' && typeof r.fill === 'string') return { type: 'pad', fill: r.fill };
  return null;
}

const TOY = jsonCodec(parseToy);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('jsonCodec', () => {
  it('encodes JSON with its UTF-8 size and decodes what the protocol accepts', () => {
    const e = TOY.encode({ type: 'note', text: 'é' });
    expect(e).toEqual({ json: '{"type":"note","text":"é"}', bytes: 27 });
    expect(TOY.bytes({ type: 'note', text: 'é' })).toBe(27);
    expect(TOY.decode(e!.json)).toEqual({ type: 'note', text: 'é' });
  });

  it('decodes nothing that is not a JSON string the protocol accepts', () => {
    expect(TOY.decode({ type: 'note', text: 'x' })).toBeNull();
    expect(TOY.decode('{"type":"note"')).toBeNull();
    expect(TOY.decode('{"type":"note","text":"far too long for a note, really"}')).toBeNull();
    expect(TOY.decode('"note"')).toBeNull();
  });

  it('drops a message over MAX_SEND_BYTES with a warning, and never decodes a longer string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(TOY.encode({ type: 'pad', fill: 'x'.repeat(MAX_SEND_BYTES) })).toBeNull();
    expect(warn).toHaveBeenCalledWith('[bbt] frame too big', expect.any(Number));
    expect(TOY.decode(JSON.stringify({ type: 'pad', fill: 'x'.repeat(MAX_SEND_BYTES) }))).toBeNull();
  });
});

describe('loopbackPair over a codec', () => {
  it('delivers in send order through the codec, holding what arrives before a listener, then the close', () => {
    const s = new VirtualScheduler();
    const [a, b]: [Transport<Toy>, Transport<Toy>] = loopbackPair(s, { latencyMs: 20, jitterMs: 30, seed: 4 }, TOY);
    for (let i = 0; i < 5; i++) a.send({ type: 'note', text: `n${i}` });
    a.send({ type: 'note', text: 'this note is longer than twenty' });
    a.close();
    s.advance(100);
    const got: string[] = [];
    let closed: string | null = null;
    b.onClose((r) => (closed = r));
    expect(closed).toBeNull();
    b.onMessage((m) => got.push(m.type === 'note' ? m.text : 'pad'));
    expect(got).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(closed).toBe(REMOTE_CLOSED);
  });

  it('holds at most MAX_HELD_MESSAGES for a late listener, warning once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new VirtualScheduler();
    const [a, b] = loopbackPair(s, { latencyMs: 1, jitterMs: 0, seed: 1 }, TOY);
    for (let i = 0; i < MAX_HELD_MESSAGES + 3; i++) a.send({ type: 'note', text: String(i) });
    s.advance(10);
    const got: Toy[] = [];
    b.onMessage((m) => got.push(m));
    expect(got).toHaveLength(MAX_HELD_MESSAGES);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('counts the bytes in flight from the codec', () => {
    const s = new VirtualScheduler();
    const [a] = loopbackPair(s, { latencyMs: 50, jitterMs: 0, seed: 1 }, TOY);
    a.send({ type: 'note', text: 'hi' });
    expect(a.bufferedAmount).toBe(TOY.bytes({ type: 'note', text: 'hi' }));
    s.advance(60);
    expect(a.bufferedAmount).toBe(0);
  });
});
