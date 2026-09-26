import { util } from 'peerjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedRng, uniform } from '../../src/core/rng';
import { VirtualScheduler, type Scheduler } from '../../src/game/clock';
import { ALPHABET } from '../../src/net/codes';
import {
  CLOSE_FLUSH_MS, DEFAULT_ICE_SERVERS, HOST_CODE_TRIES, JOIN_TIMEOUT_MS, NetError, RECONNECT_DELAY_MS, SLOW_STATUS_MS,
  STILL_CONNECTING, errorKind, errorText, hostGame, joinGame, peerOptions,
  type BrokerOptions, type ConnLike, type PeerEnv, type PeerFactory, type PeerLike,
} from '../../src/net/peer';
import * as netErrors from '../../src/net/netErrors';
import * as peerConfig from '../../src/net/peerConfig';
import { MAX_SEND_BYTES, type NetMsg } from '../../src/net/protocol';
import { MAX_HELD_MESSAGES, type Transport } from '../../src/net/transport';

type Listener = (...args: any[]) => void;

const utf8 = new TextEncoder();

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, fn: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
}

class FakeConn extends Emitter implements ConnLike {
  readonly sent: unknown[] = [];
  readonly closes: ({ flush?: boolean } | undefined)[] = [];
  dataChannel = { bufferedAmount: 0 };

  constructor(readonly remoteId: string, readonly options?: { reliable: boolean; serialization: string }) {
    super();
  }

  /** Like a PeerJS 1.5 raw DataConnection: whatever is sent goes to the data channel as it is. */
  send(data: unknown): void {
    this.sent.push(data);
  }

  close(options?: { flush?: boolean }): void {
    this.closes.push(options);
  }
}

class FakePeer extends Emitter implements PeerLike {
  disconnected = false;
  destroyed = false;
  reconnects = 0;
  readonly conns: FakeConn[] = [];

  constructor(readonly id: string | null, readonly options: BrokerOptions) {
    super();
  }

  connect(id: string, options: { reliable: boolean; serialization: string }): FakeConn {
    const conn = new FakeConn(id, options);
    this.conns.push(conn);
    return conn;
  }

