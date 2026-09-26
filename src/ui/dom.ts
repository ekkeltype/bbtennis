/** A child h() accepts: nodes and text; null, undefined and false are skipped. */
export type Child = Node | string | null | undefined | false;

/** Attributes h() accepts: `on*` functions become listeners, `style` an object of properties, booleans toggle the attribute. */
export type Attrs = Record<string, unknown>;

/**
 * Creates `<tag>` with `attrs` and `children`. `class` sets the class list; `onxxx` functions are
 * added as `xxx` listeners; `style` is an object whose keys may be CSS custom properties; `true` sets
 * an empty attribute and `false`/null/undefined leave it out; anything else is set as a string.
 * Text children are inserted as text, never parsed as HTML.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2), value as EventListener);
    } else if (name === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value as Record<string, string>)) el.style.setProperty(kebab(prop), v);
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

function kebab(prop: string): string {
  return prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Selector of the elements that may be keyboard stops (`focusables` keeps the enabled, tab-order ones). */
export const FOCUSABLE = 'button, input, [tabindex]';

/** The keyboard stops in `root` (itself included) in document order: enabled, in the tab order (tabindex ≥ 0) and not hidden. */
export function focusables(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (root.matches(FOCUSABLE)) all.unshift(root);
  return all.filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.closest('[hidden]') === null,
  );
}

/** Moves the focus `delta` stops through `root`'s focusables, wrapping; from outside them it starts at the first (or last). */
export function moveFocus(root: HTMLElement, delta: 1 | -1): void {
  const list = focusables(root);
  if (list.length === 0) return;
  const i = list.indexOf(document.activeElement as HTMLElement);
  const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
  list[next]?.focus({ preventScroll: true });
}

/** Focuses `el` (or `root`'s first focusable when `el` is null) without scrolling. */
export function focusFirst(root: HTMLElement, el: HTMLElement | null = null): void {
  (el ?? focusables(root)[0])?.focus({ preventScroll: true });
}

/** Blurs whatever element has the focus, so a later Space cannot re-activate a button (spec §4.5). */
export function blurActive(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement) el.blur();
}

/** True for an element that uses Left/Right itself: a text field (caret) or a native range input. */
export function isTextField(el: Element | null): boolean {
  if (el === null) return false;
  if (el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable) return true;
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'button' && (el as HTMLInputElement).type !== 'checkbox';
}

/**
 * True for an auto-repeated Esc, Enter or Space. Menus act on the first press of these keys only, so
 * a held key cannot click on through the screens that follow (Review Focus 1); held arrows repeat.
 */
export function isHeldActionKey(e: KeyboardEvent): boolean {
  return e.repeat && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ');
}

/** Shows `text` in a pixel toast at the bottom of `host` for `ms`, then removes it. */
export function toast(host: HTMLElement, text: string, ms = 4000): void {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  host.append(el);
  setTimeout(() => el.remove(), ms);
}
