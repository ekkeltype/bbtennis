import { rallyTargets, serveTargets } from './court';
import { drawShotRandoms, seedRng, uniform } from './rng';
import { awardPoint, createScore, currentServer, serveSide, situation } from './scoring';
import { appendWordSet, createTurn, startTurn, turnClock, turnInput } from './turn';
import { PACE_MULT, TUNING } from './tuning';
import {
  other,
  TIERS,
  type EventBody,
  type GameEvent,
  type LeadIn,
  type MatchConfig,
  type MatchState,
  type PickerState,
  type PlayerId,
  type PlayerInfo,
  type PlayerStats,
  type PointReason,
  type PromptKind,
  type ReturnTurnData,
  type RngState,
  type ServeTurnData,
  type ServeWordSet,
  type Side,
  type StrikeInfo,
  type TrainingFlags,
  type TurnData,
  type TurnState,
  type WordOption,
} from './types';
import { isComplete, wordCps, wpmOf } from './typing';
import { jsonCopy } from './util';
import { tierOfLength } from './words/lists';
import { createPicker, initialsOk, pickFixed, pickSet } from './words/picker';

/** Everything a match starts from: its options, its two players and the match-RNG seed. */
export interface EngineOptions { config: MatchConfig; players: [PlayerInfo, PlayerInfo]; seed: number }

/** Stamps an engine event at the τ the ended turn ended. */
type At = (body: EventBody) => GameEvent;

type ScoredReason = Exclude<PointReason, 'forfeit'>;
type FaultReason = 'out' | 'net' | 'ballDropped' | 'timeViolation';

/** First banner line of a point call (spec §4.3). */
const POINT_TEXT: Record<ScoredReason, string> = {
  ace: 'ACE!',
  winner: 'WINNER',
  out: 'OUT',
  net: 'NET',
  doubleFault: 'DOUBLE FAULT',
};

/** Second banner line of a fault call. */
const FAULT_TEXT: Record<FaultReason, string> = {
  out: 'OUT',
  net: 'NET',
  ballDropped: 'BALL DROPPED',
  timeViolation: 'TIME VIOLATION',
};

/**
 * The match engine (spec §5.1): the single source of truth for rules, RNG, scoring and turn creation.
 * The TurnRunner (`./turn`) runs the current turn; the engine does everything between turns. All of
 * the match lives in `state` (plain JSON data, the RNG included), so `fromState` resumes it exactly.
 *
 * Match-RNG draw order: the coin toss; then per serve turn its two word sets (words, then T/wide)
 * and its randoms; per return turn its choice words, m and its randoms; per catch one spare set.
 */
export class Engine {
  readonly state: MatchState;

  constructor(opts: EngineOptions) {
    validateTraining(opts.config.training);
    const rng = seedRng(opts.seed);
    const firstServer: PlayerId = uniform(rng) < 0.5 ? 0 : 1;
    const config = jsonCopy(opts.config);
    this.state = {
      v: 2,
      config,
      players: jsonCopy(opts.players),
      score: createScore(config.format, config.deuceRule, firstServer),
      stats: [emptyStats(), emptyStats()],
      turn: null,
      lastTurn: null,
      rallyStrikes: 0,
      longestRally: 0,
      power: [0, 0],
      pointNo: 0,
      status: 'playing',
      winner: null,
      forfeitBy: null,
      nextTurnId: 1,
      nextPromptBase: 1,
      seenKinds: [[], []],
      rng,
      picker: createPicker(),
    };
    const intro: LeadIn = { kind: 'intro', ms: TUNING.leadIn.introMs, text: [`${this.name(firstServer)} TO SERVE`] };
    this.state.turn = this.serveTurn(1, intro);
  }