  reconnect(): void {
    this.reconnects++;
    this.disconnected = false;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Simulates the broker dropping the websocket. */
  dropBroker(): void {
    this.disconnected = true;
    this.emit('disconnected', this.id);
  }
}

/** A fake PeerJS world: every Peer created goes into `peers`. */
function fakeNet() {
  const peers: FakePeer[] = [];
  const createPeer: PeerFactory = async (id, options) => {
    const peer = new FakePeer(id, options);
    peers.push(peer);
    return peer;
  };
  const s = new VirtualScheduler();
  const rng = seedRng(11);
  return { peers, s, opts: { env: {}, scheduler: s, createPeer, rand: () => uniform(rng) } };
}

/** Lets pending promise continuations run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Aborts `controller` after `depth` nested microtasks (0 = now). */
function abortAfterMicrotasks(controller: AbortController, depth: number): void {
  if (depth === 0) controller.abort();
  else queueMicrotask(() => abortAfterMicrotasks(controller, depth - 1));
}

const peerError = (type: string) => ({ type, message: `fake ${type}` });

const HELLO: NetMsg = { type: 'hello', proto: 1, app: 'bbtennis', name: 'Sam', look: { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 } };

/** A hello whose JSON is exactly `bytes` UTF-8 bytes. */
function helloOfBytes(bytes: number): NetMsg {
  const m = { ...HELLO, name: '' };
  m.name = 'x'.repeat(bytes - utf8.encode(JSON.stringify(m)).byteLength);
  expect(utf8.encode(JSON.stringify(m)).byteLength).toBe(bytes);
  return m;
}

/** The host with one open guest connection and its transport. */
async function openGuest() {
  const net = fakeNet();
  const pending = hostGame(net.opts);
  await tick();
  const peer = net.peers[0]!;
  peer.emit('open', peer.id);
  const handle = await pending;
  let transport: Transport | null = null;
  handle.onGuest((t) => (transport = t));
  const conn = new FakeConn('guest-peer-id');
  peer.emit('connection', conn);
  conn.emit('open');
  const reasons: string[] = [];
  transport!.onClose((r) => reasons.push(r));
  return { ...net, conn, transport: transport!, reasons };
}

/** A join of `code` in a fake net, with its promise, its outcome and the statuses reported. */
async function startJoin(code = ' k7tqm ', signal?: AbortSignal) {
  const net = fakeNet();
  const statuses: string[] = [];
  const pending = joinGame(code, { ...net.opts, signal, onStatus: (t) => statuses.push(t) });
  const settled = pending.then((t) => ({ t }), (e: unknown) => ({ e }));
  await tick();
  return { ...net, peer: net.peers[0]!, pending, settled, statuses };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('peer.ts re-exports', () => {
  it('re-exports the config and error API of peerConfig.ts and netErrors.ts', () => {
    expect(DEFAULT_ICE_SERVERS).toBe(peerConfig.DEFAULT_ICE_SERVERS);
    expect(peerOptions).toBe(peerConfig.peerOptions);
    expect(NetError).toBe(netErrors.NetError);
    expect(errorKind).toBe(netErrors.errorKind);
    expect(errorText).toBe(netErrors.errorText);
  });
});

describe('hostGame', () => {
  it('registers bbtennis-<CODE> with the broker options and resolves once open', async () => {
    const { peers, opts } = fakeNet();
    const pending = hostGame({ ...opts, env: { VITE_PEER_HOST: 'peer.example.com' } });
    await tick();
    expect(peers).toHaveLength(1);
    const peer = peers[0]!;
    expect(peer.id).toMatch(new RegExp(`^bbtennis-[${ALPHABET}]{5}$`));
    expect(peer.options).toEqual({ host: 'peer.example.com', config: { iceServers: DEFAULT_ICE_SERVERS } });
    peer.emit('open', peer.id);
    const handle = await pending;
    expect(`bbtennis-${handle.code}`).toBe(peer.id);
    expect(peer.destroyed).toBe(false);
  });

  it('silently regenerates the code when the id is taken', async () => {
    const { peers, opts } = fakeNet();
    const pending = hostGame(opts);
    await tick();
    peers[0]!.emit('error', peerError('unavailable-id'));
    await tick();
    peers[1]!.emit('error', peerError('unavailable-id'));
    await tick();
    peers[2]!.emit('open', peers[2]!.id);
    const handle = await pending;
    expect(peers).toHaveLength(3);
    expect(peers.map((p) => p.destroyed)).toEqual([true, true, false]);
    expect(new Set(peers.map((p) => p.id)).size).toBe(3);
    expect(handle.code).toBe(peers[2]!.id!.slice('bbtennis-'.length));
  });

  it(`gives up after ${HOST_CODE_TRIES} taken codes`, async () => {
    const { peers, opts } = fakeNet();
    const pending = hostGame(opts);
    const settled = pending.catch((e: unknown) => e);
    for (let i = 0; i < HOST_CODE_TRIES; i++) {
      await tick();
      peers[i]!.emit('error', peerError('unavailable-id'));
    }
    const err = await settled;
    expect(HOST_CODE_TRIES).toBe(5);
    expect(err).toBeInstanceOf(NetError);
    expect(err).toMatchObject({ kind: 'broker' });
    expect(peers).toHaveLength(5);
    expect(peers.every((p) => p.destroyed)).toBe(true);
  });

  it.each([['network', 'broker'], ['browser-incompatible', 'webrtc'], ['server-error', 'broker']])(
    'fails at once on %s (%s)',
    async (type, kind) => {
      const { peers, opts } = fakeNet();
      const pending = hostGame(opts);
      await tick();
      peers[0]!.emit('error', peerError(type));
      await expect(pending).rejects.toMatchObject({ kind, message: `fake ${type}` });
      expect(peers).toHaveLength(1);
      expect(peers[0]!.destroyed).toBe(true);
    },
  );

  it(`fails with broker after ${JOIN_TIMEOUT_MS} ms without an answer`, async () => {
    const { peers, s, opts } = fakeNet();
    const pending = hostGame(opts);
    await tick();
    s.advance(JOIN_TIMEOUT_MS - 1);
    await tick();
    expect(peers[0]!.destroyed).toBe(false);
    s.advance(1);
    await expect(pending).rejects.toMatchObject({ kind: 'broker' });
    expect(peers[0]!.destroyed).toBe(true);
  });

  async function openHost() {
    const net = fakeNet();
    const pending = hostGame(net.opts);
    await tick();
    const peer = net.peers[0]!;
    peer.emit('open', peer.id);
    const handle = await pending;
    /** A guest connection arriving at the host; `open` it to complete the handshake. */
    const arrive = (): FakeConn => {
      const conn = new FakeConn('guest-peer-id');
      peer.emit('connection', conn);
      return conn;
    };
    return { ...net, peer, handle, arrive };
  }

  it('hands a guest over only once its connection is open', async () => {
    const { handle, arrive } = await openHost();
    const guests: unknown[] = [];
    handle.onGuest((t) => guests.push(t));
    const conn = arrive();
    expect(guests).toHaveLength(0);
    conn.emit('open');
    expect(guests).toHaveLength(1);
  });

  it('keeps a guest that opened before onGuest was registered', async () => {
    const { handle, arrive } = await openHost();
    arrive().emit('open');
    const guests: unknown[] = [];
    handle.onGuest((t) => guests.push(t));
    expect(guests).toHaveLength(1);
  });

  it("a late onGuest and onMessage still receive the guest's hello", async () => {
    const { handle, arrive } = await openHost();
    const conn = arrive();
    conn.emit('open');
    conn.emit('data', JSON.stringify(HELLO));
    conn.emit('data', '{"type":"ready","on":true}');
    let transport: Transport | null = null;
    handle.onGuest((t) => (transport = t));
    conn.emit('data', '{"type":"ping","id":1}');
    const first: NetMsg[] = [];
    const second: NetMsg[] = [];
    transport!.onMessage((m) => first.push(m));
    transport!.onMessage((m) => second.push(m));
    conn.emit('data', '{"type":"ping","id":2}');
    expect(first).toEqual([HELLO, { type: 'ready', on: true }, { type: 'ping', id: 1 }, { type: 'ping', id: 2 }]);
    expect(second).toEqual([{ type: 'ping', id: 2 }]);
  });

  it('reports a close that came before the first onClose listener once one is added', async () => {
    const { handle, arrive } = await openHost();
    const transports: Transport[] = [];
    handle.onGuest((t) => transports.push(t));
    const conn = arrive();
    conn.emit('open');
    conn.emit('data', '{"type":"leave"}');
    conn.emit('close');
    const log: string[] = [];
    transports[0]!.onMessage((m) => log.push(m.type));
    transports[0]!.onClose((r) => log.push(`close:${r}`));
    transports[0]!.onClose((r) => log.push(`late:${r}`));
    expect(log).toEqual(['leave', 'close:closed']);
  });

  it('reports a close only after the held messages, even when onClose is added first', async () => {
    const { handle, arrive } = await openHost();
    const transports: Transport[] = [];
    handle.onGuest((t) => transports.push(t));
    const conn = arrive();
    conn.emit('open');
    const log: string[] = [];
    transports[0]!.onClose((r) => log.push(`close:${r}`));
    conn.emit('data', '{"type":"leave"}');
    conn.emit('error', peerError('negotiation-failed'));
    expect(log).toEqual([]);
    transports[0]!.onMessage((m) => log.push(m.type));
    expect(log).toEqual(['leave', 'close:negotiation-failed']);
  });

  it(`holds at most MAX_HELD_MESSAGES (${MAX_HELD_MESSAGES}) messages of an unclaimed guest that floods the host`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handle, arrive } = await openHost();
    const conn = arrive();
    conn.emit('open');
    for (let id = 0; id < 1000; id++) conn.emit('data', `{"type":"ping","id":${id}}`);
    let transport: Transport | null = null;
    handle.onGuest((t) => (transport = t));
    const got: number[] = [];
    transport!.onMessage((m) => {
      if (m.type === 'ping') got.push(m.id);
    });
    conn.emit('data', '{"type":"ping","id":1000}');
    expect(got).toEqual([...Array.from({ length: MAX_HELD_MESSAGES }, (_, id) => id), 1000]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe('[bbt] held messages over the cap, dropping the rest');
  });

  it('drops held messages on a local close', async () => {
    const { handle, arrive } = await openHost();
    let transport: Transport | null = null;
    handle.onGuest((t) => (transport = t));
    const conn = arrive();
    conn.emit('open');
    conn.emit('data', '{"type":"leave"}');
    transport!.close();
    const got: NetMsg[] = [];
    transport!.onMessage((m) => got.push(m));
    expect(got).toEqual([]);
  });

  it('never hands over a guest whose connection closed or failed before onGuest', async () => {
    const { handle, arrive } = await openHost();
    const [closed, failed, alive] = [arrive(), arrive(), arrive()];
    for (const c of [closed, failed, alive]) c.emit('open');
    closed.emit('data', JSON.stringify(HELLO));
    closed.emit('close');
    failed.emit('error', peerError('negotiation-failed'));
    const guests: Transport[] = [];
    handle.onGuest((t) => guests.push(t));
    expect(guests).toHaveLength(1);
    const got: NetMsg[] = [];
    guests[0]!.onMessage((m) => got.push(m));
    alive.emit('data', '{"type":"ping","id":7}');
    expect(got).toEqual([{ type: 'ping', id: 7 }]);
  });

  it('hands over no guest after close()', async () => {
    const { handle, arrive } = await openHost();
    const conn = arrive();
    conn.emit('open');
    handle.close();
    const guests: Transport[] = [];
    handle.onGuest((t) => guests.push(t));
    expect(guests).toEqual([]);
  });

  it('guest transport validates incoming data and sends through the connection', async () => {
    const { handle, arrive } = await openHost();
    let transport: import('../../src/net/transport').Transport | null = null;
    handle.onGuest((t) => (transport = t));
    const conn = arrive();
    conn.emit('open');
    const got: NetMsg[] = [];
    transport!.onMessage((m) => got.push(m));
    conn.emit('data', JSON.stringify({ ...HELLO, name: '<Sam>' }));
    conn.emit('data', '{"type":"hello"}');
    conn.emit('data', 'garbage');
    conn.emit('data', '[object Object]');
    conn.emit('data', { type: 'leave' });
    conn.emit('data', utf8.encode('{"type":"leave"}').buffer);
    conn.emit('data', JSON.stringify({ type: 'ping', id: 3 }));
    expect(got).toEqual([{ ...HELLO, name: '?Sam?' }, { type: 'ping', id: 3 }]);
    transport!.send({ type: 'ping', id: 4 });
    expect(conn.sent).toEqual(['{"type":"ping","id":4}']);
    conn.dataChannel.bufferedAmount = 20000;
    expect(transport!.bufferedAmount).toBe(20000);
  });

  it(`a local close lets sent messages go out and closes after ${CLOSE_FLUSH_MS} ms, without reporting onClose`, async () => {
    const { handle, arrive, s } = await openHost();
    let transport: import('../../src/net/transport').Transport | null = null;
    handle.onGuest((t) => (transport = t));
    const conn = arrive();
    conn.emit('open');
    const reasons: string[] = [];
    transport!.onClose((r) => reasons.push(r));
    transport!.send({ type: 'reject', reason: 'full', proto: 1, app: 'bbtennis' });
    transport!.close();
    transport!.close();
    transport!.send({ type: 'leave' });
    expect(conn.sent).toEqual(['{"type":"reject","reason":"full","proto":1,"app":"bbtennis"}']);
    expect(conn.closes).toEqual([]);
    s.advance(CLOSE_FLUSH_MS - 1);
    expect(conn.closes).toEqual([]);
    s.advance(1);
    expect(conn.closes).toEqual([undefined]);
    expect(conn.sent).toHaveLength(1);
    conn.emit('close');
    expect(reasons).toEqual([]);
  });

  it('reports a remote close or a connection error once and stops delivering', async () => {
    const { handle, arrive } = await openHost();
    const transports: import('../../src/net/transport').Transport[] = [];
    handle.onGuest((t) => transports.push(t));
    const [c1, c2] = [arrive(), arrive()];
    c1.emit('open');
    c2.emit('open');
    const reasons: string[] = [];
    const got: NetMsg[] = [];
    transports[0]!.onClose((r) => reasons.push(`1:${r}`));
    transports[1]!.onClose((r) => reasons.push(`2:${r}`));
    transports[0]!.onMessage((m) => got.push(m));
    c1.emit('close');
    c1.emit('close');
    c1.emit('data', '{"type":"leave"}');
    c2.emit('error', peerError('negotiation-failed'));
    expect(reasons).toEqual(['1:closed', '2:negotiation-failed']);
    expect(got).toEqual([]);
    transports[0]!.send({ type: 'leave' });
    expect(c1.sent).toEqual([]);
  });

  it(`re-registers with the broker ${RECONNECT_DELAY_MS} ms after losing it while no guest is connected`, async () => {
    const { peer, s } = await openHost();
    peer.dropBroker();
    s.advance(RECONNECT_DELAY_MS - 1);
    expect(peer.reconnects).toBe(0);
    s.advance(1);
    expect(peer.reconnects).toBe(1);
  });

  it('leaves the broker alone while a guest is connected and re-registers when the guest leaves', async () => {
    const { peer, s, handle, arrive } = await openHost();
    handle.onGuest(() => {});
    const conn = arrive();
    conn.emit('open');
    peer.dropBroker();
    s.advance(10 * RECONNECT_DELAY_MS);
    expect(peer.reconnects).toBe(0);
    conn.emit('close');
    s.advance(RECONNECT_DELAY_MS);
    expect(peer.reconnects).toBe(1);
  });

  it('ignores broker errors after it is open', async () => {
    const { peer, handle, arrive } = await openHost();
    const reasons: string[] = [];
    handle.onGuest((t) => t.onClose((r) => reasons.push(r)));
    arrive().emit('open');
    peer.emit('error', peerError('network'));
    expect(peer.destroyed).toBe(false);
    expect(reasons).toEqual([]);
  });

  it(`close() closes guests and destroys the peer after ${CLOSE_FLUSH_MS} ms, and stops reconnecting`, async () => {
    const { peer, s, handle, arrive } = await openHost();
    handle.onGuest(() => {});
    const conn = arrive();
    conn.emit('open');
    handle.close();
    expect(conn.closes).toEqual([]);
    expect(peer.destroyed).toBe(false);
    s.advance(CLOSE_FLUSH_MS);
    expect(conn.closes).toEqual([undefined]);
    expect(peer.destroyed).toBe(true);
    peer.dropBroker();
    s.advance(10 * RECONNECT_DELAY_MS);
    expect(peer.reconnects).toBe(0);
    const late = arrive();
    late.emit('open');
    expect(late.closes).toEqual([undefined]);
  });

  it('close() without guests destroys the peer at once', async () => {
    const { peer, handle } = await openHost();
    handle.close();
    expect(peer.destroyed).toBe(true);
  });
});

describe('PeerJS transport message size', () => {
  it(`sends a message of exactly MAX_SEND_BYTES (${MAX_SEND_BYTES}) as its JSON`, async () => {
    const { conn, transport, reasons } = await openGuest();
    const big = helloOfBytes(MAX_SEND_BYTES);
    transport.send(big);
    expect(conn.sent).toEqual([JSON.stringify(big)]);
    expect(reasons).toEqual([]);
  });

  it(`sends a 20000-byte message, over the ${util.chunkedMTU}-byte limit of PeerJS's JSON channel`, async () => {
    const { conn, transport } = await openGuest();
    const big = helloOfBytes(20000);
    expect(20000).toBeGreaterThan(util.chunkedMTU);
    transport.send(big);
    expect(conn.sent).toEqual([JSON.stringify(big)]);
  });

  it.each([MAX_SEND_BYTES + 1, 40000])(
    'drops a %i-byte message with a "[bbt] frame too big" warning and keeps the connection',
    async (bytes) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { conn, transport, reasons } = await openGuest();
      transport.send(helloOfBytes(bytes));
      expect(conn.sent).toEqual([]);
      expect(warn.mock.calls).toEqual([['[bbt] frame too big', bytes]]);
      transport.send({ type: 'ping', id: 1 });
      expect(conn.sent).toEqual(['{"type":"ping","id":1}']);
      expect(conn.closes).toEqual([]);
      expect(reasons).toEqual([]);
    },
  );

  it.each(['close()', 'a remote close'])('a send after %s encodes nothing, even an oversized one', async (how) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { conn, transport } = await openGuest();
    if (how === 'close()') transport.close();
    else conn.emit('close');
    const big = helloOfBytes(MAX_SEND_BYTES + 1);
    const stringify = vi.spyOn(JSON, 'stringify');
    transport.send(big);
    const stringifies = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(stringifies).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(conn.sent).toEqual([]);
  });
});

