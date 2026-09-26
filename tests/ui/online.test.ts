// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeName } from '../../src/core/text';
import type { MatchConfig, Profile } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import type { Session } from '../../src/game/session';
import { NetError, type HostHandle, type PeerEnv } from '../../src/net/peer';
import { APP_ID, PROTO, type NetMsg } from '../../src/net/protocol';
import { loopbackPair, type Transport } from '../../src/net/transport';
import { Router } from '../../src/ui/router';
import { registerOnlineScreens, type OnlineControls, type OnlineDeps, type OnlineEnv } from '../../src/ui/screens/online';
import { DEFAULT_SETTINGS, type Settings } from '../../src/ui/settings';

const LOOK = { skin: 2, hairStyle: 1, hair: 3, shirt: 7, shorts: 0, headband: null, racket: 2 };
const HANA: Profile = { name: 'Hana', look: LOOK };
const GUS: Profile = { name: 'Gus', look: { ...LOOK, shirt: 9 } };
const SETTINGS: Settings = { ...structuredClone(DEFAULT_SETTINGS), pace: 'fast', surface: 'clay', deuceRule: 'golden' };
/** The match config the host's lobby starts with: the settings' choices. */
const CONFIG: MatchConfig = { format: 'tiebreak', pace: 'fast', surface: 'clay', wordPack: 'everyday', deuceRule: 'golden', training: null };
const FRAME = 16;

let s: VirtualScheduler;
let roots: HTMLElement[];
let routers: Router[];

/** A HostHandle whose guests the test brings in: `arrive()` returns the guest's end of a new connection. */
interface FakeHandle extends HostHandle {
  closed: number;
  arrive(): Transport;
}

function fakeHandle(code = 'K7TQM'): FakeHandle {
  let cb: ((t: Transport) => void) | null = null;
  const early: Transport[] = [];
  const handle: FakeHandle = {
    code,
    closed: 0,
    onGuest(c) {
      cb = c;
      for (const t of early.splice(0)) c(t);
    },
    close() {
      handle.closed++;
    },
    arrive() {
      const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 3 });
      if (cb) cb(hostEnd);
      else early.push(hostEnd);
      return guestEnd;
    },
  };
  return handle;
}

function env(over: Partial<OnlineEnv> = {}): OnlineEnv {
  return {
    hostGame: vi.fn(async () => fakeHandle()),
    joinGame: vi.fn(async () => {
      throw new NetError('notFound');
    }),
    scheduler: s,
    ticker: (ms, fn) => s.every(ms, fn),
    seed: () => 7,
    publicUrl: 'https://example.test/bbt/',
    framed: false,
    ...over,
  };
}

interface Started { session: Session; controls: OnlineControls }

function deps(profile: Profile): OnlineDeps & { started: Started[] } {
  const started: Started[] = [];
  return {
    started,
    profile: () => structuredClone(profile),
    settings: () => structuredClone(SETTINGS),
    startMatch: vi.fn((session: Session, controls: OnlineControls) => {
      started.push({ session, controls });
    }),
  };
}

/** A router on its own root (a test may show the host and the guest side by side). */
function screen(d: OnlineDeps, e: OnlineEnv): { root: HTMLElement; router: Router } {
  const root = document.createElement('div');
  document.body.append(root);
  const router = new Router(root);
  router.register('blank', () => ({ el: document.createElement('div') }));
  router.go('blank');
  registerOnlineScreens(router, d, e);
  roots.push(root);
  routers.push(router);
  return { root, router };
}

const text = (root: HTMLElement): string => root.textContent ?? '';
const buttons = (root: HTMLElement): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('button.btn')].filter((b) => b.closest('[hidden]') === null);
const labels = (root: HTMLElement): string[] => buttons(root).map((b) => b.textContent ?? '');
function click(root: HTMLElement, label: string): HTMLButtonElement {
  const b = buttons(root).find((x) => x.textContent === label);
  if (b === undefined) throw new Error(`no visible button ${label}; have ${labels(root).join(', ')}`);
  b.click();
  return b;
}
const shown = (el: Element | null): boolean => el !== null && el.closest('[hidden]') === null;

/** Lets resolved promises (hostGame/joinGame results, clipboard writes) run their callbacks. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Everything the other end sends from now on; pings are answered, as a live peer does. */
function collect(t: Transport): NetMsg[] {
  const got: NetMsg[] = [];
  t.onMessage((m) => {
    got.push(m);
    if (m.type === 'ping') t.send({ type: 'pong', id: m.id });
  });
  return got;
}

