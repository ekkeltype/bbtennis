import { button, fullscreenButton } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import { logoCanvas } from '../../../ui/logo';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeContext } from '../context';

/** The logo with the "ARCADE" line under it (title and main menu). */
export function arcadeLogo(small = false): HTMLElement {
  return h('div', { class: `logo-wrap arcade-logo${small ? ' small' : ''}` }, logoCanvas(), h('p', { class: 'arcade-word' }, 'ARCADE'));
}

/** Title (spec §6.3): "BLACK BELT TENNIS ARCADE" over the attract demo; PRESS ENTER (or a click) opens the main menu. */
export function titleScreen(ctx: Pick<ArcadeContext, 'router' | 'toggleFullscreen'>): ScreenFactory {
  return () => {
    const next = (): void => ctx.router.go('mainMenu');
    const press = button('PRESS ENTER', next, 'press');
    const fs = fullscreenButton(ctx, 'corner');
    fs.addEventListener('click', (e) => e.stopPropagation());
    const el = h('div', { class: 'screen title' }, h('div', { class: 'title-band' }, arcadeLogo()), press, h('p', { class: 'demo-tag' }, 'DEMO'), fs);
    el.addEventListener('click', (e) => {
      if (e.target === el) next();
    });
    return { el, onShow: () => press.focus({ preventScroll: true }), onBack: () => {} };
  };
}
