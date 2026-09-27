import { powerAt } from './power';
import type { PromptKind, StrikeInfo, TurnOutcome, TurnPhase, TurnState, WordOption } from './types';
import { jsonCopy } from './util';

/** A prompt as a viewer sees it at some τ: its options and typing progress, never the letters typed. */
export interface PromptView {
  id: number;
  kind: PromptKind;
  options: WordOption[];
  locked: number | null;
  typed: number;
  lastWrongAt: number | null;
  completedAt: number | null;
  shownAt: number;
}

/** What a viewer sees of a turn at τ (spec §5.2 passive playback). */
export interface TurnView {
  phase: TurnPhase;
  τ: number;
  simτ: number;
  prompts: PromptView[];
  active: number | null;
  tossAt: number | null;
  catchAt: number | null;
  chaseProgress: number;          // 0..1 for return turns
  strike: StrikeInfo | null;      // if τ ≥ strike τ
  outcome: TurnOutcome | null;    // only if τ ≥ endτ (or strike τ for queued strikes)
  power: number | null;           // the owner's meter level at τ (power-meter spec §6); null = meter off
}

/** Everything the result log says happened up to τ. */
interface Replay {
  prompts: PromptView[];
  tossAt: number | null;
  catchAt: number | null;
  frozenMs: number;
  freezeSince: number | null;
}

/**
 * Derives what a viewer sees at τ from start data + result log (works on redacted turns). Typing is
 * rebuilt from the log alone (letters are never read); the outcome and strike appear once the turn
 * has ended and τ has reached its end (for a queued strike, T: the strike moment). The view holds
 * fresh copies only, so mutating it never changes the turn.
 */
export function turnViewAt(t: TurnState, τ: number): TurnView {
  const r = replay(t, τ);
  const outcome = t.ended && t.outcome !== null && τ >= t.outcome.endτ ? jsonCopy(t.outcome) : null;
  const d = t.data;
  let { tossAt, catchAt } = r;
  const last = r.prompts.length > 0 ? r.prompts.length - 1 : null;
  let phase: TurnPhase;
  let active: number | null = null;
  let chaseProgress = 0;

  if (d.kind === 'serve') {
    const catchEnd = catchAt === null ? null : catchAt + d.catchMs;
    if (tossAt === null) {
      phase = t.started && τ >= d.leadIn.ms ? 'preServe' : 'leadIn';
    } else if (catchEnd === null) {
      phase = 'toss';
      active = last;
    } else if (τ >= catchEnd && !(outcome !== null && outcome.endτ <= catchEnd)) {
      phase = 'preServe';
      tossAt = null;
      catchAt = null;
    } else {
      phase = 'catch';
    }
  } else {
    const [chase, choice] = r.prompts;
    phase = choice === undefined ? 'chase' : choice.completedAt === null ? 'choice' : 'queued';
    active = last;
    chaseProgress = chase === undefined ? 0 : progressOf(chase);
  }
  if (outcome !== null) {
    phase = 'ended';
    active = null;
  }

  return {
    phase,
    τ,
    simτ: τ - r.frozenMs - (r.freezeSince !== null ? τ - r.freezeSince : 0),
    prompts: r.prompts,
    active,
    tossAt,
    catchAt,
    chaseProgress,
    strike: outcome?.kind === 'strike' ? outcome.strike : null,
    outcome,
    power: powerAt(t, τ),
  };
}

function replay(t: TurnState, τ: number): Replay {
  const r: Replay = { prompts: [], tossAt: null, catchAt: null, frozenMs: 0, freezeSince: null };
  const shown = (id: number): PromptView | undefined => r.prompts.find((p) => p.id === id);
  for (const e of t.log) {
    if (e.τ > τ) break;
    switch (e.k) {
      case 'show': {
        const p = t.prompts.find((q) => q.id === e.prompt);
        if (p === undefined) break;
        r.prompts.push({
          id: p.id,
          kind: p.kind,
          options: p.options.map((o) => ({ ...o })),
          locked: p.kind === 'chase' ? 0 : null,
          typed: 0,
          lastWrongAt: null,
          completedAt: null,
          shownAt: e.τ,
        });
        break;
      }
      case 'toss':
        r.tossAt = e.τ;
        r.catchAt = null;
        break;
      case 'catch':
        r.catchAt = e.τ;
        break;
      case 'lock': {
        const p = shown(e.prompt);
        if (p === undefined) break;
        p.locked = e.option;
        p.typed++;
        break;
      }
      case 'ok': {
        const p = shown(e.prompt);
        if (p !== undefined) p.typed++;
        break;
      }
      case 'bad': {
        const p = shown(e.prompt);
        if (p !== undefined) p.lastWrongAt = e.τ;
        break;
      }
      case 'done': {
        const p = shown(e.prompt);
        if (p !== undefined) p.completedAt = e.τ;
        break;
      }
      case 'freeze':
        if (e.on) r.freezeSince = e.τ;
        else if (r.freezeSince !== null) {
          r.frozenMs += e.τ - r.freezeSince;
          r.freezeSince = null;
        }
        break;
    }
  }
  return r;
}

/** Share 0..1 of the locked word typed so far (0 while unlocked). */
function progressOf(p: PromptView): number {
  const word = p.locked === null ? undefined : p.options[p.locked];
  return word === undefined ? 0 : p.typed / word.len;
}
