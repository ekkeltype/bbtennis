import { cssUnit, type ScaleInfo } from '../render/screen';
import { h, toast } from './dom';

/** The notice shown once when the window is too small for pixel-perfect scaling (spec §4.1). */
export const NOTICE_FIT = 'Use fullscreen for a sharper view';

/**
 * The DOM overlay `#ui` (spec §4.6): the screens' root and, over them, a strip of notices. `place`
 * keeps it exactly over the canvas with `--u` = one game pixel (R24).
 */
export class Overlay {
  /** Where the Router shows the screens. */
  readonly screens: HTMLElement = h('div', { class: 'screens' });
  private readonly notices: HTMLElement = h('div', { class: 'notices' });
  private fitNoticeShown = false;

  constructor(private readonly ui: HTMLElement) {
    ui.append(this.screens, this.notices);
  }

  /** Moves and sizes the overlay onto the canvas of `info`; the first fit-mode scale forced by the window (k < 2) shows NOTICE_FIT. */
  place(info: ScaleInfo): void {
    const s = this.ui.style;
    s.left = `${info.offsetX}px`;
    s.top = `${info.offsetY}px`;
    s.width = `${info.cssW}px`;
    s.height = `${info.cssH}px`;
    s.setProperty('--u', `${cssUnit(info)}px`);
    if (info.k < 2 && !this.fitNoticeShown) {
      this.fitNoticeShown = true;
      this.notice(NOTICE_FIT);
    }
  }

  /** Shows `text` as a pixel toast at the bottom for a few seconds. */
  notice(text: string): void {
    toast(this.notices, text);
  }
}
