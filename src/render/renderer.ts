import type { DisplayPrefs, Look, ViewModel } from '../core/types';
import { ballView } from './ball';
import { Effects } from './effects';
import { Hud } from './hud';
import { OUTLINE } from './palette';
import { PlayerAnimator } from './players';
import { H, W } from './projection';
import { drawPrompts, promptScene } from './prompts';
import type { Screen } from './screen';
import { buildSheet, type SpriteSheet } from './sprites/sheet';
import { drawWorld, worldFrame, type WorldFrame } from './world';

export type { DisplayPrefs } from '../core/types';
export { PAUSE_ICON_RECT } from './hud';

/** Frames the white border pop lasts when the local player becomes the active typist (spec §4.2). */
const POP_FRAMES = 2;

const LOOK_KEYS: readonly (keyof Look)[] = ['skin', 'hairStyle', 'hair', 'shirt', 'shorts', 'headband', 'racket'];
const sameLook = (a: Look, b: Look): boolean => LOOK_KEYS.every((k) => a[k] === b[k]);

/**
 * Draws the match (spec §4.1–§4.3) into the screen's 480×270 buffer and presents it. Layers:
 * backdrop → court → net → shadows → players/ball → effects (shaken together on an ACE/WINNER) →
 * court-space UI → plates → HUD → banners. Players wear the looks given to `setLooks`, else their
 * own from the match state.
 */
export class Renderer {
  private readonly screen: Screen;
  private readonly animator = new PlayerAnimator();
  private readonly effects = new Effects();
  private readonly hud = new Hud();
  private looks: [Look, Look] | null = null;
  private sheets: { looks: [Look, Look]; sheets: [SpriteSheet, SpriteSheet] } | null = null;
  private clockMs = 0;
  private overMs = 0;
  private pop = { prompt: -1, frames: 0 };

  constructor(screen: Screen) {
    this.screen = screen;
  }

  /** Dresses players 0 and 1 in `looks` from the next frame on (their sheets are built now). */
  setLooks(looks: [Look, Look]): void {
    this.looks = [{ ...looks[0] }, { ...looks[1] }];
    this.sheetsFor(this.looks);
  }

  /** Draws the frame of `vm`, `dtMs` after the previous one, into `screen.buf`, then presents it. */
  draw(vm: ViewModel, prefs: DisplayPrefs, dtMs: number): void {
    const dt = Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    this.clockMs += dt;
    this.overMs = vm.liveTurn === null && vm.pub.turn === null ? this.overMs + dt : 0;
    const f = worldFrame(vm, this.overMs);
    const looks = this.looks ?? [vm.pub.players[0].look, vm.pub.players[1].look];
    const poses = this.animator.step(f, dt);
    const ball = ballView(f, poses);
    this.effects.update(f, poses, dt, prefs.reduceEffects);
    this.hud.update(f);

    const g = this.screen.buf;
    const shake = this.effects.shake();
    g.save();
    if (shake.x !== 0 || shake.y !== 0) {
      g.fillStyle = OUTLINE;
      g.fillRect(0, 0, W, H);
      g.translate(shake.x, shake.y);
    }
    drawWorld(g, f, { poses, ball, sheets: this.sheetsFor(looks), effects: this.effects, clockMs: this.clockMs });
    g.restore();
    const turnStart = [this.animator.turnStartFeet(0), this.animator.turnStartFeet(1)] as const;
    drawPrompts(g, promptScene(f, poses, { prefs, looks, turnStart, pop: this.popNow(f) }));
    this.hud.draw(g, f, prefs);
    this.screen.present();
  }

  private sheetsFor(looks: readonly [Look, Look]): [SpriteSheet, SpriteSheet] {
    const cached = this.sheets;
    if (cached && sameLook(cached.looks[0], looks[0]) && sameLook(cached.looks[1], looks[1])) return cached.sheets;
    const sheets: [SpriteSheet, SpriteSheet] = [buildSheet(looks[0]), buildSheet(looks[1])];
    this.sheets = { looks: [{ ...looks[0] }, { ...looks[1] }], sheets };
    return sheets;
  }

  /** True on the first two frames of each serve or chase prompt the local player types. */
  private popNow(f: WorldFrame): boolean {
    const v = f.view;
    const prompt = v && v.active !== null ? v.prompts[v.active] : undefined;
    if (prompt && f.local !== null && f.turn?.data.owner === f.local && prompt.kind !== 'choice' && prompt.id !== this.pop.prompt) {
      this.pop = { prompt: prompt.id, frames: POP_FRAMES };
    }
    if (this.pop.frames <= 0) return false;
    this.pop.frames--;
    return true;
  }
}
