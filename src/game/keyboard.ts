import { classifyKey, type KeyClass } from '../core/typing';

/** The keys that open the in-match menu instead of reaching the game (spec §4.5). */
export type MenuKey = 'Escape' | 'Tab';

/**
 * Function keys by `event.key` (F1–F12, and F13+ where a keyboard has them): left to the browser
 * for reload, fullscreen and dev tools (spec §4.5).
 */
const FUNCTION_KEY = /^F\d{1,2}$/;

/**
 * Match keyboard input (spec §4.5): keydown on the window in the capture phase, classified by
 * `classifyKey`; letters and Space go to `onKey` with the event's timeStamp, Esc and Tab to `onMenu`.
 * While enabled, every keydown other than a function key or a Ctrl/Meta combination (and the Alt
 * keyup, which opens the Windows menu) has its default prevented; function keys and Ctrl/Meta
 * combinations are never prevented or forwarded. Nothing at all is done while disabled, blocked
 * (a menu is open) or while a text field (input, textarea, select, contenteditable) has focus.
 */
export class KeyboardCapture {
  private readonly target: Window;
  private readonly onKey: (k: KeyClass, timeStamp: number) => void;
  private readonly onMenu: ((key: MenuKey) => void) | null;
  private enabled = false;
  private blocked = false;
  private disposed = false;

  constructor(target: Window, onKey: (k: KeyClass, timeStamp: number) => void, onMenu: ((key: MenuKey) => void) | null = null) {
    this.target = target;
    this.onKey = onKey;
    this.onMenu = onMenu;
    target.addEventListener('keydown', this.keydown, true);
    target.addEventListener('keyup', this.keyup, true);
  }

  /** Starts handling keys (match start or resume). */
  enable(): void {
    if (!this.disposed) this.enabled = true;
  }

  /** Stops handling keys; the page gets every key as usual. */
  disable(): void {
    this.enabled = false;
  }

  /** Blocks (true) or unblocks the capture while a menu or other DOM screen is open. */
  setBlocked(b: boolean): void {
    this.blocked = b;
  }

  /** Removes the listeners for good. */
  dispose(): void {
    this.disposed = true;
    this.enabled = false;
    this.target.removeEventListener('keydown', this.keydown, true);
    this.target.removeEventListener('keyup', this.keyup, true);
  }

  private readonly keydown = (e: KeyboardEvent): void => {
    if (!this.active() || e.ctrlKey || e.metaKey || FUNCTION_KEY.test(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (!e.repeat) this.onMenu?.(e.key);
      return;
    }
    const k = classifyKey(e);
    if (k.kind !== 'ignore') this.onKey(k, e.timeStamp);
  };

  private readonly keyup = (e: KeyboardEvent): void => {
    if (this.active() && e.key === 'Alt' && !e.ctrlKey && !e.metaKey) e.preventDefault();
  };

  private active(): boolean {
    return this.enabled && !this.blocked && !textFieldFocused(this.target.document);
  }
}

/** True while keys belong to a focused text field: an input, textarea, select or contenteditable element. */
function textFieldFocused(doc: Document): boolean {
  const el = doc.activeElement;
  if (el === null) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true || el.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}
