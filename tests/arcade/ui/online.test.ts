// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_INPUT, type ArcadeConfig, type Controller } from '../../../src/arcade/core/types';
import type { ArcadeOnlineSession } from '../../../src/arcade/game/onlineSession';
import { APP_ID, ARCADE_CODEC, PROTO, type ArcadeMsg } from '../../../src/arcade/net/protocol';
import { arcadeBrowserEnv, arcadeLobbyGame, type ArcadeOnlineEnv } from '../../../src/arcade/ui/online';
import type { Profile } from '../../../src/core/types';
import { VirtualScheduler } from '../../../src/game/clock';
import { loopbackPair, type Transport } from '../../../src/net/channel';
import type { HostHandle } from '../../../src/net/rtc';
import { hostLobbyScreen, joinScreen, type LobbyContext } from '../../../src/ui/lobbyScreens';
import { Router } from '../../../src/ui/router';

const LOOK = { skin: 2, hairStyle: 1, hair: 3, shirt: 7, shorts: 0, headband: null, racket: 2 };
const HANA: Profile = { name: 'Hana', look: LOOK };
const GUS: Profile = { name: 'Gus', look: { ...LOOK, shirt: 9 } };
const CONFIG: ArcadeConfig = { format: 'short', deuceRule: 'golden', surface: 'clay', pace: 'fast' };
const IDLE: Controller = { input: () => NO_INPUT };

let s: VirtualScheduler;
let routers: Router[];
let sessions: ArcadeOnlineSession[];

/** A host handle whose guests the test brings in: `arrive()` returns the guest's end of a new connection. */
function fakeHandle(code = 'K7TQM'): HostHandle<ArcadeMsg> & { arrive(): Transport<ArcadeMsg> } {
  let cb: ((t: Transport<ArcadeMsg>) => void) | null = null;
  return {
    code,
    onGuest(c) {
      cb = c;
    },
    close() {},
    arrive() {
      const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 3 }, ARCADE_CODEC);
      cb?.(hostEnd);
      return guestEnd;
    },
  };
}

function env(over: Partial<ArcadeOnlineEnv> = {}): ArcadeOnlineEnv {
  return {
    hostGame: vi.fn(async () => fakeHandle()),
    joinGame: vi.fn(async () => {
      throw new Error('no join in this test');
    }),
    scheduler: s,
    ticker: (ms, fn) => s.every(ms, fn),
    seed: () => 77,
    publicUrl: 'https://example.test/bbt/arcade/',
    framed: false,
    ...over,
  };
}

/** One side's lobby screens on a root of its own; `begun` collects the sessions it starts. */
function side(me: Profile, e: ArcadeOnlineEnv) {
  const root = document.createElement('div');
  document.body.append(root);
  const router = new Router(root);
  routers.push(router);
  const begun: ArcadeOnlineSession[] = [];
  const ctx: LobbyContext<ArcadeConfig, ArcadeMsg, ArcadeOnlineSession> = {
    router,
    profile: () => structuredClone(me),
    config: () => ({ ...CONFIG }),
    env: e,
    begin: (session) => {
      begun.push(session);
      sessions.push(session);
    },
  };
  const game = arcadeLobbyGame(e, IDLE);
  router.register('blank', () => ({ el: document.createElement('div') }));
  router.register('host', hostLobbyScreen(ctx, game));
  router.register('join', joinScreen(ctx, game));
  router.go('blank');
  return { root, router, begun };
}

const buttons = (root: HTMLElement): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>('button.btn')].filter((b) => b.closest('[hidden]') === null);
function click(root: HTMLElement, label: string): void {
  const b = buttons(root).find((x) => x.textContent === label);
  if (b === undefined) throw new Error(`no visible button ${label}; have ${buttons(root).map((x) => x.textContent).join(', ')}`);
  b.click();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  s = new VirtualScheduler(1000);
  routers = [];
  sessions = [];
  document.body.innerHTML = '';
  history.replaceState(null, '', '/arcade/');
});

