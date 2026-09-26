/**
 * A real match played headlessly for the art page's live scenes: the LocalSession loop (Engine plus a
 * CpuBrain per player, as the attract demo runs it) on a VirtualScheduler, one 60 Hz frame at a time.
 * Moments are found in a first run; the page then replays the same match (it is deterministic) and
 * renders the frames around each moment. No DOM here.
 */
import { redact, redactEvents } from '../../src/core/redact';
import { situation } from '../../src/core/scoring';
import { turnViewAt, type PromptView, type TurnView } from '../../src/core/turnView';
import { other, type MatchConfig, type PlayerId, type PlayerInfo, type Surface, type ViewModel } from '../../src/core/types';
import { VirtualScheduler } from '../../src/game/clock';
import { LocalSession } from '../../src/game/localSession';
import { leadInBanners } from '../../src/render/hud';
import { cpuPlayer } from '../../src/ui/players';

/** Frame length of the headless run: the 60 Hz display rate. */
export const FRAME_MS = 1000 / 60;

/** Every live scene is seen by player 0, the local player of a vs-CPU match. */
export const LIVE_VIEWER: PlayerId = 0;

/** A match to play headlessly: its options, players and seed. */
export interface LiveSetup { config: MatchConfig; players: [PlayerInfo, PlayerInfo]; seed: number }

/** One frame of the headless match: the spectator's view model and the current turn's view at its τ. */
export interface LiveFrame { vm: ViewModel; view: TurnView | null }

/** A moment to capture: its name, a caption and a test for the frames that show it. */
export interface Moment { name: string; label: string; shows(f: LiveFrame): boolean }

/** Where a moment was found: its first frame (`at`) and the frame its renderer starts from (`from`). */
export interface ShotPlan { moment: Moment; at: number; from: number }

/**
 * Seed of the live match, chosen so that Alex serves first and every moment comes early (the last,
 * MATCH POINT, under two minutes in), which keeps the page quick to draw.
 */
const SEED = 7;
/** How far into the point call's banner it is captured: slid in, the players celebrating and dejected. */
const POINT_BANNER_AT_MS = 750;
/** How far into PRE_SERVE the MATCH POINT banner is captured: slid in, before the CPU's toss. */
const MATCH_POINT_AT_MS = 300;
/** Frames planShots plays by default before giving up on a moment: 10 minutes of game time. */
const MAX_FRAMES = 36000;

/**
 * The live match of `surface`: a Normal-pace tiebreak between Alex (player 0, a human with the default
 * look, whose keys a CpuBrain types at level 8) and Bruno (the level-9 brown-belt CPU).
 */
export function liveSetup(surface: Surface): LiveSetup {
  const alex: PlayerInfo = {
    name: 'Alex',
    look: { skin: 1, hairStyle: 0, hair: 1, shirt: 6, shorts: 0, headband: null, racket: 0 },
    kind: 'human',
    cpuLevel: 8,
  };
  return {
    config: { format: 'tiebreak', pace: 'normal', surface, wordPack: 'everyday', deuceRule: 'advantage', training: null },
    players: [alex, cpuPlayer(9)],
    seed: SEED,
  };
}

/** The spectator frames of `setup`'s match from its first frame on, one every FRAME_MS, without end. */
export function* matchFrames(setup: LiveSetup): Generator<LiveFrame, never> {
  const scheduler = new VirtualScheduler();
  const session = new LocalSession({ ...setup, human: null, scheduler });
  for (;;) {
    const vm = session.frame(FRAME_MS);
    yield { vm, view: vm.pub.turn === null ? null : turnViewAt(vm.pub.turn, vm.turnτ) };
    scheduler.advance(FRAME_MS);
  }
}

/**
 * Plays `setup` and finds the first frame of each moment. A moment's renderer starts at the first frame
 * of the point before the moment's point (frame 0 in the first two points), so the frame shows the
 * players where the last rally left them and the crowd and effects as they were. Throws when a moment
 * is not found in the first `maxFrames` frames (by default ten minutes of game time).
 */
