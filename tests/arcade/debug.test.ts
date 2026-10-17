import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatch } from '../../src/arcade/core/match';
import type { ArcadeConfig, ArcadeState, PlayerInfo } from '../../src/arcade/core/types';
import { type ArcadeDebugHost, type ArcadeDebugTarget, DEBUG_SCREENS, installArcadeDebug, SHOT_READY_FRAMES } from '../../src/arcade/game/debug';

const host = (search: string): ArcadeDebugHost => ({ location: { search } });

const CONFIG: ArcadeConfig = { format: 'tiebreak', deuceRule: 'advantage', surface: 'clay', pace: 'fast' };
const LOOK = { skin: 0, hairStyle: 0, hair: 0, shirt: 0, shorts: 0, headband: null, racket: 0 };
const PLAYERS: [PlayerInfo, PlayerInfo] = [
  { name: 'You', look: LOOK, kind: 'human', cpuLevel: null },
  { name: 'White Belt', look: LOOK, kind: 'cpu', cpuLevel: 0 },
];

/** An app stand-in that logs every call the hooks make, in order, and runs a match once one is started. */
function fakeApp(level = 4): ArcadeDebugTarget & { calls: string[]; match: ArcadeState | null } {
  const calls: string[] = [];
  const app = {
    calls,
    match: null as ArcadeState | null,
    router: { go: (name: string) => void calls.push(`go ${name}`) },
    cpuSetup: { level, ...CONFIG },
    matchState: () => app.match,
    startCpuMatch: (l: number, config: ArcadeConfig, seed?: number) => {
      calls.push(`startCpuMatch ${l} ${JSON.stringify(config)} ${seed}`);
      app.match = createMatch(config, PLAYERS, seed ?? 7);
    },
    startDemoMatch: () => {
      calls.push('startDemoMatch');
      app.match = createMatch(CONFIG, PLAYERS, 3);
    },
    pauseMatch: () => void calls.push('pauseMatch'),
    quitMatch: () => {
      calls.push('quitMatch');
      app.match = null;
    },
  };
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installArcadeDebug', () => {
  it.each(['', '?debugger', '?screen=title', '?e2e=1', '?nodebug=1'])('installs nothing for search %j outside dev builds', (search) => {
    const h = host(search);
    expect(installArcadeDebug(fakeApp(), h, false)).toBeNull();
    expect(h.__arcade).toBeUndefined();
  });

  it.each([
    ['?debug', false],
    ['?debug=1', false],
    ['?screen=howTo&debug', false],
    ['', true],
  ] as const)('installs window.__arcade for search %j (dev %s)', (search, dev) => {
    const h = host(search);
    const debug = installArcadeDebug(fakeApp(), h, dev);
    expect(debug).not.toBeNull();
    expect(h.__arcade).toBe(debug!.hooks);
  });

  it(`sets __shotReady on the ${SHOT_READY_FRAMES}th frame, not before`, () => {
    const h = host('?debug');
    const debug = installArcadeDebug(fakeApp(), h, false)!;
    for (let i = 1; i < SHOT_READY_FRAMES; i++) debug.frame();
    expect(h.__shotReady).toBeUndefined();
    debug.frame();
    expect(h.__shotReady).toBe(true);
    debug.frame();
    expect(h.__shotReady).toBe(true);
  });
});