describe('PeerJS unavailable', () => {
  const failing: PeerFactory = async () => {
    throw new TypeError('Failed to fetch dynamically imported module');
  };

  it('hostGame and joinGame fail with broker when the Peer cannot be created', async () => {
    const { opts } = fakeNet();
    const env = { ...opts, createPeer: failing };
    await expect(hostGame(env)).rejects.toMatchObject({ name: 'NetError', kind: 'broker', message: 'Failed to fetch dynamically imported module' });
    await expect(joinGame('K7TQM', env)).rejects.toMatchObject({ name: 'NetError', kind: 'broker' });
  });
});

describe('joinGame', () => {
  it.each(['', 'K7TQ', 'K7TQO', 'hello!'])('rejects the malformed code %j as notFound without touching the network', async (code) => {
    const { peers, opts } = fakeNet();
    await expect(joinGame(code, opts)).rejects.toMatchObject({ kind: 'notFound' });
    expect(peers).toHaveLength(0);
  });

  it('connects reliably with raw serialization to the host only after reaching the broker', async () => {
    const { peer, pending } = await startJoin();
    expect(peer.id).toBeNull();
    expect(peer.conns).toHaveLength(0);
    peer.emit('open', 'guest-id');
    expect(peer.conns).toHaveLength(1);
    const conn = peer.conns[0]!;
    expect(conn.remoteId).toBe('bbtennis-K7TQM');
    expect(conn.options).toEqual({ reliable: true, serialization: 'raw' });
    conn.emit('open');
    const t = await pending;
    const got: NetMsg[] = [];
    t.onMessage((m) => got.push(m));
    t.send({ type: 'ready', on: true });
    expect(conn.sent).toEqual(['{"type":"ready","on":true}']);
    conn.emit('data', '{"type":"lobby","config":null,"ready":[true,false]}');
    conn.emit('data', '{"type":"pong","id":9}');
    expect(got).toEqual([{ type: 'pong', id: 9 }]);
  });

  it('maps peer-unavailable to notFound and destroys the peer', async () => {
    const { peer, settled } = await startJoin();
    peer.emit('open', 'guest-id');
    peer.emit('error', peerError('peer-unavailable'));
    const { e } = (await settled) as { e: NetError };
    expect(e).toBeInstanceOf(NetError);
    expect(e.kind).toBe('notFound');
    expect(peer.destroyed).toBe(true);
  });

  it.each([['network', 'broker'], ['webrtc', 'webrtc'], ['browser-incompatible', 'webrtc']])('maps %s to %s', async (type, kind) => {
    const { peer, settled } = await startJoin();
    peer.emit('error', peerError(type));
    expect(await settled).toMatchObject({ e: { kind } });
  });

  it(`reports "${STILL_CONNECTING}" after ${SLOW_STATUS_MS} ms`, async () => {
    const { s, statuses } = await startJoin();
    s.advance(SLOW_STATUS_MS - 1);
    expect(statuses).toEqual([]);
    s.advance(1);
    expect(statuses).toEqual(['Still connecting…']);
  });

  it('reports no status once connected', async () => {
    const { s, peer, statuses, pending } = await startJoin();
    peer.emit('open', 'guest-id');
    peer.conns[0]!.emit('open');
    await pending;
    s.advance(JOIN_TIMEOUT_MS * 2);
    expect(statuses).toEqual([]);
  });

  it(`fails with nat when the broker answered but the host did not open within ${JOIN_TIMEOUT_MS} ms`, async () => {
    const { s, peer, settled } = await startJoin();
    peer.emit('open', 'guest-id');
    s.advance(JOIN_TIMEOUT_MS - 1);
    expect(peer.destroyed).toBe(false);
    s.advance(1);
    expect(await settled).toMatchObject({ e: { kind: 'nat' } });
    expect(peer.destroyed).toBe(true);
  });

  it(`fails with broker when the broker never answered within ${JOIN_TIMEOUT_MS} ms`, async () => {
    const { s, peer, settled } = await startJoin();
    s.advance(JOIN_TIMEOUT_MS);
    expect(await settled).toMatchObject({ e: { kind: 'broker' } });
    expect(peer.destroyed).toBe(true);
  });

  it('fails with nat when the connection closes or fails to negotiate before opening', async () => {
    const first = await startJoin();
    first.peer.emit('open', 'guest-id');
    first.peer.conns[0]!.emit('close');
    expect(await first.settled).toMatchObject({ e: { kind: 'nat' } });

    const second = await startJoin();
    second.peer.emit('open', 'guest-id');
    second.peer.conns[0]!.emit('error', peerError('negotiation-failed'));
    expect(await second.settled).toMatchObject({ e: { kind: 'nat' } });
  });

  it('the joined transport outlives late broker errors and the join timeout', async () => {
    const { s, peer, pending } = await startJoin();
    peer.emit('open', 'guest-id');
    const conn = peer.conns[0]!;
    conn.emit('open');
    const t = await pending;
    const reasons: string[] = [];
    t.onClose((r) => reasons.push(r));
    peer.emit('error', peerError('network'));
    s.advance(JOIN_TIMEOUT_MS * 2);
    expect(reasons).toEqual([]);
    expect(peer.destroyed).toBe(false);
    expect(conn.closes).toEqual([]);
  });

  it(`closing the joined transport closes the connection after ${CLOSE_FLUSH_MS} ms and destroys the peer`, async () => {
    const { s, peer, pending } = await startJoin();
    peer.emit('open', 'guest-id');
    const conn = peer.conns[0]!;
    conn.emit('open');
    const t = await pending;
    t.send({ type: 'leave' });
    t.close();
    expect(conn.sent).toEqual(['{"type":"leave"}']);
    expect(conn.closes).toEqual([]);
    expect(peer.destroyed).toBe(false);
    s.advance(CLOSE_FLUSH_MS);
    expect(conn.closes).toEqual([undefined]);
    expect(peer.destroyed).toBe(true);
  });

  it('a remote close reports onClose and destroys the peer', async () => {
    const { peer, pending } = await startJoin();
    peer.emit('open', 'guest-id');
    const conn = peer.conns[0]!;
    conn.emit('open');
    const t = await pending;
    const reasons: string[] = [];
    t.onClose((r) => reasons.push(r));
    conn.emit('close');
    expect(reasons).toEqual(['closed']);
    expect(peer.destroyed).toBe(true);
  });
});

