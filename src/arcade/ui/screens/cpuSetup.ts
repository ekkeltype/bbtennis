import { BELTS } from '../../../core/belts';
import { button, panel, spinner, type Choice } from '../../../ui/controls';
import { h } from '../../../ui/dom';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, SURFACE_CHOICES } from '../../../ui/options';
import type { ScreenFactory } from '../../../ui/router';
import type { ArcadeConfig } from '../../core/types';
import type { ArcadeContext } from '../context';
import type { CpuSetup } from '../store';

/** The 15 belts, easiest first, by their BELTS labels. */
const BELT_CHOICES: readonly Choice<number>[] = BELTS.map((b) => ({ value: b.level, label: b.label }));
/** The pace presets without the typing game's WPM hints. */
const PACES = PACE_CHOICES.map(({ value, label }) => ({ value, label }));

/** The match options of a CPU setup. */
function configOf(s: Readonly<CpuSetup>): ArcadeConfig {
  return { format: s.format, deuceRule: s.deuceRule, surface: s.surface, pace: s.pace };
}

/**
 * vs CPU setup (spec §6.3): the opponent's belt (15 levels), format, deuce rule, court and pace.
 * Every change is stored at once, so the screen remembers the last setup; Start (focused) begins
 * the match with it.
 */
export function cpuSetupScreen(ctx: Pick<ArcadeContext, 'router' | 'cpuSetup' | 'setCpuSetup' | 'startCpuMatch'>): ScreenFactory {
  return () => {
    const set = (patch: Partial<CpuSetup>): void => ctx.setCpuSetup(patch);
    const start = button('START', () => ctx.startCpuMatch(ctx.cpuSetup.level, configOf(ctx.cpuSetup)), 'primary');
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'PLAY VS CPU',
        'setup arcade-setup',
        spinner({ label: 'OPPONENT', choices: BELT_CHOICES, get: () => ctx.cpuSetup.level, set: (level) => set({ level }) }),
        spinner({ label: 'FORMAT', choices: FORMAT_CHOICES, get: () => ctx.cpuSetup.format, set: (format) => set({ format }) }),
        spinner({ label: 'DEUCE', choices: DEUCE_CHOICES, get: () => ctx.cpuSetup.deuceRule, set: (deuceRule) => set({ deuceRule }) }),
        spinner({ label: 'COURT', choices: SURFACE_CHOICES, get: () => ctx.cpuSetup.surface, set: (surface) => set({ surface }) }),
        spinner({ label: 'PACE', choices: PACES, get: () => ctx.cpuSetup.pace, set: (pace) => set({ pace }) }),
        h('div', { class: 'actions' }, start, button('BACK', () => ctx.router.back())),
      ),
    );
    return { el, onShow: () => start.focus({ preventScroll: true }) };
  };
}
