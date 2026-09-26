// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { KeyClass } from '../../src/core/typing';
import { KeyboardCapture } from '../../src/game/keyboard';

type Init = KeyboardEventInit & { key: string };

let capture: KeyboardCapture;
let onKey: Mock<(k: KeyClass, timeStamp: number) => void>;
let onMenu: Mock<(key: 'Escape' | 'Tab') => void>;

/** Dispatches a keydown (or keyup) on `target` (default: the body) and returns the event. */
function press(init: Init, target: EventTarget = document.body, type: 'keydown' | 'keyup' = 'keydown'): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  document.body.innerHTML = '';
  onKey = vi.fn<(k: KeyClass, timeStamp: number) => void>();
  onMenu = vi.fn<(key: 'Escape' | 'Tab') => void>();
  capture = new KeyboardCapture(window, onKey, onMenu);
  capture.enable();
});

afterEach(() => {
  capture.dispose();
});

describe('KeyboardCapture (spec §4.5)', () => {
  it('forwards a letter with its event timeStamp and prevents its default', () => {
    const e = press({ key: 'a', code: 'KeyA' });
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith({ kind: 'letter', letter: 'a', viaCode: false }, e.timeStamp);
  });

  it('forwards Shift/Caps Lock capitals as lowercase letters', () => {
    press({ key: 'Q', code: 'KeyQ', shiftKey: true });
    expect(onKey).toHaveBeenCalledWith({ kind: 'letter', letter: 'q', viaCode: false }, expect.any(Number));
  });

  it('maps a letter of a non-Latin layout to its physical key and flags it (viaCode)', () => {
    const e = press({ key: 'ф', code: 'KeyA' });
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledWith({ kind: 'letter', letter: 'a', viaCode: true }, e.timeStamp);
  });

  it('forwards Space as a toss and prevents page scroll', () => {
    const e = press({ key: ' ', code: 'Space' });
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledWith({ kind: 'toss' }, e.timeStamp);
  });

  it.each([
    { key: 'Backspace', code: 'Backspace' },
    { key: "'", code: 'Quote' },
    { key: '/', code: 'Slash' },
    { key: '1', code: 'Digit1' },
    { key: 'Enter', code: 'Enter' },
    { key: 'ArrowDown', code: 'ArrowDown' },
    { key: 'Dead', code: 'BracketLeft' },
    { key: 'Process', code: 'KeyA' },
    { key: 'Unidentified', code: '' },
    { key: 'F5', code: 'F5' },
    { key: 'Shift', code: 'ShiftLeft', shiftKey: true },
    { key: 'Alt', code: 'AltLeft', altKey: true },
    { key: 'a', code: 'KeyA', altKey: true },
    { key: 'a', code: 'KeyA', repeat: true },
    { key: 'a', code: 'KeyA', isComposing: true },
    { key: ' ', code: 'Space', repeat: true },
  ])('prevents but ignores $key ($code)', (init) => {
    const e = press(init);
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('prevents the Alt keyup too (the Windows menu opens on it)', () => {
    const up = press({ key: 'Alt', code: 'AltLeft' }, document.body, 'keyup');
    expect(up.defaultPrevented).toBe(true);
    expect(press({ key: 'a', code: 'KeyA' }, document.body, 'keyup').defaultPrevented).toBe(false);
  });

  it.each([
    { key: 'r', code: 'KeyR', ctrlKey: true },
    { key: 'w', code: 'KeyW', ctrlKey: true },
    { key: 'r', code: 'KeyR', metaKey: true },
    { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true },
    { key: 'Control', code: 'ControlLeft', ctrlKey: true },
    { key: 'Meta', code: 'MetaLeft', metaKey: true },
    { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true },
    { key: 'Tab', code: 'Tab', ctrlKey: true },
    { key: 'Escape', code: 'Escape', metaKey: true },
  ])('never prevents or forwards a Ctrl/Meta combination: $key ($code)', (init) => {
    const e = press(init);
    expect(e.defaultPrevented).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
  });

  it.each(['Escape', 'Tab'] as const)('sends %s to the menu callback instead of the game, prevented', (key) => {
    const e = press({ key, code: key });
    expect(e.defaultPrevented).toBe(true);
    expect(onMenu).toHaveBeenCalledWith(key);
    expect(onKey).not.toHaveBeenCalled();
    press({ key, code: key, repeat: true });
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it('listens on the window in the capture phase: a page handler that stops propagation cannot hide keys', () => {
    const button = document.createElement('button');
    document.body.append(button);
    button.addEventListener('keydown', (e) => e.stopPropagation());
    const e = press({ key: 'k', code: 'KeyK' }, button);
    expect(e.defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')],
    [
      'contenteditable',
      () => {
        const div = document.createElement('div');
        div.setAttribute('contenteditable', 'true');
        div.tabIndex = 0;
        return div;
      },
    ],
  ] as const)('does nothing while a %s is focused, and works again after it loses focus', (_name, make) => {
    const el = make();
    document.body.append(el);
    el.focus();
    expect(document.activeElement).toBe(el);
    for (const init of [{ key: 'a', code: 'KeyA' }, { key: ' ', code: 'Space' }, { key: 'Tab', code: 'Tab' }]) {
      expect(press(init, el).defaultPrevented).toBe(false);
    }
    expect(press({ key: 'Alt', code: 'AltLeft' }, el, 'keyup').defaultPrevented).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
    el.blur();
    expect(press({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('does nothing while blocked (a menu is open) and resumes when unblocked', () => {
    capture.setBlocked(true);
    expect(press({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(press({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    expect(onMenu).not.toHaveBeenCalled();
    capture.setBlocked(false);
    expect(press({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(true);
    expect(onKey).toHaveBeenCalledTimes(1);
  });

  it('does nothing until enabled, nor after disable or dispose', () => {
    capture.disable();
    expect(press({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(press({ key: ' ', code: 'Space' }).defaultPrevented).toBe(false);
    capture.enable();
    expect(press({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(true);
    capture.dispose();
    capture.enable();
    expect(press({ key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(onKey).toHaveBeenCalledTimes(1);

    const fresh = new KeyboardCapture(window, onKey);
    expect(press({ key: 'b', code: 'KeyB' }).defaultPrevented).toBe(false);
    fresh.enable();
    expect(press({ key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(true);
    fresh.dispose();
    expect(onKey).toHaveBeenCalledTimes(1);
  });
});
