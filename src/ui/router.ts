import { FOCUSABLE, focusables, isHeldActionKey, isTextField, moveFocus } from './dom';

/**
 * A shown screen: its root element and lifecycle hooks. `onBack` replaces the default Esc action
 * (going back one screen), e.g. Resume on the pause menu.
 */
export interface ScreenInstance { el: HTMLElement; onShow?(): void; onHide?(): void; onBack?(): void }

/** Builds a screen for the params it is shown with. */
export type ScreenFactory = (params: unknown) => ScreenInstance;

interface Entry { name: string; params: unknown }

/**
 * Shows one DOM screen at a time inside `root` and keeps a history of the screens that led to it.
 * `go` to a screen already in the history returns to it (dropping what came after), so the history
 * stays short; `back` re-creates the previous screen with its params. Menu keys work on every
 * screen (spec §4.6): Arrow keys move the focus (Left/Right stay with a focused text field), Esc goes
 * back; keys another handler has already taken (`defaultPrevented`) are left alone. Auto-repeats of a
 * held Esc, Enter or Space are swallowed (default prevented, nothing done), so a key held from the
 * match or the previous screen can neither resume from the pause menu nor click a newly focused
 * button; held arrows still repeat. `onChange` hears the name of every screen shown.
 */
export class Router {
  private readonly factories = new Map<string, ScreenFactory>();
  private readonly history: Entry[] = [];
  private shown: ScreenInstance | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly onChange: (name: string) => void = () => {},
  ) {
    root.ownerDocument.addEventListener('keydown', this.keydown);
    root.addEventListener('pointerover', this.hover);
  }

  /** Name of the screen shown, '' before the first `go`. */
  get current(): string {
    return this.history.at(-1)?.name ?? '';
  }

  /** Registers (or replaces) the factory of screen `name`. */
  register(name: string, f: ScreenFactory): void {
    this.factories.set(name, f);
  }

  /** Shows screen `name` built with `params`; throws for an unregistered name. */
  go(name: string, params?: unknown): void {
    if (!this.factories.has(name)) throw new Error(`Router: no screen named '${name}'`);
    const at = this.history.findIndex((e) => e.name === name);
    if (at >= 0) this.history.length = at;
    this.history.push({ name, params });
    this.show();
  }

  /** Returns to the previous screen; does nothing on the first one. */
  back(): void {
    if (this.history.length < 2) return;
    this.history.pop();
    this.show();
  }

  /** Stops listening for keys and pointer moves. */
  dispose(): void {
    this.root.ownerDocument.removeEventListener('keydown', this.keydown);
    this.root.removeEventListener('pointerover', this.hover);
  }

  private show(): void {
    const entry = this.history.at(-1);
    const factory = entry && this.factories.get(entry.name);
    if (!entry || !factory) return;
    const prev = this.shown;
    this.shown = null;
    prev?.onHide?.();
    prev?.el.remove();
    const next = factory(entry.params);
    this.shown = next;
    this.root.append(next.el);
    next.onShow?.();
    if (!next.el.contains(this.root.ownerDocument.activeElement)) focusables(next.el)[0]?.focus({ preventScroll: true });
    this.onChange(entry.name);
  }

  private readonly keydown = (e: KeyboardEvent): void => {
    if (isHeldActionKey(e)) {
      e.preventDefault();
      return;
    }
    const screen = this.shown;
    if (screen === null || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    const active = this.root.ownerDocument.activeElement;
    switch (e.key) {
      case 'Escape':
        if (screen.onBack) screen.onBack();
        else this.back();
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        moveFocus(screen.el, e.key === 'ArrowDown' ? 1 : -1);
        break;
      case 'ArrowRight':
      case 'ArrowLeft':
        if (isTextField(active)) return;
        moveFocus(screen.el, e.key === 'ArrowRight' ? 1 : -1);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  /**
   * Mouse hover focuses the keyboard stop under the pointer (a row's inner arrow buttons count as the
   * row), so hover and keyboard share one highlight; text fields keep their caret until clicked.
   */
  private readonly hover = (e: PointerEvent): void => {
    const screen = this.shown;
    if (!screen || !(e.target instanceof Element)) return;
    const stops = focusables(screen.el);
    let el = e.target.closest<HTMLElement>(FOCUSABLE);
    while (el !== null && !stops.includes(el)) el = el.parentElement?.closest<HTMLElement>(FOCUSABLE) ?? null;
    if (el === null || isTextField(el) || el === this.root.ownerDocument.activeElement) return;
    el.focus({ preventScroll: true });
  };
}