afterEach(() => {
  for (const x of sessions) x.dispose();
  for (const r of routers) {
    r.go('blank');
    r.dispose();
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Arcade online lobby (online spec §5)', () => {
  it('the host edits the four Arcade options, starting from the last CPU setup', async () => {
    const host = side(HANA, env());
    host.router.go('host');
    await flush();
    const labels = [...host.root.querySelectorAll('.rows .label')].map((l) => l.textContent);
    expect(labels).toEqual(['FORMAT', 'DEUCE', 'COURT', 'PACE']);
    const values = [...host.root.querySelectorAll('.rows .value')].map((v) => v.textContent);
    expect(values).toEqual(['SHORT SET', 'GOLDEN POINT', 'CLAY', 'FAST']);
    expect(host.root.querySelector('.code')?.textContent).toBe('K7TQM');
  });

  it('host and guest start one match together: the host plays player 0 and the guest player 1, on the same options and seed', async () => {
    const handle = fakeHandle();
    const host = side(HANA, env({ hostGame: vi.fn(async () => handle) }));
    host.router.go('host');
    await flush();
    const guest = side(GUS, env({ joinGame: vi.fn(async () => handle.arrive()) }));
    guest.router.go('join', { code: 'K7TQM' });
    click(guest.root, 'CONNECT');
    await flush();
    s.advance(50);
    expect(host.root.querySelector('.opponent .name')?.textContent).toBe('GUS');
    const shownRows = [...guest.root.querySelectorAll('.config .label')].map((l) => l.textContent);
    expect(shownRows).toEqual(['FORMAT', 'DEUCE', 'COURT', 'PACE']);
    expect([...guest.root.querySelectorAll('.config .value')].map((v) => v.textContent)).toEqual(['SHORT SET', 'GOLDEN POINT', 'CLAY', 'FAST']);
    click(guest.root, 'READY');
    s.advance(50);
    click(host.root, 'READY');
    s.advance(50);
    expect(host.begun).toHaveLength(1);
    expect(guest.begun).toHaveLength(1);
    const [h] = host.begun;
    const [g] = guest.begun;
    expect(h!.viewer).toBe(0);
    expect(g!.viewer).toBe(1);
    for (let i = 0; i < 60; i++) {
      s.advance(16);
      h!.frame(16);
      g!.frame(16);
    }
    const a = h!.view!.state;
    const b = g!.view!.state;
    expect(a.config).toEqual(CONFIG);
    expect(b.config).toEqual(CONFIG);
    expect(b.players.map((p) => p.name)).toEqual(['Hana', 'Gus']);
    expect(a.score.firstServerOfMatch).toBe(b.score.firstServerOfMatch);
    expect(Math.abs(a.tick - b.tick)).toBeLessThanOrEqual(3);
  });

  it('a guest on another build is turned away: "Versions differ — reload" (Review Focus 3)', async () => {
    const handle = fakeHandle();
    const host = side(HANA, env({ hostGame: vi.fn(async () => handle) }));
    host.router.go('host');
    await flush();
    const stranger = handle.arrive();
    const got: ArcadeMsg[] = [];
    stranger.onMessage((m) => got.push(m));
    stranger.send({ type: 'hello', proto: PROTO, app: 'bbtennis-arcade@0ther0build', name: 'Old', look: LOOK });
    s.advance(50);
    expect(got).toContainEqual({ type: 'reject', reason: 'version', proto: PROTO, app: APP_ID });
    expect(host.root.querySelector('.opponent .name')?.textContent ?? '').toBe('');

    const [hostEnd, guestEnd] = loopbackPair(s, { latencyMs: 10, jitterMs: 0, seed: 2 }, ARCADE_CODEC);
    hostEnd.onMessage((m) => {
      if (m.type === 'hello') hostEnd.send({ type: 'reject', reason: 'version', proto: PROTO, app: 'bbtennis-arcade@0ther0build' });
    });
    const guest = side(GUS, env({ joinGame: vi.fn(async () => guestEnd) }));
    guest.router.go('join', { code: 'K7TQM' });
    click(guest.root, 'CONNECT');
    await flush();
    s.advance(50);
    expect(guest.root.textContent).toContain('Versions differ — both players reload with Ctrl+Shift+R');
    expect(guest.root.textContent).not.toContain('(host v');
  });
});

describe('arcadeBrowserEnv', () => {
  it('points invite links at the Arcade page of the Pages build', () => {
    vi.stubEnv('VITE_PUBLIC_URL', 'https://ekkeltype.github.io/bbtennis/');
    expect(arcadeBrowserEnv().publicUrl).toBe('https://ekkeltype.github.io/bbtennis/arcade/');
    vi.stubEnv('VITE_PUBLIC_URL', '');
    expect(arcadeBrowserEnv().publicUrl).toBeNull();
  });
});
