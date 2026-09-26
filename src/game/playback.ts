/** Tuning of a playback clock: how far it trails the owner's confirmed τ, its top speed and how softly it settles. */
export interface PlaybackOptions {
  /** Target distance behind the confirmed τ (ms): 60 online, 0 for local CPU turns. */
  margin: number;
  /** Highest playback rate (1.1 = 10 % fast) while catching up. */
  maxRate: number;
  /** Lag (ms) that changes the rate by 1: rate = 1 + (τc − margin − τ_play) / relaxMs. */
  relaxMs: number;
}

/**
 * Passive-playback clock (spec §5.2): shows a turn the viewer does not own at τ_play, which starts at
 * 0 when the turn begins here and advances each frame at `clamp(1 + (τc − margin − τ_play)/relaxMs, 0,
 * maxRate)`, never beyond the owner's latest confirmed τc, so everything drawn is already known.
 */
export class PlaybackClock {
  private readonly opts: PlaybackOptions;
  private play = 0;
  private confirmed = 0;

  constructor(opts: PlaybackOptions) {
    const { margin, maxRate, relaxMs } = opts;
    if (!(Number.isFinite(margin) && margin >= 0 && Number.isFinite(maxRate) && maxRate > 0 && Number.isFinite(relaxMs) && relaxMs > 0)) {
      throw new RangeError(`PlaybackClock: invalid options ${JSON.stringify(opts)}`);
    }
    this.opts = { margin, maxRate, relaxMs };
  }

  /** Starts the turn's playback: τ_play = 0 (confirmations already received are kept). */
  begin(): void {
    this.play = 0;
  }

  /** Records the owner's latest confirmed τ; a lower or non-finite τ changes nothing. */
  confirm(τc: number): void {
    if (Number.isFinite(τc) && τc > this.confirmed) this.confirmed = τc;
  }

  /** Advances playback by a frame of `dtMs` (non-finite or negative counts as 0) and returns τ_play. */
  tick(dtMs: number): number {
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    const { margin, maxRate, relaxMs } = this.opts;
    const rate = Math.min(maxRate, Math.max(0, 1 + (this.confirmed - margin - this.play) / relaxMs));
    this.play = Math.max(this.play, Math.min(this.confirmed, this.play + rate * dt));
    return this.play;
  }

  /** The current τ_play. */
  get τ(): number {
    return this.play;
  }

  /** The owner's latest confirmed τ (0 before any). */
  get confirmedτ(): number {
    return this.confirmed;
  }
}
