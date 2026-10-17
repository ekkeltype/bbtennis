import { AudioEngine } from '../../audio/engine';
import { Umpire } from '../../audio/speech';
import { startLoop } from '../../game/loop';
import { Screen } from '../../render/screen';
import { fontsReady } from '../../ui/boot';
import { blurActive } from '../../ui/dom';
import { Overlay } from '../../ui/overlay';
import { humanPlayer } from '../../ui/players';
import { Router } from '../../ui/router';
import { customizeScreen } from '../../ui/screens/customize';
import { gateScreen } from '../../ui/screens/gate';
import { randomSeed } from '../../ui/seed';
import type { Profile } from '../../ui/settings';
import { ArcadeDirector } from '../audio/director';
import { ArcadeCpu } from '../core/cpu';
import { DT } from '../core/tuning';
import type { ArcadeConfig, ArcadeState } from '../core/types';
import { HeldKeys, KeyboardController } from '../game/keys';
import { ArcadeSession, type ArcadeView } from '../game/session';
import { ArcadeRenderer } from '../render/renderer';
import { ArcadeAttract } from './attract';
import type { ArcadeContext } from './context';
import { arcadeCpuPlayer } from './players';
import { cpuSetupScreen } from './screens/cpuSetup';
import { howToScreen } from './screens/howTo';
import { mainMenuScreen } from './screens/mainMenu';
import { matchScreen } from './screens/match';
import { optionsScreen } from './screens/options';
import { pauseScreen } from './screens/pause';
import { resultsScreen, type ResultsParams } from './screens/results';
import { titleScreen } from './screens/title';
import { ArcadeStore, type ArcadeSettings, type CpuSetup } from './store';

/** Screens with the attract demo running behind them. */
const ATTRACT_SCREENS: ReadonlySet<string> = new Set(['title', 'mainMenu']);
/** Screens without the title music (spec §6.2: it plays on the title and menu screens). */
const QUIET_SCREENS: ReadonlySet<string> = new Set(['gate', 'match', 'pause']);
/** DEV ONLY (temporary, until Task 14's debug hooks): screens `?screen=` may jump to, past the gate. */
const DEV_SCREENS: ReadonlySet<string> = new Set(['title', 'mainMenu', 'cpuSetup', 'customize', 'options', 'howTo', 'match', 'pause']);
/** Frames drawn in a dev build before the page reports `__shotReady` (so the canvas has drawn). */
const SHOT_READY_FRAMES = 45;
const NOTICE_STORAGE = "Progress can't be saved in this browser mode";

/** The page's elements: the focusable game root, the game canvas and the DOM overlay. */
export interface ArcadeElements { root: HTMLElement; canvas: HTMLCanvasElement; ui: HTMLElement }

/** The match against the CPU: its session, the setup a restart or rematch replays, and whether Results were shown. */
interface Match { session: ArcadeSession; level: number; config: ArcadeConfig; finished: boolean }

/**
 * The Arcade app (spec §6.3): owns the canvas Screen and ArcadeRenderer, audio (engine, umpire,
 * director), the HeldKeys, the Router on the `#ui` Overlay, the attract demo and the current match,
 * and drives them from one loop: session.frame → renderer.draw → director.consume. Its saved data
 * is the Arcade's own ArcadeStore. The keys are enabled only on the match screen, which is shown
 * only while the match is not paused.
 */
export class ArcadeApp implements ArcadeContext {
  readonly router: Router;
  private readonly store = new ArcadeStore(() => this.storageNotice());
  private readonly root: HTMLElement;
  private readonly overlay: Overlay;
  private readonly screen: Screen;
  private renderer: ArcadeRenderer;
  /** The match state the renderer has drawn; another one gets a fresh renderer. */
  private drawn: Readonly<ArcadeState> | null = null;
  private readonly audio = new AudioEngine();
  private readonly umpire: Umpire;
  private readonly director: ArcadeDirector;
  private readonly keys: HeldKeys;
  private readonly attract = new ArcadeAttract();
  private match: Match | null = null;
  private gateOpen = false;
  private readyIn: number | null = null;
  private storageNoticeShown = false;

