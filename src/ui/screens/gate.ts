import type { UiContext } from '../context';
import { h } from '../dom';
import { logoCanvas } from '../logo';
import type { ScreenFactory } from '../router';

/** Keys that never open the gate: modifiers alone, Tab, Esc (not a user activation), and F1–F12 (browser keys, spec §4.5). */
const NOT_A_START_KEY = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Tab', 'Escape', 'ContextMenu']);

/** True when the page is not framed (on itch.io it is an iframe, where keys reach it only after a click). */
export function isTopLevel(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

function isStartKey(e: KeyboardEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !NOT_A_START_KEY.has(e.key) && !/^F\d{1,2}$/.test(e.key);
}

/**
 * The start gate (spec §4.6): "Click to start" (on a top-level page also "or press any key"). The
 * gesture focuses the window, creates the AudioContext and unlocks speech through `openGate`.
 */
export function gateScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const anyKey = isTopLevel();
    let opened = false;
    const open = (): void => {
      if (opened) return;
      opened = true;
      ctx.openGate();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (!isStartKey(e)) return;
      e.preventDefault();
      open();
    };
    const el = h(
      'div',
      { class: 'screen gate', onclick: open },
      h('div', { class: 'logo-wrap' }, logoCanvas()),
      h('p', { class: 'start blink' }, 'CLICK TO START'),
      anyKey ? h('p', { class: 'sub' }, 'OR PRESS ANY KEY') : null,
    );
    return {
      el,
      onShow: () => {
        if (anyKey) document.addEventListener('keydown', onKey);
      },
      onHide: () => document.removeEventListener('keydown', onKey),
      onBack: () => {},
    };
  };
}
