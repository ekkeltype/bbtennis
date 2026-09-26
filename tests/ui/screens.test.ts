// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../../src/core/engine';
import type { MatchState } from '../../src/core/types';
import type { UiContext } from '../../src/ui/context';
import { Router } from '../../src/ui/router';
import { cpuSetupScreen } from '../../src/ui/screens/cpuSetup';
import { gateScreen } from '../../src/ui/screens/gate';
import { mainMenuScreen } from '../../src/ui/screens/mainMenu';
import { registerOnlineScreens } from '../../src/ui/screens/online';
import { pauseScreen } from '../../src/ui/screens/pause';
import { resultsScreen } from '../../src/ui/screens/results';
import { DEFAULT_CAREER, DEFAULT_PROFILE, DEFAULT_SETTINGS, type Settings } from '../../src/ui/settings';

let root: HTMLElement;
let router: Router;

/** A UiContext whose actions are spies and whose settings follow `setSettings`; `offer` is the first-launch Training offer. */
function fakeContext(settings: Partial<Settings> = {}, offer = false) {
  const ctx = {
    router,
    settings: { ...structuredClone(DEFAULT_SETTINGS), ...settings },
    profile: structuredClone(DEFAULT_PROFILE),
    career: structuredClone(DEFAULT_CAREER),
    setSettings: vi.fn((patch: Partial<Settings>) => {
      ctx.settings = { ...ctx.settings, ...patch };
    }),
    setProfile: vi.fn(),
    voiceAvailable: vi.fn(() => true),
    openGate: vi.fn(),
    startCpuMatch: vi.fn(),
    startTraining: vi.fn(),
    rematch: vi.fn(),
    pauseMatch: vi.fn(),
    resumeMatch: vi.fn(),
    restartMatch: vi.fn(),
    quitMatch: vi.fn(),
    forfeitMatch: vi.fn(),
    toggleFullscreen: vi.fn(),
    focusGame: vi.fn(),
    trainingOffered: vi.fn(() => offer),
    dismissTrainingOffer: vi.fn(() => {
      offer = false;
    }),
  };
  return ctx satisfies UiContext;
}

const labels = (): string[] => [...root.querySelectorAll('button.btn')].map((b) => b.textContent ?? '');
const focused = (): string | null | undefined => document.activeElement?.textContent;
const press = (key: string, target: EventTarget = document.activeElement ?? document.body, init: KeyboardEventInit = {}): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

function finished(): MatchState {
  const config = { format: 'tiebreak', pace: 'normal', surface: 'hard', wordPack: 'everyday', deuceRule: 'advantage', training: null } as const;
  const look = DEFAULT_PROFILE.look;
  const s = new Engine({
    config,
    players: [
      { name: 'Alex', look, kind: 'human', cpuLevel: null },
      { name: 'Mika', look, kind: 'cpu', cpuLevel: 6 },
    ],
    seed: 1,
  }).state;
  s.status = 'over';
  s.winner = 0;
  return s;
}

beforeEach(() => {
  // jsdom has no 2D canvas; the logo and previews simply stay blank.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  router = new Router(root);
});

afterEach(() => {
  router.dispose();
  vi.restoreAllMocks();
});

