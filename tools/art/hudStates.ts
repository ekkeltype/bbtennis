/**
 * World frames for the art page's HUD section (spec §4.3): scoreboards, serve clocks, the rally
 * readouts and every kind of banner. Each is a real serve turn from an Engine, started and seen at a
 * chosen τ, with a score scripted point by point through core/scoring; the readouts come from the live
 * match. No DOM here.
 */
import { Engine } from '../../src/core/engine';
import { redact } from '../../src/core/redact';
import { awardPoint, createScore } from '../../src/core/scoring';
import { TUNING } from '../../src/core/tuning';
import type { FormatId, GameEvent, LeadIn, MatchState, Overlay, PlayerId, PlayerInfo, ScoreState } from '../../src/core/types';
import { BELT_COLOR } from '../../src/render/palette';
import { worldFrame, type WorldFrame } from '../../src/render/world';
import { cpuPlayer } from '../../src/ui/players';
import { LIVE_VIEWER, liveSetup, matchFrames, viewAs } from './liveMatch';

/** One HUD sample: its caption and the frame the HUD draws. */
export interface HudSample { label: string; frame: WorldFrame }

const LEAD = TUNING.leadIn;
const SERVE_CLOCK_MS = TUNING.serveClockMs;
/** Where settled samples are seen: this far into their banner (slid in, not fading). */
const SETTLED_MS = 700;
/** How far into PRE_SERVE the scoreboards and situation banners are seen. */
const PRE_SERVE_AT_MS = 500;
/** The rally readout sample: this far into the return turn after the viewer's strike. */
const READOUT_AT_MS = 500;
/** How long the match-over samples have been over (the champion banner has slid in). */
const OVER_MS = 1000;
/** Frames readoutSample plays before giving up. */
const MAX_FRAMES = 36000;
/** The lead-in before an ordinary point: the WINNER call. */
const AFTER_POINT: LeadIn = { kind: 'point', ms: LEAD.pointMs, text: ['WINNER'] };
/** Point winners of a tiebreak at 6-5 to player 0, and of one won 7-5 by player 0. */
const TIEBREAK_6_5 = '0101010101' + '0';
const TIEBREAK_7_5 = TIEBREAK_6_5 + '0';

const NO_OVERLAY: Overlay = {
  paused: false,
  countdown: null,
  coach: null,
  wait: false,
  unstable: false,
  hintSpace: false,
  hintFirstLetter: false,
  focusLost: false,
  rttMs: null,
};

const [ALEX, BRUNO] = liveSetup('hard').players;

/** A `format` score after the points of `winners` ('0' or '1' per point, in order), player 0 serving first. */
function scored(format: FormatId, winners: string): ScoreState {
  const s = createScore(format, 'advantage', 0);
  for (const w of winners) awardPoint(s, w === '0' ? 0 : 1);
  return s;
}

/** The points of love games won by each of `players` in turn. */
function games(...players: PlayerId[]): string {
  return players.map((p) => String(p).repeat(4)).join('');
}

/**
 * A started serve turn (in its lead-in at τ 0, no toss yet) with `leadIn`, in a match of `players` at
 * `score`. The turn keeps the coin-toss winner as server and the deuce side; the HUD shows neither (its
 * serve dot follows the score). Optional `power` sets both meters and the turn owner's start level.
 */
function servingState(
  players: [PlayerInfo, PlayerInfo],
  score: ScoreState,
  leadIn: LeadIn,
  power: [number, number] = [0, 0],
): MatchState {
  const engine = new Engine({ config: { ...liveSetup('hard').config, format: score.format }, players, seed: 1 });
  const s = engine.state;
  const d = s.turn?.data;
  if (d?.kind !== 'serve') throw new Error('hud: a new engine has no serve turn');
  s.score = score;
  d.leadIn = leadIn;
  s.power = power;
  d.power = power[d.owner];
  engine.start(d.owner);
  return s;
}

/** Player 0's frame of `state` at τ (`overMs` once the match is over), with `events`. */
function frameOf(state: MatchState, τ: number, events: GameEvent[] = [], overMs = 0): WorldFrame {
  const vm = { pub: redact(state, LIVE_VIEWER), viewer: LIVE_VIEWER, turnτ: τ, liveTurn: null, early: null, events, overlay: NO_OVERLAY };
  return worldFrame(vm, overMs);
}

/** A sample `OVER_MS` after player 0 won the tiebreak 7-5 against `players[1]`. */
function matchOver(label: string, players: [PlayerInfo, PlayerInfo]): HudSample {
  const s = servingState(players, scored('tiebreak', TIEBREAK_7_5), AFTER_POINT);
  s.status = 'over';
  s.winner = s.score.winner;
  s.lastTurn = s.turn;
  s.turn = null;
  return { label, frame: frameOf(s, 0, [], OVER_MS) };
}

/** A PRE_SERVE sample: the serve turn after an ordinary point, `atMs` into PRE_SERVE. */
function preServe(
  label: string,
  players: [PlayerInfo, PlayerInfo],
  score: ScoreState,
  atMs = PRE_SERVE_AT_MS,
  power: [number, number] = [0, 0],
): HudSample {
  return { label, frame: frameOf(servingState(players, score, AFTER_POINT, power), AFTER_POINT.ms + atMs) };
}

/**
 * Scoreboards (spec §4.3): tiebreak and game points, deuce and advantage, set columns with the longest
 * names (12 letters), every belt colour on the opponent's swatch, the serve dot on either row, and a
 * finished match (no serve dot).
 */