  constructor(el: ArcadeElements) {
    this.root = el.root;
    this.screen = new Screen(el.canvas);
    this.renderer = new ArcadeRenderer(this.screen);
    this.umpire = new Umpire(() => this.settings.volumes.master * this.settings.volumes.sfx);
    this.umpire.enabled = false;
    this.director = new ArcadeDirector(this.audio, this.umpire, { surface: () => this.match?.config.surface ?? 'hard', viewer: () => 0 });
    this.audio.setVolumes(this.settings.volumes);

    this.overlay = new Overlay(el.ui);
    this.router = new Router(this.overlay.screens, (name) => this.onScreen(name));
    this.overlay.place(this.screen.info);
    this.screen.onChange((info) => this.overlay.place(info));

    this.keys = new HeldKeys(window, () => this.pauseMatch());
    window.addEventListener('blur', () => this.pauseMatch());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseMatch();
    });
  }

  /** Registers the screens, waits for the fonts, starts the loop and shows the gate. */
  async start(): Promise<void> {
    const r = this.router;
    r.register('gate', gateScreen(this));
    r.register('title', titleScreen(this));
    r.register('mainMenu', mainMenuScreen(this));
    r.register('cpuSetup', cpuSetupScreen(this));
    r.register('customize', customizeScreen(this));
    r.register('options', optionsScreen(this));
    r.register('howTo', howToScreen(this));
    r.register('match', matchScreen(this));
    r.register('pause', pauseScreen(this));
    r.register('results', resultsScreen(this));
    await fontsReady();
    startLoop((dt) => this.frame(dt));
    const dev = import.meta.env.DEV ? new URLSearchParams(location.search).get('screen') : null;
    if (dev !== null && DEV_SCREENS.has(dev)) this.devJump(dev);
    else r.go('gate');
    if (!this.store.storageOk()) this.storageNotice();
    if (import.meta.env.DEV) this.readyIn = SHOT_READY_FRAMES;
  }

  // ArcadeContext ---------------------------------------------------------------------------

  get profile(): Readonly<Profile> {
    return this.store.profile;
  }

  get settings(): Readonly<ArcadeSettings> {
    return this.store.settings;
  }

  get cpuSetup(): Readonly<CpuSetup> {
    return this.store.cpuSetup;
  }

  setProfile(profile: Profile): void {
    this.store.setProfile(profile);
  }

  setSettings(patch: Partial<ArcadeSettings>): void {
    this.store.setSettings(patch);
    this.audio.setVolumes(this.settings.volumes);
  }

  setCpuSetup(patch: Partial<CpuSetup>): void {
    this.store.setCpuSetup(patch);
  }

  openGate(): void {
    if (this.gateOpen) return;
    this.gateOpen = true;
    window.focus();
    void this.audio.unlock();
    this.umpire.enabled = true;
    this.router.go('title');
  }

  startCpuMatch(level: number, config: ArcadeConfig): void {
    this.endMatch();
    const seed = randomSeed();
    const session = new ArcadeSession({
      config: { ...config },
      players: [humanPlayer(this.profile), arcadeCpuPlayer(level)],
      seed,
      controllers: [new KeyboardController(this.keys), new ArcadeCpu(1, level, seed)],
      viewer: 0,
    });
    this.match = { session, level, config: { ...config }, finished: false };
    this.router.go('match');
  }

  rematch(): void {
    this.restartMatch();
  }

  /** Pauses the match and opens the pause menu: from the match screen only, and not once the match is decided. */
  pauseMatch(): void {
    const m = this.match;
    if (!m || this.router.current !== 'match' || m.session.view?.state.status === 'over') return;
    m.session.pause();
    this.router.go('pause');
  }

  /** From the pause menu only (a stray resume would restart the countdown): the match screen, then 3-2-1. */
  resumeMatch(): void {
    const m = this.match;
    if (!m || this.router.current !== 'pause') return;
    m.session.resume();
    this.router.back();
  }

  restartMatch(): void {
    const m = this.match;
    if (m) this.startCpuMatch(m.level, m.config);
  }

  quitMatch(): void {
    this.endMatch();
    this.router.go('mainMenu');
  }

  toggleFullscreen(): void {
    const done = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    done.catch(() => {});
  }

  focusGame(): void {
    window.focus();
    this.root.focus({ preventScroll: true });
  }

  // Loop and screens ------------------------------------------------------------------------

  private frame(dt: number): void {
    const m = this.match;
    if (m) this.playFrame(m, dt);
    else if (ATTRACT_SCREENS.has(this.router.current)) this.draw(this.attract.frame(dt), dt);
    if (this.readyIn !== null && --this.readyIn <= 0) {
      this.readyIn = null;
      (window as unknown as { __shotReady: boolean }).__shotReady = true;
    }
  }

  /** One frame of the match (drawn behind the pause menu and Results too); Results once it is over. */
  private playFrame(m: Match, dt: number): void {
    const view = m.session.frame(dt);
    this.draw(view, dt);
    // Events come from this frame's ticks: their age is the sim time since their tick.
    this.director.consume(view, (e) => (view.t - e.tick * DT) * 1000);
    if (m.finished || !m.session.over) return;
    m.finished = true;
    const params: ResultsParams = { result: view.state, viewer: 0 };
    this.router.go('results', params);
  }

  /** Draws a view once; a match state drawn for the first time gets a fresh renderer (no effects carried over). */
  private draw(view: ArcadeView, dt: number): void {
    if (view.state !== this.drawn) {
      this.renderer = new ArcadeRenderer(this.screen);
      this.drawn = view.state;
    }
    this.renderer.draw(view, { reduceEffects: this.settings.reduceEffects }, dt);
  }

  /** Every screen change: the keys work only on the match screen (whose root takes the focus); music plays in the menus. */
  private onScreen(name: string): void {
    if (name === 'match') {
      blurActive();
      this.root.focus({ preventScroll: true });
      this.keys.enable();
    } else {
      this.keys.disable();
    }
    this.audio.music(this.gateOpen && !QUIET_SCREENS.has(name));
  }

  private endMatch(): void {
    this.match?.session.dispose();
    this.match = null;
  }

  /** Says once per visit that progress can't be saved: at boot (the storage probe), or at the first save that fails. */
  private storageNotice(): void {
    if (this.storageNoticeShown) return;
    this.storageNoticeShown = true;
    this.overlay.notice(NOTICE_STORAGE);
  }

  /** DEV ONLY (temporary, Task 14 may replace it): `?screen=` shows a screen as if reached from the main menu. */
  private devJump(name: string): void {
    this.router.go('title');
    if (name === 'title') return;
    this.router.go('mainMenu');
    if (name === 'match' || name === 'pause') {
      const { level, ...config } = this.cpuSetup;
      this.startCpuMatch(level, config);
      if (name === 'pause') this.pauseMatch();
    } else if (name !== 'mainMenu') {
      this.router.go(name);
    }
  }
}
