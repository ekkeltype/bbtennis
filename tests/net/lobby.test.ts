import { beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { loopbackPair, type Transport } from '../../src/net/channel';
import { jsonCodec } from '../../src/net/codec';
import type { LinkMsg } from '../../src/net/link';
import { GuestLobby, HostLobby, type HostStart, type LobbyMsg, type LobbyProto } from '../../src/net/lobby';
import type { HostHandle } from '../../src/net/rtc';

/** A toy game: its match config, and a protocol of the lobby's and link's messages plus its own start. */
interface Toy { size: number }
type ToyMsg = LobbyMsg<Toy> | LinkMsg | { type: 'start'; n: number };

const TYPES = new Set(['hello', 'welcome', 'reject', 'lobby', 'ready', 'ping', 'pong', 'leave', 'start']);
const TOY = jsonCodec<ToyMsg>((raw) => {
  const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  return typeof type === 'string' && TYPES.has(type) ? (raw as ToyMsg) : null;
});

const PROTO: LobbyProto = { proto: 1, app: 'toy@abc123' };
const LOOK = { skin: 2, hairStyle: 1, hair: 3, shirt: 7, shorts: 0, headband: null, racket: 2 };
const HANA: Profile = { name: 'Hana', look: LOOK };
const GUS: Profile = { name: 'Gus', look: { ...LOOK, shirt: 9 } };

/** What a session factory got: the transport it runs on and, on the host, the start data. */
interface ToySession { t: Transport<ToyMsg>; start: HostStart<Toy> | null; got: ToyMsg[] }

let s: VirtualScheduler;

beforeEach(() => {
  s = new VirtualScheduler(1000);
});

/** Lets resolved promises (the host and join results) run their callbacks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A HostHandle whose guests the test brings in: `arrive()` returns the guest's end of a new connection. */
interface FakeHandle extends HostHandle<ToyMsg> {
  closed: number;
  arrive(): Transport<ToyMsg>;
}

function fakeHandle(): FakeHandle {
  let cb: ((t: Transport<ToyMsg>) => void) | null = null;
  const early: Transport<ToyMsg>[] = [];
  const handle: FakeHandle = {
    code: 'K7TQM',
    closed: 0,
    onGuest(c) {
      cb = c;
      for (const t of early.splice(0)) c(t);
    },
    close() {
      handle.closed++;
    },
    arrive() {
      const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 3 }, TOY);
      if (cb) cb(hostEnd);
      else early.push(hostEnd);
      return guestEnd;
    },
  };
  return handle;
}

/** Everything the other end sends from now on; pings are answered, as a live peer does. */
function collect(t: Transport<ToyMsg>): ToyMsg[] {
  const got: ToyMsg[] = [];
  t.onMessage((m) => {
    got.push(m);
    if (m.type === 'ping') t.send({ type: 'pong', id: m.id });
  });
  return got;
}

/** A host lobby on a fake handle, open and waiting; its sessions and starts are recorded. */
async function hosting(): Promise<{ lobby: HostLobby<Toy, ToyMsg, ToySession>; handle: FakeHandle; started: { session: ToySession; release: () => void }[] }> {
  const handle = fakeHandle();
  const started: { session: ToySession; release: () => void }[] = [];
  const lobby = new HostLobby<Toy, ToyMsg, ToySession>({
    proto: PROTO,
    host: async () => handle,
    scheduler: s,
    seed: () => 42,
    me: HANA,
    config: { size: 3 },
    onChange: () => {},
    session: (t, start) => {
      t.send({ type: 'start', n: 7 });
      return { t, start, got: collect(t) };
    },
    onStart: (session, release) => started.push({ session, release }),
  });
  lobby.open();
  await flush();
  return { lobby, handle, started };
}

/** A guest lobby that joins through `handle`; its sessions are recorded. */
function guest(handle: FakeHandle, proto: LobbyProto = PROTO): { lobby: GuestLobby<Toy, ToyMsg, ToySession>; started: ToySession[] } {
  const started: ToySession[] = [];
  const lobby = new GuestLobby<Toy, ToyMsg, ToySession>({
    proto,
    join: async () => handle.arrive(),
    scheduler: s,
    me: GUS,
    onChange: () => {},
    session: (t) => ({ t, start: null, got: collect(t) }),
    onStart: (session) => started.push(session),
  });
  return { lobby, started };
}

const hello = (p: Profile, proto: LobbyProto = PROTO): ToyMsg => ({ type: 'hello', proto: proto.proto, app: proto.app, name: p.name, look: p.look });

