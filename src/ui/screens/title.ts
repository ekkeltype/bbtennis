import { button, fullscreenButton } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { logoCanvas } from '../logo';
import type { ScreenFactory } from '../router';

/**
 * Title (spec §4.6): the logo over the attract demo, "PRESS ENTER" to reach the main menu. `logo`
 * builds the logo for each showing (default: the game's logo canvas).
 */
export function titleScreen(ctx: Pick<UiContext, 'router' | 'toggleFullscreen'>, logo: () => HTMLElement = logoCanvas): ScreenFactory {
  return () => {
    const next = (): void => ctx.router.go('mainMenu');
    const press = button('PRESS ENTER', next, 'press');
    const fs = fullscreenButton(ctx, 'corner');
    fs.addEventListener('click', (e) => e.stopPropagation());
    const el = h(
      'div',
      { class: 'screen title' },
      h('div', { class: 'title-band' }, logo()),
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