describe('cancellation', () => {
  /** A fake net whose PeerJS "loads" only when `load()` is called. */
  function loadingNet() {
    const net = fakeNet();
    let load!: () => void;
    const loaded = new Promise<void>((resolve) => (load = resolve));
    const createPeer: PeerFactory = async (id, options) => {
      await loaded;
      return net.opts.createPeer(id, options);
    };
    return { ...net, load, opts: { ...net.opts, createPeer } };
  }

  it('an already-aborted signal rejects hostGame and joinGame with cancelled without creating a peer', async () => {
    const { peers, opts } = fakeNet();
    const signal = AbortSignal.abort();
    await expect(hostGame({ ...opts, signal })).rejects.toMatchObject({ name: 'NetError', kind: 'cancelled' });
    await expect(joinGame('K7TQM', { ...opts, signal })).rejects.toMatchObject({ name: 'NetError', kind: 'cancelled' });
    expect(peers).toHaveLength(0);
  });

  it.each([
    ['hostGame', (opts: PeerEnv) => hostGame(opts)],
    ['joinGame', (opts: PeerEnv) => joinGame('K7TQM', opts)],
  ] as const)('%s aborted while PeerJS loads rejects at once and destroys the peer created later', async (_name, start) => {
    const { peers, opts, load } = loadingNet();
    const controller = new AbortController();
    const settled = start({ ...opts, signal: controller.signal }).catch((e: unknown) => e);
    await tick();
    controller.abort();
    expect(await settled).toMatchObject({ kind: 'cancelled' });
    load();
    await tick();
    expect(peers).toHaveLength(1);
    expect(peers[0]!.destroyed).toBe(true);
  });

  it.each([
    ['hostGame', (opts: PeerEnv) => hostGame(opts)],
    ['joinGame', (opts: PeerEnv) => joinGame('K7TQM', opts)],
  ] as const)('%s notices an abort that came while it was still setting up its timers', async (_name, start) => {
    const { peers, s, opts } = fakeNet();
    const controller = new AbortController();
    const abortingScheduler: Scheduler = {
      now: () => s.now(),
      every: (ms, fn) => s.every(ms, fn),
      after: (ms, fn) => {
        controller.abort();
        return s.after(ms, fn);
      },
    };
    const settled = start({ ...opts, scheduler: abortingScheduler, signal: controller.signal }).catch((e: unknown) => e);
    await tick();
    expect(await settled).toMatchObject({ kind: 'cancelled' });
    expect(peers).toHaveLength(1);
    expect(peers[0]!.destroyed).toBe(true);
  });

  it.each([
    ['hostGame', (opts: PeerEnv) => hostGame(opts)],
    ['joinGame', (opts: PeerEnv) => joinGame('K7TQM', opts)],
  ] as const)('%s always settles as cancelled when the abort comes from a microtask right after the Peer is created', async (_name, start) => {
    const depths = Array.from({ length: 13 }, (_, i) => i);
    const outcomes: { depth: number; kind: unknown; destroyed: boolean | undefined }[] = [];
    for (const depth of depths) {
      const { peers, opts } = fakeNet();
      const controller = new AbortController();
      const createPeer: PeerFactory = async (id, options) => {
        const peer = await opts.createPeer(id, options);
        abortAfterMicrotasks(controller, depth);
        return peer;
      };
      const settled = start({ ...opts, createPeer, signal: controller.signal }).then(() => 'resolved', (e: unknown) => e);
      const outcome = await Promise.race([settled, tick().then(() => 'pending')]);
      await tick();
      const kind = outcome instanceof NetError ? outcome.kind : outcome;
      outcomes.push({ depth, kind, destroyed: peers[0]?.destroyed });
    }
    expect(outcomes).toEqual(depths.map((depth) => ({ depth, kind: 'cancelled', destroyed: true })));
  });

  it('hostGame aborted while waiting for the broker destroys the peer, rejects and tries no other code', async () => {
    const { peers, s, opts } = fakeNet();
    const controller = new AbortController();
    const settled = hostGame({ ...opts, signal: controller.signal }).catch((e: unknown) => e);
    await tick();
    controller.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(NetError);
    expect(err).toMatchObject({ kind: 'cancelled' });
    expect(peers[0]!.destroyed).toBe(true);
    peers[0]!.emit('error', peerError('unavailable-id'));
    s.advance(JOIN_TIMEOUT_MS * 2);
    await tick();
    expect(peers).toHaveLength(1);
  });

  it('hostGame aborted in the same turn as the broker opens still rejects, and the peer is destroyed', async () => {
    const { peers, opts } = fakeNet();
    const controller = new AbortController();
    const settled = hostGame({ ...opts, signal: controller.signal }).catch((e: unknown) => e);
    await tick();
    peers[0]!.emit('open', peers[0]!.id);
    controller.abort();
    expect(await settled).toMatchObject({ kind: 'cancelled' });
    expect(peers[0]!.destroyed).toBe(true);
  });

  it('joinGame aborted before the broker answers destroys the peer and reports nothing more', async () => {
    const controller = new AbortController();
    const { s, peer, settled, statuses } = await startJoin('K7TQM', controller.signal);
    controller.abort();
    expect(await settled).toMatchObject({ e: { kind: 'cancelled' } });
    expect(peer.destroyed).toBe(true);
    peer.emit('open', 'guest-id');
    peer.emit('error', peerError('network'));
    s.advance(JOIN_TIMEOUT_MS * 2);
    expect(statuses).toEqual([]);
  });

  it('joinGame aborted while connecting rejects, and a connection that opens afterwards is closed at once', async () => {
    const controller = new AbortController();
    const { peer, settled } = await startJoin('K7TQM', controller.signal);
    peer.emit('open', 'guest-id');
    const conn = peer.conns[0]!;
    controller.abort();
    expect(await settled).toMatchObject({ e: { kind: 'cancelled' } });
    expect(peer.destroyed).toBe(true);
    conn.emit('open');
    expect(conn.closes).toEqual([undefined]);
  });

  it('joinGame aborted in the same turn as the connection opens rejects and closes that transport', async () => {
    const controller = new AbortController();
    const { s, peer, settled } = await startJoin('K7TQM', controller.signal);
    peer.emit('open', 'guest-id');
    const conn = peer.conns[0]!;
    conn.emit('open');
    controller.abort();
    expect(await settled).toMatchObject({ e: { kind: 'cancelled' } });
    s.advance(CLOSE_FLUSH_MS);
    expect(conn.closes).toEqual([undefined]);
    expect(peer.destroyed).toBe(true);
  });

  it('aborting after hostGame or joinGame resolved changes nothing', async () => {
    const hostAbort = new AbortController();
    const host = fakeNet();
    const hosting = hostGame({ ...host.opts, signal: hostAbort.signal });
    await tick();
    host.peers[0]!.emit('open', host.peers[0]!.id);
    await hosting;
    hostAbort.abort();
    expect(host.peers[0]!.destroyed).toBe(false);

    const joinAbort = new AbortController();
    const { peer, pending } = await startJoin('K7TQM', joinAbort.signal);
    peer.emit('open', 'guest-id');
    const conn = peer.conns[0]!;
    conn.emit('open');
    const t = await pending;
    joinAbort.abort();
    t.send({ type: 'ping', id: 1 });
    expect(conn.sent).toEqual(['{"type":"ping","id":1}']);
    expect(conn.closes).toEqual([]);
    expect(peer.destroyed).toBe(false);
  });
});
