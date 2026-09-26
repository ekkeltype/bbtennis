import { other, type DeuceRule, type FormatId, type PlayerId, type ScoreState, type Side } from './types';

/** Who won the game, set and match with the point just awarded; null where that unit is still running. */
export interface AwardResult { game: PlayerId | null; set: PlayerId | null; match: PlayerId | null }

const GAME_POINTS = 4;
const TIEBREAK_POINTS = 7;
const WIN_MARGIN = 2;
const GAMES_TO_WIN_SET: Record<FormatId, number> = { tiebreak: 0, short: 4, full: 6, bo3: 4 };

type ScoreIndex = 0 | 1 | 2 | 3;
const GAME_SCORE_SHOWN = ['0', '15', '30', '40'] as const;
const GAME_SCORE_SPOKEN = ['love', 'fifteen', 'thirty', 'forty'] as const;
const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Games needed to win a set (by two): 4 short sets and best of three, 6 full set, 0 the tiebreak format. */
export function gamesToWinSet(format: FormatId): number {
  return GAMES_TO_WIN_SET[format];
}

function setsToWinMatch(format: FormatId): number {
  return format === 'bo3' ? 2 : 1;
}

/** A set is decided by a tiebreak once both players reach its game target (so the tiebreak format opens with one). */
function tiebreakDue(format: FormatId, games: [number, number]): boolean {
  const n = gamesToWinSet(format);
  return games[0] === n && games[1] === n;
}

/** Fresh match score; `firstServer` (the coin-toss winner) serves first, including in the tiebreak format. */
export function createScore(format: FormatId, deuceRule: DeuceRule, firstServer: PlayerId): ScoreState {
  return {
    format,
    deuceRule,
    setGames: [],
    setTiebreaks: [],
    games: [0, 0],
    points: [0, 0],
    inTiebreak: tiebreakDue(format, [0, 0]),
    setsWon: [0, 0],
    firstServerOfMatch: firstServer,
    gameServer: firstServer,
    winner: null,
  };
}

/** Would `p` win the current game (or tiebreak) by winning the next point? Golden point never applies in tiebreaks. */
function pointWinsGame(s: ScoreState, p: PlayerId): boolean {
  const mine = s.points[p] + 1;
  const lead = mine - s.points[other(p)];
  if (s.inTiebreak) return mine >= TIEBREAK_POINTS && lead >= WIN_MARGIN;
  return mine >= GAME_POINTS && (s.deuceRule === 'golden' || lead >= WIN_MARGIN);
}

/** Would `p` win the current set by winning the current game? A tiebreak always decides its set. */
function gameWinsSet(s: ScoreState, p: PlayerId): boolean {
  if (s.inTiebreak) return true;
  const mine = s.games[p] + 1;
  return mine >= gamesToWinSet(s.format) && mine - s.games[other(p)] >= WIN_MARGIN;
}

/** Would `p` win the match by winning the current set? */
function setWinsMatch(s: ScoreState, p: PlayerId): boolean {
  return s.setsWon[p] + 1 >= setsToWinMatch(s.format);
}

/** `points` after one more point for `p`, as a new pair. */
function pointsWith(points: [number, number], p: PlayerId): [number, number] {
  const out: [number, number] = [points[0], points[1]];
  out[p] += 1;
  return out;
}

/** The tiebreak points of each completed set, aligned with `setGames` (null where none was recorded). */
function tiebreaksOf(s: ScoreState): ([number, number] | null)[] {
  return s.setGames.map((_, i) => s.setTiebreaks?.[i] ?? null);
}

/**
 * Scores one point for `winner`, mutating `s`. A finished game resets the points and passes the serve
 * (a tiebreak counts as one game); a finished set moves to `setGames`, with its tiebreak points (or
 * null) to `setTiebreaks`, and resets the games. Once the match is over this changes nothing and
 * returns all nulls.
 */
export function awardPoint(s: ScoreState, winner: PlayerId): AwardResult {
  const result: AwardResult = { game: null, set: null, match: null };
  if (s.winner !== null) return result;
  if (!pointWinsGame(s, winner)) {
    s.points[winner] += 1;
    return result;
  }
  const wonSet = gameWinsSet(s, winner);
  const tiebreak = s.inTiebreak ? pointsWith(s.points, winner) : null;
  result.game = winner;
  s.points = [0, 0];
  s.games[winner] += 1;
  s.gameServer = other(s.gameServer);
  if (wonSet) {
    result.set = winner;
    s.setTiebreaks = [...tiebreaksOf(s), tiebreak];
    s.setGames.push(s.games);
    s.games = [0, 0];
    s.setsWon[winner] += 1;
    if (s.setsWon[winner] >= setsToWinMatch(s.format)) {
      result.match = winner;
      s.winner = winner;
    }
  }
  s.inTiebreak = s.winner === null && tiebreakDue(s.format, s.games);
  return result;
}

/** Server of the next point: the game's server; in a tiebreak its first server serves one point, then two each. */
export function currentServer(s: ScoreState): PlayerId {
  if (!s.inTiebreak) return s.gameServer;
  const played = s.points[0] + s.points[1];
  return Math.floor((played + 1) / 2) % 2 === 0 ? s.gameServer : other(s.gameServer);
}