  /** Restores an engine from a full (unredacted) state, e.g. for tests; the state is copied. */
  static fromState(state: MatchState): Engine {
    if (state.rng === null || state.picker === null) {
      throw new Error('Engine.fromState needs a full state, but this one is redacted (no rng/picker)');
    }
    // Every bit of the engine lives in `state`, so an instance is its prototype plus a state.
    return Object.assign(Object.create(Engine.prototype) as Engine, { state: jsonCopy(state) });
  }

  /** Owner of the current turn, or null when the match is over. */
  owner(): PlayerId | null {
    const { status, turn } = this.state;
    return status === 'playing' && turn !== null ? turn.data.owner : null;
  }

  /** Starts the current turn's clock (owner's τ = 0); the match's first start also emits the coin toss. */
  start(player: PlayerId): GameEvent[] {
    const t = this.turnOwnedBy(player);
    if (t === null || t.started) return [];
    const opening = t.data.kind === 'serve' && t.data.leadIn.kind === 'intro';
    return this.run(t, () => {
      const events = startTurn(t);
      return opening ? [stamp(t, 0, { type: 'coinToss', winner: t.data.owner }), ...events] : events;
    });
  }

  /** The owner's input ('toss' or a letter a–z) at its turn clock τ; ignored from anyone else or before the start. */
  input(player: PlayerId, key: string, τ: number): GameEvent[] {
    const t = this.turnOwnedBy(player);
    return t === null || !t.started ? [] : this.run(t, () => turnInput(t, key, τ));
  }

  /** The owner confirms its turn clock reached τ; ignored from anyone else or before the start. */
  clock(player: PlayerId, τ: number): GameEvent[] {
    const t = this.turnOwnedBy(player);
    return t === null || !t.started ? [] : this.run(t, () => turnClock(t, τ));
  }

  /** `player` gives up: the match ends at once, won by the other player (in the state and its score). */
  forfeit(player: PlayerId): GameEvent[] {
    const s = this.state;
    const t = s.turn;
    if (s.status !== 'playing' || t === null) return [];
    const winner = other(player);
    s.status = 'over';
    s.winner = winner;
    s.score.winner = winner;
    s.forfeitBy = player;
    s.lastTurn = t;
    s.turn = null;
    return [stamp(t, t.τ, { type: 'match', winner })];
  }

  private turnOwnedBy(player: PlayerId): TurnState | null {
    const t = this.state.turn;
    return this.owner() === player ? t : null;
  }

  /**
   * Runs one TurnRunner call on the current turn and responds to what happened: the situation
   * banner when PRE_SERVE first begins, a new spare word set after each catch, and the turn's end.
   */
  private run(t: TurnState, call: () => GameEvent[]): GameEvent[] {
    let announce = t.phase === 'leadIn';
    let caught = t.log.filter((e) => e.k === 'catch').length;
    const out: GameEvent[] = [];
    for (const e of call()) {
      out.push(e);
      if (e.type === 'preServe' && announce) {
        announce = false;
        const text = situation(this.state.score);
        if (text !== null) out.push(stamp(t, e.τ, { type: 'situation', text }));
      } else if (e.type === 'catch') {
        this.addSpareSet(t, caught++);
      }
    }
    if (t.ended) out.push(...this.endTurn(t));
    return out;
  }

  /** After the catch of set `caught`: one new spare set, sharing no word with that set or any later one. */
  private addSpareSet(t: TurnState, caught: number): void {
    const d = t.data;
    if (d.kind !== 'serve') return;
    const avoid = d.wordSets.slice(caught).flatMap((set) => words(set.options));
    appendWordSet(t, this.serveSet(d.receiver, d.side, avoid));
  }

