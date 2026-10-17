// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeldKeys, KeyboardController } from '../../src/arcade/game/keys';

let keys: HeldKeys;
let onMenu: ReturnType<typeof vi.fn<() => void>>;

function fire(type: 'keydown' | 'keyup', init: KeyboardEventInit & { code: string }, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, key: init.code, ...init });
  target.dispatchEvent(e);
  return e;
}
const down = (code: string, init: KeyboardEventInit = {}) => fire('keydown', { code, ...init });
const up = (code: string) => fire('keyup', { code });

beforeEach(() => {
  document.body.innerHTML = '';
  onMenu = vi.fn<() => void>();
  keys = new HeldKeys(window, onMenu);
  keys.enable();
});
afterEach(() => keys.dispose());

describe('HeldKeys key map', () => {
  it('maps movement keys, WASD and arrows alike', () => {
    for (const [code, mx, my] of [['KeyW', 0, 1], ['ArrowUp', 0, 1], ['KeyS', 0, -1], ['ArrowDown', 0, -1], ['KeyA', -1, 0], ['ArrowLeft', -1, 0], ['KeyD', 1, 0], ['ArrowRight', 1, 0]] as const) {
      down(code);
      expect(keys.input(), code).toMatchObject({ mx, my });
      up(code);
      expect(keys.input(), code).toMatchObject({ mx: 0, my: 0 });
    }
  });

  it('maps the shot keys', () => {
    for (const [code, flag] of [['KeyJ', 'topspin'], ['KeyZ', 'topspin'], ['KeyK', 'slice'], ['KeyX', 'slice'], ['KeyL', 'lob'], ['KeyC', 'lob']] as const) {
      down(code);
      expect(keys.input()[flag], code).toBe(true);
      up(code);
      keys.input();
    }
  });

  it('cancels opposite keys', () => {
    down('KeyA');
    down('ArrowRight');
    expect(keys.input().mx).toBe(0);
    down('KeyW');
    down('KeyS');
    expect(keys.input().my).toBe(0);
    up('ArrowRight');
    expect(keys.input().mx).toBe(-1);
  });

  it('reports two shot keys pressed on the same tick as both true', () => {
    down('KeyJ');
    down('KeyK');
    expect(keys.input()).toMatchObject({ topspin: true, slice: true, lob: false });
  });

  it('prevents default for game keys', () => {
    expect(down('KeyD').defaultPrevented).toBe(true);
    expect(down('KeyJ').defaultPrevented).toBe(true);
  });
});

describe('HeldKeys latch', () => {
  it('reports a tap shorter than one tick once', () => {
    down('KeyJ');
    up('KeyJ');
    expect(keys.input().topspin).toBe(true);
    expect(keys.input().topspin).toBe(false);
  });

  it('keeps reporting a held shot key and ignores auto-repeat for latching', () => {
    down('KeyK');
    expect(keys.input().slice).toBe(true);
    down('KeyK', { repeat: true });
    expect(keys.input().slice).toBe(true);
    up('KeyK');
    expect(keys.input().slice).toBe(false);
  });

  it('does not latch an auto-repeat', () => {
    down('KeyL');
    up('KeyL');
    keys.input();
    down('KeyL', { repeat: true });
    up('KeyL');
    expect(keys.input().lob).toBe(false);
  });
});

describe('HeldKeys clearing', () => {
  it('blur clears held keys and latched taps', () => {
    down('KeyD');
    down('KeyJ');
    up('KeyJ');
    window.dispatchEvent(new Event('blur'));
    expect(keys.input()).toMatchObject({ mx: 0, topspin: false });
  });

  it('visibilitychange clears', () => {
    down('KeyD');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(keys.input().mx).toBe(0);
  });

  it('disable clears and stops handling keys', () => {
    down('KeyD');
    keys.disable();
    expect(keys.input().mx).toBe(0);
    expect(down('KeyD').defaultPrevented).toBe(false);
    expect(keys.input().mx).toBe(0);
  });

  it('clear() empties held and latched', () => {
    down('KeyW');
    down('KeyL');
    keys.clear();
    expect(keys.input()).toMatchObject({ my: 0, lob: false });
  });
});

describe('HeldKeys menu and filters', () => {
  it('Escape and Tab call onMenu once per press and are prevented', () => {
    expect(down('Escape').defaultPrevented).toBe(true);
    down('Escape', { repeat: true });
    expect(onMenu).toHaveBeenCalledTimes(1);
    down('Tab');
    expect(onMenu).toHaveBeenCalledTimes(2);
  });

  it('never touches Ctrl/Meta combinations or function keys', () => {
    expect(down('KeyJ', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(down('KeyD', { metaKey: true }).defaultPrevented).toBe(false);
    expect(fire('keydown', { code: 'F5', key: 'F5' }).defaultPrevented).toBe(false);
    expect(keys.input()).toMatchObject({ topspin: false, mx: 0 });
  });

  it('drops held keys on a Meta keydown or keyup (macOS sends no keyup for keys held under Cmd)', () => {
    down('KeyD');
    expect(keys.input()).toMatchObject({ mx: 1 });
    expect(fire('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true }).defaultPrevented).toBe(false);
    expect(keys.input()).toMatchObject({ mx: 0 });

    down('KeyD');
    fire('keyup', { code: 'MetaLeft', key: 'Meta' });
    expect(keys.input()).toMatchObject({ mx: 0 });

    down('KeyD');
    expect(down('KeyW', { metaKey: true }).defaultPrevented).toBe(false);
    expect(keys.input()).toMatchObject({ mx: 0, my: 0 });
  });

  it('prevents the Alt keyup default', () => {
    expect(fire('keyup', { code: 'AltLeft', key: 'Alt' }).defaultPrevented).toBe(true);
  });

  it('ignores keys while a text field has focus', () => {
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    expect(fire('keydown', { code: 'KeyD' }, field).defaultPrevented).toBe(false);
    expect(keys.input().mx).toBe(0);
    fire('keydown', { code: 'Escape' }, field);
    expect(onMenu).not.toHaveBeenCalled();
  });

  it('does nothing before enable() and after dispose()', () => {
    const k = new HeldKeys(window, onMenu);
    down('KeyD');
    expect(k.input().mx).toBe(0);
    k.enable();
    k.dispose();
    down('KeyD');
    expect(k.input().mx).toBe(0);
  });
});

describe('KeyboardController', () => {
  it('reads the HeldKeys', () => {
    const c = new KeyboardController(keys);
    down('KeyA');
    expect(c.input().mx).toBe(-1);
  });
});
