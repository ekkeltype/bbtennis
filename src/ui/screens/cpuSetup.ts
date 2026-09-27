import { CPU_LEVELS, type CpuLevelInfo } from '../../core/cpu';
import { BELT_COLOR, RAMPS } from '../../render/palette';
import { button, panel, pickerRow, spinner, swatch } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { DEUCE_CHOICES, FORMAT_CHOICES, PACE_CHOICES, PACK_CHOICES, SURFACE_CHOICES } from '../options';
import { cpuPlayer } from '../players';
import type { ScreenFactory } from '../router';
import { beaten, type Career, type Settings } from '../settings';

/** "GREEN BELT, 2 STRIPES" / "BLACK BELT, 2ND DAN". */
export function rankText(l: CpuLevelInfo): string {
  const belt = `${l.belt.toUpperCase()} BELT`;
  if (l.dan !== 0) return `${belt}, ${l.dan === 2 ? '2ND' : '3RD'} DAN`;
  if (l.stripes === 0) return belt;
  return `${belt}, ${l.stripes} ${l.stripes === 1 ? 'STRIPE' : 'STRIPES'}`;
}

/**
 * One level of the belt strip: the belt in its colour with a dark tip carrying its stripes (white) or
 * dan bars (gold), ticked once the player has beaten it.
 */
function beltItem(l: CpuLevelInfo, career: Readonly<Career>): HTMLElement {
  const bars = l.dan !== 0 ? l.dan : l.stripes;
  const tip = h('span', { class: `tip${l.dan !== 0 ? ' dan' : ''}` }, ...Array.from({ length: bars }, () => h('span', { class: 'bar' })));
  return h(
    'span',
    { class: 'belt', title: rankText(l) },
    swatch(RAMPS.cloth[BELT_COLOR[l.belt]], 'belt-body'),
    tip,
    beaten(career, l.level) ? h('span', { class: 'earned' }, icon('tick')) : null,
  );
}

/**
 * vs CPU setup (spec §4.6): the 15 levels as a belt strip (beaten levels ticked) with
 * the opponent's name, rank and WPM, then format, pace, court, word pack and deuce rule. Every change
 * is stored at once, so the screen remembers the last choices; Start has the focus.
 */
export function cpuSetupScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const set = (patch: Partial<Settings>): void => ctx.setSettings(patch);
    const record = h('p', { class: 'record' });
    const showRecord = (): void => {
      const r = ctx.career.perLevel[ctx.settings.cpuLevel];
      record.textContent = r && r.played > 0 ? `YOUR RECORD: WON ${r.won} OF ${r.played}` : 'NOT PLAYED YET';
    };
    const levels = pickerRow({
      label: 'OPPONENT',
      count: CPU_LEVELS.length,
      get: () => ctx.settings.cpuLevel,
      set: (cpuLevel) => {
        set({ cpuLevel });
        showRecord();
      },
      item: (i) => beltItem(CPU_LEVELS[i]!, ctx.career),
      describe: (i) => {
        const l = CPU_LEVELS[i]!;
        return `${cpuPlayer(i).name.toUpperCase()} · ${rankText(l)} · ${l.wpm} WPM`;
      },
    });
    levels.classList.add('belts');
    showRecord();
    const start = button('START', () => ctx.startCpuMatch(), 'primary');
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'PLAY VS CPU',
        'setup',
        levels,
        h('p', { class: 'legend' }, icon('tick'), ' BEATEN', h('span', { class: 'gap' }), 'BEAT ANY LEVEL TO EARN ITS BELT'),
        record,
        spinner({ label: 'FORMAT', choices: FORMAT_CHOICES, get: () => ctx.settings.format, set: (format) => set({ format }) }),
        spinner({ label: 'PACE', choices: PACE_CHOICES, get: () => ctx.settings.pace, set: (pace) => set({ pace }) }),
        spinner({ label: 'COURT', choices: SURFACE_CHOICES, get: () => ctx.settings.surface, set: (surface) => set({ surface }) }),
        spinner({ label: 'WORDS', choices: PACK_CHOICES, get: () => ctx.settings.wordPack, set: (wordPack) => set({ wordPack }) }),
        spinner({ label: 'DEUCE', choices: DEUCE_CHOICES, get: () => ctx.settings.deuceRule, set: (deuceRule) => set({ deuceRule }) }),
        h('div', { class: 'actions' }, start, button('BACK', () => ctx.router.back())),
      ),
    );
    return { el, onShow: () => start.focus({ preventScroll: true }) };
  };
}
