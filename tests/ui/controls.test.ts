// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fullscreenButton, pickerRow, slider, spinner } from '../../src/ui/controls';
import { focusables, h } from '../../src/ui/dom';

function press(target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('h()', () => {
  it('builds an element with classes, attributes, listeners and children', () => {
    const onClick = vi.fn();
    const el = h('button', { class: 'btn big', type: 'button', onclick: onClick, 'aria-label': 'Go' }, 'GO ', h('span', {}, '!'));
    expect(el.tagName).toBe('BUTTON');
    expect(el.className).toBe('btn big');
    expect(el.getAttribute('type')).toBe('button');
    expect(el.getAttribute('aria-label')).toBe('Go');
    expect(el.textContent).toBe('GO !');
    el.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('sets boolean attributes only when true and skips null / false children', () => {
    const on = h('button', { disabled: true }, null, false, 'x');
    const off = h('button', { disabled: false });
    expect(on.hasAttribute('disabled')).toBe(true);
    expect(on.textContent).toBe('x');
    expect(off.hasAttribute('disabled')).toBe(false);
  });

  it('puts text in as text, never as HTML', () => {
    const el = h('div', {}, '<img src=x onerror=alert(1)>');
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('sets CSS custom properties and styles from a style object', () => {
    const el = h('div', { style: { '--c': '#fff', width: '3px' } });
    expect(el.style.getPropertyValue('--c')).toBe('#fff');
    expect(el.style.width).toBe('3px');
  });
});

describe('focusables', () => {
  it('lists enabled buttons, inputs and tabindex=0 elements in document order', () => {
    const root = h(
      'div',
      {},
      h('button', {}, 'a'),
      h('button', { disabled: true }, 'b'),
      h('div', { tabindex: 0 }, 'c'),
      h('button', { tabindex: -1 }, 'd'),
      h('input', {}),
    );
    expect(focusables(root).map((e) => e.tagName + (e.textContent ?? ''))).toEqual(['BUTTONa', 'DIVc', 'INPUT']);
  });
});

describe('spinner', () => {
  const choices = [
    { value: 'relaxed', label: 'RELAXED' },
    { value: 'normal', label: 'NORMAL' },
    { value: 'fast', label: 'FAST' },
  ] as const;

  function make(start: string) {
    let value = start;
    const set = vi.fn((v: string) => {
      value = v;
    });
    const el = spinner({ label: 'PACE', choices, get: () => value, set });
    document.body.append(el);
    return { el, set, value: () => value };
  }

  it('shows its label and the current choice, and is one keyboard stop', () => {
    const { el } = make('normal');
    expect(el.textContent).toContain('PACE');
    expect(el.querySelector('.value')?.textContent).toBe('NORMAL');
    expect(focusables(el)).toEqual([el]);
  });

  it('ArrowRight / Enter / Space step forward, ArrowLeft back, both wrapping', () => {
    const s = make('normal');
    expect(press(s.el, 'ArrowRight').defaultPrevented).toBe(true);
    expect(s.value()).toBe('fast');
    press(s.el, 'Enter');
    expect(s.value()).toBe('relaxed');
    press(s.el, ' ');
    expect(s.value()).toBe('normal');
    press(s.el, 'ArrowLeft');
    press(s.el, 'ArrowLeft');
    expect(s.value()).toBe('fast');
    expect(s.el.querySelector('.value')?.textContent).toBe('FAST');
  });

  it('a held Enter / Space steps once (their auto-repeats are ignored); a held arrow keeps stepping', () => {
    const s = make('relaxed');
    press(s.el, 'Enter');
    press(s.el, 'Enter', { repeat: true });
    press(s.el, ' ', { repeat: true });
    expect(s.value()).toBe('normal');
    expect(s.set).toHaveBeenCalledOnce();
    press(s.el, 'ArrowRight', { repeat: true });
    expect(s.value()).toBe('fast');
  });

  it('the arrow buttons step with the mouse', () => {
    const s = make('relaxed');
    s.el.querySelector<HTMLButtonElement>('.next')!.click();
    expect(s.value()).toBe('normal');
    s.el.querySelector<HTMLButtonElement>('.prev')!.click();
    s.el.querySelector<HTMLButtonElement>('.prev')!.click();
    expect(s.value()).toBe('fast');
  });

  it('does nothing when disabled', () => {
    let value = 'normal';
    const el = spinner({ label: 'VOICE', choices, get: () => value, set: (v) => (value = v), disabled: true });
    press(el, 'ArrowRight');
    el.querySelector<HTMLButtonElement>('.next')!.click();
    expect(value).toBe('normal');
    expect(focusables(el)).toEqual([]);
  });

  it('leaves other keys alone (Up/Down move focus elsewhere)', () => {
    const s = make('normal');
    expect(press(s.el, 'ArrowDown').defaultPrevented).toBe(false);
    expect(s.set).not.toHaveBeenCalled();
  });
});

describe('slider', () => {
  function make(start: number) {
    let value = start;
    const el = slider({ label: 'MUSIC', steps: 10, get: () => value, set: (v) => (value = v) });
    document.body.append(el);
    return { el, value: () => value };
  }

  it('shows one lit segment per step of the value', () => {
    const { el } = make(0.3);
    expect(el.querySelectorAll('.seg')).toHaveLength(10);
    expect(el.querySelectorAll('.seg.on')).toHaveLength(3);
  });

  it('arrow keys move one step, clamped to 0..1', () => {
    const s = make(0.9);
    press(s.el, 'ArrowRight');
    expect(s.value()).toBeCloseTo(1);
    press(s.el, 'ArrowRight');
    expect(s.value()).toBeCloseTo(1);
    for (let i = 0; i < 12; i++) press(s.el, 'ArrowLeft');
    expect(s.value()).toBe(0);
    expect(s.el.querySelectorAll('.seg.on')).toHaveLength(0);
  });

  it('clicking a segment sets the value to that step', () => {
    const s = make(0);
    s.el.querySelectorAll<HTMLElement>('.seg')[4]!.click();
    expect(s.value()).toBeCloseTo(0.5);
    expect(s.el.querySelectorAll('.seg.on')).toHaveLength(5);
  });
});

describe('pickerRow', () => {
  function make(start: number) {
    let value = start;
    const el = pickerRow({
      label: 'SHIRT',
      count: 4,
      get: () => value,
      set: (i) => (value = i),
      item: (i) => h('span', { class: 'swatch' }, String(i)),
      describe: (i) => `COLOUR ${i}`,
    });
    document.body.append(el);
    return { el, value: () => value };
  }

  it('marks the selected item and names it', () => {
    const { el } = make(2);
    const items = el.querySelectorAll('.item');
    expect(items).toHaveLength(4);
    expect(items[2]!.classList.contains('on')).toBe(true);
    expect(el.querySelector('.value')?.textContent).toBe('COLOUR 2');
  });

  it('ArrowLeft / ArrowRight cycle through the items', () => {
    const s = make(3);
    press(s.el, 'ArrowRight');
    expect(s.value()).toBe(0);
    press(s.el, 'ArrowLeft');
    expect(s.value()).toBe(3);
    expect(s.el.querySelectorAll('.item')[3]!.classList.contains('on')).toBe(true);
  });

  it('clicking an item selects it', () => {
    const s = make(0);
    s.el.querySelectorAll<HTMLElement>('.item')[1]!.click();
    expect(s.value()).toBe(1);
    expect(s.el.querySelector('.value')?.textContent).toBe('COLOUR 1');
  });
});

describe('fullscreenButton', () => {
  it('is a FULLSCREEN menu button with its icon that toggles fullscreen', () => {
    const ctx = { toggleFullscreen: vi.fn() };
    const b = fullscreenButton(ctx, 'corner');
    expect(b.textContent).toBe('FULLSCREEN');
    expect(b.classList.contains('btn')).toBe(true);
    expect(b.classList.contains('fs')).toBe(true);
    expect(b.classList.contains('corner')).toBe(true);
    expect(b.querySelector('.icon')).not.toBeNull();
    b.click();
    expect(ctx.toggleFullscreen).toHaveBeenCalledOnce();
  });
});
