import { inServiceBox, serverSpot } from './court';
import { contactFactor, displayKmh, flightTimeMs, graceMs, resolveShot, strikeV } from './shot';
import { buildFlight, tossZ } from './trajectory';
import type { PromptState, ServeTurnData, StrikeInfo, TurnLogEntry, TurnState } from './types';
import { lockedWord, wordCps, wpmOf } from './typing';

/** A pending serve-turn deadline at turn-clock τ. */
export interface ServeDeadline {
  kind: 'preServe' | 'serveClock' | 'catchEnd' | 'tooLow';
  τ: number;
}

/**
 * The serve turn's pending deadlines in its current phase (spec §3.1, §3.2), listed in the order
 * they fire when they fall on the same τ.
 */
export function serveDeadlines(t: TurnState, d: ServeTurnData): ServeDeadline[] {
  const clockτ = serveClockτ(t, d);
  switch (t.phase) {
    case 'leadIn':
      return [{ kind: 'preServe', τ: d.leadIn.ms + t.frozenMs }];
    case 'preServe':
      return clockτ === null ? [] : [{ kind: 'serveClock', τ: clockτ }];
    case 'toss': {
      if (t.tossAt === null) return [];
      return [{ kind: 'tooLow', τ: t.tossAt + 2 * apexMs(d) + frozenSince(t, t.tossAt) }];
    }
    case 'catch': {
      if (t.catchAt === null) return [];
      const catchEnd: ServeDeadline = { kind: 'catchEnd', τ: t.catchAt + d.catchMs };
      // A clock that ran out during the toss is judged at the catch end instead.
      return clockτ !== null && clockτ > t.catchAt ? [{ kind: 'serveClock', τ: clockτ }, catchEnd] : [catchEnd];
    }
    default:
      return [];
  }
}

/** Turn-clock τ at which the serve clock runs out (it stands still while frozen), or null without one. */
export function serveClockτ(t: TurnState, d: ServeTurnData): number | null {
  return d.serveClockMs === null ? null : d.leadIn.ms + d.serveClockMs + t.frozenMs;
}

/**
 * The server's strike when the serve prompt `p` completes at τ (spec §3.2.4): launched from the
 * server's spot at the toss height, v × contact factor, judged against the receiver's service box.
 */
export function serveStrike(t: TurnState, d: ServeTurnData, p: PromptState, τ: number): StrikeInfo {
  const word = lockedWord(p);
  const option = p.locked;
  const target = option === null ? undefined : d.wordSets[t.setIndex]?.targets[option];
  if (word === null || option === null || target === undefined || t.tossAt === null) {
    throw new Error('TurnRunner: a serve strike needs a locked word, its target and a toss');
  }
  const a = apexMs(d);
  const sinceToss = τ - t.tossAt - frozenSince(t, t.tossAt);
  const cps = wordCps(p);
  const v = strikeV(cps, { contactFactor: contactFactor(sinceToss, a) });
  const shot = resolveShot({
    tier: word.tier,
    slips: p.slips,
    stretch: false,
    target,
    randoms: d.randoms,
    isIn: (q) => inServiceBox(q, d.receiver, d.side),
  });
  const flight = buildFlight({
    isServe: true,
    tier: word.tier,
    p0: { ...serverSpot(d.owner, d.side), z: tossZ(sinceToss, a) },
    landing: shot.landing,
    outcome: shot.outcome,
    T: flightTimeMs({ pace: d.pace, chaseLen: word.len, v, tier: word.tier, isServe: true, n: 0 }),
    grace: graceMs(d.pace),
    destEnd: d.receiver,
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
    stretch: false,
    isServe: true,
    forehand: true,
    kmh: displayKmh(v, word.tier, 0, true),
    target: { ...target },
    shot,
    flight,
  };
}

/** Toss apex a = tossApex × pace (spec §3.2.3); the ball is too low to hit at 2a. */
function apexMs(d: ServeTurnData): number {
  return d.tossApexMs * d.pace;
}

/**
 * Frozen time accumulated since τ0: frozenMs minus the freezes that had ended by τ0, summed from
 * the log in the same order as frozenMs, so it is exactly 0 when nothing froze since τ0.
 */
function frozenSince(t: TurnState, τ0: number): number {
  return t.frozenMs - frozenBefore(t.log, τ0);
}

function frozenBefore(log: TurnLogEntry[], τ: number): number {
  let frozen = 0;
  let since: number | null = null;
  for (const e of log) {
    if (e.τ > τ) break;
    if (e.k !== 'freeze') continue;
    if (e.on) since = e.τ;
    else if (since !== null) {
      frozen += e.τ - since;
      since = null;
    }
  }
  return frozen;
}
