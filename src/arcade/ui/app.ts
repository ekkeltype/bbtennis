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
import { installArcadeDebug, type ArcadeDebug } from '../game/debug';
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
import { arcadeLogo, titleScreen } from './screens/title';
import { ArcadeStore, type ArcadeSettings, type CpuSetup } from './store';

/** Screens with the attract demo running behind them. */
const ATTRACT_SCREENS: ReadonlySet<string> = new Set(['title', 'mainMenu']);
/** Screens without the title music (spec §6.2: it plays on the title and menu screens). */
const QUIET_SCREENS: ReadonlySet<string> = new Set(['gate', 'match', 'pause']);
/** The belt of the CPU playing the near side of the debug demo match (Black belt). */
const DEMO_LEVEL = 12;
const NOTICE_STORAGE = "Progress can't be saved in this browser mode";

/** The page's elements: the focusable game root, the game canvas and the DOM overlay. */
export interface ArcadeElements { root: HTMLElement; canvas: HTMLCanvasElement; ui: HTMLElement }

/** What a restart or rematch replays: the CPU's belt, the options, and whether a CPU plays the near side too (the debug demo). */
interface MatchSetup { level: number; config: ArcadeConfig; demo: boolean }

/** The match against the CPU: its session, its setup, and whether Results were shown. */
interface Match { session: ArcadeSession; setup: MatchSetup; finished: boolean }

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
  /** The debug hooks (dev builds and `?debug` pages), else null. */
  private debug: ArcadeDebug | null = null;
  private storageNoticeShown = false;

  constructor(el: ArcadeElements) {
    this.root = el.root;
    this.screen = new Screen(el.canvas);
    this.renderer = new ArcadeRenderer(this.screen);
    this.umpire = new Umpire(() => this.settings.volumes.master * this.settings.volumes.sfx);
    this.umpire.enabled = false;
    this.director = new ArcadeDirector(this.audio, this.umpire, { surface: () => this.match?.setup.config.surface ?? 'hard', viewer: () => 0 });
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
    // In fullscreen the browser takes Esc to leave it, so the page never sees that keydown.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) this.pauseMatch();
    });
  }

  /** Registers the screens, waits for the fonts, starts the loop and shows the gate. */
  async start(): Promise<void> {
    const r = this.router;
    r.register('gate', gateScreen(this, () => arcadeLogo()));
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
    this.debug = installArcadeDebug(this);
    if (!this.debug?.showStartScreen()) r.go('gate');
    if (!this.store.storageOk()) this.storageNotice();
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

  startCpuMatch(level: number, config: ArcadeConfig, seed: number = randomSeed()): void {
    this.beginMatch({ level, config: { ...config }, demo: false }, seed);
  }

  /** Debug (`__arcade.demo()`): the saved CPU setup's match with a Black-belt CPU playing the near side. */
  startDemoMatch(): void {
    const { level, ...config } = this.cpuSetup;
    this.beginMatch({ level, config, demo: true }, randomSeed());
  }

  /** The current match's live state (also behind Pause and Results), or null without a match. */
  matchState(): Readonly<ArcadeState> | null {
    return this.match?.session.view?.state ?? null;
  }

  rematch(): void {
    this.restartMatch();
  }

  /** Pauses the match and opens the pause menu (Esc/Tab, the pause icon, blur, a hidden tab, leaving fullscreen): from the match screen only, and not once the match is decided. */
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
    if (m) this.beginMatch(m.setup, randomSeed());
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
    this.debug?.frame();
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

  /** Ends any match and starts `setup` with `seed` on the match screen: the keyboard (or the demo's CPU) near, the CPU far. */
  private beginMatch(setup: MatchSetup, seed: number): void {
    this.endMatch();
    const near = setup.demo
      ? { player: arcadeCpuPlayer(DEMO_LEVEL), controller: new ArcadeCpu(0, DEMO_LEVEL, seed) }
      : { player: humanPlayer(this.profile), controller: new KeyboardController(this.keys) };
    const session = new ArcadeSession({
      config: { ...setup.config },
      players: [near.player, arcadeCpuPlayer(setup.level)],
      seed,
      controllers: [near.controller, new ArcadeCpu(1, setup.level, seed)],
      viewer: 0,
    });
    this.match = { session, setup, finished: false };
    this.router.go('match');
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
}
