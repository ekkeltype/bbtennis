import { AudioDirector } from './audio/director';
import { AudioEngine } from './audio/engine';
import { Umpire } from './audio/speech';
import type { DisplayPrefs, MatchConfig, ViewModel } from './core/types';
import { RealScheduler } from './game/clock';
import { installDebugHooks } from './game/debug';
import { KeyboardCapture } from './game/keyboard';
import { LocalSession } from './game/localSession';
import { startLoop } from './game/loop';
import type { Session } from './game/session';
import { Renderer } from './render/renderer';
import { Screen } from './render/screen';
import { Attract, randomSeed } from './ui/attract';
import { fontsReady } from './ui/boot';
import type { ResultsParams, UiContext } from './ui/context';
import { showDevScreen, testable } from './ui/devScreen';
import { blurActive } from './ui/dom';
import { localKeyResults } from './ui/keySounds';
import { hintsOn, mayPause, PLAY_SCREENS, resultsAfterLeave, trainingEnd, type Match } from './ui/matchLifecycle';
import { Overlay } from './ui/overlay';
import { PlayerStore } from './ui/playerStore';
import { cpuPlayer, humanPlayer } from './ui/players';
import { registerScreens } from './ui/registerScreens';
import { Router } from './ui/router';
import type { OnlineControls } from './ui/screens/online';
import { createTrainingSession } from './ui/screens/training';
import type { Career, Profile, Settings } from './ui/settings';
import { storageOk } from './ui/storage';

/** Screens with the attract demo running behind them (spec §4.6). */
const ATTRACT_SCREENS: ReadonlySet<string> = new Set(['title', 'mainMenu']);
/** Screens without the title music. */
const QUIET_SCREENS: ReadonlySet<string> = new Set(['gate', 'match', 'training', 'pause']);
/** Frames drawn before a dev/E2E page reports `__shotReady` (so the attract demo has drawn). */
const SHOT_READY_FRAMES = 45;
const NOTICE_STORAGE = "Progress can't be saved in this browser mode";

const clone = <T>(v: T): T => structuredClone(v);

/** The page's elements: the focusable game root, the game canvas, and the DOM overlay. */
export interface AppElements { root: HTMLElement; canvas: HTMLCanvasElement; ui: HTMLElement }

/**
 * The game app (spec §4.6, §5): owns the canvas Screen and Renderer, audio (engine, umpire, director),
 * the keyboard capture, the DOM Router on the `#ui` Overlay, the attract demo and the current match,
 * and drives them all from one animation loop: session.frame → renderer.draw → audio director. The
 * player's stored data is a PlayerStore, applied as it changes; the match lifecycle's decisions
 * (pausing, Training's end, the career, online Results) come from `ui/matchLifecycle`.
 */
export class App implements UiContext {
  readonly router: Router;
  private readonly store = new PlayerStore();
  private readonly root: HTMLElement;
  private readonly overlay: Overlay;
  private readonly screen: Screen;
  private renderer: Renderer;
  private drawn: Session | null = null;
  private readonly scheduler = new RealScheduler();
  private readonly audio = new AudioEngine();
  private readonly umpire: Umpire;
  private readonly director: AudioDirector;
  private readonly capture: KeyboardCapture;
  private readonly attract: Attract;
  private match: Match | null = null;
  private gateOpen = false;
  private blurred = false;
  private readyIn: number | null = null;

