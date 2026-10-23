import { AudioEngine } from '../../audio/engine';
import { Umpire } from '../../audio/speech';
import { startLoop } from '../../game/loop';
import { Screen } from '../../render/screen';
import { fontsReady } from '../../ui/boot';
import { blurActive } from '../../ui/dom';
import { Overlay } from '../../ui/overlay';
import { humanPlayer } from '../../ui/players';
import { Router } from '../../ui/router';
import { guardOnlineMatch, hostLobbyScreen, joinScreen, type JoinParams, type LobbyContext } from '../../ui/lobbyScreens';
import { customizeScreen } from '../../ui/screens/customize';
import { gateScreen } from '../../ui/screens/gate';
import { randomSeed } from '../../ui/seed';
import type { Profile } from '../../ui/settings';
import { ArcadeDirector } from '../audio/director';
import { ArcadeCpu } from '../core/cpu';
import { DT } from '../core/tuning';
import type { ArcadeConfig, ArcadeState, PlayerId } from '../core/types';
import { debugLagMs, installArcadeDebug, type ArcadeDebug } from '../game/debug';
import { HeldKeys, KeyboardController } from '../game/keys';
import type { ArcadeOnlineSession, NetStats } from '../game/onlineSession';
import { ArcadeSession, type ArcadeView } from '../game/session';
import type { ArcadeMsg } from '../net/protocol';
import { ArcadeRenderer } from '../render/renderer';
import { ArcadeAttract } from './attract';
import type { ArcadeContext } from './context';
import { arcadeLogoCanvas } from './logo';
import { arcadeBrowserEnv, arcadeLobbyGame, type ArcadeOnlineEnv } from './online';
import { arcadeCpuPlayer } from './players';
import { cpuSetupScreen } from './screens/cpuSetup';
import { howToScreen } from './screens/howTo';
import { mainMenuScreen } from './screens/mainMenu';
import { matchScreen } from './screens/match';
import { optionsScreen } from './screens/options';
import { pauseScreen } from './screens/pause';
import { resultsScreen, type OnlineResults, type ResultsParams } from './screens/results';
import { titleScreen } from './screens/title';
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

/** What the app drives: a local ArcadeSession, or one side of an online match. */
interface MatchSession {
  frame(dtMs: number): ArcadeView;
  readonly view: ArcadeView | null;
  readonly over: boolean;
  readonly result: Readonly<ArcadeState> | null;
  pause(): void;
  resume(): void;
  dispose(): void;
}

/**
 * The match being played: its session; vs CPU, its setup (for Restart and Rematch); online, the
 * session and what to run once the app is done with it (page guards, the host's game code); whose
 * side the screen shows; and the Results showing (null while it is played).
 */
interface Match {
  session: MatchSession;
  setup: MatchSetup | null;
  online: { session: ArcadeOnlineSession; release: () => void } | null;
  viewer: PlayerId;
  results: ResultsParams | null;
}

/** The match options of a CPU setup (the host lobby starts from them). */
function configOf(s: Readonly<{ level: number } & ArcadeConfig>): ArcadeConfig {
  return { format: s.format, deuceRule: s.deuceRule, surface: s.surface, pace: s.pace };
}

/** What online Results say (online spec §3.6): Rematch while possible, who forfeited, how the opponent went and whether that ended the match. */
function onlineResults(s: ArcadeOnlineSession): OnlineResults {
  const gone = s.opponentGone;
  return {
    canRematch: s.mayRematch,
    forfeitBy: s.forfeitBy,
    opponentGone: gone,
    endedBy: gone !== null && s.endReason === gone ? gone : null,
    lost: s.endReason === 'disconnect' && gone === null,
  };
}

