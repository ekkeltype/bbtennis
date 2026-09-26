import { button } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { logoCanvas } from '../logo';
import type { ScreenFactory } from '../router';

/** The fullscreen toggle shown on the title, main menu and pause screens (a button, never a letter hotkey). */
export function fullscreenButton(ctx: UiContext, cls = ''): HTMLButtonElement {
  const b = button('FULLSCREEN', () => ctx.toggleFullscreen(), `fs ${cls}`.trim());
  b.prepend(icon('fullscreen'));
  return b;
}

/** Title (spec §4.6): the logo over the attract demo, "PRESS ENTER" to reach the main menu. */
export function titleScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const next = (): void => ctx.router.go('mainMenu');
    const press = button('PRESS ENTER', next, 'press');
    const fs = fullscreenButton(ctx, 'corner');
    fs.addEventListener('click', (e) => e.stopPropagation());
    const el = h(
      'div',
      { class: 'screen title' },
      h('div', { class: 'title-band' }, logoCanvas()),
      press,
      h('p', { class: 'demo-tag' }, 'DEMO'),
      fs,
    );
    el.addEventListener('click', (e) => {
      if (e.target === el) next();
    });
    return { el, onShow: () => press.focus({ preventScroll: true }), onBack: () => {} };
  };
}
