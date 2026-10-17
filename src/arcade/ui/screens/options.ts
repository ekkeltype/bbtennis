import { button, fullscreenButton, panel, slider, spinner, type Choice } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeContext } from '../context';
import type { ArcadeSettings } from '../store';

const ON_OFF: readonly Choice<boolean>[] = [
  { value: true, label: 'ON' },
  { value: false, label: 'OFF' },
];
const VOLUME_STEPS = 10;

type Volume = keyof ArcadeSettings['volumes'];

/** Options (spec §6.3): master / music / effects volume, Reduce effects and Fullscreen. Changes apply and are stored at once. */
export function optionsScreen(ctx: Pick<ArcadeContext, 'router' | 'settings' | 'setSettings' | 'toggleFullscreen'>): ScreenFactory {
  return () => {
    const volume = (label: string, key: Volume): HTMLElement =>
      slider({
        label,
        steps: VOLUME_STEPS,
        get: () => ctx.settings.volumes[key],
        set: (v) => ctx.setSettings({ volumes: { ...ctx.settings.volumes, [key]: v } }),
      });
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'OPTIONS',
        'options',
        h('h3', { class: 'group' }, 'SOUND'),
        volume('MASTER', 'master'),
        volume('MUSIC', 'music'),
        volume('EFFECTS', 'sfx'),
        h('h3', { class: 'group' }, 'DISPLAY'),
        spinner({
          label: 'REDUCE EFFECTS',
          choices: ON_OFF,
          get: () => ctx.settings.reduceEffects,
          set: (reduceEffects) => ctx.setSettings({ reduceEffects }),
        }),
        h('div', { class: 'actions' }, button('DONE', () => ctx.router.back(), 'primary'), fullscreenButton(ctx)),
      ),
    );
    return { el };
  };
}