/** Side to serve from: deuce when the points played in the current game or tiebreak are even, ad when odd. */
export function serveSide(s: ScoreState): Side {
  return (s.points[0] + s.points[1]) % 2 === 0 ? 'deuce' : 'ad';
}

/** Index into the 0/15/30/40 tables; counts past 40 (deuce play) stay at 40. */
function scoreIndex(points: number): ScoreIndex {
  return Math.min(points, 3) as ScoreIndex;
}

/** Scoreboard points per player: '0'/'15'/'30'/'40', 'AD' beside '' for an advantage, plain digits in a tiebreak. */
export function pointsDisplay(s: ScoreState): [string, string] {
  const [a, b] = s.points;
  if (s.inTiebreak) return [String(a), String(b)];
  if (a >= 3 && b >= 3 && a !== b) return a > b ? ['AD', ''] : ['', 'AD'];
  return [GAME_SCORE_SHOWN[scoreIndex(a)], GAME_SCORE_SHOWN[scoreIndex(b)]];
}

/** One set column of a score line: the number shown and the small superscript beside it (null = none). */
export interface SetCell { value: number; sup: number | null }

/**
 * The completed sets as a score line shows them, one row per player (spec §3.6, §4.3): each set's
 * games, with the tiebreak loser's points as a superscript beside the set winner's games for a set
 * decided in a tiebreak (7⁵ over 6); in the Tiebreak format, its tiebreak points (7 over 5) instead of 1–0.
 */
export function setLine(s: ScoreState): [SetCell[], SetCell[]] {
  const tiebreaks = tiebreaksOf(s);
  const row = (p: PlayerId): SetCell[] =>
    s.setGames.map((games, i) => {
      const tb = tiebreaks[i] ?? null;
      if (tb === null) return { value: games[p], sup: null };
      if (s.format === 'tiebreak') return { value: tb[p], sup: null };
      return { value: games[p], sup: tb[p] > tb[other(p)] ? tb[other(p)] : null };
    });
  return [row(0), row(1)];
}

/**
 * Banner before the next point, by priority: 'MATCH POINT' > 'SET POINT' > 'GOLDEN POINT' (40–40 under the
 * golden rule, where the umpire calls "Deuce" and the next point takes the game) > 'BREAK POINT' (the receiver is
 * one point from the game) > 'DEUCE'; null when none applies or the match is over.
 */
export function situation(s: ScoreState): string | null {
  if (s.winner !== null) return null;
  const players: PlayerId[] = [0, 1];
  const gamePoint = players.filter((p) => pointWinsGame(s, p));
  const setPoint = gamePoint.filter((p) => gameWinsSet(s, p));
  if (setPoint.some((p) => setWinsMatch(s, p))) return 'MATCH POINT';
  if (setPoint.length > 0) return 'SET POINT';
  const [a, b] = s.points;
  const deuce = !s.inTiebreak && a === b && a >= 3;
  if (deuce && s.deuceRule === 'golden') return 'GOLDEN POINT';
  if (gamePoint.includes(other(currentServer(s)))) return 'BREAK POINT';
  if (deuce) return 'DEUCE';
  return null;
}

/** English words for a non-negative integer, e.g. 21 → 'twenty-one'. */
function numberWords(n: number): string {
  if (n >= 100) {
    const rest = n % 100;
    return `${numberWords(Math.floor(n / 100))} hundred${rest === 0 ? '' : ` ${numberWords(rest)}`}`;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)] as string;
    return n % 10 === 0 ? tens : `${tens}-${ONES[n % 10] as string}`;
  }
  return ONES[n] as string;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The umpire's call, in words, for the score right after a point won by `lastWinner`: 'Fifteen love'
 * (server first), 'Thirty all', 'Deuce', 'Advantage <name>', 'Game, <name>'; in a tiebreak the leader's
 * score first then their name ('Four two, <name>') or 'Three all'.
 */
export function umpireCall(s: ScoreState, names: [string, string], lastWinner: PlayerId): string {
  const [a, b] = s.points;
  if (a + b === 0) return `Game, ${names[lastWinner]}`;
  if (s.inTiebreak) {
    if (a === b) return `${capitalize(numberWords(a))} all`;
    const leader: PlayerId = a > b ? 0 : 1;
    return `${capitalize(numberWords(Math.max(a, b)))} ${numberWords(Math.min(a, b))}, ${names[leader]}`;
  }
  if (a >= 3 && b >= 3) {
    if (a === b) return 'Deuce';
    return `Advantage ${names[a > b ? 0 : 1]}`;
  }
  const server = currentServer(s);
  const serverScore = GAME_SCORE_SPOKEN[scoreIndex(s.points[server])];
  const receiverScore = GAME_SCORE_SPOKEN[scoreIndex(s.points[other(server)])];
  return a === b ? `${capitalize(serverScore)} all` : `${capitalize(serverScore)} ${receiverScore}`;
}
