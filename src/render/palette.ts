import type { Surface, Tier } from '../core/types';

/**
 * Scene/UI master palette (spec §4.1): 48 named colours, ≤ 48 unique. Shades within a family run
 * light → dark (…Hi, base, …Lo); every other scene/UI table in this file snaps to these values.
 */
export const PAL = {
  // Neutrals, cool-tinted, near-black → white.
  ink: '#0D0B14',
  night: '#131523',
  shadow: '#29243A',
  slate: '#4A4760',
  grey: '#7B7C94',
  silver: '#B5B8C9',
  mist: '#D9DBE5',
  cream: '#F5F2E8',
  white: '#FFFFFF',
  // Okabe–Ito tier colours (spec §4.2).
  tierSky: '#56B4E9',
  tierYellow: '#F0E442',
  tierVermillion: '#D55E00',
  tierPurple: '#CC79A7',
  // Typed-letter shade for the yellow tier (see TIER_TYPED).
  tierYellowTyped: '#9C9230',
  // Stadium: sky, crowd, ad boards and umpire chair, ball.
  skyTop: '#5B7FD0',
  skyHorizon: '#A4C6F0',
  crowdRed: '#B5474B',
  crowdBlue: '#4A62B0',
  crowdPurple: '#B06FA0', // also the insane tier's typed shade (TIER_TYPED).
  gold: '#E0A83E',
  skinLight: '#EEC19C',
  skinDark: '#8C573A',
  boardGreen: '#1C5A44',
  boardGreenHi: '#2F7D5D',
  ball: '#DDF050',
  ballShade: '#9DB63A',
  // Hard court: blue acrylic with a green surround.
  hardHi: '#4F87C8',
  hard: '#3F73B3',
  hardLo: '#335F99',
  hardSurroundHi: '#4F9C6F',
  hardSurround: '#3F865C',
  hardSurroundLo: '#326E4A',
  // Clay.
  clayDust: '#EBA87C',
  clayHi: '#DB7B4C',
  clay: '#C8663B',
  clayLo: '#AE5433',
  clayDeep: '#924229',
  // Grass: two mowing-stripe shades, a darker surround and worn baseline turf.
  grassHi: '#76B951',
  grass: '#65A844',
  grassLo: '#548F38',
  grassDeep: '#447A2E',
  grassWorn: '#C4B06C',
  // Dojo: wooden planks and tatami.
  woodHi: '#CD965C',
  wood: '#B27B49',
  woodLo: '#8E5F38',
  tatamiHi: '#D4CB88',
  tatami: '#B9AF69',
  tatamiLo: '#958C50',
} satisfies Record<string, string>;

/** Word-tier colours (Okabe–Ito, spec §4.2): easy sky blue, medium yellow, hard vermillion, insane reddish purple. */
export const TIER_COLOR: Record<Tier, string> = {
  easy: PAL.tierSky,
  medium: PAL.tierYellow,
  hard: PAL.tierVermillion,
  insane: PAL.tierPurple,
};

/**
 * Typed-letter shade per tier (spec §4.2): a muted/darker shade of the tier colour, ≥ 4.5:1 on
 * `PLATE.fill` and at most 1/1.8 of the remaining letters' luminance, so typed and remaining letters
 * stay apart (plain yellow is only 1.18:1 from near-white). Snapped to existing palette colours
 * where one fits: hard-court blue for sky, clay for vermillion, the (re-tinted) crowd purple for insane.
 */
export const TIER_TYPED: Record<Tier, string> = {
  easy: PAL.hardHi,
  medium: PAL.tierYellowTyped,
  hard: PAL.clay,
  insane: PAL.crowdPurple,
};

/** Shared 1 px silhouette/mark outline, darker than every ramp shade. */
export const OUTLINE: string = PAL.ink;

/**
 * Word-plate colours (spec §4.2): `fill` dark plate body; `text` remaining letters and the inverse
 * cursor block (≥ 12:1 on fill); `outline` 1 px dark stroke outside the tier outline; `dim` remote
 * plate outline and hidden-letter dots; `flash` wrong-key fill flash; `halo` local-active halo.
 */
export const PLATE: { fill: string; text: string; outline: string; dim: string; flash: string; halo: string } = {
  fill: PAL.night,
  text: PAL.cream,
  outline: OUTLINE,
  dim: PAL.grey,
  flash: PAL.mist,
  halo: PAL.shadow,
};

/** One character shade ramp: highlight, mid tone and shadow, strictly darker in that order. */
export type Ramp = [hi: string, mid: string, lo: string];