const hello = (p: Profile, proto = PROTO): NetMsg => ({ type: 'hello', proto, app: APP_ID, name: p.name, look: p.look });

beforeEach(() => {
  // jsdom has no 2D canvas; the look previews simply stay blank.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  s = new VirtualScheduler(1000);
  roots = [];
  routers = [];
  document.body.innerHTML = '';
  history.replaceState(null, '', '/');
});

afterEach(() => {
  // Leaving the screens runs their onHide: previews stop, lobbies close.
  for (const r of routers) {
    r.go('blank');
    r.dispose();
  }
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
  Reflect.deleteProperty(document, 'execCommand');
});

describe('host lobby: the code', () => {
  it('registers a game and shows its code at 2× with Copy code and Copy invite link, waiting for an opponent', async () => {
    const e = env();
    const { root, router } = screen(deps(HANA), e);
    router.go('host');
    expect(text(root)).toContain('Getting a game code…');
    await flush();
    expect(e.hostGame).toHaveBeenCalledOnce();
    expect(vi.mocked(e.hostGame).mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    const code = root.querySelector('.code');
    expect(code?.textContent).toBe('K7TQM');
    expect(document.activeElement?.textContent).toBe('COPY CODE');
    expect(code?.classList.contains('big')).toBe(true);
    expect(labels(root)).toEqual(expect.arrayContaining(['COPY CODE', 'COPY INVITE LINK', 'READY', 'BACK']));
    expect(text(root)).toContain('Waiting for opponent…');
    // Nobody to be ready with yet.
    expect(buttons(root).find((b) => b.textContent === 'READY')?.disabled).toBe(true);
  });

  it.each([
    [null, false, null],
    ['', false, null],
    ['https://example.test/bbt/', false, 'COPY INVITE LINK'],
    ['https://example.test/bbt/', true, 'COPY BROWSER INVITE LINK'],
  ])('with VITE_PUBLIC_URL %j (in an iframe: %j) the invite button reads %j', async (publicUrl, framed, label) => {
    const { root, router } = screen(deps(HANA), env({ publicUrl, framed }));
    router.go('host');
    await flush();
    const invite = labels(root).filter((l) => l.includes('INVITE'));
    expect(invite).toEqual(label === null ? [] : [label]);
  });

  it('copies the code with the Clipboard API', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { root, router } = screen(deps(HANA), env());
    router.go('host');
    await flush();
    click(root, 'COPY CODE');
    await flush();
    expect(writeText).toHaveBeenCalledWith('K7TQM');
    expect(root.querySelector('.copy-note')?.textContent).toBe('Code copied');
  });

  it('without the Clipboard API, copies the invite link from a hidden textarea with execCommand("copy") inside the click', async () => {
    let copied = '';
    const exec = vi.fn(() => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const { root, router } = screen(deps(HANA), env());
    router.go('host');
    await flush();
    // A click focuses the button it lands on.
    const b = buttons(root).find((x) => x.textContent === 'COPY INVITE LINK')!;
    b.focus();
    click(root, 'COPY INVITE LINK');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(copied).toBe('https://example.test/bbt/?join=K7TQM');
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(b);
    await flush();
    expect(root.querySelector('.copy-note')?.textContent).toBe('Invite link copied');
  });

  it('when the Clipboard API refuses, falls back to execCommand; when that fails too, selects the code and says "Press Ctrl+C"', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const exec = vi.fn(() => false);
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
    const { root, router } = screen(deps(HANA), env());
    router.go('host');
    await flush();
    click(root, 'COPY CODE');
    await flush();
    expect(writeText).toHaveBeenCalledWith('K7TQM');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(window.getSelection()?.toString()).toBe('K7TQM');
    expect(root.querySelector('.copy-note')?.textContent).toBe('Press Ctrl+C to copy');
  });

  it('shows a network error with Retry and Back; Retry registers again', async () => {
    const hostGame = vi.fn(async () => fakeHandle('ABCDE'));
    hostGame.mockRejectedValueOnce(new NetError('broker'));
    const { root, router } = screen(deps(HANA), env({ hostGame }));
    router.go('host');
    await flush();
    expect(text(root)).toContain("Can't reach the connection server");
    expect(labels(root)).toEqual(['RETRY', 'BACK']);
    click(root, 'RETRY');
    await flush();
    expect(hostGame).toHaveBeenCalledTimes(2);
    expect(root.querySelector('.code')?.textContent).toBe('ABCDE');
    expect(text(root)).not.toContain("Can't reach");
  });

  it('Back cancels a registration still under way (its abort signal)', async () => {
    let signal: AbortSignal | undefined;
    const hostGame = vi.fn((opts: PeerEnv) => {
      signal = opts.signal;
      return new Promise<HostHandle>(() => {});
    });
    const { root, router } = screen(deps(HANA), env({ hostGame }));
    router.go('host');
    click(root, 'BACK');
    expect(signal?.aborted).toBe(true);
    expect(router.current).toBe('blank');
  });
});

