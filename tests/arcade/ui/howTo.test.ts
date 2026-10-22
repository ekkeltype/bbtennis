// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { howToScreen } from '../../../src/arcade/ui/screens/howTo';
import { Router } from '../../../src/ui/router';

let root: HTMLElement;
let router: Router;

/** Spec §4.1's keys (both layouts, and pause), as their keycaps read. Tab also opens the pause menu (§6.3). */
const KEYS = ['W', 'A', 'S', 'D', 'ARROWS', 'J', 'K', 'L', 'Z', 'X', 'C', 'ESC', 'TAB'];

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  router = new Router(root);
  router.register('mainMenu', () => ({ el: document.createElement('div') }));
  router.register('howTo', howToScreen({ router }));
  router.go('mainMenu');
  router.go('howTo');
});

afterEach(() => {
  router.dispose();
});

describe('How to Play', () => {
  it('shows a keycap for every key of the controls', () => {
    const caps = [...root.querySelectorAll('kbd')].map((k) => k.textContent);
    for (const key of KEYS) expect(caps).toContain(key);
  });

  it('pairs each action with its keys in the controls table', () => {
    const rows = [...root.querySelectorAll('table.controls tbody tr')].map((tr) => [...tr.querySelectorAll('kbd')].map((k) => k.textContent).join(' '));
    const actions = [...root.querySelectorAll('table.controls tbody th')].map((th) => th.textContent);
    expect(actions).toEqual(['MOVE', 'TOPSPIN', 'SLICE', 'LOB', 'PAUSE']);
    expect(rows).toEqual(['W A S D ARROWS', 'J Z', 'K X', 'L C', 'ESC TAB ESC TAB']);
  });

  it('shows Esc and Tab as pause keys in both layouts', () => {
    const pause = [...root.querySelectorAll('table.controls tbody tr')].find((tr) => tr.querySelector('th')?.textContent === 'PAUSE')!;
    expect([...pause.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['ESC / TAB', 'ESC / TAB']);
  });

  it('explains the swing timing, aim, serve and shot types', () => {
    const text = root.textContent ?? '';
    expect(text).toMatch(/plant/i);
    expect(text).toMatch(/only aim/i);
    expect(text).toContain('0.5 s');
    expect(text).toContain('PERFECT');
    for (const topic of ['SWING', 'AIM', 'SERVE', 'SHOTS']) expect(text).toContain(topic);
    for (const shot of ['Topspin', 'Slice', 'Lob', 'smash']) expect(text).toContain(shot);
  });

  it('Back returns to the menu', () => {
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'BACK')!.click();
    expect(router.current).toBe('mainMenu');
  });
});
