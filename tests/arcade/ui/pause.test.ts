// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArcadeSession } from '../../../src/arcade/game/session';
import { ArcadeApp } from '../../../src/arcade/ui/app';

/** A 2D context whose every method is a no-op (jsdom has no canvas): enough for the app to be built. */
const fake2d = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => undefined),
  set: (t, k, v) => {
    t[k] = v;
    return true;
  },
});

let app: ArcadeApp;
const pause = vi.spyOn(ArcadeSession.prototype, 'pause');
const resume = vi.spyOn(ArcadeSession.prototype, 'resume');

const buttonNamed = (text: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll<HTMLButtonElement>('#ui button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
};
const key = (target: EventTarget, code: string, k = code): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true }));
};
/** True when the game's HeldKeys take a movement key (they claim it only while enabled); the key is released again. */
const keysOn = (): boolean => {
  const down = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true });
  window.dispatchEvent(down);
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }));
  return down.defaultPrevented;
};

beforeAll(async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake2d as unknown as CanvasRenderingContext2D);
  // The loop is not run: no frames are drawn, only the screens and the match lifecycle are exercised.
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  localStorage.clear();
  document.body.innerHTML = '<div id="app" tabindex="-1"><canvas id="game"></canvas><div id="ui"></div></div>';
  const root = document.getElementById('app')!;
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  app = new ArcadeApp({ root, canvas, ui });
  await app.start();
  app.openGate();
  app.startCpuMatch(3, { format: 'tiebreak', deuceRule: 'advantage', surface: 'clay', pace: 'normal' });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('pausing a vs-CPU match', () => {
  it('starts on the match screen with the keys on', () => {
    expect(app.router.current).toBe('match');
    expect(keysOn()).toBe(true);
  });

  it('Esc pauses the session, turns the keys off and opens the pause menu', () => {
    pause.mockClear();
    key(window, 'Escape');
    expect(pause).toHaveBeenCalledOnce();
    expect(app.router.current).toBe('pause');
    expect(keysOn()).toBe(false);
  });

  it("Resume calls the session's resume, turns the keys back on and returns to the match", () => {
    resume.mockClear();
    buttonNamed('RESUME').click();
    expect(resume).toHaveBeenCalledOnce();
    expect(app.router.current).toBe('match');
    expect(keysOn()).toBe(true);
  });

  it('a stray resume while the match runs does not restart the countdown', () => {
    resume.mockClear();
    app.resumeMatch();
    expect(resume).not.toHaveBeenCalled();
  });

  it('Tab, the pause icon, window blur and a hidden tab pause too; Esc on the menu resumes', () => {
    const opens: (() => void)[] = [
      () => key(window, 'Tab'),
      () => document.querySelector<HTMLButtonElement>('#ui .pause-hit')!.click(),
      () => window.dispatchEvent(new Event('blur')),
      () => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      },
    ];
    for (const open of opens) {
      pause.mockClear();
      resume.mockClear();
      open();
      expect(pause).toHaveBeenCalledOnce();
      expect(app.router.current).toBe('pause');
      key(document.body, 'Escape');
      expect(resume).toHaveBeenCalledOnce();
      expect(app.router.current).toBe('match');
    }
  });

  it('Quit leaves the match for the main menu with the keys off', () => {
    key(window, 'Escape');
    buttonNamed('QUIT').click();
    expect(app.router.current).toBe('mainMenu');
    expect(keysOn()).toBe(false);
  });
});