  /** Books the ended turn (stats, score) and creates the next turn, if the match goes on. */
  private endTurn(t: TurnState): GameEvent[] {
    const s = this.state;
    const outcome = t.outcome;
    if (outcome === null) throw new Error('Engine: an ended turn has no outcome');
    const previous = s.lastTurn;
    const discarded = t.data.kind === 'return' && outcome.kind === 'call';
    if (!discarded) addTyping(s.stats[t.data.owner], t);
    this.seenKinds()[t.data.owner] = [...t.seenKinds];
    for (const p of t.prompts) s.nextPromptBase = Math.max(s.nextPromptBase, p.id + 1);
    s.lastTurn = t;
    s.turn = null;
    const at: At = (body) => stamp(t, outcome.endτ, body);

    switch (outcome.kind) {
      case 'strike':
        this.strike(t, outcome.strike);
        return [];
      case 'fault':
        return this.fault(serveData(t), outcome.reason, at);
      case 'call': {
        const d = returnData(t);
        if (d.incoming.isServe) return this.fault(serveData(previous), outcome.call, at);
        s.stats[d.striker].errors++;
        return this.point(d.owner, outcome.call, at);
      }
      case 'miss': {
        const d = returnData(t);
        const reason = outcome.ace ? 'ace' : 'winner';
        s.stats[d.striker][outcome.ace ? 'aces' : 'winners']++;
        return [at({ type: 'call', call: reason, player: d.owner }), ...this.point(d.striker, reason, at)];
      }
    }
  }

  /** A strike: serve stats, rally length (a faulted serve is not in play), then the receiver's turn. */
  private strike(t: TurnState, strike: StrikeInfo): void {
    const s = this.state;
    const stats = s.stats[strike.player];
    if (strike.isServe && strike.shot.outcome === 'in') {
      stats.fastestServeKmh = Math.max(stats.fastestServeKmh, strike.kmh);
    }
    if (!strike.isServe || strike.shot.outcome === 'in') {
      s.rallyStrikes++;
      s.longestRally = Math.max(s.longestRally, s.rallyStrikes);
    }
    s.turn = this.returnTurn(t, strike);
  }

  /**
   * A fault on serve `d` is called FAULT (+ reason) for faultMs (spec §3.1 FAULT_CALL): before a second
   * serve after a first-serve fault, otherwise before the DOUBLE FAULT point call in the same lead-in.
   */
  private fault(d: ServeTurnData, reason: FaultReason, at: At): GameEvent[] {
    const call = ['FAULT', FAULT_TEXT[reason]];
    if (d.serveNo === 1) {
      this.state.turn = this.serveTurn(2, { kind: 'fault', ms: TUNING.leadIn.faultMs, text: call });
      return [];
    }
    this.state.stats[d.owner].doubleFaults++;
    return [at({ type: 'call', call: 'doubleFault', player: d.owner }), ...this.point(d.receiver, 'doubleFault', at, call)];
  }

  /**
   * Scores a point; then either the match is over or the next point's serve turn is created, its
   * lead-in the point call (spec §3.1 POINT_CALL), preceded by `faultCall` for a double fault.
   */
  private point(winner: PlayerId, reason: ScoredReason, at: At, faultCall: string[] = []): GameEvent[] {
    const s = this.state;
    const lead = TUNING.leadIn;
    s.stats[winner].pointsWon++;
    const won = awardPoint(s.score, winner);
    s.pointNo++;
    s.rallyStrikes = 0;
    const events = [at({ type: 'point', winner, reason })];
    const text = [...faultCall, POINT_TEXT[reason]];
    let ms = (faultCall.length > 0 ? lead.faultMs : 0) + lead.pointMs;
    if (won.game !== null) {
      events.push(at({ type: 'game', winner: won.game }));
      text.push(`GAME ${this.name(won.game)}`);
      ms += lead.gameExtraMs;
    }
    if (won.set !== null) {
      events.push(at({ type: 'set', winner: won.set }));
      text.push(`SET ${this.name(won.set)}`);
      ms += lead.setExtraMs;
    }
    if (won.match !== null) {
      events.push(at({ type: 'match', winner: won.match }));
      s.status = 'over';
      s.winner = won.match;
      return events;
    }
    s.turn = this.serveTurn(1, { kind: 'point', ms, text });
    return events;
  }

