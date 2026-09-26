import type { GameEvent, MatchState, PlayerId, PublicState, ShotRandoms, TurnState, WordOption } from './types';
import { jsonCopy } from './util';

/** Who looks at the state: a player, or a spectator (attract mode) who may see everything. */
type Viewer = PlayerId | 'spectator';

const NO_RANDOMS: ShotRandoms = [0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * The state as `viewer` may see it (spec §5.1, §5.3 secrecy): a deep copy without the RNG and picker
 * state, with every turn (current and last) redacted by `redactTurn`. Never mutates `state`.
 */
export function redact(state: MatchState, viewer: Viewer): PublicState {
  const pub = jsonCopy(state);
  pub.rng = null;
  pub.picker = null;
  if (pub.turn !== null) hideSecrets(pub.turn, viewer);
  if (pub.lastTurn !== null) hideSecrets(pub.lastTurn, viewer);
  return pub;
}

/**
 * Events as `viewer` may see them: copies of all of them. Events carry no secrets — key, lock and
 * word events hold no letters, and a strike's word is public from the strike on.
 */
export function redactEvents(events: GameEvent[], _state: MatchState, _viewer: Viewer): GameEvent[] {
  return jsonCopy(events);
}

/**
 * A copy of turn `t` as `viewer` may see it. A turn owned by someone else (unless the viewer is a
 * spectator) loses its pre-drawn randoms; a serve turn also hides every serve word (length and tier
 * stay), its target markers (targets emptied, variant always 'T', since the variant fixes them) and
 * its typed letters, except the struck word in its prompt.
 */
export function redactTurn(t: TurnState, viewer: Viewer): TurnState {
  const out = jsonCopy(t);
  hideSecrets(out, viewer);
  return out;
}

function hideSecrets(t: TurnState, viewer: Viewer): void {
  const d = t.data;
  if (viewer === 'spectator' || d.owner === viewer) return;
  d.randoms = [...NO_RANDOMS];
  if (d.kind !== 'serve') return;
  for (const set of d.wordSets) {
    set.options = set.options.map(hide);
    set.targets = [];
    set.variant = 'T';
  }
  const struck = t.outcome?.kind === 'strike';
  for (const p of t.prompts) {
    const revealed = struck && p.completedAt !== null ? p.locked : null;
    p.options = p.options.map((o, i) => (i === revealed ? o : hide(o)));
  }
  t.log = t.log.map((e) => ('ch' in e ? { ...e, ch: '*' } : e));
}

function hide(o: WordOption): WordOption {
  return { word: '', len: o.len, tier: o.tier, hidden: true };
}
