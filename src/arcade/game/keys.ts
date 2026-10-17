import { isTextField } from '../../ui/dom';
import { NO_INPUT, type Controller, type PlayerInput } from '../core/types';

type Shot = 'topspin' | 'slice' | 'lob';

/** Function keys by `event.key`: left to the browser (reload, fullscreen, dev tools). */
const FUNCTION_KEY = /^F\d{1,2}$/;

/** Axis keys by `KeyboardEvent.code`: the axis and its sign. */
const AXIS: Readonly<Record<string, readonly ['mx' | 'my', 1 | -1]>> = {
  KeyW: ['my', 1], ArrowUp: ['my', 1],
  KeyS: ['my', -1], ArrowDown: ['my', -1],
  KeyA: ['mx', -1], ArrowLeft: ['mx', -1],
  KeyD: ['mx', 1], ArrowRight: ['mx', 1],
};

const SHOT: Readonly<Record<string, Shot>> = {
  KeyJ: 'topspin', KeyZ: 'topspin',
  KeyK: 'slice', KeyX: 'slice',
  KeyL: 'lob', KeyC: 'lob',
};

const MENU = new Set(['Escape', 'Tab']);

/**
 * Physical-key input for the near player (spec §4.1). Window keydown/keyup in the capture phase.
 * While enabled, game keys have their default prevented; function keys and Ctrl/Meta combinations
 * are never touched, and nothing happens while a text field has focus. Held keys are cleared on
 * blur and when the page is hidden (Review Focus 1). A shot key pressed since the last `input()`
 * is latched, so a tap shorter than one tick still counts (Review Focus 2).
 */
export class HeldKeys {
  private readonly target: Window;
  private readonly onMenu: () => void;
  private readonly held = new Set<string>();
  private readonly latched = new Set<Shot>();
  private enabled = false;
  private disposed = false;

  constructor(target: Window, onMenu: () => void) {
    this.target = target;
    this.onMenu = onMenu;
    target.addEventListener('keydown', this.keydown, true);
    target.addEventListener('keyup', this.keyup, true);
    target.addEventListener('blur', this.clear);
    target.document.addEventListener('visibilitychange', this.clear);
  }

  enable(): void {
    if (!this.disposed) this.enabled = true;
  }

  /** Stops handling keys and clears. */
  disable(): void {
    this.enabled = false;
    this.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.clear();
    this.target.removeEventListener('keydown', this.keydown, true);
    this.target.removeEventListener('keyup', this.keyup, true);
    this.target.removeEventListener('blur', this.clear);
    this.target.document.removeEventListener('visibilitychange', this.clear);
  }

  /** Clears held and latched keys (blur, pause). */
  readonly clear = (): void => {
    this.held.clear();
    this.latched.clear();
  };

  /**
   * The near player's input for the next tick: held keys, plus shot keys pressed since the last
   * call even if already released. Each latched press is reported once. Several shot keys may be
   * true together; the match picks by priority.
   */
  input(): PlayerInput {
    let mx = 0;
    let my = 0;
    const shots = { topspin: false, slice: false, lob: false };
    for (const code of this.held) {
      const axis = AXIS[code];
      if (axis !== undefined) {
        if (axis[0] === 'mx') mx += axis[1];
        else my += axis[1];
      }
      const shot = SHOT[code];
      if (shot !== undefined) shots[shot] = true;
    }
    for (const shot of this.latched) shots[shot] = true;
    this.latched.clear();
    return { ...NO_INPUT, mx: sign(mx), my: sign(my), ...shots };
  }

  private readonly keydown = (e: KeyboardEvent): void => {
    if (!this.active() || e.ctrlKey || e.metaKey || FUNCTION_KEY.test(e.key)) return;
    if (MENU.has(e.code)) {
      e.preventDefault();
      if (!e.repeat) this.onMenu();
      return;
    }
    const shot = SHOT[e.code];
    if (AXIS[e.code] === undefined && shot === undefined) return;
    e.preventDefault();
    if (shot !== undefined && !e.repeat) this.latched.add(shot);
    this.held.add(e.code);
  };

  private readonly keyup = (e: KeyboardEvent): void => {
    if (!this.active()) return;
    if (e.key === 'Alt' && !e.ctrlKey && !e.metaKey) e.preventDefault();
    this.held.delete(e.code);
  };

  private active(): boolean {
    return this.enabled && !isTextField(this.target.document.activeElement);
  }
}

/** Clamps an axis sum (two keys of one direction cannot both be held, but be safe) to -1, 0 or 1. */
function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** A Controller reading a HeldKeys. */
export class KeyboardController implements Controller {
  private readonly keys: HeldKeys;

  constructor(keys: HeldKeys) {
    this.keys = keys;
  }

  input(): PlayerInput {
    return this.keys.input();
  }
}
