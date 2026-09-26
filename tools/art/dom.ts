/** Page structure and canvas helpers shared by the art page sections. */

function el(tag: string, className: string | null, text: string | null, parent: HTMLElement): HTMLElement {
  const node = document.createElement(tag);
  if (className !== null) node.className = className;
  if (text !== null) node.textContent = text;
  parent.append(node);
  return node;
}

/** A new `<section data-shot="name">` with a heading, appended to `parent`; `name` names its PNG. */
export function addSection(parent: HTMLElement, name: string, title: string): HTMLElement {
  const section = el('section', null, null, parent);
  section.dataset['shot'] = name;
  el('h2', null, title, section);
  return section;
}

/** A sub-heading inside a section. */
export function addHeading(parent: HTMLElement, text: string): void {
  el('h3', null, text, parent);
}

/** A row of figures with a text label on its left, appended to `parent`. */
export function addRow(parent: HTMLElement, label: string): HTMLElement {
  const row = el('div', 'row', null, parent);
  el('div', 'label', label, row);
  return row;
}

/** A wrapping grid of figures, appended to `parent`. */
export function addGrid(parent: HTMLElement): HTMLElement {
  return el('div', 'grid', null, parent);
}

/** `canvas` with an optional small caption above it, appended to `parent`. */
export function addFigure(parent: HTMLElement, canvas: HTMLCanvasElement, caption?: string): void {
  const figure = el('figure', null, null, parent);
  if (caption !== undefined) el('figcaption', null, caption, figure);
  figure.append(canvas);
}

/** A visible error note, for a section that failed to draw. */
export function addError(parent: HTMLElement, text: string): void {
  el('pre', 'error', text, parent);
}

/** A `w`×`h` canvas and its 2D context, image smoothing off. */
export function newCanvas(w: number, h: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  g.imageSmoothingEnabled = false;
  return { canvas, g };
}

/** A copy of the `w`×`h` area of `src` whose top-left corner is (`x`, `y`). */
export function cropped(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const { canvas, g } = newCanvas(w, h);
  g.drawImage(src, x, y, w, h, 0, 0, w, h);
  return canvas;
}

/** A copy of `src` enlarged by the whole number `k`, nearest-neighbour. */
export function scaled(src: HTMLCanvasElement, k: number): HTMLCanvasElement {
  const { canvas, g } = newCanvas(src.width * k, src.height * k);
  g.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}
