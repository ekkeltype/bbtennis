import type { Surface } from '../../core/types';
import type { Effects } from '../../render/effects';
import type { ArcadeEvent, ArcadeState, PlayerId } from '../core/types';
import type { ArcadeView } from '../game/session';

/** Run dust: one puff per this many ms while a player runs at least DUST_SPEED m/s. */
const DUST_EVERY_MS = 110;
const DUST_SPEED = 4;
/** Crowd excitement on any point, and the floor it holds through a long rally. */
const CHEER_POINT = 0.7;
const CHEER_RALLY = 0.45;
/** Hits in a point (the serve included) from which the crowd gets excited. */
const RALLY_HITS = 6;
const PLAYERS = [0, 1] as const;

/**
 * Turns the match's events into the shared `Effects` triggers (spec §6.1): a spark at each hit's
 * contact, bounce puffs (clay marks on clay, cleared at each set-up), run dust behind fast runners
 * (none on the dojo's wooden floor, as in the typing game), a screen shake on an ace, a winner or a
 * smash (never with Reduce effects), crowd cheers on points and long rallies, confetti on the
 * match. Advances the effects every frame.
 */
export class ArcadeFx {
  private readonly effects: Effects;
  private readonly dustMs: [number, number] = [0, 0];
  private hits = 0;
  private state: Readonly<ArcadeState> | null = null;

  constructor(effects: Effects) {
    this.effects = effects;
  }

  /**
   * Takes in the frame's events and the players' speeds, then advances the effects by `dtMs`. Give
   * each view exactly once: its events trigger effects with no dedup, so a repeat would replay them.
   */
  consume(view: ArcadeView, reduce: boolean, dtMs: number): void {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    const s = view.state;
    if (s !== this.state) this.newMatch(s);
    const surface = s.config.surface;
    for (const e of view.events) this.onEvent(e, surface, reduce);
    const frozen = view.overlay.paused || view.overlay.countdown !== null;
    if (!frozen) for (const p of PLAYERS) this.dust(s, p, surface, dt, reduce);
    this.effects.advance(dt, reduce);
    if (this.hits >= RALLY_HITS) this.effects.cheer(CHEER_RALLY);
  }

  /** Another session's state: forget the last one's rally and marks. */
  private newMatch(s: Readonly<ArcadeState>): void {
    this.state = s;
    this.hits = 0;
    this.dustMs[0] = 0;
    this.dustMs[1] = 0;
    this.effects.clearMarks();
  }

  private onEvent(e: ArcadeEvent, surface: Surface, reduce: boolean): void {
    const fx = this.effects;
    switch (e.type) {
      case 'hit':
        fx.spark(e.hit.contact, reduce);
        this.hits += 1;
        if (e.hit.type === 'smash') this.shake(reduce);
        return;
      case 'bounce':
        fx.bouncePuff(e.at, surface, reduce);
        return;
      case 'point':
        fx.cheer(CHEER_POINT);
        if (e.reason === 'ace' || e.reason === 'winner') this.shake(reduce);
        return;
      case 'match':
        fx.confettiBurst(reduce);
        return;
      case 'setup':
        fx.clearMarks();
        this.hits = 0;
        return;
      default:
        return;
    }
  }

  private shake(reduce: boolean): void {
    if (!reduce) this.effects.startShake();
  }

  /** A dust puff at the feet every DUST_EVERY_MS of fast running. */
  private dust(s: Readonly<ArcadeState>, p: PlayerId, surface: Surface, dt: number, reduce: boolean): void {
    const { pos, vel } = s.p[p];
    if (surface === 'dojo' || Math.sqrt(vel.x * vel.x + vel.y * vel.y) < DUST_SPEED) {
      this.dustMs[p] = 0;
      return;
    }
    this.dustMs[p] += dt;
    if (this.dustMs[p] < DUST_EVERY_MS) return;
    this.dustMs[p] %= DUST_EVERY_MS;
    this.effects.runDust(pos, surface, reduce);
  }
}
