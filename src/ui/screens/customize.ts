import { sanitizeName, NAME_MAX } from '../../core/text';
import type { Look } from '../../core/types';
import { RAMPS } from '../../render/palette';
import { HAIR_STYLES } from '../../render/sprites/parts';
import { button, panel, pickerRow, swatch } from '../controls';
import type { UiContext } from '../context';
import { h } from '../dom';
import { icon } from '../icons';
import { LookPreview, paintHead } from '../preview';
import type { ScreenFactory } from '../router';
import { liveName, type Profile } from '../settings';

const CLOTH_NAMES = ['WHITE', 'YELLOW', 'GREEN', 'BROWN', 'BLACK', 'RED', 'BLUE', 'NAVY', 'ORANGE', 'PURPLE', 'PINK', 'TEAL'];
const HAIR_NAMES = ['BLACK', 'DARK BROWN', 'BROWN', 'AUBURN', 'GINGER', 'BLONDE', 'PLATINUM', 'SILVER'];
const RACKET_NAMES = ['GRAPHITE', 'RED', 'BLUE', 'WHITE', 'LIME', 'ORANGE'];

type RampField = 'skin' | 'hair' | 'shirt' | 'shorts' | 'racket';

/**
 * Customize (spec §4.6): name (≤ 12 font glyphs, sanitised as it is typed), skin, hair style and
 * colour, shirt, shorts, headband (or none) and racket, with a live animated preview in the near and
 * far views. Every change is stored at once; choosing a headband stops the earned-belt default.
 */
export function customizeScreen(ctx: UiContext): ScreenFactory {
  return () => {
    const draft: Profile = { name: ctx.profile.name, look: { ...ctx.profile.look } };
    const preview = new LookPreview(draft.look);
    const heads = HAIR_STYLES.map(() => h('canvas', { class: 'head' }));
    const paintHeads = (): void => heads.forEach((c, i) => paintHead(c, draft.look, i));
    let headbandChosen = false;
    const commit = (): void => {
      ctx.setProfile({ name: draft.name, look: { ...draft.look } }, headbandChosen);
      preview.setLook(draft.look);
      paintHeads();
    };
    const setLook = (patch: Partial<Look>): void => {
      Object.assign(draft.look, patch);
      commit();
    };

    const name = h('input', {
      class: 'name-field',
      type: 'text',
      maxlength: NAME_MAX,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Name',
      value: draft.name,
    });
    name.addEventListener('input', () => {
      const v = liveName(name.value);
      if (v !== name.value) name.value = v;
    });
    const saveName = (): void => {
      draft.name = sanitizeName(name.value);
      name.value = draft.name;
      commit();
    };
    name.addEventListener('change', saveName);
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveName();
      }
    });

    const rampRow = (label: string, field: RampField, table: readonly (readonly string[])[], names: readonly string[]): HTMLElement =>
      pickerRow({
        label,
        count: table.length,
        get: () => draft.look[field],
        set: (i) => {
          draft.look[field] = i;
          commit();
        },
        item: (i) => swatch(table[i]),
        describe: (i) => names[i] ?? '',
      });

    const rows = [
      h('label', { class: 'row name-row' }, h('span', { class: 'label' }, 'NAME'), name),
      rampRow('SKIN', 'skin', RAMPS.skin, RAMPS.skin.map((_, i) => `TONE ${i + 1}`)),
      pickerRow({
        label: 'STYLE',
        count: HAIR_STYLES.length,
        get: () => draft.look.hairStyle,
        set: (hairStyle) => setLook({ hairStyle }),
        item: (i) => heads[i]!,
        describe: (i) => (HAIR_STYLES[i] ?? '').toUpperCase(),
      }),
      rampRow('HAIR', 'hair', RAMPS.hair, HAIR_NAMES),
      rampRow('SHIRT', 'shirt', RAMPS.cloth, CLOTH_NAMES),
      rampRow('SHORTS', 'shorts', RAMPS.cloth, CLOTH_NAMES),
      pickerRow({
        label: 'BAND',
        count: RAMPS.cloth.length + 1,
        get: () => (draft.look.headband === null ? 0 : draft.look.headband + 1),
        set: (i) => {
          headbandChosen = true;
          setLook({ headband: i === 0 ? null : i - 1 });
        },
        item: (i) => (i === 0 ? h('span', { class: 'swatch none' }, icon('none')) : swatch(RAMPS.cloth[i - 1])),
        describe: (i) => (i === 0 ? 'NO HEADBAND' : `${CLOTH_NAMES[i - 1] ?? ''} HEADBAND`),
      }),
      rampRow('RACKET', 'racket', RAMPS.racket, RACKET_NAMES),
    ];

    paintHeads();
    const [near, far] = preview.canvases;
    const el = h(
      'div',
      { class: 'screen dim' },
      panel(
        'CUSTOMIZE',
        'customize',
        h(
          'div',
          { class: 'split' },
          h(
            'div',
            { class: 'stage' },
            h('figure', {}, near, h('figcaption', {}, 'NEAR')),
            h('figure', {}, far, h('figcaption', {}, 'FAR')),
          ),
          h('div', { class: 'rows' }, ...rows),
        ),
        h('div', { class: 'actions' }, button('DONE', () => ctx.router.back(), 'primary')),
      ),
    );
    return {
      el,
      onShow: () => {
        preview.start();
        name.focus({ preventScroll: true });
      },
      onHide: () => {
        preview.stop();
        if (sanitizeName(name.value) !== draft.name) saveName();
      },
    };
  };
}
