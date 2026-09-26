import { describe, expect, it } from 'vitest';
import { VirtualScheduler } from '../../src/game/clock';
import { type DebugHost, installDebugHooks } from '../../src/game/debug';
import { LocalSession } from '../../src/game/localSession';
import type { Session } from '../../src/game/session';
import { activePrompt, FRAME, keyOf, PLAYERS, seedWhere, TIEBREAK } from './sessionHelpers';

const host = (search: string): DebugHost => ({ location: { search } });

describe('installDebugHooks', () => {
  it.each(['', '?e2e=0', '?foo=1', '?e2e=true'])('installs nothing for search %j outside dev mode', (search) => {
    const h = host(search);
    expect(installDebugHooks(() => null, h, false)).toBeNull();
    expect(h.__bbt).toBeUndefined();
  });

  it.each([
    ['?e2e=1', false],
    ['?screen=title&e2e=1', false],
    ['', true],
  ] as const)('installs window.__bbt for search %j (dev %s)', (search, dev) => {
    const h = host(search);
    const hooks = installDebugHooks(() => null, h, dev);
    expect(hooks).not.toBeNull();
    expect(h.__bbt).toBe(hooks);
  });

  it('reports nothing without a session', () => {
    const hooks = installDebugHooks(() => null, host('?e2e=1'), false)!;
    expect(hooks.view()).toBeNull();
    expect(hooks.activeWords()).toBeNull();
    expect(hooks.owner()).toBeNull();
    expect(hooks.status()).toBe('none');
  });

  it('reads the current session\'s latest view: status, owner and the active words to type', () => {
    const s = new VirtualScheduler();
    const session = new LocalSession({ config: TIEBREAK, players: PLAYERS, seed: seedWhere(0), human: 0, scheduler: s });
    let current: Session | null = session;
    const hooks = installDebugHooks(() => current, host('?e2e=1'), false)!;
    expect(hooks.status()).toBe('none');

    const step = (): void => {
      s.advance(FRAME);
      session.frame(FRAME);
    };
    session.frame(FRAME);
    expect(hooks.view()).toBe(session.view);
    expect(hooks.status()).toBe('leadIn:intro');
    expect(hooks.owner()).toBe(0);
    expect(hooks.activeWords()).toBeNull();

    while (session.view?.pub.turn?.phase !== 'preServe') step();
    expect(hooks.status()).toBe('preServe');
    session.key({ kind: 'toss' }, s.now());
    session.frame(FRAME);
    expect(hooks.status()).toBe('toss');
    const prompt = activePrompt(session.view!.pub.turn)!;
    const words = prompt.options.map((o) => o.word);
    expect(hooks.activeWords()).toEqual({ words, locked: null, typed: 0, kind: 'serve' });
    session.key(keyOf(words[1]!.charAt(0)), s.now());
    session.frame(FRAME);
    expect(hooks.activeWords()).toEqual({ words, locked: 1, typed: 1, kind: 'serve' });

    session.pause();
    session.frame(FRAME);
    expect(hooks.status()).toBe('paused');
    session.resume();
    session.frame(FRAME);
    expect(hooks.status()).toBe('countdown');

    current = null;
    expect(hooks.status()).toBe('none');
    expect(hooks.owner()).toBeNull();
  });

  it('reports "over" once the match is over', () => {
    const s = new VirtualScheduler();
    const session = new LocalSession({
      config: TIEBREAK,
      players: [
        { ...PLAYERS[0], kind: 'cpu', cpuLevel: 9 },
        { ...PLAYERS[1], kind: 'cpu', cpuLevel: 9 },
      ],
      seed: 5,
      human: null,
      scheduler: s,
    });
    const hooks = installDebugHooks(() => session, host('?e2e=1'), false)!;
    while (!session.over) {
      s.advance(200);
      session.frame(200);
    }
    expect(hooks.status()).toBe('over');
    expect(hooks.owner()).toBeNull();
    expect(hooks.activeWords()).toBeNull();
  });
});