  constructor(el: AppElements) {
    this.root = el.root;
    this.screen = new Screen(el.canvas);
    this.screen.mode = this.settings.display;
    this.renderer = new Renderer(this.screen);
    this.umpire = new Umpire(() => this.settings.volumes.master * this.settings.volumes.sfx);
    this.umpire.enabled = false;
    this.director = new AudioDirector(this.audio, this.umpire);
    this.audio.setVolumes(this.settings.volumes);
    this.attract = new Attract(this.scheduler);

    this.overlay = new Overlay(el.ui);
    this.router = new Router(this.overlay.screens, (name) => this.onScreen(name));
    this.overlay.place(this.screen.info);
    this.screen.onChange((info) => this.overlay.place(info));

    this.capture = new KeyboardCapture(
      window,
      (k, timeStamp) => this.match?.session.key(k, timeStamp),
      () => this.pauseMatch(),
    );
    this.capture.setBlocked(true);
    this.capture.enable();

    window.addEventListener('blur', () => {
      this.blurred = true;
      this.openMenu(true);
    });
    window.addEventListener('focus', () => {
      this.blurred = false;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.openMenu(true);
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) this.openMenu(true);
    });
    installDebugHooks(() => this.match?.session ?? null);
  }

  /** Registers the screens, waits for the fonts, starts the loop and shows the first screen. */
  async start(): Promise<void> {
    registerScreens(this.router, this, {
      profile: () => clone(this.profile),
      settings: () => clone(this.settings),
      startMatch: (session, controls) => this.startOnline(session, controls),
    });
    await fontsReady();
    startLoop((dt) => this.frame(dt));
    const q = new URLSearchParams(location.search);
    const screen = testable(q) ? q.get('screen') : null;
    if (screen === null) this.router.go('gate');
    else showDevScreen(this, screen, q);
    if (!storageOk()) this.overlay.notice(NOTICE_STORAGE);
    if (testable(q)) this.readyIn = SHOT_READY_FRAMES;
  }

  // UiContext -------------------------------------------------------------------------------

  get settings(): Settings {
    return this.store.settings;
  }

  get profile(): Profile {
    return this.store.profile;
  }

  get career(): Career {
    return this.store.career;
  }

  setSettings(patch: Partial<Settings>): void {
    this.store.setSettings(patch);
    this.audio.setVolumes(this.settings.volumes);
    this.umpire.enabled = this.gateOpen && this.settings.umpireVoice;
    if (this.screen.mode !== this.settings.display) this.screen.mode = this.settings.display;
  }

  setProfile(profile: Profile, headbandChosen: boolean): void {
    this.store.setProfile(profile, headbandChosen);
  }

  voiceAvailable(): boolean {
    return this.umpire.available;
  }

  openGate(): void {
    if (this.gateOpen) return;
    this.gateOpen = true;
    window.focus();
    void this.audio.unlock();
    this.umpire.enabled = this.settings.umpireVoice;
    this.router.go('title');
    const code = new URLSearchParams(location.search).get('join');
    if (code !== null) this.router.go('join', { code });
  }

  startCpuMatch(): void {
    const s = this.settings;
    const config: MatchConfig = { format: s.format, pace: s.pace, surface: s.surface, wordPack: s.wordPack, deuceRule: s.deuceRule, training: null };
    const players = [humanPlayer(this.profile), cpuPlayer(s.cpuLevel)] as const;
    const make = (): Session =>
      new LocalSession({
        config,
        players: [...players],
        seed: randomSeed(),
        human: 0,
        scheduler: this.scheduler,
        hints: hintsOn(this.settings.matchesPlayed),
      });
    this.begin({ kind: 'cpu', session: make(), make, level: s.cpuLevel });
  }

  startTraining(): void {
    const make = (): Session => createTrainingSession(this.profile, randomSeed(), this.scheduler);
    this.begin({ kind: 'training', session: make(), make });
  }

  trainingOffered(): boolean {
    return this.store.trainingOffered();
  }

  dismissTrainingOffer(): void {
    this.store.dismissTrainingOffer();
  }

  rematch(): void {
    const m = this.match;
    if (m?.kind === 'online') m.controls?.rematch?.();
    else if (m?.make) this.begin({ ...m, session: m.make() });
  }

  pauseMatch(): void {
    this.openMenu(false);
  }

  resumeMatch(): void {
    const m = this.match;
    if (!m || this.router.current !== 'pause') return;
    m.session.resume();
    this.router.back();
  }

  restartMatch(): void {
    const m = this.match;
    if (m?.make) this.begin({ ...m, session: m.make() });
  }

  quitMatch(): void {
    this.endMatch();
    this.router.go('mainMenu');
  }

  forfeitMatch(): void {
    const m = this.match;
    if (m?.kind !== 'online') return;
    m.controls?.forfeit();
    this.router.back();
  }

  toggleFullscreen(): void {
    const done = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    done.catch(() => {});
  }

  focusGame(): void {
    window.focus();
    this.blurred = false;
    this.root.focus({ preventScroll: true });
  }

  // Matches ---------------------------------------------------------------------------------

  /** Starts showing a match (replacing any other) on its play screen. */
  private begin(m: Pick<Match, 'kind' | 'session'> & Partial<Match>): void {
    this.endMatch();
    this.match = { make: null, level: null, controls: null, ...m, sinceDoneMs: null, results: null, frozen: false };
    this.router.go(m.kind === 'training' ? 'training' : 'match');
  }

  /** Online screens hand their started session over here. */
  private startOnline(session: Session, controls: OnlineControls): void {
    this.begin({ kind: 'online', session, controls });
  }

  private endMatch(): void {
    this.match?.session.dispose();
    this.match = null;
  }

  /** Opens the in-match menu (pausing a local match) when `mayPause` allows it; `auto`: blur, hidden tab or fullscreen exit. */
  private openMenu(auto: boolean): void {
    const m = this.match;
    if (!m || !mayPause({ kind: m.kind, finished: m.results !== null, over: m.session.over }, this.router.current, auto)) return;
    m.session.pause();
    this.router.go('pause', { kind: m.kind });
  }

  /**
   * Moves on to Results once the match is over (Training: once its lessons are done, or it ended
   * without them). Online Results go back to the match when a rematch starts, and show again with
   * Rematch disabled once the opponent has left.
   */
  private checkEnd(m: Match, vm: ViewModel, dt: number): void {
    if (m.results !== null) {
      if (m.kind !== 'online' || this.router.current !== 'results') return;
      if (!m.session.over) {
        m.results = null;
        this.router.go('match');
        return;
      }
      const again = resultsAfterLeave(m.results, m.controls?.rematch !== undefined);
      if (again !== null) this.finish(m, again, false);
      return;
    }
    if (m.kind === 'training') return this.checkTraining(m, vm, dt);
    const result = m.session.over ? m.session.result : null;
    if (result === null) return;
    const viewer = m.session.view?.viewer === 1 ? 1 : 0;
    const newBelt = m.kind === 'cpu' ? this.store.recordCpuMatch(m.level ?? 0, result) : null;
    const canRematch = m.make !== null || m.controls?.rematch !== undefined;
    this.finish(m, { kind: m.kind, result, viewer, newBelt, canRematch }, false);
  }

  /** Training's end: `trainingDone` is stored as the last lesson is done; Results follow (see `trainingEnd`). */
  private checkTraining(m: Match, vm: ViewModel, dt: number): void {
    const s = m.session;
    const running = PLAY_SCREENS.has(this.router.current) && !vm.overlay.paused && vm.overlay.countdown === null;
    const step = trainingEnd(m.sinceDoneMs, { lessonsDone: s instanceof LocalSession && s.trainingDone, over: s.over, running, dtMs: dt });
    if (m.sinceDoneMs === null && step.sinceDoneMs !== null && !this.settings.trainingDone) this.setSettings({ trainingDone: true });
    m.sinceDoneMs = step.sinceDoneMs;
    if (step.show !== null) this.finish(m, { kind: 'training', done: step.show === 'complete' }, step.show === 'complete');
  }

  private finish(m: Match, params: ResultsParams, freeze: boolean): void {
    m.results = params;
    m.frozen = freeze;
    this.router.go('results', params);
  }

  // Loop ------------------------------------------------------------------------------------

  private frame(dt: number): void {
    const m = this.match;
    if (m && !m.frozen) this.playFrame(m, dt);
    else if (!m && ATTRACT_SCREENS.has(this.router.current)) this.attractFrame(dt);
    if (this.readyIn !== null && --this.readyIn <= 0) {
      this.readyIn = null;
      (window as unknown as { __shotReady: boolean }).__shotReady = true;
    }
  }

  private playFrame(m: Match, dt: number): void {
    let vm = m.session.frame(dt);
    if (m.kind === 'online' && this.blurred && !vm.overlay.focusLost) vm = { ...vm, overlay: { ...vm.overlay, focusLost: true } };
    this.draw(m.session, vm, dt);
    this.director.onEvents(vm.events, { viewer: vm.viewer, muted: false, state: vm.pub, surface: vm.pub.config.surface });
    for (const r of localKeyResults(vm.events, vm.viewer)) this.director.onLocalKey(r);
    this.checkEnd(m, vm, dt);
  }

  /** The attract demo: drawn without the HUD (a spectator), its sound, crowd and umpire muted (spec §4.6). */
  private attractFrame(dt: number): void {
    const vm = this.attract.frame(dt);
    this.draw(this.attract.session, vm, dt);
    this.director.onEvents(vm.events, { viewer: vm.viewer, muted: true, state: vm.pub, surface: vm.pub.config.surface });
  }

  /** Draws a session's frame; a session drawn for the first time gets a fresh Renderer (no carried-over animation state). */
  private draw(session: Session, vm: ViewModel, dt: number): void {
    if (session !== this.drawn) {
      this.renderer = new Renderer(this.screen);
      this.drawn = session;
    }
    this.renderer.draw(vm, this.prefs(), dt);
  }

  private prefs(): DisplayPrefs {
    const { largeWords, reduceEffects, showWpm } = this.settings;
    return { largeWords, reduceEffects, showWpm };
  }

  // Screens ---------------------------------------------------------------------------------

  /** Every screen change: keys reach the game only on a play screen (whose root takes the focus), music plays in menus. */
  private onScreen(name: string): void {
    const play = PLAY_SCREENS.has(name);
    this.capture.setBlocked(!play);
    if (play) {
      blurActive();
      this.root.focus({ preventScroll: true });
    }
    this.audio.music(this.gateOpen && !QUIET_SCREENS.has(name));
  }
}