describe('host lobby: the guest', () => {
  async function hosting(e: OnlineEnv = env()): Promise<{ root: HTMLElement; router: Router; handle: FakeHandle; d: ReturnType<typeof deps> }> {
    const handle = fakeHandle();
    const d = deps(HANA);
    const { root, router } = screen(d, { ...e, hostGame: vi.fn(async () => handle) });
    router.go('host');
    await flush();
    return { root, router, handle, d };
  }

  /** A guest that has said hello and been welcomed: its end and what it got. */
  function joined(handle: FakeHandle, p: Profile = GUS): { g: Transport; got: NetMsg[] } {
    const g = handle.arrive();
    const got = collect(g);
    g.send(hello(p));
    s.advance(30);
    return { g, got };
  }

  it("answers a guest's hello with welcome, then shows its name (as text), its look and the round trip", async () => {
    const { root, handle } = await hosting();
    const { got } = joined(handle, { name: '<b>Gus</b>', look: GUS.look });
    expect(got[0]).toEqual({ type: 'welcome', proto: PROTO, hostProfile: HANA, config: CONFIG });
    const card = root.querySelector('.opponent');
    expect(shown(card)).toBe(true);
    expect(card?.querySelector('.name')?.textContent).toBe(sanitizeName('<b>Gus</b>').toUpperCase());
    expect(card?.querySelector('b')).toBeNull();
    expect(card?.querySelector('canvas')).not.toBeNull();
    expect(card?.querySelector('.state')?.textContent).toBe('NOT READY');
    expect(text(root)).not.toContain('Waiting for opponent');
    expect(buttons(root).find((b) => b.textContent === 'READY')?.disabled).toBe(false);
    // The code came with the focus on Copy code; the guest brings it to Ready.
    expect(document.activeElement?.textContent).toBe('READY');
    s.advance(2600);
    expect(root.querySelector('.ping')?.textContent).toBe('PING 20 MS');
  });

  it('rejects a second guest with "full" and a guest of another protocol version with "version", then closes them', async () => {
    const { handle } = await hosting();
    joined(handle);
    const second = handle.arrive();
    const got2 = collect(second);
    const closes: string[] = [];
    second.onClose((r) => closes.push(r));
    second.send(hello({ name: 'Zed', look: LOOK }));
    s.advance(1000);
    expect(got2[0]).toEqual({ type: 'reject', reason: 'full', proto: PROTO, app: APP_ID });
    expect(closes).toEqual(['closed']);

    const { handle: h2 } = await hosting();
    const old = h2.arrive();
    const got3 = collect(old);
    old.send(hello({ name: 'Old', look: LOOK }, PROTO + 1));
    s.advance(1000);
    expect(got3[0]).toEqual({ type: 'reject', reason: 'version', proto: PROTO, app: APP_ID });
  });

  it("a guest's ready shows at once; a config change sends lobby{config, ready} and clears both Ready flags", async () => {
    const { root, handle } = await hosting();
    const { g, got } = joined(handle);
    g.send({ type: 'ready', on: true });
    s.advance(30);
    expect(root.querySelector('.opponent .state')?.textContent).toBe('READY');
    expect(got.at(-1)).toEqual({ type: 'lobby', config: CONFIG, ready: [false, true] });
    const format = [...root.querySelectorAll<HTMLElement>('.row')].find((r) => r.textContent?.startsWith('FORMAT'))!;
    format.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    s.advance(30);
    expect(got.at(-1)).toEqual({ type: 'lobby', config: { ...CONFIG, format: 'short' }, ready: [false, false] });
    expect(root.querySelector('.opponent .state')?.textContent).toBe('NOT READY');
  });

  it('a guest who leaves the lobby frees it: waiting again', async () => {
    const { root, handle } = await hosting();
    const { g } = joined(handle);
    g.send({ type: 'leave' });
    s.advance(30);
    expect(shown(root.querySelector('.opponent'))).toBe(false);
    expect(text(root)).toContain('Waiting for opponent…');
    joined(handle, { name: 'Ann', look: LOOK });
    expect(root.querySelector('.opponent .name')?.textContent).toBe('ANN');
  });

  it('starts once both are ready: a HostSession on the handed-over transport, which alone sends start; the lobby hears nothing more', async () => {
    const { root, handle, d } = await hosting();
    const { g, got } = joined(handle);
    g.send({ type: 'ready', on: true });
    s.advance(30);
    click(root, 'READY');
    expect(d.startMatch).toHaveBeenCalledOnce();
    const { session, controls } = d.started[0]!;
    s.advance(30);
    expect(got.filter((m) => m.type === 'start')).toEqual([{ type: 'start', config: CONFIG, hostProfile: HANA, guestProfile: GUS }]);
    expect(got.at(-1)?.type).toBe('frame');
    const vm = session.frame(FRAME);
    expect(vm.viewer).toBe(0);
    expect(vm.pub.players.map((p) => p.name)).toEqual(['Hana', 'Gus']);
    expect(vm.pub.config).toEqual(CONFIG);
    expect(typeof controls.forfeit).toBe('function');
    // The lobby no longer answers: a late ready changes nothing and brings no lobby message.
    const before = got.length;
    g.send({ type: 'ready', on: false });
    s.advance(30);
    expect(got.slice(before).filter((m) => m.type === 'lobby')).toEqual([]);
    expect(text(root)).toContain('Starting…');
  });

  it('Back leaves the lobby: the guest is told, and the code is released', async () => {
    const { root, handle } = await hosting();
    const { g, got } = joined(handle);
    const closes: string[] = [];
    g.onClose((r) => closes.push(r));
    click(root, 'BACK');
    s.advance(1000);
    expect(got.at(-1)).toEqual({ type: 'leave' });
    expect(closes).toEqual(['closed']);
    expect(handle.closed).toBe(1);
  });
});

