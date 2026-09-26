import { button, panel, slider, spinner, type Choice } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import type { ScreenFactory } from '../router';
import type { Settings } from '../settings';
import { DEUCE_CHOICES, PACE_CHOICES, PACK_CHOICES } from './cpuSetup';

const ON_OFF: readonly Choice<boolean>[] = [
  { value: true, label: 'ON' },
  { value: false, label: 'OFF' },
];
const DISPLAY_CHOICES: readonly Choice<Settings['display']>[] = [
  { value: 'pixel', label: 'PIXEL-PERFECT' },
  { value: 'fit', label: 'FIT' },
];
const VOLUME_STEPS = 10;

type Toggle = 'umpireVoice' | 'showWpm' | 'largeWords' | 'reduceEffects';
type Volume = keyof Settings['volumes'];

/**
 * Options (spec §4.6): default pace, word pack and deuce rule; master/music/sfx volumes; umpire voice
 * (shown OFF, disabled, with a note when no local English voice exists; the stored choice is kept for
 * a device that has one); show WPM; large words; reduce effects; display mode. Changes apply and are
 * stored at once.
 */
export function optionsScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const toggle = (label: string, key: Toggle): HTMLElement =>
      spinner({
        label,
        choices: ON_OFF,
        get: () => ctx.settings[key],
        set: (v) => {
          const patch: Partial<Settings> = {};
          patch[key] = v;
          ctx.setSettings(patch);
        },
      });
    const volume = (label: string, key: Volume): HTMLElement =>
      slider({
        label,
        steps: VOLUME_STEPS,
        get: () => ctx.settings.volumes[key],
        set: (v) => ctx.setSettings({ volumes: { ...ctx.settings.volumes, [key]: v } }),
      });
    const voice = ctx.voiceAvailable();
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'OPTIONS',
        'options',
        h('h3', { class: 'group' }, 'MATCH DEFAULTS'),
        spinner({ label: 'PACE', choices: PACE_CHOICES, get: () => ctx.settings.pace, set: (pace) => ctx.setSettings({ pace }) }),
        spinner({ label: 'WORDS', choices: PACK_CHOICES, get: () => ctx.settings.wordPack, set: (wordPack) => ctx.setSettings({ wordPack }) }),
        spinner({ label: 'DEUCE', choices: DEUCE_CHOICES, get: () => ctx.settings.deuceRule, set: (deuceRule) => ctx.setSettings({ deuceRule }) }),
        h('h3', { class: 'group' }, 'SOUND'),
        volume('MASTER', 'master'),
        volume('MUSIC', 'music'),
        volume('EFFECTS', 'sfx'),
        voice
          ? toggle('UMPIRE VOICE', 'umpireVoice')
          : spinner({ label: 'UMPIRE VOICE', choices: ON_OFF, get: () => false, set: () => {}, disabled: true, note: 'NO VOICE' }),
        h('h3', { class: 'group' }, 'DISPLAY'),
        toggle('SHOW WPM', 'showWpm'),
        toggle('LARGE WORDS', 'largeWords'),
        toggle('REDUCE EFFECTS', 'reduceEffects'),
        spinner({ label: 'SCALING', choices: DISPLAY_CHOICES, get: () => ctx.settings.display, set: (display) => ctx.setSettings({ display }) }),
        h('div', { class: 'actions' }, button('DONE', () => ctx.router.back(), 'primary')),
      ),
    );
    return { el };
  };
}