describe('generic lobby: hello and welcome', () => {
  it("answers a guest's hello with welcome{proto, hostProfile, config}", async () => {
    const { lobby, handle } = await hosting();
    expect(lobby.phase).toBe('waiting');
    expect(lobby.code).toBe('K7TQM');
    const g = handle.arrive();
    const got = collect(g);
    g.send(hello(GUS));
    s.advance(30);
    expect(got[0]).toEqual({ type: 'welcome', proto: 1, hostProfile: HANA, config: { size: 3 } });
    expect(lobby.phase).toBe('joined');
    expect(lobby.guest).toEqual(GUS);
  });

  it('a guest lobby says hello and, welcomed, shows the host and the config', async () => {
    const { lobby: host, handle } = await hosting();
    const { lobby } = guest(handle);
    lobby.connect('K7TQM');
    expect(lobby.phase).toBe('connecting');
    await flush();
    s.advance(30);
    expect(lobby.phase).toBe('joined');
    expect(lobby.host).toEqual(HANA);
    expect(lobby.config).toEqual({ size: 3 });
    expect(host.guest).toEqual(GUS);
  });
});

describe('generic lobby: versions', () => {
  it('a guest with another app id is rejected with "version", and its error text names no versions', async () => {
    const { lobby: host, handle } = await hosting();
    const { lobby } = guest(handle, { proto: 1, app: 'toy@def456' });
    lobby.connect('K7TQM');
    await flush();
    s.advance(30);
    expect(lobby.phase).toBe('failed');
    expect(lobby.error).toBe('Versions differ — both players reload with Ctrl+Shift+R');
    expect(lobby.error).not.toContain('(host v');
    expect(host.phase).toBe('waiting');
  });

  it('a guest with another protocol number is rejected with both versions in the text', async () => {
    const { handle } = await hosting();
    const { lobby } = guest(handle, { proto: 2, app: PROTO.app });
    lobby.connect('K7TQM');
    await flush();
    s.advance(30);
    expect(lobby.error).toBe('Versions differ (host v1, you v2) — reload with Ctrl+Shift+R');
  });

  it('the rejected guest gets reject{version, proto, app} and its connection closes', async () => {
    const { handle } = await hosting();
    const g = handle.arrive();
    const got = collect(g);
    const closes: string[] = [];
    g.onClose((r) => closes.push(r));
    g.send(hello(GUS, { proto: 1, app: 'toy@def456' }));
    s.advance(1000);
    expect(got[0]).toEqual({ type: 'reject', reason: 'version', proto: 1, app: PROTO.app });
    expect(closes).toEqual(['closed']);
  });
});

describe('generic lobby: Ready and the config', () => {
  it('a config change clears both Ready flags and sends lobby{config, ready}', async () => {
    const { lobby, handle } = await hosting();
    const g = handle.arrive();
    const got = collect(g);
    g.send(hello(GUS));
    s.advance(30);
    lobby.toggleReady();
    s.advance(30);
    expect(got.at(-1)).toEqual({ type: 'lobby', config: { size: 3 }, ready: [true, false] });
    lobby.setConfig({ size: 5 });
    expect(lobby.ready).toEqual([false, false]);
    s.advance(30);
    expect(got.at(-1)).toEqual({ type: 'lobby', config: { size: 5 }, ready: [false, false] });
    g.send({ type: 'ready', on: true });
    s.advance(30);
    expect(lobby.ready).toEqual([false, true]);
    lobby.setConfig({ size: 4 });
    expect(lobby.ready).toEqual([false, false]);
    s.advance(30);
    expect(got.at(-1)).toEqual({ type: 'lobby', config: { size: 4 }, ready: [false, false] });
  });

  it('the guest lobby follows a config change: the new config, both flags cleared', async () => {
    const { lobby: host, handle } = await hosting();
    const { lobby } = guest(handle);
    lobby.connect('K7TQM');
    await flush();
    s.advance(30);
    lobby.toggleReady();
    s.advance(30);
    expect(host.ready).toEqual([false, true]);
    host.setConfig({ size: 5 });
    expect(host.ready).toEqual([false, false]);
    expect(host.config).toEqual({ size: 5 });
    s.advance(30);
    expect(lobby.config).toEqual({ size: 5 });
    expect(lobby.ready).toEqual([false, false]);
  });
});

describe('generic lobby: the start', () => {
  it("both ready: the host's factory gets the transport and the start data; the guest's gets the transport with the host's start first", async () => {
    const { lobby: host, handle, started: hostStarted } = await hosting();
    const { lobby, started } = guest(handle);
    lobby.connect('K7TQM');
    await flush();
    s.advance(30);
    lobby.toggleReady();
    s.advance(30);
    host.toggleReady();
    expect(host.phase).toBe('started');
    expect(hostStarted).toHaveLength(1);
    expect(hostStarted[0]!.session.start).toEqual({ config: { size: 3 }, me: HANA, guest: GUS, seed: 42 });
    s.advance(30);
    expect(lobby.phase).toBe('started');
    expect(started).toHaveLength(1);
    expect(started[0]!.got[0]).toEqual({ type: 'start', n: 7 });

    // The sessions own the transport now: what one sends reaches the other, and the lobbies hear nothing.
    started[0]!.t.send({ type: 'ready', on: false });
    s.advance(30);
    expect(hostStarted[0]!.session.got).toContainEqual({ type: 'ready', on: false });
    expect(host.ready).toEqual([true, true]);
    // The code is released once the match is done.
    expect(handle.closed).toBe(0);
    hostStarted[0]!.release();
    expect(handle.closed).toBe(1);
  });
});