describe('start gate', () => {
  it.each(['a', ' ', 'Enter', 'ArrowUp'])('%j opens it (top-level page)', (key) => {
    const ctx = fakeContext();
    router.register('gate', gateScreen(ctx));
    router.go('gate');
    press(key, document.body);
    expect(ctx.openGate).toHaveBeenCalledOnce();
  });

  it.each(['F5', 'F11', 'Shift', 'Control', 'Tab'])('%j does not, and keeps its browser action', (key) => {
    const ctx = fakeContext();
    router.register('gate', gateScreen(ctx));
    router.go('gate');
    const e = press(key, document.body);
    expect(ctx.openGate).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it.each(['a', 'Enter'])('a held %j (auto-repeat) does not open it; only a fresh press does', (key) => {
    const ctx = fakeContext();
    router.register('gate', gateScreen(ctx));
    router.go('gate');
    press(key, document.body, { repeat: true });
    expect(ctx.openGate).not.toHaveBeenCalled();
    press(key, document.body);
    expect(ctx.openGate).toHaveBeenCalledOnce();
  });

  it('Esc does not open it either', () => {
    const ctx = fakeContext();
    router.register('gate', gateScreen(ctx));
    router.go('gate');
    press('Escape', document.body);
    expect(ctx.openGate).not.toHaveBeenCalled();
  });

  it('a click opens it, once', () => {
    const ctx = fakeContext();
    router.register('gate', gateScreen(ctx));
    router.go('gate');
    const el = root.querySelector<HTMLElement>('.gate')!;
    el.click();
    el.click();
    press('a', document.body);
    expect(ctx.openGate).toHaveBeenCalledOnce();
  });
});

describe('main menu', () => {
  it('offers Training first until it is done', () => {
    const ctx = fakeContext({ trainingDone: false });
    router.register('mainMenu', mainMenuScreen(ctx));
    router.go('mainMenu');
    expect(labels()[0]).toBe('TRAINING');
    expect(focused()).toBe('TRAINING');
  });

  it('moves Training down the list once done', () => {
    const ctx = fakeContext({ trainingDone: true });
    router.register('mainMenu', mainMenuScreen(ctx));
    router.go('mainMenu');
    const items = labels();
    expect(items[0]).toBe('PLAY VS CPU');
    expect(items).toContain('TRAINING');
    expect(items.at(-1)).toBe('FULLSCREEN');
  });

  it('Play Online opens Host and Join, which lead to the online screens', () => {
    const ctx = fakeContext();
    router.register('mainMenu', mainMenuScreen(ctx));
    registerOnlineScreens(router, { profile: () => ctx.profile, settings: () => ctx.settings, startMatch: vi.fn() });
    router.go('mainMenu');
    const online = [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'PLAY ONLINE')!;
    online.click();
    expect(focused()).toBe('HOST GAME');
    (document.activeElement as HTMLButtonElement).click();
    expect(router.current).toBe('host');
  });

  it('on a first launch, offers Training in a small prompt with TRAINING focused', () => {
    const ctx = fakeContext({}, true);
    router.register('mainMenu', mainMenuScreen(ctx));
    router.go('mainMenu');
    const offer = root.querySelector<HTMLElement>('.training-offer')!;
    expect(offer.textContent).toContain('NEW HERE? LEARN THE BASICS IN TRAINING');
    expect([...offer.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['TRAINING', 'LATER']);
    expect(document.activeElement).toBe(offer.querySelector('button'));
    (document.activeElement as HTMLButtonElement).click();
    expect(ctx.startTraining).toHaveBeenCalledOnce();
    expect(ctx.dismissTrainingOffer).not.toHaveBeenCalled();
  });

  it('LATER dismisses the offer for good and puts the focus on the menu', () => {
    const ctx = fakeContext({}, true);
    router.register('mainMenu', mainMenuScreen(ctx));
    router.go('mainMenu');
    const later = [...root.querySelectorAll<HTMLButtonElement>('.training-offer button')].find((b) => b.textContent === 'LATER')!;
    later.click();
    expect(ctx.dismissTrainingOffer).toHaveBeenCalledOnce();
    expect(root.querySelector('.training-offer')).toBeNull();
    expect(focused()).toBe('TRAINING');
    expect(document.activeElement?.closest('.menu')).not.toBeNull();
    router.go('mainMenu');
    expect(root.querySelector('.training-offer')).toBeNull();
  });

  it('shows no offer otherwise', () => {
    const ctx = fakeContext();
    router.register('mainMenu', mainMenuScreen(ctx));
    router.go('mainMenu');
    expect(root.querySelector('.training-offer')).toBeNull();
    expect(root.textContent).not.toContain('NEW HERE?');
  });
});

describe('vs CPU setup', () => {
  it('focuses Start and stores each change at once', () => {
    const ctx = fakeContext();
    router.register('cpuSetup', cpuSetupScreen(ctx));
    router.go('cpuSetup');
    expect(focused()).toBe('START');
    const deuce = [...root.querySelectorAll<HTMLElement>('.row')].find((r) => r.textContent?.startsWith('DEUCE'))!;
    press('ArrowRight', deuce);
    expect(ctx.setSettings).toHaveBeenCalledWith({ deuceRule: 'golden' });
    const belts = root.querySelector<HTMLElement>('.belts')!;
    press('ArrowRight', belts);
    expect(ctx.setSettings).toHaveBeenCalledWith({ cpuLevel: 1 });
    expect(belts.querySelector('.value')?.textContent).toContain('WHITE BELT, 1 STRIPE');
  });

  it('shows all 15 levels, marks the milestones and ticks earned belts', () => {
    const ctx = fakeContext();
    ctx.career.earned = ['white', 'green'];
    router.register('cpuSetup', cpuSetupScreen(ctx));
    router.go('cpuSetup');
    expect(root.querySelectorAll('.belt')).toHaveLength(15);
    expect(root.querySelectorAll('.belt.milestone')).toHaveLength(7);
    expect(root.querySelectorAll('.belt .earned')).toHaveLength(2);
  });

  it('Start starts the match', () => {
    const ctx = fakeContext();
    router.register('cpuSetup', cpuSetupScreen(ctx));
    router.go('cpuSetup');
    (document.activeElement as HTMLButtonElement).click();
    expect(ctx.startCpuMatch).toHaveBeenCalledOnce();
  });
});

describe('in-match menu', () => {
  it('vs CPU: Resume / Restart / Quit (+ Fullscreen); Esc resumes', () => {
    const ctx = fakeContext();
    router.register('pause', pauseScreen(ctx));
    router.go('pause', { kind: 'cpu' });
    expect(labels()).toEqual(['RESUME', 'RESTART', 'QUIT', 'FULLSCREEN']);
    expect(focused()).toBe('RESUME');
    press('Escape');
    expect(ctx.resumeMatch).toHaveBeenCalledOnce();
  });

  it('a held Esc does not resume: the repeats of the Esc that paused the match are ignored', () => {
    const ctx = fakeContext();
    router.register('pause', pauseScreen(ctx));
    router.go('pause', { kind: 'cpu' });
    press('Escape', undefined, { repeat: true });
    press('Escape', undefined, { repeat: true });
    expect(ctx.resumeMatch).not.toHaveBeenCalled();
    expect(router.current).toBe('pause');
  });

  it('online: Resume / Forfeit (+ Fullscreen)', () => {
    const ctx = fakeContext();
    router.register('pause', pauseScreen(ctx));
    router.go('pause', { kind: 'online' });
    expect(labels()).toEqual(['RESUME', 'FORFEIT', 'FULLSCREEN']);
  });
});

describe('results', () => {
  it('a match: banner, score, stat table, earned belt, Rematch / Menu; Esc goes to the menu', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.go('results', { kind: 'cpu', result: finished(), viewer: 0, newBelt: 'green', canRematch: true });
    expect(root.querySelector('.panel-title')?.textContent).toBe('YOU WIN!');
    expect(root.querySelectorAll('.stats tbody tr')).toHaveLength(10);
    expect(root.querySelector('.belt-earned')?.textContent).toContain('GREEN');
    expect(labels()).toEqual(['REMATCH', 'MENU']);
    press('Escape');
    expect(ctx.quitMatch).toHaveBeenCalledOnce();
  });

  it('online Rematch asks the opponent and then waits', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.go('results', { kind: 'online', result: finished(), viewer: 0, newBelt: null, canRematch: true });
    const b = document.activeElement as HTMLButtonElement;
    b.click();
    b.click();
    expect(ctx.rematch).toHaveBeenCalledOnce();
    expect(b.textContent).toBe('WAITING FOR OPPONENT...');
    expect(b.disabled).toBe(true);
  });

  it('online, the opponent gone: Rematch disabled, an OPPONENT LEFT note, Menu focused', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.go('results', { kind: 'online', result: finished(), viewer: 0, newBelt: null, canRematch: true, opponentLeft: true });
    const rematch = [...root.querySelectorAll<HTMLButtonElement>('button.btn')].find((b) => b.textContent === 'REMATCH')!;
    expect(rematch.disabled).toBe(true);
    expect(root.querySelector('.opponent-left')?.textContent).toBe('OPPONENT LEFT');
    expect(focused()).toBe('MENU');
    rematch.click();
    expect(ctx.rematch).not.toHaveBeenCalled();
  });

  it('online with the opponent still there: no note', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.go('results', { kind: 'online', result: finished(), viewer: 0, newBelt: null, canRematch: true });
    expect(root.querySelector('.opponent-left')).toBeNull();
  });

  it('no Rematch when the match cannot be replayed, and no belt line without a new belt', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.go('results', { kind: 'online', result: finished(), viewer: 1, newBelt: null, canRematch: false });
    expect(root.querySelector('.panel-title')?.textContent).toBe('ALEX WINS');
    expect(root.querySelector('.belt-earned')).toBeNull();
    expect(labels()).toEqual(['MENU']);
  });

  it('Training not finished: a friendly Try again panel without a stat table', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.go('results', { kind: 'training', done: false });
    expect(root.querySelector('.panel-title')?.textContent).toBe('TRY AGAIN');
    expect(root.querySelector('.stats')).toBeNull();
    (document.activeElement as HTMLButtonElement).click();
    expect(ctx.startTraining).toHaveBeenCalledOnce();
  });

  it('Training complete: on to a vs CPU match', () => {
    const ctx = fakeContext();
    router.register('results', resultsScreen(ctx));
    router.register('cpuSetup', cpuSetupScreen(ctx));
    router.go('results', { kind: 'training', done: true });
    expect(root.querySelector('.panel-title')?.textContent).toBe('TRAINING COMPLETE!');
    expect(root.querySelector('.stats')).toBeNull();
    (document.activeElement as HTMLButtonElement).click();
    expect(ctx.quitMatch).toHaveBeenCalledOnce();
    expect(router.current).toBe('cpuSetup');
  });
});
