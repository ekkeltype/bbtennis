import type { MatchConfig, Surface, ViewModel } from '../core/types';
import type { Scheduler } from '../game/clock';
import { LocalSession } from '../game/localSession';
import { attractPlayers } from './players';

/** The demo restarts this long after its MATCH_OVER (spec §4.6). */
const RESTART_AFTER_MS = 2000;
const SURFACES: readonly Surface[] = ['hard', 'clay', 'grass', 'dojo'];

/** A fresh 32-bit match seed from the platform's crypto RNG (Math.random if that is missing). */
export function randomSeed(): number {
  try {
    return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  } catch {
    return Math.floor(Math.random() * 2 ** 32);
  }
}

/**
 * The attract-mode demo behind Title and Main menu (spec §4.6): CPU vs CPU seen as a spectator, two
 * random levels from Green to Black, a random surface, a Normal-pace tiebreak and a new seed each run,
 * restarting 2 s after MATCH_OVER. It never reads keys or writes stats; the app mutes its audio.
 */
export class Attract {
  private current: LocalSession | null = null;
  private overSince: number | null = null;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly random: () => number = Math.random,
  ) {}

  /** The running demo session (started on first use). */
  get session(): LocalSession {
    this.current ??= this.create();
    return this.current;
  }

  /** Advances the demo one frame and returns its view; a demo over for 2 s is first replaced by a new one. */
  frame(dtMs: number): ViewModel {
    if (this.overSince !== null && this.scheduler.now() - this.overSince >= RESTART_AFTER_MS) this.stop();
    const vm = this.session.frame(dtMs);
    if (vm.pub.status === 'over') this.overSince ??= this.scheduler.now();
    return vm;
  }

  /** Drops the demo; the next frame starts a new one. */
  stop(): void {
    this.current?.dispose();
    this.current = null;
    this.overSince = null;
  }

  private create(): LocalSession {
    const surface = SURFACES[Math.min(SURFACES.length - 1, Math.floor(this.random() * SURFACES.length))] ?? 'hard';
    const config: MatchConfig = { format: 'tiebreak', pace: 'normal', surface, wordPack: 'mixed', deuceRule: 'advantage', training: null };
    return new LocalSession({ config, players: attractPlayers(this.random), seed: randomSeed(), human: null, scheduler: this.scheduler });
  }
}
