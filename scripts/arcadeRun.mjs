/**
 * `node scripts/arcadeRun.mjs [--full]` (Arcade spec §7, in the browser): plays Black Belt Tennis
 * Arcade by keyboard in the local Chrome, against the Vite dev server (scripts/lib/pageShot.mjs), on
 * `arcade/index.html?debug`, whose `window.__arcade` hooks show the match state.
 *
 * Gate (click) → title → PRESS ENTER → main menu → PLAY VS CPU → setup, then `__arcade.startMatch(0, 1)`:
 * the saved setup (a fresh browser: a Normal-pace tiebreak on hard) against the White belt, seed 1.
 * The player serves as the How to Play screen says: tap J to toss, tap J again about 650 ms later
 * (just after the top of the toss) with D held. Returns are pressed early: J once a ball comes,
 * about 0.55 s before the predicted contact, while moving toward the ball's predicted spot (from
 * `__arcade.state().flight`); the swing is automatic. A ball that will land out is let go.
 *
 * About 10 s of play after the first serve, longer until the player's first return, then the
 * summary: the player's returns and serves, points played, screenshots. With `--full`, play goes on
 * to Results. Screenshots go to artifacts/arcade/ (cleared first): title, menu, setup, serve (the
 * first toss), rally (just after the player's first return) and, with --full, results.
 *
 * Exits 1 when the page logs a console error, when the player has not returned a ball within 20 s
 * of match time, on a timeout, or when Chrome or the server can't start; 0 otherwise. The browser and
 * the server are always closed.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, openReadyPage, startDevServer } from './lib/pageShot.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'artifacts', 'arcade');
const VIEWPORT = { width: 960, height: 540 };
const FULL = process.argv.includes('--full');
/** Longest wait for a page or a screen. */
const STEP_MS = 20_000;
/** Match time (s) of play after the first serve, and the latest match time for the player's first return. */
const PLAY_S = 10;
const FIRST_RETURN_S = 20;
/** With --full: the latest match time (s) for Results. */
const FULL_S = 8 * 60;
/** Wall-clock cap for the match, whatever the match time says (a stalled page). */
const WALL_MS = FULL ? 10 * 60_000 : 90_000;
const POLL_MS = 8;
const TICK_HZ = 60;

/** Court and rules numbers the player needs (src/core/court.ts COURT, src/arcade/core/tuning.ts ARCADE). */
const HALF_WIDTH = 4.115;
const HALF_LENGTH = 11.885;
const BALL_R = 0.033;
const MAX_ABS_X = 6.5;
const MAX_BEHIND = 2.0;
const NET_GAP = 0.4;
/** Ticks from the toss to its top (serve.apexTime 0.65 s at Normal pace). */
const SERVE_TICKS = 39;
/**
 * Contact heights a groundstroke is planned for after the bounce: the CPU's band (src/arcade/core/cpu.ts),
 * then, for a slice that bounces lower, most of the reach zone's 0.15–2.7 m.
 */
const BANDS = [
  { lo: 0.5, hi: 1.4 },
  { lo: 0.2, hi: 2.5 },
];
/**
 * Contacts are planned at least this far past the bounce (more than the 1.4 m reach), so the ball
 * can't dip out of the reach zone just before bouncing, which swings at it as a half-volley.
 */
const PAST_BOUNCE = 1.6;
/** Stand this far beside the ball's track, on the forehand side. */
const SIDE = 0.7;
/** Running speed assumed when planning (top speed 6 m/s less the acceleration), and the slack allowed. */
const RUN = 5.0;
const SLACK = 0.3;
/** Commit this long before the predicted contact: the charge fills in 0.5 s, and PERFECT is the next 0.12 s. */
const LEAD_S = 0.56;
/** Held keys stop this close to the spot. */
const DEADBAND = 0.2;
/** Where the player waits between shots: behind the centre of the baseline. */
const HOME = { x: 0, y: -(HALF_LENGTH + 0.8) };

