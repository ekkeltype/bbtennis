import { CPU_LEVELS, isMilestone, type CpuLevelInfo } from '../../core/cpu';
import type { DeuceRule, FormatId, PaceId, Surface, WordPackId } from '../../core/types';
import { BELT_COLOR, RAMPS } from '../../render/palette';
import { button, panel, pickerRow, spinner, swatch, type Choice } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { cpuPlayer } from '../players';
import type { ScreenFactory } from '../router';
import type { Settings } from '../settings';

/** Match formats with what it takes to win (spec §3.6). */
export const FORMAT_CHOICES: readonly Choice<FormatId>[] = [
  { value: 'tiebreak', label: 'TIEBREAK', hint: 'FIRST TO 7' },
  { value: 'short', label: 'SHORT SET', hint: 'FIRST TO 4 GAMES' },
  { value: 'full', label: 'FULL SET', hint: 'FIRST TO 6 GAMES' },
  { value: 'bo3', label: 'BEST OF 3', hint: 'SHORT SETS' },
];
/** Pace presets with the typing speed each suits (spec §3.9). */
export const PACE_CHOICES: readonly Choice<PaceId>[] = [
  { value: 'relaxed', label: 'RELAXED', hint: '30 WPM' },
  { value: 'normal', label: 'NORMAL', hint: '50 WPM' },
  { value: 'fast', label: 'FAST', hint: '70 WPM' },
  { value: 'lightning', label: 'LIGHTNING', hint: '90 WPM' },
];
/** Court surfaces (cosmetic). */
export const SURFACE_CHOICES: readonly Choice<Surface>[] = [
  { value: 'hard', label: 'HARD' },
  { value: 'clay', label: 'CLAY' },
  { value: 'grass', label: 'GRASS' },
  { value: 'dojo', label: 'DOJO' },
];
/** Word packs (spec §3.10), Everyday first. */
export const PACK_CHOICES: readonly Choice<WordPackId>[] = [
  { value: 'everyday', label: 'EVERYDAY' },
  { value: 'sports', label: 'SPORTS' },
  { value: 'dojo', label: 'DOJO' },
  { value: 'mixed', label: 'MIXED' },
];
/** Deuce handling (spec §3.6). */
export const DEUCE_CHOICES: readonly Choice<DeuceRule>[] = [
  { value: 'advantage', label: 'ADVANTAGE' },
  { value: 'golden', label: 'GOLDEN POINT' },
];

/** "GREEN BELT, 2 STRIPES" / "BLACK BELT, 2ND DAN". */
export function rankText(l: CpuLevelInfo): string {
  const belt = `${l.belt.toUpperCase()} BELT`;
  if (l.dan !== 0) return `${belt}, ${l.dan === 2 ? '2ND' : '3RD'} DAN`;
  if (l.stripes === 0) return belt;
  return `${belt}, ${l.stripes} ${l.stripes === 1 ? 'STRIPE' : 'STRIPES'}`;
}

/** One level of the belt strip: the belt in its colour with a dark tip carrying its stripes (white) or dan bars (gold). */
function beltItem(l: CpuLevelInfo, earned: readonly string[]): HTMLElement {
  const bars = l.dan !== 0 ? l.dan : l.stripes;
  const tip = h('span', { class: `tip${l.dan !== 0 ? ' dan' : ''}` }, ...Array.from({ length: bars }, () => h('span', { class: 'bar' })));
  const milestone = isMilestone(l.level);
  return h(
    'span',
    { class: `belt${milestone ? ' milestone' : ''}`, title: rankText(l) },
    milestone ? h('span', { class: 'mark' }, icon('diamond')) : null,
    swatch(RAMPS.cloth[BELT_COLOR[l.belt]], 'belt-body'),
    tip,
    milestone && earned.includes(l.belt) ? h('span', { class: 'earned' }, icon('tick')) : null,
  );
}

/**
 * vs CPU setup (spec §4.6): the 15 levels as a belt strip (milestones marked, earned belts ticked) with
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
      item: (i) => beltItem(CPU_LEVELS[i]!, ctx.career.earned),
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
        h('p', { class: 'legend' }, icon('diamond'), ' BEAT TO EARN THE BELT', h('span', { class: 'gap' }), icon('tick'), ' EARNED'),
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