export function scoreboardSamples(): HudSample[] {
  const bo3 = scored('bo3', games(0, 1, 0, 1, 0, 0) + games(0, 1, 0, 1, 0, 1, 1, 1) + games(0, 1, 0, 1) + '111');
  const alexandra: PlayerInfo = { ...ALEX, name: 'Alexandra Li', look: { ...ALEX.look, headband: BELT_COLOR.black } };
  return [
    preServe('tiebreak, first point (white belt)', [ALEX, cpuPlayer(0)], scored('tiebreak', '')),
    preServe('tiebreak 6-5 (yellow belt)', [ALEX, cpuPlayer(3)], scored('tiebreak', TIEBREAK_6_5)),
    preServe('short set 2-1, 15-40 (green belt)', [ALEX, cpuPlayer(6)], scored('short', games(0, 1, 0) + '0111')),
    preServe('short set 3-3, deuce (brown belt)', [ALEX, BRUNO], scored('short', games(0, 1, 0, 1, 0, 1) + '010101'), PRE_SERVE_AT_MS, [4, 1]),
    preServe('short set 3-3, advantage Bruno', [ALEX, BRUNO], scored('short', games(0, 1, 0, 1, 0, 1) + '0101011'), PRE_SERVE_AT_MS, [2, 4]),
    preServe('best of three 4-2 3-5 2-2, 0-40; 12-letter names; black-belt headband vs 3rd dan', [alexandra, cpuPlayer(14)], bo3),
    matchOver('match over: Alex won the tiebreak 7-5 (black belt)', [ALEX, cpuPlayer(12)]),
  ];
}

/** The serve clock (spec §3.2.1) at 30, 10, 5 (its last seconds, in yellow) and 1 second left. */
export function serveClockSamples(): HudSample[] {
  return [30, 10, 5, 1].map((left) =>
    preServe(`serve clock, ${left} s left`, [ALEX, BRUNO], scored('tiebreak', ''), SERVE_CLOCK_MS - left * 1000),
  );
}

/**
 * The rally readouts: the live match's first return turn after one of player 0's strikes, 0.5 s in,
 * with the shot speed and the WPM of player 0's last completed word.
 */
export function readoutSample(): HudSample {
  let lastWord: GameEvent | null = null;
  let i = 0;
  for (const { vm } of matchFrames(liveSetup('hard'))) {
    if (i++ >= MAX_FRAMES) break;
    for (const e of vm.events) if (e.type === 'wordDone' && e.player === LIVE_VIEWER) lastWord = e;
    const d = vm.pub.turn?.data;
    if (d?.kind === 'return' && d.striker === LIVE_VIEWER && vm.turnτ >= READOUT_AT_MS && lastWord !== null) {
      return { label: 'rally: shot speed and last-word WPM', frame: worldFrame({ ...viewAs(vm, LIVE_VIEWER), events: [lastWord] }) };
    }
  }
  throw new Error(`hud: no return turn after a strike by player ${LIVE_VIEWER} within ${MAX_FRAMES} frames`);
}

/** A lead-in banner sample: `text` as a lead-in of `kind`, `ms` long, seen at τ. */
function leadIn(label: string, kind: LeadIn['kind'], text: string[], ms: number, τ: number): HudSample {
  return { label, frame: frameOf(servingState([ALEX, BRUNO], scored('tiebreak', ''), { kind, ms, text }), τ) };
}

/**
 * Banners (spec §3.1, §4.3): the coin toss, both fault reasons, a double fault's two parts (R30), the
 * point calls with GAME and SET lines joining, a banner sliding in, the situation banners and the
 * champion.
 */
export function bannerSamples(): HudSample[] {
  const doubleFault = ['FAULT', 'NET', 'DOUBLE FAULT'];
  const withGame = LEAD.pointMs + LEAD.gameExtraMs;
  const withSet = withGame + LEAD.setExtraMs;
  return [
    leadIn('intro (coin toss)', 'intro', ['ALEX TO SERVE'], LEAD.introMs, SETTLED_MS),
    leadIn('fault: ball dropped', 'fault', ['FAULT', 'BALL DROPPED'], LEAD.faultMs, SETTLED_MS),
    leadIn('fault: time violation', 'fault', ['FAULT', 'TIME VIOLATION'], LEAD.faultMs, SETTLED_MS),
    leadIn('double fault: the fault call first', 'point', doubleFault, LEAD.faultMs + LEAD.pointMs, SETTLED_MS),
    leadIn('double fault: then the point call', 'point', doubleFault, LEAD.faultMs + LEAD.pointMs, LEAD.faultMs + SETTLED_MS),
    leadIn('point: ace', 'point', ['ACE!'], LEAD.pointMs, SETTLED_MS),
    leadIn('point: winner, the game line joined', 'point', ['WINNER', 'GAME ALEX'], withGame, LEAD.pointMs + SETTLED_MS),
    leadIn('point: out, game and set lines joined', 'point', ['OUT', 'GAME BRUNO', 'SET BRUNO'], withSet, withGame + SETTLED_MS),
    leadIn('point: net', 'point', ['NET'], LEAD.pointMs, SETTLED_MS),
    leadIn('point: winner sliding in (90 ms)', 'point', ['WINNER'], LEAD.pointMs, 90),
    preServe('situation: match point (tiebreak 6-5)', [ALEX, BRUNO], scored('tiebreak', TIEBREAK_6_5)),
    preServe('situation: set point (best of three, 3-2, 40-15)', [ALEX, BRUNO], scored('bo3', games(0, 1, 0, 1, 0) + '0010')),
    preServe('situation: break point (short set 1-1, 15-40)', [ALEX, BRUNO], scored('short', games(0, 1) + '0111')),
    preServe('situation: deuce', [ALEX, BRUNO], scored('short', '010101')),
    matchOver('match over: the champion', [ALEX, BRUNO]),
  ];
}