describe('__arcade hooks', () => {
  it('state(): null without a match, then a copy of the live match state', () => {
    const app = fakeApp();
    const hooks = installArcadeDebug(app, host('?debug'), false)!.hooks;
    expect(hooks.state()).toBeNull();
    hooks.startMatch(0, 1);
    const copy = hooks.state()!;
    expect(copy).toEqual(app.match);
    expect(copy).not.toBe(app.match);
    copy.p[0].pos.x = 99;
    expect(app.match!.p[0].pos.x).not.toBe(99);
    app.quitMatch();
    expect(hooks.state()).toBeNull();
  });

  it('startMatch(level, seed) plays the saved setup\'s options against that belt, the seed passed through (random when omitted)', () => {
    const app = fakeApp(9);
    const hooks = installArcadeDebug(app, host('?debug'), false)!.hooks;
    hooks.startMatch(0, 1);
    hooks.startMatch(14);
    expect(app.calls).toEqual([`startCpuMatch 0 ${JSON.stringify(CONFIG)} 1`, `startCpuMatch 14 ${JSON.stringify(CONFIG)} undefined`]);
  });

  it.each([[-1], [15], [2.5], [Number.NaN]])('startMatch rejects belt level %s', (level) => {
    const app = fakeApp();
    const hooks = installArcadeDebug(app, host('?debug'), false)!.hooks;
    expect(() => hooks.startMatch(level, 1)).toThrow(RangeError);
    expect(() => hooks.startMatch(0, 0.5)).toThrow(RangeError);
    expect(app.calls).toEqual([]);
  });

  it('demo() starts the CPU-vs-CPU demo match', () => {
    const app = fakeApp();
    installArcadeDebug(app, host('?debug'), false)!.hooks.demo();
    expect(app.calls).toEqual(['startDemoMatch']);
  });

  it.each([
    ['title', ['go title']],
    ['mainMenu', ['go title', 'go mainMenu']],
    ['cpuSetup', ['go title', 'go mainMenu', 'go cpuSetup']],
    ['customize', ['go title', 'go mainMenu', 'go customize']],
    ['options', ['go title', 'go mainMenu', 'go options']],
    ['howTo', ['go title', 'go mainMenu', 'go howTo']],
    ['match', ['go title', 'go mainMenu', `startCpuMatch 4 ${JSON.stringify(CONFIG)} undefined`]],
    ['pause', ['go title', 'go mainMenu', `startCpuMatch 4 ${JSON.stringify(CONFIG)} undefined`, 'pauseMatch']],
  ])('screen(%j) goes there through the title and main menu', (name, calls) => {
    const app = fakeApp();
    installArcadeDebug(app, host('?debug'), false)!.hooks.screen(name);
    expect(app.calls).toEqual(calls);
  });

  it('screen() leaves a match in progress first', () => {
    const app = fakeApp();
    const hooks = installArcadeDebug(app, host('?debug'), false)!.hooks;
    hooks.demo();
    hooks.screen('howTo');
    expect(app.calls).toEqual(['startDemoMatch', 'quitMatch', 'go title', 'go mainMenu', 'go howTo']);
    expect(app.match).toBeNull();
  });

  it.each(['gate', 'results', 'nope', ''])('screen(%j) throws and goes nowhere', (name) => {
    const app = fakeApp();
    const hooks = installArcadeDebug(app, host('?debug'), false)!.hooks;
    expect(() => hooks.screen(name)).toThrow(/no screen/);
    expect(app.calls).toEqual([]);
  });

  it('lists every screen screen() accepts', () => {
    expect(DEBUG_SCREENS).toEqual(['title', 'mainMenu', 'cpuSetup', 'customize', 'options', 'howTo', 'match', 'pause']);
  });
});

describe('showStartScreen (?screen=)', () => {
  it('shows the page\'s ?screen= and reports it', () => {
    const app = fakeApp();
    const debug = installArcadeDebug(app, host('?debug&screen=options'), false)!;
    expect(debug.showStartScreen()).toBe(true);
    expect(app.calls).toEqual(['go title', 'go mainMenu', 'go options']);
  });

  it('works in a dev build without ?debug', () => {
    const app = fakeApp();
    expect(installArcadeDebug(app, host('?screen=pause'), true)!.showStartScreen()).toBe(true);
    expect(app.calls.at(-1)).toBe('pauseMatch');
  });

  it('reports false without ?screen=, so the app shows the gate', () => {
    const app = fakeApp();
    expect(installArcadeDebug(app, host('?debug'), false)!.showStartScreen()).toBe(false);
    expect(app.calls).toEqual([]);
  });

  it('warns about an unknown ?screen= and reports false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = fakeApp();
    expect(installArcadeDebug(app, host('?debug&screen=bogus'), false)!.showStartScreen()).toBe(false);
    expect(app.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('?screen=bogus'));
  });
});