  /** A serve turn for the current score: the current server, side, two word sets and fresh randoms. */
  private serveTurn(serveNo: 1 | 2, leadIn: LeadIn): TurnState {
    const { score, config } = this.state;
    const training = config.training;
    const owner = currentServer(score);
    const receiver = other(owner);
    const side = serveSide(score);
    const ids = this.nextIds();
    const first = this.serveSet(receiver, side, []);
    const spare = this.serveSet(receiver, side, words(first.options));
    return this.newTurn({
      kind: 'serve',
      ...ids,
      owner,
      receiver,
      serveNo,
      side,
      leadIn,
      serveClockMs: training !== null && !training.serveClock ? null : TUNING.serveClockMs,
      tossApexMs: TUNING.tossApexMs,
      catchMs: TUNING.catchMs,
      pace: PACE_MULT[config.pace],
      wordSets: [first, spare],
      randoms: drawShotRandoms(this.rng()),
      freezeFirst: this.freezes(owner),
      power: this.meterFor(owner),
    });
  }

  /** The receiver's turn after `strike`: the chase word, pre-picked choice words and targets, fresh randoms. */
  private returnTurn(prev: TurnState, strike: StrikeInfo): TurnState {
    const { config } = this.state;
    const fixed = config.training?.fixedWords ?? null;
    const ids = this.nextIds();
    const options =
      fixed !== null
        ? pickFixed(this.picker(), fixed.choice, 'choice')
        : pickSet(this.rng(), this.picker(), config.wordPack, [strike.word.word]);
    const m = uniform(this.rng()) < 0.5 ? 1 : -1;
    const owner = other(strike.player);
    return this.newTurn({
      kind: 'return',
      ...ids,
      owner,
      striker: strike.player,
      incoming: strike.flight,
      chase: strike.word,
      isServeReturn: strike.isServe,
      n: strike.isServe ? 0 : returnData(prev).n + 1,
      choice: { options, targets: rallyTargets(strike.player, m), m },
      pace: PACE_MULT[config.pace],
      randoms: drawShotRandoms(this.rng()),
      freezeFirst: this.freezes(owner),
      power: this.meterFor(owner),
    });
  }

  /** Training freezes the first prompt of each kind for a person (the trainee), never for the CPU (spec §3.12). */
  private freezes(owner: PlayerId): boolean {
    const { config, players } = this.state;
    return config.training?.freezeUntilFirstKey === true && players[owner].kind !== 'cpu';
  }

  /** The owner's meter level for a new turn's start data, or null in training (meter off, power-meter spec §4.1). */
  private meterFor(owner: PlayerId): number | null {
    const { config, power } = this.state;
    return config.training !== null ? null : power[owner];
  }

  /** One toss's serve words (none of `avoid`) with their targets in the receiver's box. */
  private serveSet(receiver: PlayerId, side: Side, avoid: string[]): ServeWordSet {
    const { config } = this.state;
    const fixed = config.training?.fixedWords ?? null;
    const options =
      fixed !== null
        ? pickFixed(this.picker(), fixed.serve, 'serve')
        : pickSet(this.rng(), this.picker(), config.wordPack, avoid);
    const variant = uniform(this.rng()) < 0.5 ? 'T' : 'wide';
    return { options, targets: serveTargets(receiver, side, variant), variant };
  }

  /** The new turn's id and prompt base (R26: after every prompt id used so far, and ≥ the last base + 2). */
  private nextIds(): { turnId: number; promptBase: number } {
    const s = this.state;
    const ids = { turnId: s.nextTurnId, promptBase: s.nextPromptBase };
    s.nextTurnId += 1;
    s.nextPromptBase += 2;
    return ids;
  }

  /**
   * An unstarted turn that carries over the kinds of prompt its owner has seen so far in the match, so
   * a training freeze applies once per kind per player: the CPU's turns never use up the trainee's.
   */
  private newTurn(data: TurnData): TurnState {
    const t = createTurn(data);
    t.seenKinds = [...this.seenKinds()[data.owner]];
    return t;
  }

