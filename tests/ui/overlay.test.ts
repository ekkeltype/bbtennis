// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScaleInfo } from '../../src/render/screen';
import { NOTICE_FIT, Overlay } from '../../src/ui/overlay';

let ui: HTMLElement;

const info = (over: Partial<ScaleInfo> = {}): ScaleInfo => ({ k: 2, dpr: 1, cssW: 960, cssH: 540, mode: 'pixel', offsetX: 32, offsetY: 18, ...over });
const toasts = (): string[] => [...ui.querySelectorAll('.notices .toast')].map((t) => t.textContent ?? '');

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="ui"></div>';
  ui = document.getElementById('ui')!;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Overlay (the #ui layer over the canvas)', () => {
  it('holds the screens and, after them, the notices', () => {
    const o = new Overlay(ui);
    expect(o.screens.parentElement).toBe(ui);
    expect(o.screens.className).toBe('screens');
    expect(ui.lastElementChild?.className).toBe('notices');
  });

  it('sits exactly over the canvas with --u = one game pixel (spec §4.6, R24)', () => {
    const o = new Overlay(ui);
    o.place(info({ cssW: 1200, cssH: 675, offsetX: 40, offsetY: 12 }));
    expect(ui.style.left).toBe('40px');
    expect(ui.style.top).toBe('12px');
    expect(ui.style.width).toBe('1200px');
    expect(ui.style.height).toBe('675px');
    expect(ui.style.getPropertyValue('--u')).toBe('2.5px');
  });

  it('suggests fullscreen once when the window forces fit mode (k < 2, spec §4.1)', () => {
    const o = new Overlay(ui);
    o.place(info());
    expect(toasts()).toEqual([]);
    o.place(info({ k: 1, mode: 'fit' }));
    o.place(info({ k: 1, mode: 'fit' }));
    expect(toasts()).toEqual([NOTICE_FIT]);
    expect(NOTICE_FIT).toBe('Use fullscreen for a sharper view');
  });

  it('shows a notice for a while', () => {
    const o = new Overlay(ui);
    o.notice('Hello');
    expect(toasts()).toEqual(['Hello']);
    vi.advanceTimersByTime(4000);
    expect(toasts()).toEqual([]);
  });
});
