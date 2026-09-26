import { AudioDirector } from './audio/director';
import { AudioEngine } from './audio/engine';
import { Umpire } from './audio/speech';
import { averageWpm } from './core/engine';
import type { DisplayPrefs, MatchConfig, MatchState, ViewModel } from './core/types';
import { RealScheduler } from './game/clock';
import { installDebugHooks } from './game/debug';
import { KeyboardCapture } from './game/keyboard';
import { LocalSession } from './game/localSession';
import { startLoop } from './game/loop';
import type { Session } from './game/session';
import { BELT_COLOR } from './render/palette';
import { Renderer } from './render/renderer';
import { cssUnit, Screen, type ScaleInfo } from './render/screen';
import { Attract, randomSeed } from './ui/attract';
import type { MatchKind, ResultsParams, UiContext } from './ui/context';
import { blurActive, toast } from './ui/dom';
import { localKeyResults } from './ui/keySounds';
import { cpuPlayer, humanPlayer } from './ui/players';
import { Router } from './ui/router';
import { sampleResults } from './ui/samples';
import { cpuSetupScreen } from './ui/screens/cpuSetup';
import { customizeScreen } from './ui/screens/customize';
import { gateScreen } from './ui/screens/gate';
import { howToScreen } from './ui/screens/howTo';
import { mainMenuScreen } from './ui/screens/mainMenu';
import { playScreen } from './ui/screens/match';
import { registerOnlineScreens, type OnlineControls } from './ui/screens/online';
import { optionsScreen } from './ui/screens/options';
import { pauseScreen } from './ui/screens/pause';
import { resultsScreen } from './ui/screens/results';
import { titleScreen } from './ui/screens/title';
import { createTrainingSession, trainingScreen } from './ui/screens/training';
import {
  DEFAULT_CAREER,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  highestBelt,
  isCareer,
  isProfile,
  isSettings,
  recordCareer,
  type Belt,
  type Career,
  type Profile,
  type Settings,
} from './ui/settings';
import { load, save, storageOk } from './ui/storage';

/** Screens over a match being played: keys go to the game there, and only there. */
const PLAY_SCREENS: ReadonlySet<string> = new Set(['match', 'training']);
/** Screens with the attract demo running behind them (spec §4.6). */
const ATTRACT_SCREENS: ReadonlySet<string> = new Set(['title', 'mainMenu']);
/** Screens without the title music. */
const QUIET_SCREENS: ReadonlySet<string> = new Set(['gate', 'match', 'training', 'pause']);
/** A player's first matches show the SPACE keycap and first-letter hints (spec §3.12). */
const FIRST_MATCHES_WITH_HINTS = 3;
/** How long the last Training point's banner stays before the "complete" panel. */
const TRAINING_END_MS = 2500;
/** Frames drawn before a dev/E2E page reports `__shotReady` (so the attract demo has drawn). */
const SHOT_READY_FRAMES = 45;
const NOTICE_STORAGE = "Progress can't be saved in this browser mode";
const NOTICE_FIT = 'Use fullscreen for a sharper view';

const clone = <T>(v: T): T => structuredClone(v);

/** The match being played: its session and what Results, Restart and Rematch need. */
interface Match {
  kind: MatchKind;
  session: Session;
  /** A new session with the same config and players (Restart, vs-CPU Rematch); null online. */
  make: (() => Session) | null;
  /** vs CPU: the opponent's level, for the career. */
  level: number | null;
  controls: OnlineControls | null;
  /** Training: local time the last lesson was completed. */
  doneAt: number | null;
  /** Results are showing. */
  finished: boolean;
  /** The session is no longer advanced or drawn (a Training session left running when complete). */
  frozen: boolean;
}

/** The page's elements: the focusable game root, the game canvas, and the DOM overlay. */
export interface AppElements { root: HTMLElement; canvas: HTMLCanvasElement; ui: HTMLElement }

/** True in dev builds and on pages opened with `?e2e=1` (the E2E script's production runs). */
function testable(q: URLSearchParams): boolean {
  return import.meta.env.DEV || q.get('e2e') === '1';
}

/** Resolves once both UI fonts are loaded (or after 3 s, so a font failure never blocks the game). */
async function fontsReady(): Promise<void> {
  try {
    const fonts = document.fonts;
    const loads = Promise.all([fonts.load('16px "Press Start 2P"'), fonts.load('16px "Pixelify Sans"')]).then(() => fonts.ready);
    await Promise.race([loads, new Promise((r) => setTimeout(r, 3000))]);
  } catch {
    // Fall back to whatever fonts are available.
  }
}

