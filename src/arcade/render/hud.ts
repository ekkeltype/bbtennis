import { drawBanner, type Banner } from '../../render/banner';
import { drawPauseIcon, drawServeClock, message, readout, speedAlpha } from '../../render/hudParts';
import { H, W } from '../../render/projection';
import { drawScoreboard } from '../../render/scoreboard';
import { serveClockLeft } from '../core/match';
import { ARCADE, DT, TICK_HZ } from '../core/tuning';
import type { ArcadeEvent, ArcadeState, CallKind, PlayerId } from '../core/types';
import type { ArcadeView } from '../game/session';

/** A banner over a span of ticks; `endTick` is Infinity for the match banner, which stays. */
export interface HudBanner { lines: string[]; startTick: number; endTick: number; small: boolean }

/** The serve clock shows in its last seconds only. */
const CLOCK_SHOW_S = 5;

const CALL_TEXT: Record<CallKind, string> = {
  fault: 'FAULT',
  out: 'OUT',
  net: 'NET',
  ace: 'ACE',
  winner: 'WINNER',
  doubleFault: 'DOUBLE FAULT',
  timeViolation: 'TIME VIOLATION',
  ballDropped: 'BALL DROPPED',
};

const ticksOf = (seconds: number): number => Math.round(seconds * TICK_HZ);

/** The highest of a point's game / set / match events (they share the point's tick). */
function wonAt(events: readonly ArcadeEvent[]): { text: 'GAME' | 'SET' | 'MATCH'; winner: PlayerId } | null {
  for (const type of ['match', 'set', 'game'] as const) {
    const e = events.find((x) => x.type === type);
    if (e && e.type === type) return { text: type === 'match' ? 'MATCH' : type === 'set' ? 'SET' : 'GAME', winner: e.winner };
  }
  return null;
}

/**
 * Banner (if any) at the current tick, from the latest call / point / game / set / match / situation
 * in state + recent events. The intro names the coin toss winner (`<NAME> TO SERVE`). A call shows
 * for its dead time (FAULT + NET for a serve into the net); after a point call comes GAME / SET /
 * MATCH and the winner's name until the next serve (the match one stays), or the situation, small,
 * while the score is called.
 */
export function bannerAt(s: Readonly<ArcadeState>, recent: readonly ArcadeEvent[]): HudBanner | null {
  const now = s.tick;
  if (s.phase.kind === 'intro') {
    const name = s.players[s.score.firstServerOfMatch].name.toUpperCase();
    return { lines: [`${name} TO SERVE`], startTick: 0, endTick: s.phase.until, small: false };
  }
  const call = s.point.call;
  if (call === null) return null;
  const flow = ARCADE.flow;
  const at = recent.filter((e) => e.tick === call.tick);
  const serveCall = call.call === 'fault' || call.call === 'timeViolation';
  const callEnd = call.tick + ticksOf(serveCall ? flow.faultPause : flow.call);
  if (now < callEnd) {
    const lines = [CALL_TEXT[call.call]];
    if (call.call === 'fault' && at.some((e) => e.type === 'netHit')) lines.push('NET');
    return { lines, startTick: call.tick, endTick: callEnd, small: false };
  }
  if (serveCall) return null;
  const won = wonAt(at);
  if (won) {
    const end = won.text === 'MATCH' ? Infinity : call.tick + ticksOf(flow.call + flow.score + flow.gameBanner);
    return now < end ? { lines: [won.text, s.players[won.winner].name.toUpperCase()], startTick: callEnd, endTick: end, small: false } : null;
  }
  const sit = at.find((e) => e.type === 'situation');
  const sitEnd = callEnd + ticksOf(flow.score);
  return sit?.type === 'situation' && now < sitEnd ? { lines: [sit.text], startTick: callEnd, endTick: sitEnd, small: true } : null;
}

/** Whole seconds left on the serve clock in its last 5 s, else null. */
export function serveClockShown(s: Readonly<ArcadeState>): number | null {
  const left = serveClockLeft(s);
  return left !== null && left <= CLOCK_SHOW_S ? Math.ceil(left) : null;
}

/** The latest serve's speed (km/h, rounded) and the readout's opacity: 1 for 2 s, then fading out over 0.5 s; null once gone. */
export function serveKmhShown(s: Readonly<ArcadeState>, recent: readonly ArcadeEvent[]): { kmh: number; alpha: number } | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i]!;
    if (e.type !== 'hit' || !e.hit.type.startsWith('serve')) continue;
    const alpha = speedAlpha(((s.tick - e.tick) * 1000) / TICK_HZ);
    return alpha === null ? null : { kmh: Math.round(e.kmh), alpha };
  }
  return null;
}

/** A tick-span banner as the banner painter wants it at sim time `t` (s): all lines join at once. */
function toBanner(b: HudBanner, t: number): Banner {
  const ageMs = (t - b.startTick * DT) * 1000;
  const leftMs = Number.isFinite(b.endTick) ? (b.endTick * DT - t) * 1000 : null;
  return { lines: b.lines.map((text) => ({ text, ageMs })), ageMs, leftMs, small: b.small };
}

/**
 * The Arcade HUD (spec §6.1): the shared scoreboard, the serve clock in its last 5 s, the serve
 * speed for 2 s then fading (bottom right), the pause icon, the call / score / situation banners and the 3-2-1
 * resume countdown. A spectator (the attract demo behind the menus) gets none of it, as in the
 * typing game. `clockMs` (the renderer's wall clock) is unused: every part runs on sim time
 * (`view.t`), so it freezes with the sim.
 */
export function drawArcadeHud(ctx: CanvasRenderingContext2D, view: ArcadeView, recent: readonly ArcadeEvent[], clockMs: number): void {
  if (view.viewer === 'spectator') return;
  const s = view.state;
  drawScoreboard(ctx, s.score, s.players);
  const clock = serveClockShown(s);
  if (clock !== null) drawServeClock(ctx, clock);
  const speed = serveKmhShown(s, recent);
  if (speed !== null) readout(ctx, `${speed.kmh} KM/H`, W - 2, H - 12, speed.alpha);
  drawPauseIcon(ctx);
  const banner = bannerAt(s, recent);
  if (banner) drawBanner(ctx, toBanner(banner, view.t));
  if (view.overlay.countdown !== null) message(ctx, String(view.overlay.countdown), null, H / 2);
}