/**
 * Character ramp table (spec §4.1), separate from `PAL`; `Look` fields index into it.
 * skin 6 (light → deep), hair 8, cloth 12 (shirt/shorts/headband; belts via `BELT_COLOR`), racket 6.
 */
export const RAMPS: { skin: Ramp[]; hair: Ramp[]; cloth: Ramp[]; racket: Ramp[] } = {
  skin: [
    ['#FFE0C8', '#F2BE9C', '#D0927A'],
    ['#F9CFA3', '#E3A878', '#BC7F5A'],
    ['#E9B884', '#C99158', '#A06A42'],
    ['#D29C6A', '#AE7646', '#855432'],
    ['#AE7650', '#8A5634', '#643A24'],
    ['#8A5A40', '#663E2A', '#44261A'],
  ],
  hair: [
    ['#4E4960', '#2D2939', '#1A1622'], // black
    ['#735038', '#4F3324', '#321F16'], // dark brown
    ['#A06E44', '#784B2D', '#52321E'], // brown
    ['#B85C3C', '#8C3F29', '#5F291B'], // auburn
    ['#EE9650', '#CB6C30', '#96481F'], // ginger
    ['#F8DC8A', '#E0B75C', '#AE863C'], // blonde
    ['#FFF6DC', '#E8D6AA', '#BAA47C'], // platinum
    ['#E4E4EC', '#B0B2C2', '#7C7E92'], // silver
  ],
  cloth: [
    ['#FFFFFF', '#DCDEEA', '#A7A9C0'], // white
    ['#FFF27E', '#F3CC3C', '#C49824'], // yellow
    ['#84DA6C', '#46A946', '#2A7436'], // green
    ['#B47C4C', '#885530', '#5C381F'], // brown
    ['#5B576E', '#353140', '#1D1A26'], // black
    ['#FF6E60', '#D83C3C', '#9A2430'], // red
    ['#6EAAFF', '#3A70DA', '#26459E'], // blue
    ['#56649E', '#303C74', '#1D234C'], // navy
    ['#FFAC58', '#F07C28', '#B4531B'], // orange
    ['#B47EE2', '#824ABA', '#552D84'], // purple
    ['#FFAACA', '#F06EA0', '#B84670'], // pink
    ['#62E2CA', '#24B2A2', '#197A70'], // teal
  ],
  racket: [
    ['#706C82', '#474350', '#27242E'], // graphite
    ['#F4665C', '#C83434', '#881F28'], // red
    ['#609EF2', '#2F64CA', '#1F3C86'], // blue
    ['#FFFFFF', '#D4D6E2', '#9C9EB2'], // white
    ['#CCF25C', '#8EC434', '#5C8C24'], // lime
    ['#FFC65C', '#EA942C', '#AA621D'], // orange
  ],
};

/** Cloth ramp index (into `RAMPS.cloth`) for each CPU/career belt colour (spec §3.8, §3.11). */
export const BELT_COLOR: Record<'white' | 'yellow' | 'green' | 'brown' | 'black', number> = {
  white: 0,
  yellow: 1,
  green: 2,
  brown: 3,
  black: 4,
};

/**
 * Per-surface scene colours (spec §4.1), all from `PAL`. `court` and `surround` run light → dark;
 * `accent` holds surface details: hard [scuffs]; clay [dust, ball marks]; grass [worn turf];
 * dojo [tatami edge cloth, lantern paper, lantern red, lantern glow].
 */
export const SURFACE_PAL: Record<Surface, { court: string[]; surround: string[]; lines: string; accent: string[] }> = {
  hard: {
    court: [PAL.hardHi, PAL.hard, PAL.hardLo],
    surround: [PAL.hardSurroundHi, PAL.hardSurround, PAL.hardSurroundLo],
    lines: PAL.white,
    accent: [PAL.slate],
  },
  clay: {
    court: [PAL.clayHi, PAL.clay, PAL.clayLo],
    surround: [PAL.clayLo, PAL.clayDeep],
    lines: PAL.white,
    accent: [PAL.clayDust, PAL.clayDeep],
  },
  grass: {
    court: [PAL.grassHi, PAL.grass, PAL.grassLo],
    surround: [PAL.grassLo, PAL.grassDeep],
    lines: PAL.white,
    accent: [PAL.grassWorn],
  },
  dojo: {
    court: [PAL.woodHi, PAL.wood, PAL.woodLo],
    surround: [PAL.tatamiHi, PAL.tatami, PAL.tatamiLo],
    lines: PAL.cream,
    accent: [PAL.boardGreen, PAL.cream, PAL.crowdRed, PAL.gold],
  },
};