const log = (line) => console.log(`[arcadeRun] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shots = [];

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  shots.push(`${name}.png`);
}

const visible = (page, selector, timeout = STEP_MS) => page.locator(selector).first().waitFor({ state: 'visible', timeout });

/** Clicks the menu button labelled exactly `label` once it is visible and enabled. */
const click = (page, label) => page.locator('#ui button', { hasText: new RegExp(`^${label}$`) }).first().click({ timeout: STEP_MS });

/** Server of the current point (src/core/scoring.ts currentServer). */
function serverOf(score) {
  if (!score.inTiebreak) return score.gameServer;
  const played = score.points[0] + score.points[1];
  return Math.floor((played + 1) / 2) % 2 === 0 ? score.gameServer : 1 - score.gameServer;
}

/** Ball position `t` s after the flight's hit (src/arcade/core/flight.ts flightPos). */
function flightPos(f, t) {
  const c = Math.min(Math.max(t, 0), f.tGone);
  let seg = f.segments[0];
  for (const s of f.segments) if (s.t0 <= c) seg = s;
  const d = c - seg.t0;
  const at = (k) => seg.p0[k] + seg.v0[k] * d + 0.5 * seg.a[k] * d * d;
  return { x: at('x'), y: at('y'), z: at('z') };
}

/** True when a ground point is in player 0's singles half (lines in). */
const inNearCourt = (p) => Math.abs(p.x) <= HALF_WIDTH + BALL_R && p.y <= BALL_R && p.y >= -(HALF_LENGTH + BALL_R);

const clampSpot = (p) => ({
  x: Math.min(MAX_ABS_X, Math.max(-MAX_ABS_X, p.x)),
  y: Math.min(-NET_GAP, Math.max(-(HALF_LENGTH + MAX_BEHIND), p.y)),
});

/**
 * Where and when player 0 meets the incoming flight `f` (it is now `ft` s after its hit, the player at
 * `pos`): the first tick, PAST_BOUNCE beyond the bounce, with the ball in a groundstroke band (the
 * first band, then the next) that the player can run to, else the one it misses by least; null for a
 * net ball, a ball landing out, or one that never comes into a band.
 */
function planFor(f, pos, ft) {
  const first = f.bounces[0];
  if (f.net || first === undefined || !inNearCourt(first.at)) return null;
  let best = null;
  for (const band of BANDS) {
    for (let n = Math.floor(Math.max(ft, first.t) * TICK_HZ) + 1; n / TICK_HZ < f.tEnd; n++) {
      const t = n / TICK_HZ;
      const b = flightPos(f, t);
      if (b.z < band.lo || b.z > band.hi || b.y >= 0 || Math.hypot(b.x - first.at.x, b.y - first.at.y) < PAST_BOUNCE) continue;
      const spot = clampSpot({ x: b.x - SIDE, y: b.y });
      const lateBy = Math.hypot(spot.x - pos.x, spot.y - pos.y) - RUN * (t - ft) - SLACK;
      if (lateBy <= 0) return { t, spot };
      if (best === null || lateBy < best.lateBy) best = { t, spot, lateBy };
    }
  }
  return best;
}

/** Movement keys toward `to` from `pos` for player 0 (screen right = +x, up = toward the net = +y). */
function keysToward(pos, to) {
  const keys = [];
  if (to.x > pos.x + DEADBAND) keys.push('KeyD');
  else if (to.x < pos.x - DEADBAND) keys.push('KeyA');
  if (to.y > pos.y + DEADBAND) keys.push('KeyW');
  else if (to.y < pos.y - DEADBAND) keys.push('KeyS');
  return keys;
}

/** The keyboard player: held keys and the presses made so far. */
class Player {
  constructor(page) {
    this.page = page;
    this.held = new Set();
    /** Set-up (phase.since) already tossed in; toss (tick) already struck; flight (hit tick) already committed to. */
    this.tossedIn = null;
    this.struck = null;
    this.committedTo = null;
    /** The plan for the incoming flight, by its hit tick. */
    this.plan = null;
    this.serves = 0;
  }

  /** Holds exactly `keys` (presses the new ones, releases the rest). */
  async hold(keys) {
    const want = new Set(keys);
    for (const k of [...this.held]) {
      if (!want.has(k)) {
        await this.page.keyboard.up(k);
        this.held.delete(k);
      }
    }
    for (const k of want) {
      if (!this.held.has(k)) {
        await this.page.keyboard.down(k);
        this.held.add(k);
      }
    }
  }

  /** A shot-key tap (the game latches a tap shorter than a tick). */
  async tap(code) {
    await this.page.keyboard.down(code);
    await this.page.keyboard.up(code);
  }

  /** One look at the state `s` and the keys for it. */
  async act(s) {
    const me = s.p[0];
    const phase = s.phase.kind;
    if (phase === 'setup' && serverOf(s.score) === 0) {
      await this.hold([]);
      if (this.tossedIn !== s.phase.since) {
        this.tossedIn = s.phase.since;
        await this.tap('KeyJ');
      }
      return;
    }
    if (phase === 'toss' && s.toss?.player === 0) {
      await this.hold(['KeyD']);
      if (this.struck !== s.toss.tick && s.tick - s.toss.tick >= SERVE_TICKS) {
        this.struck = s.toss.tick;
        this.serves++;
        await this.tap('KeyJ');
      }
      return;
    }
    const f = s.flight;
    if (phase !== 'rally' || f === null) {
      await this.hold([]);
      return;
    }
    const ft = (s.tick - f.hit.tick) / TICK_HZ;
    if (f.hit.player === 0 || ft >= f.tEnd) {
      await this.hold(keysToward(me.pos, HOME));
      return;
    }
    if (this.plan?.flight !== f.hit.tick) this.plan = { flight: f.hit.tick, meet: planFor(f, me.pos, ft) };
    const meet = this.plan.meet;
    if (meet === null) {
      await this.hold([]);
      return;
    }
    await this.hold(keysToward(me.pos, meet.spot));
    if (me.commit === null && this.committedTo !== f.hit.tick && meet.t - ft <= LEAD_S) {
      this.committedTo = f.hit.tick;
      await this.tap('KeyJ');
    }
  }
}

/** The page's match state, `window.__arcade.state()`. */
const stateOf = (page) => page.evaluate(() => window.__arcade.state());

/**
 * Plays until the match time `endS(state)` says to stop (null: go on); the serve and rally
 * screenshots on the way. Resolves to the final state.
 */
async function play(page, player, done) {
  const wallEnd = Date.now() + WALL_MS;
  let s = await stateOf(page);
  for (;;) {
    if (!shots.includes('serve.png') && s.phase.kind === 'toss' && s.tick - s.toss.tick >= 12) await shot(page, 'serve');
    if (!shots.includes('rally.png') && s.stats[0].hits > 0 && s.flight?.hit.player === 0 && s.tick - s.flight.hit.tick >= 9) await shot(page, 'rally');
    if (done(s)) return s;
    if (Date.now() > wallEnd) throw new Error(`timed out after ${WALL_MS} ms of play; match time ${(s.tick / TICK_HZ).toFixed(1)} s`);
    await player.act(s);
    await sleep(POLL_MS);
    s = await stateOf(page);
  }
}

async function run(browser, origin) {
  const tab = await openReadyPage(browser, `${origin}/arcade/index.html?debug`, { viewport: VIEWPORT, timeout: STEP_MS, tag: 'arcadeRun' });
  const { page } = tab;
  try {
    await visible(page, '.screen.gate');
    await page.locator('.screen.gate').click();
    await visible(page, '.screen.title');
    await page.waitForTimeout(600);
    await shot(page, 'title');
    await click(page, 'PRESS ENTER');
    await visible(page, '.screen.main-menu');
    await page.waitForTimeout(300);
    await shot(page, 'menu');
    await click(page, 'PLAY VS CPU');
    await visible(page, '.panel.setup');
    await shot(page, 'setup');

    await page.evaluate(() => window.__arcade.startMatch(0, 1));
    await visible(page, '.screen.play.cpu');
    await page.waitForFunction(() => window.__arcade.state() !== null, null, { timeout: STEP_MS });
    const start = await stateOf(page);
    const [you, cpu] = start.players;
    if (cpu.cpuLevel !== 0 || you.kind !== 'human') throw new Error(`expected you vs the White belt, got ${you.name} vs ${cpu.name} (level ${cpu.cpuLevel})`);
    log(`match: ${you.name} vs ${cpu.name}, ${start.config.format} at ${start.config.pace} pace on ${start.config.surface}; ${serverOf(start.score) === 0 ? 'you serve' : 'the CPU serves'} first`);

    const player = new Player(page);
    let servedAt = null;
    const matchS = (s) => s.tick / TICK_HZ;
    let s = await play(page, player, (st) => {
      if (servedAt === null && st.point.hits > 0) servedAt = matchS(st);
      const returned = st.stats[0].hits > 0;
      if (!returned && matchS(st) >= FIRST_RETURN_S) return true;
      if (FULL) return st.status === 'over' || matchS(st) >= FULL_S;
      return returned && servedAt !== null && matchS(st) >= servedAt + PLAY_S;
    });
    await player.hold([]);
    if (s.stats[0].hits === 0) throw new Error(`no return by the player within ${FIRST_RETURN_S} s of match time (${s.pointNo} points played)`);
    if (FULL) {
      if (s.status !== 'over') throw new Error(`the match is not over after ${FULL_S} s of match time`);
      await visible(page, '.panel.results', STEP_MS);
      await page.waitForTimeout(300);
      await shot(page, 'results');
      s = await stateOf(page);
    }
    if (tab.errorCount > 0) {
      const errors = tab.transcript.filter((l) => l.startsWith('[console.error]') || l.startsWith('[pageerror]'));
      throw new Error(`the page logged ${tab.errorCount} error(s):\n${errors.join('\n')}`);
    }
    const st = s.stats;
    log(`your returns: ${st[0].hits} (${st[0].perfectHits} perfect); your serves: ${player.serves}; CPU returns: ${st[1].hits}`);
    log(`points played: ${s.pointNo} (you ${st[0].pointsWon}, CPU ${st[1].pointsWon}); longest rally ${s.longestRally}; match time ${matchS(s).toFixed(1)} s`);
    if (FULL) log(`result: ${s.winner === 0 ? 'you won' : 'the CPU won'}`);
  } finally {
    await page.context().close();
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const { server, origin } = await startDevServer(ROOT);
  let browser = null;
  try {
    log(`vite dev server: ${origin}`);
    browser = await launchChrome();
    await run(browser, origin);
    return 0;
  } finally {
    log(`${shots.length} screenshots in artifacts/arcade/: ${shots.join(', ') || '(none)'}`);
    await browser?.close();
    await server.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[arcadeRun] FAIL: ${err.message ?? err}`);
    process.exitCode = 1;
  },
);
