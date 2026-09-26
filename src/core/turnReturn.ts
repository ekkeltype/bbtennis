import { COURT, inSinglesHalf, restSpot } from './court';
import { displayKmh, flightTimeMs, graceMs, resolveShot, strikeV } from './shot';
import { ballAt, buildFlight, stanceFor } from './trajectory';
import { TUNING } from './tuning';
import type { PromptState, ReturnTurnData, StrikeInfo, TurnState, Vec3 } from './types';
import { lockedWord, wordCps, wpmOf } from './typing';
import { clamp } from './util';

const TR = TUNING.trajectory;

/**
 * A pending return-turn deadline at turn-clock τ. `netHit` and `bounce` are cues: they only present
 * the incoming ball and fire at any τ the turn has reached, an input's own τ included.
 */
export interface ReturnDeadline {
  kind: 'netHit' | 'bounce' | 'call' | 'contact' | 'pass';
  τ: number;
}

/**
 * The return turn's pending deadlines (spec §3.3), listed in the order they fire when they fall on
 * the same τ: the ball's net/bounce cues, an OUT/NET call, then the queued contact at T or the pass
 * at T + grace. Every time on the incoming flight is simulation time, shifted by the frozen time.
 */
export function returnDeadlines(t: TurnState, d: ReturnTurnData): ReturnDeadline[] {
  const f = d.incoming;
  const at = (simMs: number): number => simMs + t.frozenMs;
  const list: ReturnDeadline[] = [];
  // A NET ball drops at the net and never bounces, so the two cues never share a time (cueFired is keyed by time).
  if (f.outcome === 'net' && f.netT !== null && !cueFired(t, f.netT)) list.push({ kind: 'netHit', τ: at(f.netT) });
  if (f.outcome !== 'net' && !cueFired(t, f.tBounce)) list.push({ kind: 'bounce', τ: at(f.tBounce) });
  if (f.outcome !== 'in' && f.callT !== null) list.push({ kind: 'call', τ: at(f.callT) });
  if (t.outcome?.kind === 'strike') list.push({ kind: 'contact', τ: at(f.T) });
  else if (t.outcome === null) list.push({ kind: 'pass', τ: at(f.T + f.grace) });
  return list;
}

/**
 * The receiver's strike with the completed choice prompt `p`, struck at τ (spec §3.3.4): at the
 * contact point C when queued, or from the ball's position past C for a stretch (v × 0.9, σ + 0.5).
 * The completing key ended any freeze, so the simulation time of τ is τ − frozenMs.
 */
export function returnStrike(t: TurnState, d: ReturnTurnData, p: PromptState, τ: number, stretch: boolean): StrikeInfo {
  const word = lockedWord(p);
  const option = p.locked;
  const target = option === null ? undefined : d.choice.targets[option];
  if (word === null || option === null || target === undefined) {
    throw new Error('TurnRunner: a return strike needs a locked choice word and its target');
  }
  const f = d.incoming;
  const n = d.n + 1;
  const cps = wordCps(p);
  const v = strikeV(cps, { stretch });
  const shot = resolveShot({
    tier: word.tier,
    slips: p.slips,
    stretch,
    target,
    randoms: d.randoms,
    isIn: (q) => inSinglesHalf(q, d.striker),
  });
  const flight = buildFlight({
    isServe: false,
    tier: word.tier,
    p0: stretch ? clampToCourt(ballAt(f, τ - t.frozenMs)) : { x: f.contact.x, y: f.contact.y, z: TR.contactZ },
    landing: shot.landing,
    outcome: shot.outcome,
    T: flightTimeMs({ pace: d.pace, chaseLen: word.len, v, tier: word.tier, isServe: false, n }),
    grace: graceMs(d.pace),
    destEnd: d.striker,
  });
  return {
    τ,
    player: d.owner,
    word: { ...word },
    option,
    slips: p.slips,
    cps,
    wpm: wpmOf(cps),
    v,
    stretch,
    isServe: false,
    forehand: stanceFor(f.contact, d.owner, restSpot(d.owner)).forehand,
    kmh: displayKmh(v, word.tier, n, false),
    target: { ...target },
    shot,
    flight,
  };
}

/** R20: a stretch strike point stays within 1.2 m behind a baseline and |x| ≤ 5.8 (spec §3.0); z is kept. */
function clampToCourt(p: Vec3): Vec3 {
  const maxY = COURT.halfLength + TR.maxBehindBaseline;
  return { x: clamp(p.x, -TR.maxAbsX, TR.maxAbsX), y: clamp(p.y, -maxY, maxY), z: p.z };
}

/**
 * True once the cue at simulation time `at` has fired. A cue fires at the first processed τ with
 * τ ≥ at + frozenMs, so it has fired iff that held at the latest processed τ (checked from the live
 * state, which is what the firing compared) or at the moment a freeze began (frozen time summed from
 * the log exactly as frozenMs was). Each check repeats the firing comparison bit for bit, so a cue
 * can neither fire twice nor be skipped across a freeze.
 */
function cueFired(t: TurnState, at: number): boolean {
  if (t.freezeSince === null && at + t.frozenMs <= t.τ) return true;
  let frozen = 0;
  let since: number | null = null;
  for (const e of t.log) {
    if (e.k !== 'freeze') continue;
    if (!e.on) {
      if (since !== null) frozen += e.τ - since;
      since = null;
    } else if (at + frozen <= e.τ) {
      return true;
    } else {
      since = e.τ;
    }
  }
  return false;
}
