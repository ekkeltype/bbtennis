// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { titleScreen } from '../../../src/arcade/ui/screens/title';
import { Router } from '../../../src/ui/router';

let root: HTMLElement;
let router: Router;

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  router = new Router(root);
  router.register('mainMenu', () => ({ el: document.createElement('div') }));
  router.register('title', titleScreen({ router, toggleFullscreen: vi.fn() }));
  router.go('title');
});

afterEach(() => {
  router.dispose();
  vi.restoreAllMocks();
});

describe('Arcade title', () => {
  it('shows the logo stamped ARCADE on the shared title band', () => {
    const logo = root.querySelector('.title-band canvas.logo.stamped');
    expect(logo?.getAttribute('aria-label')).toBe('Black Belt Tennis Arcade');
  });

  it('PRESS ENTER (focused) opens the main menu', () => {
    const press = [...root.querySelectorAll('button')].find((b) => b.textContent === 'PRESS ENTER')!;
    expect(document.activeElement).toBe(press);
    press.click();
    expect(router.current).toBe('mainMenu');
  });
});