/**
 * The Arcade app (spec §6.3, online spec §5): owns the canvas Screen and ArcadeRenderer, audio
 * (engine, umpire, director), the HeldKeys, the Router on the `#ui` Overlay, the attract demo and the
 * current match (vs CPU, or online from the Host / Join screens), and drives them from one loop:
 * session.frame → renderer.draw → director.consume. Its saved data is the Arcade's own ArcadeStore.
 * The keys are enabled only on the match screen. A local match pauses behind its menu and on blur, a
 * hidden tab or leaving fullscreen; an online one never pauses, and shows "CLICK TO FOCUS" after the
 * window loses the focus instead.
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
  private readonly onlineEnv: ArcadeOnlineEnv;
  /** The window lost the focus during an online match (until a click or the focus comes back). */
  private blurred = false;
  private gateOpen = false;
  /** The debug hooks (dev builds and `?debug` pages), else null. */
  private debug: ArcadeDebug | null = null;
  private storageNoticeShown = false;

  /** `online`: the network and clock of the online screens; the browser's (with any debug `?lag=`) by default. */
  constructor(el: ArcadeElements, online?: ArcadeOnlineEnv) {
    this.onlineEnv = online ?? arcadeBrowserEnv(debugLagMs(location.search));
    this.root = el.root;
    this.screen = new Screen(el.canvas);
    this.renderer = new ArcadeRenderer(this.screen);
    this.umpire = new Umpire(() => this.settings.volumes.master * this.settings.volumes.sfx);
    this.umpire.enabled = false;
    this.director = new ArcadeDirector(this.audio, this.umpire, {
      surface: () => this.match?.session.view?.state.config.surface ?? 'hard',
      viewer: () => this.match?.viewer ?? 0,
    });
    this.audio.setVolumes(this.settings.volumes);

    this.overlay = new Overlay(el.ui);
    this.router = new Router(this.overlay.screens, (name) => this.onScreen(name));
    this.overlay.place(this.screen.info);
    this.screen.onChange((info) => this.overlay.place(info));

    this.keys = new HeldKeys(window, () => this.pauseMatch());
    window.addEventListener('blur', () => this.autoPause(true));
    window.addEventListener('focus', () => {
      this.blurred = false;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.autoPause(true);
    });
    // In fullscreen the browser takes Esc to leave it, so the page never sees that keydown.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) this.autoPause(false);
    });
  }

  /** Registers the screens, waits for the fonts, starts the loop and shows the gate. */
  async start(): Promise<void> {
    const r = this.router;
    r.register('gate', gateScreen(this, arcadeLogoCanvas));
    r.register('title', titleScreen(this));
    r.register('mainMenu', mainMenuScreen(this));
    r.register('cpuSetup', cpuSetupScreen(this));
    r.register('customize', customizeScreen(this));
    r.register('options', optionsScreen(this));
    r.register('howTo', howToScreen(this));
    r.register('match', matchScreen(this));
    r.register('pause', pauseScreen(this));
    r.register('results', resultsScreen(this));
    const lobby: LobbyContext<ArcadeConfig, ArcadeMsg, ArcadeOnlineSession> = {
      router: r,
      profile: () => structuredClone(this.profile),
      config: () => configOf(this.cpuSetup),
      env: this.onlineEnv,
      begin: (session, release) => this.startOnline(session, release),
    };
    const game = arcadeLobbyGame(this.onlineEnv, new KeyboardController(this.keys));
    r.register('host', hostLobbyScreen(lobby, game));
    r.register('join', joinScreen(lobby, game));
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
    // An invite link (`?join=CODE`) opens Join with the code filled in, Back leading to the main menu.
    const code = new URLSearchParams(location.search).get('join');
    if (code === null) return;
    this.router.go('mainMenu');
    const params: JoinParams = { code };
    this.router.go('join', params);
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

  /** The current online match's netcode numbers, or null without one. */
  netStats(): NetStats | null {
    return this.match?.online?.session.netStats() ?? null;
  }

  rematch(): void {
    const online = this.match?.online;
    if (online) online.session.rematch();
    else this.restartMatch();
  }

  /**
   * Opens the in-match menu (Esc/Tab, the pause icon; for a local match also blur, a hidden tab or
   * leaving fullscreen, see autoPause), pausing a local match: from the match screen only, and not once
   * the match is decided.
   */
  pauseMatch(): void {
    const m = this.match;
    if (!m || this.router.current !== 'match' || m.results !== null || m.session.view?.state.status === 'over') return;
    m.session.pause();
    this.router.go('pause', { kind: m.online ? 'online' : 'cpu' });
  }

  /** From the in-match menu only (a stray resume would restart the countdown): the match screen, then (local) 3-2-1. */
  resumeMatch(): void {
    const m = this.match;
    if (!m || this.router.current !== 'pause') return;
    m.session.resume();
    this.router.back();
  }

  restartMatch(): void {
    const setup = this.match?.setup;
    if (setup) this.beginMatch(setup, randomSeed());
  }

  forfeitMatch(): void {
    const online = this.match?.online;
    if (!online) return;
    online.session.forfeit();
    if (this.router.current === 'pause') this.router.back();
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
    this.blurred = false;
    this.root.focus({ preventScroll: true });
  }

  // Loop and screens ------------------------------------------------------------------------

  private frame(dt: number): void {
    const m = this.match;
    if (m) this.playFrame(m, dt);
    else if (ATTRACT_SCREENS.has(this.router.current)) this.draw(this.attract.frame(dt), dt);
    this.debug?.frame();
  }

  /** One frame of the match (drawn behind the menu and Results too); Results once it is over. */
  private playFrame(m: Match, dt: number): void {
    let view = m.session.frame(dt);
    if (m.online && this.blurred) view = { ...view, overlay: { ...view.overlay, focusLost: true } };
    try {
      this.draw(view, dt);
      // Events come from this frame's ticks: their age is the sim time since their tick.
      this.director.consume(view, (e) => (view.t - e.tick * DT) * 1000);
    } finally {
      // Results come whatever the drawing did, so a match that cannot be drawn can still be left.
      this.checkEnd(m, view);
    }
  }

  /**
   * Results once the match is over. Online (online spec §3.6) they go back to the match when a
   * rematch starts, and show again with Rematch disabled once the opponent goes after the match.
   */
  private checkEnd(m: Match, view: ArcadeView): void {
    const online = m.online?.session ?? null;
    if (m.results !== null) {
      if (online === null || this.router.current !== 'results') return;
      if (!online.over) {
        m.results = null;
        this.router.go('match');
      } else if (online.opponentGone !== null && m.results.online?.opponentGone === null) {
        this.showResults(m, { ...m.results, online: onlineResults(online) });
      }
      return;
    }
    if (!m.session.over) return;
    this.showResults(m, { result: m.session.result ?? view.state, viewer: m.viewer, online: online === null ? undefined : onlineResults(online) });
  }

  private showResults(m: Match, params: ResultsParams): void {
    m.results = params;
    this.router.go('results', params);
  }

  /** Blur, a hidden tab or leaving fullscreen: a local match pauses; an online one goes on, and a lost focus is shown. */
  private autoPause(lostFocus: boolean): void {
    if (this.match?.online) {
      if (lostFocus) this.blurred = true;
      return;
    }
    this.pauseMatch();
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
    this.match = { session, setup, online: null, viewer: 0, results: null };
    this.router.go('match');
  }

  /** An online match the Host or Join screen started: shown from this side's end, with the page guards while it runs. */
  private startOnline(session: ArcadeOnlineSession, release: () => void): void {
    this.endMatch();
    const unguard = guardOnlineMatch(session);
    this.blurred = false;
    this.match = {
      session,
      setup: null,
      online: {
        session,
        release: () => {
          unguard();
          release();
        },
      },
      viewer: session.viewer,
      results: null,
    };
    this.router.go('match');
  }

  /** Disposes of the current match (an online one leaves, and its guards and game code go). */
  private endMatch(): void {
    const m = this.match;
    if (!m) return;
    m.session.dispose();
    m.online?.release();
    this.match = null;
  }

  /** Says once per visit that progress can't be saved: at boot (the storage probe), or at the first save that fails. */
  private storageNotice(): void {
    if (this.storageNoticeShown) return;
    this.storageNoticeShown = true;
    this.overlay.notice(NOTICE_STORAGE);
  }
}
