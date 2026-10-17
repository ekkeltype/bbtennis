import { SURFACE_CHOICES, valuesOf } from '../../ui/options';
import { randomSeed } from '../../ui/seed';
import { ArcadeCpu } from '../core/cpu';
import type { ArcadeConfig } from '../core/types';
import { ArcadeSession, type ArcadeView } from '../game/session';
import { arcadeCpuPlayer } from './players';

/** The demo's opponents come from Green belt (level 6) to Black belt (level 12). */
const LEVELS: readonly number[] = [6, 7, 8, 9, 10, 11, 12];
const SURFACES = valuesOf(SURFACE_CHOICES);

/**
 * The attract demo behind the title and main menu: CPU vs CPU seen as a spectator (no HUD), two
 * different random belts from Green to Black, a random surface, a Normal-pace tiebreak and a new
 * seed each run; a demo that is over is replaced on the next frame. It never reads keys; the app
 * gives it no audio director, so it is silent.
 */
export class ArcadeAttract {
  private current: ArcadeSession | null = null;

  /** `random` draws the belts and surface (0 ≤ r < 1). */
  constructor(private readonly random: () => number = Math.random) {}

  /** Advances the demo by `dtMs` (starting a new one first when there is none, or it is over). */
  frame(dtMs: number): ArcadeView {
    if (this.current === null || this.current.over) {
      this.current?.dispose();
      this.current = this.create();
    }
    return this.current.frame(dtMs);
  }

  private pick<T>(list: readonly T[]): T {
    return list[Math.min(list.length - 1, Math.floor(this.random() * list.length))]!;
  }

  private create(): ArcadeSession {
    const a = this.pick(LEVELS);
    const b = this.pick(LEVELS.filter((l) => l !== a));
    const seed = randomSeed();
    const config: ArcadeConfig = { format: 'tiebreak', deuceRule: 'advantage', surface: this.pick(SURFACES), pace: 'normal' };
    return new ArcadeSession({
      config,
      players: [arcadeCpuPlayer(a), arcadeCpuPlayer(b)],
      seed,
      controllers: [new ArcadeCpu(0, a, seed), new ArcadeCpu(1, b, seed)],
      viewer: 'spectator',
    });
  }
}