describe('join screen', () => {
  function joinScreen(e: OnlineEnv = env(), code: string | null = null): { root: HTMLElement; router: Router; d: ReturnType<typeof deps>; field: HTMLInputElement } {
    const d = deps(GUS);
    const { root, router } = screen(d, e);
    router.go('join', { code });
    return { root, router, d, field: root.querySelector<HTMLInputElement>('input.code-field')! };
  }

  function type(field: HTMLInputElement, value: string): void {
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  const connect = (root: HTMLElement): HTMLButtonElement => buttons(root).find((b) => b.textContent === 'CONNECT')!;

  it('trims and uppercases the code; a character outside the alphabet shows a hint, and Connect waits for a valid code', () => {
    const { root, field } = joinScreen();
    expect(document.activeElement).toBe(field);
    type(field, ' k7tq');
    expect(field.value).toBe('K7TQ');
    expect(connect(root).disabled).toBe(true);
    expect(shown(root.querySelector('.hint'))).toBe(false);
    type(field, 'K7TQ0');
    expect(connect(root).disabled).toBe(true);
    expect(shown(root.querySelector('.hint'))).toBe(true);
    expect(root.querySelector('.hint')?.textContent).toContain('0');
    type(field, 'k7tqm ');
    expect(field.value).toBe('K7TQM');
    expect(connect(root).disabled).toBe(false);
    expect(shown(root.querySelector('.hint'))).toBe(false);
  });

  it('an invite link (?join=CODE) fills the code in, with one Connect button focused', () => {
    const { root, field } = joinScreen(env(), 'k7tqm');
    expect(field.value).toBe('K7TQM');
    expect(labels(root).filter((l) => l === 'CONNECT')).toHaveLength(1);
    expect(document.activeElement).toBe(connect(root));
  });

  it('connects: "Connecting…", "Still connecting…", hello; on welcome it shows the host and the config read-only and drops ?join from the URL', async () => {
    history.replaceState(null, '', '/?join=K7TQM&e2e=1');
    const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got = collect(hostEnd);
    let status: ((text: string) => void) | undefined;
    let open: ((t: Transport) => void) | undefined;
    const joinGame = vi.fn((_code: string, opts: PeerEnv) => {
      status = opts.onStatus;
      return new Promise<Transport>((r) => (open = r));
    });
    const { root } = joinScreen(env({ joinGame }), 'K7TQM');
    click(root, 'CONNECT');
    expect(joinGame).toHaveBeenCalledWith('K7TQM', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(text(root)).toContain('Connecting…');
    status!('Still connecting…');
    expect(text(root)).toContain('Still connecting…');
    open!(guestEnd);
    await flush();
    s.advance(30);
    expect(got).toEqual([hello(GUS)]);
    expect(location.search).toBe('?join=K7TQM&e2e=1');

    hostEnd.send({ type: 'welcome', proto: PROTO, hostProfile: HANA, config: CONFIG });
    s.advance(30);
    expect(root.querySelector('.opponent .name')?.textContent).toBe('HANA');
    const values = [...root.querySelectorAll('.config .value')].map((v) => v.textContent);
    expect(values).toEqual(['TIEBREAK', 'FAST', 'CLAY', 'EVERYDAY', 'GOLDEN POINT']);
    expect(root.querySelector('.config .spin')).toBeNull();
    expect(location.search).toBe('?e2e=1');
    expect(document.activeElement?.textContent).toBe('READY');

    hostEnd.send({ type: 'lobby', config: { ...CONFIG, format: 'bo3' }, ready: [true, false] });
    s.advance(30);
    expect(root.querySelector('.config .value')?.textContent).toBe('BEST OF 3');
    expect(root.querySelector('.opponent .state')?.textContent).toBe('READY');
    click(root, 'READY');
    s.advance(30);
    expect(got.at(-1)).toEqual({ type: 'ready', on: true });
  });

  it("on the host's start, hands the app a GuestSession that got the start; the lobby hears nothing more", async () => {
    const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const got = collect(hostEnd);
    const { root, d } = joinScreen(env({ joinGame: vi.fn(async () => guestEnd) }), 'K7TQM');
    click(root, 'CONNECT');
    await flush();
    hostEnd.send({ type: 'welcome', proto: PROTO, hostProfile: HANA, config: CONFIG });
    hostEnd.send({ type: 'start', config: CONFIG, hostProfile: HANA, guestProfile: GUS });
    s.advance(30);
    expect(d.startMatch).toHaveBeenCalledOnce();
    const vm = d.started[0]!.session.frame(FRAME);
    expect(vm.viewer).toBe(1);
    expect(vm.pub.players.map((p) => p.name)).toEqual(['Hana', 'Gus']);
    expect(vm.pub.config).toEqual(CONFIG);
    // A lobby message now goes to the session, which ignores it; the screen stays as it was.
    hostEnd.send({ type: 'lobby', config: { ...CONFIG, format: 'bo3' }, ready: [false, false] });
    s.advance(30);
    expect(root.querySelector('.config .value')?.textContent).toBe('TIEBREAK');
    expect(got.filter((m) => m.type === 'hello')).toHaveLength(1);
  });

  it.each([
    ['a failed connection', new NetError('notFound'), null, 'No game with code K7TQM'],
    ['a version reject', null, { type: 'reject', reason: 'version', proto: PROTO + 1, app: APP_ID }, `Versions differ (host v${PROTO + 1}, you v${PROTO}) — reload with Ctrl+Shift+R`],
    ['a full game', null, { type: 'reject', reason: 'full', proto: PROTO, app: APP_ID }, 'That game already has two players'],
    ['a game in a match', null, { type: 'reject', reason: 'in-match', proto: PROTO, app: APP_ID }, 'That game already has two players'],
  ] as const)('shows %s as an error with Retry and Back', async (_what, error, reply, message) => {
    const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const joinGame = vi.fn(async () => {
      if (error !== null) throw error;
      return guestEnd;
    });
    const { root } = joinScreen(env({ joinGame }), 'K7TQM');
    click(root, 'CONNECT');
    await flush();
    if (reply !== null) hostEnd.send(reply);
    s.advance(30);
    expect(text(root)).toContain(message);
    expect(labels(root)).toEqual(['RETRY', 'BACK']);
    click(root, 'RETRY');
    expect(joinGame).toHaveBeenCalledTimes(2);
  });

  it("a host that never answers the hello times out: \"The game didn't answer\"", async () => {
    const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    // The host is there (it answers pings) but never answers the hello.
    collect(hostEnd);
    const { root } = joinScreen(env({ joinGame: vi.fn(async () => guestEnd) }), 'K7TQM');
    click(root, 'CONNECT');
    await flush();
    s.advance(9000);
    expect(text(root)).not.toContain("didn't answer");
    s.advance(1100);
    expect(text(root)).toContain("The game didn't answer — try again");
  });

  it('a host that leaves the lobby is an error with Retry and Back', async () => {
    const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 1 });
    const { root } = joinScreen(env({ joinGame: vi.fn(async () => guestEnd) }), 'K7TQM');
    click(root, 'CONNECT');
    await flush();
    hostEnd.send({ type: 'welcome', proto: PROTO, hostProfile: HANA, config: CONFIG });
    hostEnd.send({ type: 'leave' });
    s.advance(30);
    expect(text(root)).toContain('Hana left the game');
    expect(labels(root)).toEqual(['RETRY', 'BACK']);
  });

  it('Back while connecting cancels the attempt', async () => {
    let signal: AbortSignal | undefined;
    const joinGame = vi.fn((_c: string, opts: PeerEnv) => {
      signal = opts.signal;
      return new Promise<Transport>(() => {});
    });
    const { root, router } = joinScreen(env({ joinGame }), 'K7TQM');
    click(root, 'CONNECT');
    click(root, 'BACK');
    expect(signal?.aborted).toBe(true);
    expect(router.current).toBe('blank');
  });
});