  /** Each player's seen prompt kinds (a state saved without them starts from none). */
  private seenKinds(): [PromptKind[], PromptKind[]] {
    return (this.state.seenKinds ??= [[], []]);
  }

  private name(p: PlayerId): string {
    return this.state.players[p].name.toUpperCase();
  }

  private rng(): RngState {
    const rng = this.state.rng;
    if (rng === null) throw new Error('Engine: the match RNG state is missing');
    return rng;
  }

  private picker(): PickerState {
    const picker = this.state.picker;
    if (picker === null) throw new Error('Engine: the word picker state is missing');
    return picker;
  }
}

/** Statistics of a player who has not played yet. */
export function emptyStats(): PlayerStats {
  return {
    pointsWon: 0,
    aces: 0,
    doubleFaults: 0,
    winners: 0,
    errors: 0,
    wordsCompleted: 0,
    intervalSum: 0,
    typingMs: 0,
    topWpm: 0,
    correctKeys: 0,
    wrongKeys: 0,
    fastestServeKmh: 0,
  };
}

/** Average WPM over completed words, 12·Σ(n − 1)/ΣΔt (spec §3.11); 0 before any typing time. */
export function averageWpm(s: PlayerStats): number {
  return s.typingMs > 0 ? (12 * s.intervalSum) / (s.typingMs / 1000) : 0;
}

/** Accuracy = correct / (correct + wrong) keys (spec §3.11); 0 before any key. */
export function accuracy(s: PlayerStats): number {
  const keys = s.correctKeys + s.wrongKeys;
  return keys > 0 ? s.correctKeys / keys : 0;
}

/** Adds a turn's typing to its owner's stats: every key, and each completed word (spec §3.11). */
function addTyping(s: PlayerStats, t: TurnState): void {
  for (const p of t.prompts) {
    s.correctKeys += p.correctKeys;
    s.wrongKeys += p.wrongKeys;
    if (!isComplete(p) || p.tFirst === null || p.tLast === null) continue;
    s.wordsCompleted++;
    s.intervalSum += p.typed - 1;
    s.typingMs += p.tLast - p.tFirst;
    if (p.typed >= 5) s.topWpm = Math.max(s.topWpm, wpmOf(wordCps(p)));
  }
}

/** Throws unless every fixed training triple is [easy, medium, hard] lowercase words with valid initials. */
function validateTraining(training: TrainingFlags | null): void {
  const fixed = training?.fixedWords ?? null;
  if (fixed === null) return;
  for (const which of ['serve', 'choice'] as const) {
    const list = fixed[which];
    if (list.length === 0) throw new Error(`Invalid training word list: fixedWords.${which} is empty`);
    list.forEach((triple, i) => {
      if (!isTierTriple(triple)) {
        throw new Error(
          `Invalid training word list: fixedWords.${which}[${i}] ${JSON.stringify(triple)} must be ` +
            'lowercase [easy, medium, hard] words with distinct, non-adjacent initials',
        );
      }
    });
  }
}

function isTierTriple(triple: readonly string[]): boolean {
  return (
    triple.length === TIERS.length &&
    triple.every((w, i) => /^[a-z]+$/.test(w) && tierOfLength(w.length) === TIERS[i]) &&
    initialsOk(triple)
  );
}

function serveData(t: TurnState | null): ServeTurnData {
  if (t?.data.kind !== 'serve') throw new Error('Engine: expected a serve turn');
  return t.data;
}

function returnData(t: TurnState): ReturnTurnData {
  if (t.data.kind !== 'return') throw new Error('Engine: expected a return turn');
  return t.data;
}

function stamp(t: TurnState, τ: number, body: EventBody): GameEvent {
  return { turn: t.data.turnId, τ, ...body };
}

function words(options: readonly WordOption[]): string[] {
  return options.map((o) => o.word);
}
