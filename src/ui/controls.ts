import { h, isHeldActionKey, type Child } from './dom';
import { icon } from './icons';

/** One value of a spinner: what it stores, what it shows and an optional short hint beside it. */
export interface Choice<T> { value: T; label: string; hint?: string }

/** A menu row the arrow keys adjust: a keyboard stop of its own whose inner arrow buttons are for the mouse. */
interface RowOptions { label: string; disabled?: boolean; note?: string }

/** A menu button (Enter/Space/click activate it natively). */
export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onclick: onClick }, label);
}

/** A colour swatch showing a ramp's mid shade with its highlight and shadow as a pixel bevel (null = empty). */
export function swatch(ramp: readonly string[] | null | undefined, cls = ''): HTMLElement {
  const style = ramp ? { '--c': ramp[1] ?? '', '--hi': ramp[0] ?? '', '--lo': ramp[2] ?? '' } : null;
  return h('span', { class: `swatch ${cls}`.trim(), style });
}

/** A framed panel with a title bar. */
export function panel(title: string, cls: string, ...children: Child[]): HTMLElement {
  return h('section', { class: `panel ${cls}`.trim() }, h('h2', { class: 'panel-title' }, title), ...children);
}

/**
 * The row frame: label, the control, an optional note; keys go to `onKey`, which returns true when it
 * used the key. A held Enter/Space acts once: its auto-repeats are left to the Router, which swallows them.
 */
function row(o: RowOptions, cls: string, role: string, control: HTMLElement, onKey: (key: string) => boolean): HTMLElement {
  const el = h(
    'div',
    { class: `row ${cls}${o.disabled === true ? ' disabled' : ''}`, tabindex: o.disabled === true ? -1 : 0, role, 'aria-label': o.label },
    h('span', { class: 'label' }, o.label),
    control,
    o.note === undefined ? null : h('span', { class: 'note' }, o.note),
  );
  el.addEventListener('keydown', (e) => {
    if (o.disabled === true || e.ctrlKey || e.altKey || e.metaKey || isHeldActionKey(e)) return;
    if (onKey(e.key)) e.preventDefault();
  });
  return el;
}

function arrowButton(dir: 'left' | 'right', disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = h('button', { type: 'button', class: dir === 'left' ? 'arrow prev' : 'arrow next', tabindex: -1, disabled, 'aria-hidden': 'true' }, icon(dir));
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', onClick);
  return b;
}

/**
 * A "◀ VALUE ▶" row: ArrowRight, Enter and Space step to the next choice, ArrowLeft to the previous
 * one, both wrapping (a held arrow keeps stepping, a held Enter/Space steps once); the arrow buttons
 * do the same with the mouse. `get` is read after every change.
 */
export function spinner<T>(o: RowOptions & { choices: readonly Choice<T>[]; get(): T; set(v: T): void }): HTMLElement {
  const value = h('span', { class: 'value' });
  const hint = h('span', { class: 'hint' });
  const index = (): number => Math.max(0, o.choices.findIndex((c) => c.value === o.get()));
  const show = (): void => {
    const c = o.choices[index()];
    value.textContent = c?.label ?? '';
    hint.textContent = c?.hint ?? '';
    el.setAttribute('aria-valuetext', c?.label ?? '');
  };
  const step = (d: 1 | -1): void => {
    if (o.disabled === true || o.choices.length === 0) return;
    const c = o.choices[(index() + d + o.choices.length) % o.choices.length];
    if (c !== undefined) o.set(c.value);
    show();
  };
  const disabled = o.disabled === true;
  const control = h('span', { class: 'ctl' }, arrowButton('left', disabled, () => step(-1)), value, arrowButton('right', disabled, () => step(1)), hint);
  const el = row(o, 'spin', 'spinbutton', control, (key) => {
    if (key === 'ArrowLeft') step(-1);
    else if (key === 'ArrowRight' || key === 'Enter' || key === ' ') step(1);
    else return false;
    return true;
  });
  show();
  return el;
}

/** A volume-style row of `steps` segments for a value 0..1: arrows move one step (clamped), a click sets that segment's step. */
export function slider(o: RowOptions & { steps: number; get(): number; set(v: number): void }): HTMLElement {
  const segs = Array.from({ length: o.steps }, (_, i) => {
    const s = h('span', { class: 'seg' });
    s.addEventListener('click', () => put(i + 1));
    return s;
  });
  const value = h('span', { class: 'value' });
  const current = (): number => Math.round(Math.min(1, Math.max(0, o.get())) * o.steps);
  const show = (): void => {
    const n = current();
    segs.forEach((s, i) => s.classList.toggle('on', i < n));
    value.textContent = String(n);
    el.setAttribute('aria-valuenow', String(n));
  };
  const put = (n: number): void => {
    if (o.disabled === true) return;
    o.set(Math.min(o.steps, Math.max(0, n)) / o.steps);
    show();
  };
  const control = h('span', { class: 'ctl' }, h('span', { class: 'segs' }, ...segs), value);
  const el = row(o, 'slider', 'slider', control, (key) => {
    if (key === 'ArrowLeft') put(current() - 1);
    else if (key === 'ArrowRight') put(current() + 1);
    else return false;
    return true;
  });
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', String(o.steps));
  show();
  return el;
}

/**
 * A row of `count` clickable items (swatches, belts) with the selected one marked and named by
 * `describe`: ArrowLeft/ArrowRight move the selection, wrapping; a click selects an item.
 */
export function pickerRow(
  o: RowOptions & { count: number; get(): number; set(i: number): void; item(i: number): HTMLElement; describe(i: number): string },
): HTMLElement {
  const items = Array.from({ length: o.count }, (_, i) => {
    const it = h('span', { class: 'item' }, o.item(i));
    it.addEventListener('click', () => put(i));
    return it;
  });
  const value = h('span', { class: 'value' });
  const show = (): void => {
    const sel = o.get();
    items.forEach((it, i) => it.classList.toggle('on', i === sel));
    value.textContent = o.describe(sel);
    el.setAttribute('aria-valuetext', value.textContent);
  };
  const put = (i: number): void => {
    if (o.disabled === true) return;
    o.set(((i % o.count) + o.count) % o.count);
    show();
  };
  const control = h('span', { class: 'ctl' }, h('span', { class: 'items' }, ...items), value);
  const el = row(o, 'picker', 'listbox', control, (key) => {
    if (key === 'ArrowLeft') put(o.get() - 1);
    else if (key === 'ArrowRight') put(o.get() + 1);
    else return false;
    return true;
  });
  show();
  return el;
}
