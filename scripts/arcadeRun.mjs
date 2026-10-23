/**
 * `node scripts/arcadeRun.mjs [--full]` (Arcade spec §7, in the browser): plays Black Belt Tennis
 * Arcade by keyboard in the local Chrome, against the Vite dev server (scripts/lib/pageShot.mjs), on
 * `arcade/index.html?debug`, whose `window.__arcade` hooks show the match state.
 *
 * Gate (click) → title → PRESS ENTER → main menu → PLAY VS CPU → setup, then `__arcade.startMatch(0, 1)`:
 * the saved setup (a fresh browser: a Normal-pace tiebreak on hard) against the White belt, seed 1.
 * The player is scripts/lib/arcadeBot.mjs on player 0: it serves as the How to Play screen says and
 * returns by pressing J early, about 0.55 s before the predicted contact (from
 * `__arcade.state().flight`), while moving to the ball; the swing is automatic.
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
import { ArcadeBot, serverOf, TICK_HZ } from './lib/arcadeBot.mjs';
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

    const player = new ArcadeBot(page, 0);
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
