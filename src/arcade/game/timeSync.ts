import { NET } from './rollback';

/** How many recent estimates the average covers (about a sixth of a second of input messages). */
const WINDOW = 10;
/** A lead up to this many ticks is left alone (the estimates jitter by about a tick). */
const DEAD_ZONE = 0.5;
/** Slower by this much of the clock rate per tick of lead beyond the dead zone… */
const SLOW_PER_TICK = 0.06;
/** …but never slower than this. */
const MIN_RATE = 0.85;

/**
 * Keeps the two sides' tick clocks together (online spec §3.3). Each side's advantage is its tick
 * minus the opponent's tick it last heard of; with a one-way latency of L ticks and this side X ticks
 * ahead, its advantage is X + L and the opponent's −X + L, so half their difference is X whatever the
 * latency. A side ahead (on average, beyond half a tick) runs its clock slower in proportion to its
 * lead, so it eases in without overshooting; the side behind never speeds up.
 */
export class TimeSync {
  private readonly estimates: number[] = [];

  /** This side's advantage: its tick minus the opponent's tick it last heard of (their inputs run inputDelay ahead of their tick). */
  static advantage(tick: number, lastRemote: number): number {
    return tick - (lastRemote - NET.inputDelay);
  }

  /** Notes this side's advantage now and the opponent's, as it sent it with its latest inputs. */
  note(local: number, remote: number): void {
    this.estimates.push((local - remote) / 2);
    if (this.estimates.length > WINDOW) this.estimates.shift();
  }

  /** How many ticks this side is ahead of the opponent, on average (negative: behind). */
  get ahead(): number {
    if (this.estimates.length === 0) return 0;
    return this.estimates.reduce((a, b) => a + b, 0) / this.estimates.length;
  }

  /** The rate to run this side's clock at: 1, or less while it is ahead. */
  rate(): number {
    const lead = this.ahead - DEAD_ZONE;
    return lead > 0 ? Math.max(MIN_RATE, 1 - SLOW_PER_TICK * lead) : 1;
  }
}