/**
 * The game app (spec §4.6, §5): owns the canvas Screen and Renderer, audio (engine, umpire, director),
 * the keyboard capture, the DOM Router on `#ui`, the attract demo and the current match, and drives
 * them all from one animation loop: session.frame → renderer.draw → audio director. Settings, profile
 * and career live in localStorage (spec §5.4) and are applied as they change.
 */
export class App implements UiContext {
  readonly router: Router;
  settings: Settings;
  profile: Profile;
  career: Career;
  private headbandChosen: boolean;
  private readonly root: HTMLElement;
  private readonly ui: HTMLElement;
  private readonly notices: HTMLElement;
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
  private fitNoticeShown = false;
  private readyIn: number | null = null;

  constructor(el: AppElements) {
    this.root = el.root;
    this.ui = el.ui;
    this.settings = load('settings', clone(DEFAULT_SETTINGS), isSettings);
    this.profile = load('profile', clone(DEFAULT_PROFILE), isProfile);
    this.career = load('career', clone(DEFAULT_CAREER), isCareer);
    this.headbandChosen = load('headbandChosen', false, (v): v is boolean => typeof v === 'boolean');

    this.screen = new Screen(el.canvas);
    this.screen.mode = this.settings.display;
    this.renderer = new Renderer(this.screen);
    this.umpire = new Umpire(() => this.settings.volumes.master * this.settings.volumes.sfx);
    this.umpire.enabled = false;
    this.director = new AudioDirector(this.audio, this.umpire);
    this.audio.setVolumes(this.settings.volumes);
    this.attract = new Attract(this.scheduler);

    const screens = document.createElement('div');
    screens.className = 'screens';
    this.notices = document.createElement('div');
    this.notices.className = 'notices';
    this.ui.append(screens, this.notices);
    this.router = new Router(screens, (name) => this.onScreen(name));
    this.placeUi(this.screen.info);
    this.screen.onChange((info) => this.placeUi(info));

    this.capture = new KeyboardCapture(
      window,
      (k, timeStamp) => this.match?.session.key(k, timeStamp),
      () => this.pauseMatch(),
    );
    this.capture.setBlocked(true);
    this.capture.enable();

    window.addEventListener('blur', () => {
      this.blurred = true;
      this.autoPause();
    });
    window.addEventListener('focus', () => {
      this.blurred = false;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.autoPause();
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) this.autoPause();
    });
    installDebugHooks(() => this.match?.session ?? null);
  }

  /** Registers the screens, waits for the fonts, starts the loop and shows the first screen. */
  async start(): Promise<void> {
    this.registerScreens();
    await fontsReady();
    startLoop((dt) => this.frame(dt));
    const q = new URLSearchParams(location.search);
    const screen = testable(q) ? q.get('screen') : null;
    if (screen === null) this.router.go('gate');
    else this.showDevScreen(screen, q);
    if (!storageOk()) toast(this.notices, NOTICE_STORAGE);
    if (testable(q)) this.readyIn = SHOT_READY_FRAMES;
  }

  // UiContext -------------------------------------------------------------------------------

  setSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...clone(patch) };
    save('settings', this.settings);
    this.audio.setVolumes(this.settings.volumes);
    this.umpire.enabled = this.gateOpen && this.settings.umpireVoice;
    if (this.screen.mode !== this.settings.display) this.screen.mode = this.settings.display;
  }

  setProfile(profile: Profile, headbandChosen: boolean): void {
    this.profile = clone(profile);
    save('profile', this.profile);
    if (headbandChosen && !this.headbandChosen) {
      this.headbandChosen = true;
      save('headbandChosen', true);
    }
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
        hints: this.settings.matchesPlayed < FIRST_MATCHES_WITH_HINTS,
      });
    this.begin({ kind: 'cpu', session: make(), make, level: s.cpuLevel });
  }

  startTraining(): void {
    const make = (): Session => createTrainingSession(this.profile, randomSeed(), this.scheduler);
    this.begin({ kind: 'training', session: make(), make });
  }

  rematch(): void {
    const m = this.match;
    if (m?.kind === 'online') m.controls?.rematch?.();
    else if (m?.make) this.begin({ ...m, session: m.make() });
  }

  pauseMatch(): void {
    const m = this.match;
    if (!m || m.finished || m.session.over || !PLAY_SCREENS.has(this.router.current)) return;
    m.session.pause();
    this.router.go('pause', { kind: m.kind });
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
    this.match = { make: null, level: null, controls: null, ...m, doneAt: null, finished: false, frozen: false };
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

  /** Pauses a local match on blur, hidden tab or fullscreen exit (online never pauses: its overlay says "click to focus"). */
  private autoPause(): void {
    if (this.match?.kind !== 'online') this.pauseMatch();
  }

  /**
   * Moves on to Results once the match is over (Training: once its lessons are done, or it ended
   * without them); back to the match when an online session starts its rematch.
   */
  private checkEnd(m: Match): void {
    if (m.finished) {
      if (m.kind === 'online' && !m.session.over && this.router.current === 'results') {
        m.finished = false;
        this.router.go('match');
      }
      return;
    }
    const now = this.scheduler.now();
    if (m.kind === 'training') {
      const training = m.session;
      if (training instanceof LocalSession && training.trainingDone && m.doneAt === null) {
        m.doneAt = now;
        if (!this.settings.trainingDone) this.setSettings({ trainingDone: true });
      }
      if (m.doneAt !== null && now - m.doneAt >= TRAINING_END_MS) this.finish(m, { kind: 'training', done: true }, true);
      else if (m.doneAt === null && training.over) this.finish(m, { kind: 'training', done: false }, false);
      return;
    }
    const result = m.session.over ? m.session.result : null;
    if (result === null) return;
    const viewer = m.session.view?.viewer;
    const me = viewer === 1 ? 1 : 0;
    const newBelt = m.kind === 'cpu' ? this.recordCpuMatch(m.level ?? 0, result) : null;
    this.finish(m, { kind: m.kind === 'online' ? 'online' : 'cpu', result, viewer: me, newBelt, canRematch: m.make !== null || m.controls?.rematch !== undefined }, false);
  }

  private finish(m: Match, params: ResultsParams, freeze: boolean): void {
    m.finished = true;
    m.frozen = freeze;
    this.router.go('results', params);
  }

  /**
   * A finished vs-CPU match goes into the career (spec §3.11) and counts towards the first-matches
   * hints; the highest belt becomes the headband unless the player chose one. Returns a newly earned belt.
   */
  private recordCpuMatch(level: number, r: MatchState): Belt | null {
    const before = this.career.earned;
    this.career = recordCareer(this.career, level, r.winner === 0, averageWpm(r.stats[0]));
    save('career', this.career);
    this.setSettings({ matchesPlayed: this.settings.matchesPlayed + 1 });
    const best = highestBelt(this.career);
    if (!this.headbandChosen && best !== null && this.profile.look.headband !== BELT_COLOR[best]) {
      this.setProfile({ ...this.profile, look: { ...this.profile.look, headband: BELT_COLOR[best] } }, false);
    }
    return (this.career.earned.find((b) => !before.includes(b)) as Belt | undefined) ?? null;
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
    this.checkEnd(m);
  }

  /** The attract demo: drawn, but its sound, crowd and umpire muted (spec §4.6). */
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

  private registerScreens(): void {
    const r = this.router;
    r.register('gate', gateScreen(this));
    r.register('title', titleScreen(this));
    r.register('mainMenu', mainMenuScreen(this));
    r.register('cpuSetup', cpuSetupScreen(this));
    r.register('customize', customizeScreen(this));
    r.register('options', optionsScreen(this));
    r.register('howTo', howToScreen(this));
    r.register('match', playScreen(this, 'cpu'));
    r.register('training', trainingScreen(this));
    r.register('pause', pauseScreen(this));
    r.register('results', resultsScreen(this));
    registerOnlineScreens(r, {
      profile: () => clone(this.profile),
      settings: () => clone(this.settings),
      startMatch: (session, controls) => this.startOnline(session, controls),
    });
  }

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

  /** Keeps `#ui` exactly over the canvas with `--u` = one game pixel (spec §4.6, R24). */
  private placeUi(info: ScaleInfo): void {
    const s = this.ui.style;
    s.left = `${info.offsetX}px`;
    s.top = `${info.offsetY}px`;
    s.width = `${info.cssW}px`;
    s.height = `${info.cssH}px`;
    s.setProperty('--u', `${cssUnit(info)}px`);
    if (info.k < 2 && !this.fitNoticeShown) {
      this.fitNoticeShown = true;
      toast(this.notices, NOTICE_FIT);
    }
  }

  /** Dev/E2E (`?screen=`): jumps straight to screen `name` with sample data, skipping the start gate. */
  private showDevScreen(name: string, q: URLSearchParams): void {
    const r = this.router;
    if (name === 'gate') return r.go('gate');
    r.go('title');
    if (name === 'title') return;
    r.go('mainMenu');
    if (name === 'match' || name === 'pause') {
      this.startCpuMatch();
      if (name === 'pause') this.pauseMatch();
    } else if (name === 'training') {
      this.startTraining();
    } else if (name === 'results') {
      r.go('results', sampleResults(this.profile, q.get('sample')));
    } else if (name === 'join') {
      r.go('join', { code: q.get('join') });
    } else if (name !== 'mainMenu') {
      try {
        r.go(name);
      } catch {
        console.warn(`[bbt] ?screen=${name}: no such screen`);
      }
    }
  }
}
