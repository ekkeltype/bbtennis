// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router, type ScreenInstance } from '../../src/ui/router';

let root: HTMLElement;
let router: Router;
let changes: string[];

/** A screen whose element holds `buttons` buttons labelled `<name>0`, `<name>1`, … and records its lifecycle. */
function screen(name: string, buttons = 2, extra: Partial<ScreenInstance> = {}) {
  const log: string[] = [];
  const params: unknown[] = [];
  const factory = vi.fn((p: unknown): ScreenInstance => {
    params.push(p);
    const el = document.createElement('div');
    el.dataset['screen'] = name;
    for (let i = 0; i < buttons; i++) {
      const b = document.createElement('button');
      b.textContent = `${name}${i}`;
      el.append(b);
    }
    return { el, onShow: () => log.push('show'), onHide: () => log.push('hide'), ...extra };
  });
  return { factory, log, params };
}

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const target = document.activeElement ?? document.body;
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

const shown = (): string | undefined => root.querySelector<HTMLElement>('[data-screen]')?.dataset['screen'];
const focused = (): string | null | undefined => document.activeElement?.textContent;

beforeEach(() => {
  document.body.innerHTML = '';
  root = document.createElement('div');
  document.body.append(root);
  changes = [];
  router = new Router(root, (name) => changes.push(name));
});

afterEach(() => {
  router.dispose();
});

describe('Router navigation', () => {
  it('shows nothing before the first go', () => {
    expect(router.current).toBe('');
    expect(root.children).toHaveLength(0);
  });

  it('go mounts the screen, calls onShow and reports the change', () => {
    const a = screen('a');
    router.register('a', a.factory);
    router.go('a', { x: 1 });
    expect(router.current).toBe('a');
    expect(shown()).toBe('a');
    expect(a.params).toEqual([{ x: 1 }]);
    expect(a.log).toEqual(['show']);
    expect(changes).toEqual(['a']);
  });

  it('go hides and removes the previous screen', () => {
    const a = screen('a');
    const b = screen('b');
    router.register('a', a.factory);
    router.register('b', b.factory);
    router.go('a');
    router.go('b');
    expect(a.log).toEqual(['show', 'hide']);
    expect(root.querySelectorAll('[data-screen]')).toHaveLength(1);
    expect(shown()).toBe('b');
  });

  it('back re-creates the previous screen with its params', () => {
    const a = screen('a');
    const b = screen('b');
    router.register('a', a.factory);
    router.register('b', b.factory);
    router.go('a', 'first');
    router.go('b');
    router.back();
    expect(router.current).toBe('a');
    expect(shown()).toBe('a');
    expect(a.params).toEqual(['first', 'first']);
    expect(b.log).toEqual(['show', 'hide']);
    expect(changes).toEqual(['a', 'b', 'a']);
  });

  it('back on the first screen does nothing', () => {
    const a = screen('a');
    router.register('a', a.factory);
    router.go('a');
    router.back();
    expect(router.current).toBe('a');
    expect(a.factory).toHaveBeenCalledTimes(1);
  });

  it('going to a screen already in the history returns to it, dropping what came after', () => {
    for (const n of ['menu', 'setup', 'match', 'results']) router.register(n, screen(n).factory);
    router.go('menu');
    router.go('setup');
    router.go('match');
    router.go('results');
    router.go('menu', 'again');
    expect(router.current).toBe('menu');
    router.back();
    expect(router.current).toBe('menu');
    router.go('setup');
    router.back();
    expect(router.current).toBe('menu');
  });

  it('throws for an unknown screen', () => {
    expect(() => router.go('nowhere')).toThrow(/nowhere/);
  });

  it('focuses the first focusable element when the screen does not focus anything itself', () => {
    router.register('a', screen('a', 3).factory);
    router.go('a');
    expect(focused()).toBe('a0');
  });

  it('keeps the focus a screen chose in onShow', () => {
    let el: HTMLElement | null = null;
    router.register('a', () => {
      el = document.createElement('div');
      el.innerHTML = '<button>one</button><button>two</button>';
      const e = el;
      return { el: e, onShow: () => e.querySelectorAll('button')[1]?.focus() };
    });
    router.go('a');
    expect(focused()).toBe('two');
  });
});

