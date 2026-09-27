import { rallyTargets, serveTargets } from '../../src/core/court';
import { buildFlight } from '../../src/core/trajectory';
import type {
  BallFlight,
  PlayerId,
  ReturnTurnData,
  ServeTurnData,
  ServeWordSet,
  ShotRandoms,
  Side,
  Tier,
  WordOption,
} from '../../src/core/types';

/** Shot randoms all at 0.5: every shot lands on its target and nothing clips the net. */
export const HALF: ShotRandoms = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];

/** Tier of a word length (power-meter spec §3: easy 2–4, medium 5–7, hard 8–11, insane 12–15). */
export const tierOf = (len: number): Tier => (len <= 4 ? 'easy' : len <= 7 ? 'medium' : len <= 11 ? 'hard' : 'insane');

/** A word option for `word`. */
export const opt = (word: string): WordOption => ({ word, len: word.length, tier: tierOf(word.length) });

/** A serve word set aimed at `receiver`'s service box from `side` (default: player 1, deuce). */
export const serveSet = (
  words: string[],
  variant: 'T' | 'wide' = 'T',
  receiver: PlayerId = 1,
  side: Side = 'deuce',
): ServeWordSet => ({
  options: words.map(opt),
  targets: serveTargets(receiver, side, variant),
  variant,
});

/** The first serve word set of `serveData`. */
export const SET_A = ['ball', 'volley', 'tiebreaker'];
/** The spare serve word set of `serveData`. */
export const SET_B = ['ace', 'racket', 'backhander'];

/** Server 0 → receiver 1 from the deuce side; intro lead-in 2.5 s, serve clock 30 s, apex a = 2 s. */
export function serveData(over: Partial<ServeTurnData> = {}): ServeTurnData {
  return {
    kind: 'serve',
    turnId: 7,
    promptBase: 40,
    owner: 0,
    receiver: 1,
    serveNo: 1,
    side: 'deuce',
    leadIn: { kind: 'intro', ms: 2500, text: ['ALEX TO SERVE'] },
    serveClockMs: 30000,
    tossApexMs: 2000,
    catchMs: 500,
    pace: 1,
    wordSets: [serveSet(SET_A), serveSet(SET_B, 'wide')],
    randoms: HALF,
    freezeFirst: false,
    ...over,
  };
}

/** A rally ball from player 0 to player 1: T = 3 s, grace 0.4 s, bouncing at 1.8 s (overridable). */
export const flight = (over: Partial<Parameters<typeof buildFlight>[0]> = {}): BallFlight =>
  buildFlight({
    isServe: false,
    tier: 'medium',
    p0: { x: -1, y: -11.5, z: 1 },
    landing: { x: 1.5, y: 9 },
    outcome: 'in',
    T: 3000,
    grace: 400,
    destEnd: 1,
    ...over,
  });

/** The default incoming ball of `returnData`: in. */
export const RALLY_IN = flight();
/** The same rally ball landing wide: called OUT at its bounce. */
export const RALLY_OUT = flight({ landing: { x: 4.6, y: 9 }, outcome: 'out' });

/** The choice words of `returnData`. */
export const CHOICE = ['drop', 'volley', 'crosscourt'];

/** Receiver 1 returning a rally ball struck by player 0 at depth n = 1 (so the reply flies at n = 2, one pressure step). */
export function returnData(over: Partial<ReturnTurnData> = {}): ReturnTurnData {
  return {
    kind: 'return',
    turnId: 8,
    promptBase: 48,
    owner: 1,
    striker: 0,
    incoming: RALLY_IN,
    chase: opt('ball'),
    isServeReturn: false,
    n: 1,
    choice: { options: CHOICE.map(opt), targets: rallyTargets(0, 1), m: 1 },
    pace: 1,
    randoms: HALF,
    freezeFirst: false,
    ...over,
  };
}