describe('online match hand-off', () => {
  /** Host and guest screens side by side on one loopback, both Ready: the two started matches. */
  async function match(): Promise<{ host: Started; guest: Started; handle: FakeHandle }> {
    const handle = fakeHandle();
    const hd = deps(HANA);
    const gd = deps(GUS);
    const host = screen(hd, env({ hostGame: vi.fn(async () => handle) }));
    const guest = screen(gd, env({ joinGame: vi.fn(async () => handle.arrive()) }));
    host.router.go('host');
    await flush();
    guest.router.go('join', { code: handle.code });
    click(guest.root, 'CONNECT');
    await flush();
    s.advance(30);
    click(guest.root, 'READY');
    s.advance(30);
    click(host.root, 'READY');
    s.advance(30);
    expect(hd.started).toHaveLength(1);
    expect(gd.started).toHaveLength(1);
    return { host: hd.started[0]!, guest: gd.started[0]!, handle };
  }

  function run(a: Session, b: Session, ms: number): void {
    for (let t = 0; t < ms; t += FRAME) {
      s.advance(FRAME);
      a.frame(FRAME);
      b.frame(FRAME);
    }
  }

  it('host and join screens start one match together: the guest session plays the host session\'s first turn', async () => {
    const { host, guest } = await match();
    run(host.session, guest.session, 1000);
    const h = host.session.frame(FRAME);
    const g = guest.session.frame(FRAME);
    expect(g.pub.players.map((p) => p.name)).toEqual(['Hana', 'Gus']);
    expect(g.pub.turn?.data.turnId).toBe(1);
    expect(h.pub.turn?.data.turnId).toBe(1);
    expect(host.session.over).toBe(false);
    expect(guest.session.over).toBe(false);
  });

  it('while the match runs, unloading the page asks first and pagehide leaves; dispose drops the guards and releases the code', async () => {
    const { host, guest, handle } = await match();
    run(host.session, guest.session, 500);
    const unload = (): boolean => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(unload()).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    run(host.session, guest.session, 100);
    expect(guest.session.over).toBe(true);
    expect(unload()).toBe(false);
    expect(handle.closed).toBe(0);
    host.session.dispose();
    guest.session.dispose();
    expect(handle.closed).toBe(1);
  });

  it('dispose while the match runs removes the unload guard', async () => {
    const { host, guest } = await match();
    host.session.dispose();
    guest.session.dispose();
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it('the controls forfeit the match, and offer a rematch only while the opponent is there', async () => {
    const { host, guest } = await match();
    run(host.session, guest.session, 500);
    expect(host.controls.rematch).toBeTypeOf('function');
    guest.controls.forfeit();
    run(host.session, guest.session, 100);
    expect(guest.session.over).toBe(true);
    expect(host.session.over).toBe(true);
    expect(host.session.result?.forfeitBy).toBe(1);
    guest.session.dispose();
    run(host.session, guest.session, 100);
    expect(host.controls.rematch).toBeUndefined();
    expect(guest.controls.rematch).toBeTypeOf('function');
  });
});