describe('Router keys', () => {
  beforeEach(() => {
    router.register('a', screen('a', 3).factory);
    router.register('b', screen('b', 3).factory);
    router.go('a');
    router.go('b');
  });

  it('Esc goes back', () => {
    const e = press('Escape');
    expect(router.current).toBe('a');
    expect(e.defaultPrevented).toBe(true);
  });

  it("Esc calls the screen's onBack instead when it has one", () => {
    const onBack = vi.fn();
    router.register('c', screen('c', 1, { onBack }).factory);
    router.go('c');
    press('Escape');
    expect(onBack).toHaveBeenCalledOnce();
    expect(router.current).toBe('c');
  });

  it('a held Esc (auto-repeat) does not call onBack; only a fresh press does', () => {
    const onBack = vi.fn();
    router.register('c', screen('c', 1, { onBack }).factory);
    router.go('c');
    const held = press('Escape', { repeat: true });
    press('Escape', { repeat: true });
    expect(onBack).not.toHaveBeenCalled();
    expect(held.defaultPrevented).toBe(true);
    press('Escape');
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('a held Esc does not go back either', () => {
    press('Escape', { repeat: true });
    expect(router.current).toBe('b');
  });

  it.each(['Enter', ' '])('a held %j is swallowed so it cannot click the focused button; a fresh press is left to it', (key) => {
    expect(press(key, { repeat: true }).defaultPrevented).toBe(true);
    expect(press(key).defaultPrevented).toBe(false);
  });

  it('held arrow keys still repeat through the menu', () => {
    press('ArrowDown', { repeat: true });
    press('ArrowDown', { repeat: true });
    expect(focused()).toBe('b2');
  });

  it('ignores keys another handler already took (defaultPrevented), e.g. the match keyboard capture', () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    e.preventDefault();
    document.body.dispatchEvent(e);
    expect(router.current).toBe('b');
  });

  it('ignores Esc with a modifier held', () => {
    press('Escape', { ctrlKey: true });
    expect(router.current).toBe('b');
  });

  it('ArrowDown / ArrowUp move the focus through the screen, wrapping around', () => {
    expect(focused()).toBe('b0');
    press('ArrowDown');
    expect(focused()).toBe('b1');
    press('ArrowDown');
    press('ArrowDown');
    expect(focused()).toBe('b0');
    press('ArrowUp');
    expect(focused()).toBe('b2');
  });

  it('ArrowLeft / ArrowRight also move between buttons', () => {
    press('ArrowRight');
    expect(focused()).toBe('b1');
    press('ArrowLeft');
    expect(focused()).toBe('b0');
  });

  it('arrow keys skip disabled buttons and elements taken out of the tab order', () => {
    const el = root.querySelector('[data-screen="b"]')!;
    const buttons = el.querySelectorAll('button');
    buttons[1]!.disabled = true;
    press('ArrowDown');
    expect(focused()).toBe('b2');
    buttons[0]!.tabIndex = -1;
    press('ArrowDown');
    expect(focused()).toBe('b2');
  });

  it('leaves Left/Right to a focused text field (caret movement) but Up/Down still move on', () => {
    const el = root.querySelector('[data-screen="b"]')!;
    const input = document.createElement('input');
    el.prepend(input);
    input.focus();
    const e = press('ArrowRight');
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    press('ArrowDown');
    expect(focused()).toBe('b0');
  });

  it("hovering an item focuses it; hovering a row's inner arrow button focuses the row", () => {
    const el = root.querySelector('[data-screen="b"]')!;
    const row = document.createElement('div');
    row.tabIndex = 0;
    const arrow = document.createElement('button');
    arrow.tabIndex = -1;
    row.append(arrow);
    el.append(row);
    el.querySelectorAll('button')[2]!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(focused()).toBe('b2');
    arrow.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.activeElement).toBe(row);
  });

  it('hovering never takes the focus out of a focused text field (it keeps its caret while the pointer crosses rows)', () => {
    const el = root.querySelector('[data-screen="b"]')!;
    const input = document.createElement('input');
    el.prepend(input);
    input.focus();
    el.querySelectorAll('button')[1]!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(document.activeElement).toBe(input);
    input.blur();
    el.querySelectorAll('button')[1]!.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(focused()).toBe('b1');
  });

  it('stops handling keys after dispose', () => {
    router.dispose();
    press('Escape');
    expect(router.current).toBe('b');
  });
});