export function planShots(setup: LiveSetup, moments: readonly Moment[], maxFrames = MAX_FRAMES): ShotPlan[] {
  const found = new Map<Moment, ShotPlan>();
  const pointStarts: number[] = [];
  let i = 0;
  for (const f of matchFrames(setup)) {
    if (i >= maxFrames) break;
    const point = f.vm.pub.pointNo;
    pointStarts[point] ??= i;
    for (const m of moments) {
      if (!found.has(m) && m.shows(f)) found.set(m, { moment: m, at: i, from: pointStarts[Math.max(0, point - 1)] ?? 0 });
    }
    if (found.size === moments.length) return moments.map((m) => found.get(m)!);
    i++;
  }
  const missing = moments.filter((m) => !found.has(m)).map((m) => m.name);
  throw new Error(`live match (${setup.config.surface}): no ${missing.join(', ')} within ${maxFrames} frames`);
}

/** `vm`, a spectator's view model, as `viewer` sees it: state and events redacted for that player. */
export function viewAs(vm: ViewModel, viewer: PlayerId): ViewModel {
  return { ...vm, viewer, pub: redact(vm.pub, viewer), events: redactEvents(vm.events, vm.pub, viewer) };
}

function activePrompt(view: TurnView | null): PromptView | undefined {
  return view === null || view.active === null ? undefined : view.prompts[view.active];
}

/** The active prompt is a `kind` prompt, locked, with at least half its word typed but not all of it. */
function halfTyped(view: TurnView | null, kind: PromptView['kind']): boolean {
  const p = activePrompt(view);
  const word = p === undefined || p.locked === null ? undefined : p.options[p.locked];
  return p?.kind === kind && word !== undefined && p.typed * 2 >= word.len && p.typed < word.len;
}

/** A toss in the air whose serve word `server` has typed at least half of. */
function tossTyped({ vm, view }: LiveFrame, server: PlayerId): boolean {
  return vm.pub.turn?.data.owner === server && view?.phase === 'toss' && halfTyped(view, 'serve');
}

/** The viewer's `kind` prompt, at least half typed. */
function viewerTyped({ vm, view }: LiveFrame, kind: 'chase' | 'choice'): boolean {
  return vm.pub.turn?.data.owner === LIVE_VIEWER && view?.phase === kind && halfTyped(view, kind);
}

/**
 * The moments of each live scene section (brief 23b): the viewer's toss with typed letters, the viewer
 * chasing mid-way and with a choice locked, a point call's banner, the opponent's toss seen through
 * hidden plates, and the MATCH POINT banner.
 */
export const LIVE_MOMENTS: readonly Moment[] = [
  {
    name: 'toss',
    label: 'serve toss, half the serve word typed',
    shows: (f) => tossTyped(f, LIVE_VIEWER),
  },
  {
    name: 'chase',
    label: 'chase mid-way, the ball in flight',
    shows: (f) => viewerTyped(f, 'chase'),
  },
  {
    name: 'choice',
    label: 'choice locked, half the word typed',
    shows: (f) => viewerTyped(f, 'choice'),
  },
  {
    name: 'point',
    label: 'point call banner in the lead-in',
    shows: ({ vm, view }) => {
      const d = vm.pub.turn?.data;
      if (d?.kind !== 'serve' || d.leadIn.kind !== 'point' || view?.phase !== 'leadIn') return false;
      const call = leadInBanners(d.leadIn).find((b) => b.point);
      return call !== undefined && vm.turnτ >= call.fromMs + POINT_BANNER_AT_MS;
    },
  },
  {
    name: 'hidden',
    label: "opponent's toss: hidden serve plates",
    shows: (f) => tossTyped(f, other(LIVE_VIEWER)),
  },
  {
    name: 'matchpoint',
    label: 'MATCH POINT banner as PRE_SERVE begins',
    shows: ({ vm, view }) => {
      const d = vm.pub.turn?.data;
      return (
        d?.kind === 'serve' &&
        view?.phase === 'preServe' &&
        view.prompts.length === 0 &&
        vm.turnτ - d.leadIn.ms >= MATCH_POINT_AT_MS &&
        situation(vm.pub.score) === 'MATCH POINT'
      );
    },
  },
];
