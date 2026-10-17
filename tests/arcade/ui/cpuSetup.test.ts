// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArcadeConfig } from '../../../src/arcade/core/types';
import { cpuSetupScreen } from '../../../src/arcade/ui/screens/cpuSetup';
import { ArcadeStore, type CpuSetup } from '../../../src/arcade/ui/store';
import { BELTS } from '../../../src/core/belts';
import { Router } from '../../../src/ui/router';

let root: HTMLElement;
let router: Router;

/** The screen's context over a real store (so "remembered" means stored), with a spy for Start. */
function context(store: ArcadeStore) {
  return {
    router,
    get cpuSetup(): Readonly<CpuSetup> {
      return store.cpuSetup;
    },
    setCpuSetup: (patch: Partial<CpuSetup>) => store.setCpuSetup(patch),
    startCpuMatch: vi.fn<(level: number, config: ArcadeConfig) => void>(),
  };
}

function show(store: ArcadeStore) {
  const ctx = context(store);
  router.register('cpuSetup', cpuSetupScreen(ctx));
  router.go('cpuSetup');
  return ctx;
}

const row = (label: string): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no row ${label}`);
  return el;
};
const press = (el: HTMLElement, key: string, times = 1): void => {
  for (let i = 0; i < times; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
const buttonNamed = (text: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent === text);
  if (!b) throw new Error(`no button ${text}`);
  return b;
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  localStorage.clear();
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  router = new Router(root);
});

afterEach(() => {
  router.dispose();
  vi.restoreAllMocks();
});

describe('CPU setup screen', () => {
  it('offers the 15 belts by their BELTS labels', () => {
    show(new ArcadeStore());
    const opponent = row('OPPONENT');
    const seen: string[] = [];
    for (let i = 0; i < BELTS.length; i++) {
      seen.push(opponent.getAttribute('aria-valuetext') ?? '');
      press(opponent, 'ArrowRight');
    }
    expect(seen).toEqual(BELTS.map((b) => b.label));
    expect(opponent.getAttribute('aria-valuetext')).toBe(BELTS[0]!.label);
  });

  it('remembers the last belt (and the other choices) in a new visit', () => {
    show(new ArcadeStore());
    press(row('OPPONENT'), 'ArrowRight', 9);
    press(row('COURT'), 'ArrowLeft');
    expect(row('OPPONENT').getAttribute('aria-valuetext')).toBe('BROWN BELT');

    router.dispose();
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.append(root);
    router = new Router(root);
    const again = new ArcadeStore();
    expect(again.cpuSetup.level).toBe(9);
    show(again);
    expect(row('OPPONENT').getAttribute('aria-valuetext')).toBe('BROWN BELT');
    expect(row('COURT').getAttribute('aria-valuetext')).toBe('DOJO');
  });

  it('Start builds the ArcadeConfig of the choices shown and starts the match at the chosen belt', () => {
    const store = new ArcadeStore();
    store.setCpuSetup({ level: 2, format: 'tiebreak', deuceRule: 'advantage', surface: 'hard', pace: 'normal' });
    const ctx = show(store);
    press(row('OPPONENT'), 'ArrowRight', 3);
    press(row('FORMAT'), 'ArrowRight');
    press(row('DEUCE'), 'ArrowRight');
    press(row('COURT'), 'ArrowRight');
    press(row('PACE'), 'ArrowRight');
    buttonNamed('START').click();
    expect(ctx.startCpuMatch).toHaveBeenCalledOnce();
    expect(ctx.startCpuMatch).toHaveBeenCalledWith(5, { format: 'short', deuceRule: 'golden', surface: 'clay', pace: 'fast' });
  });

  it('focuses Start, shows no typing-speed hints, and Back goes back', () => {
    router.register('mainMenu', () => ({ el: document.createElement('div') }));
    router.go('mainMenu');
    show(new ArcadeStore());
    expect(document.activeElement?.textContent).toBe('START');
    expect(root.textContent).not.toContain('WPM');
    buttonNamed('BACK').click();
    expect(router.current).toBe('mainMenu');
  });
});
