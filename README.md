# Black Belt Tennis

A retro pixel-art tennis match decided by typing. Toss the ball and type a word before it drops to
serve. Retype your opponent's word to run to the ball, then pick your shot by its first letter: harder
words aim for the corners, arrive sooner and are harder to return, but they punish typos. Play a CPU
opponent across 15 karate belts, or a friend online with a five-character code. It runs in a desktop
browser (Chrome, Edge, Firefox) with a physical keyboard, with nothing to install.

## Screenshots

No screenshots are committed. `npm run e2e` (see [below](#end-to-end-run-npm-run-e2e)) plays the
production build and saves fresh ones to `artifacts/e2e/`, which is git-ignored and cleared on each
run:

| File in `artifacts/e2e/` | What it shows |
|---|---|
| `1-gate.png`, `1-title.png` | The start gate, then the title over the attract demo (CPU vs CPU) |
| `2-<screen>-960x540.png`, `2-<screen>-1920x1080.png` | Every screen at both sizes: `gate`, `title`, `mainMenu`, `cpuSetup`, `customize`, `options`, `howTo`, `match`, `pause`, `training`, `results`, `host` and `join` |
| `3-training-preServe.png`, `3-training-toss.png`, `3-training-pointCall.png` | Training's first lesson: the coach's SPACE prompt, the toss with its serve words, the point call |
| `4-match-preServe.png`, `4-match-toss.png` | A vs-CPU match: waiting to serve, then the toss with the three serve words |
| `4-match-chase.png`, `4-match-choice.png` | The return: retyping the opponent's word to run, then picking a shot by its first letter |
| `4-match-pointCall.png`, `4-match-results.png` | The umpire's call at the end of a point, and the Results after the match |
| `5-online-host-*.png`, `5-online-guest-*.png` | Both sides of an online match (`lobby`, `chase`, `pointCall`, `2points`), when the PeerJS broker is reachable |

## How to play

Only one player types at a time, and every point is a chain of typed words.

**Serve.** Press <kbd>Space</kbd> to toss. Three words appear above you: easy, medium and hard. Easy
is sky blue with one pip, medium is yellow with two, hard is vermillion with three. Type one before
the ball drops. The first letter locks your choice. A serve struck before the ball starts to fall
keeps its full speed. If you lock nothing, you catch the ball and toss again with new words. If you
lock a word and don't finish it, the ball drops: fault. A 30-second serve clock runs until you
strike, and running out is a fault. Two faults lose the point.

**Return.** When your opponent strikes, the word they hit with appears above you. Type it to run to
the ball (the chase). Three shot words then appear on your opponent's side: type the first letter of
one to pick it, and finish it before the ball reaches you. Finish just late and you play a stretch
shot, which is slower and riskier. Finish too late and the ball goes past you: an ace or a winner.

**Placement.** Easy shots land deep in the middle and are safe. Medium goes near a sideline. Hard
goes 0.5 m inside the sideline and the baseline. It reaches your opponent sooner and is the hardest
to return, but it is the most sensitive to typos. Serve targets work the same way in the service box.
Typing a word faster hits the ball faster, and rallies speed up the longer they last.

**Typos.** The cursor is strict: a wrong key doesn't advance and there is no backspace. Every slip on
your shot word raises the chance of hitting the net or out, most of all on hard shots. Slips on a
chase word only cost time. A shot typed without a slip and struck in time never goes out or into
the net.

**Scoring** is real tennis scoring. Formats: Tiebreak (a single tiebreak to 7, win by 2), Short set
(first to 4 games, tiebreak at 4–4), Full set (first to 6 games, tiebreak at 6–6) and Best of 3 short
sets. A new player's first vs-CPU setup is a White belt at Relaxed pace in the Tiebreak format. After
that, setup remembers the format you last picked, and the host lobby starts from it. At deuce, play
Advantage or a Golden point.

## Controls

| Input | Action |
|---|---|
| <kbd>Space</kbd> | Toss the ball when you are serving |
| <kbd>A</kbd>–<kbd>Z</kbd> | Type. Case doesn't matter; on a non-Latin layout each key types its US-layout letter |
| <kbd>Esc</kbd>, <kbd>Tab</kbd> or the pause icon | In-match menu. It pauses a match vs the CPU or a Training session; an online match keeps running |
| Fullscreen button | On the title, main menu and pause menu. There is no letter hotkey, because letters are always typing. In fullscreen, the first <kbd>Esc</kbd> leaves fullscreen |

Every other key is ignored and never counts as a typo. F1–F12 keep working (reload, fullscreen, dev
tools). A match against the CPU also pauses when you switch tabs or windows. It resumes with a 3-2-1
countdown.

## Modes

- **Training** walks you through the serve, the return, a three-shot rally and one real point
  against a White-belt coach, at a relaxed pace. On your first launch, a panel beside the main menu
  offers it: **Training** (focused, so <kbd>Enter</kbd> starts it) or **Later**, which puts the offer
  away for good. Training stays first on the main menu until you finish it once.
- **Play vs CPU** has 15 levels shown as belts. Each belt from White to Brown has 0–2 stripes, and
  after them come Black, Black 2nd dan and Black 3rd dan:

  | Belt | White | Yellow | Green | Brown | Black | 2nd dan | 3rd dan |
  |---|---|---|---|---|---|---|---|
  | WPM | 25 · 28 · 31 | 35 · 38 · 41 | 45 · 51 · 58 | 65 · 72 · 81 | 90 | 105 | 120 |

  Beat any level of a colour, stripes and dan grades included, to earn that belt; every level you have
  beaten gets a tick on the belt strip. Your highest belt colours your default headband. Every
  level is always open. You also choose the format, pace, court (Hard, Clay, Grass or Dojo; the court
  is cosmetic), word pack and deuce rule, and setup remembers your last choices. Pace scales the
  ball's flight time: Relaxed ×1.5 (~30 WPM), Normal ×1.0 (~50 WPM), Fast ×0.75 (~70 WPM) and
  Lightning ×0.6 (~90 WPM). Your career record (vs CPU only) is kept in this browser.
- **Play Online**: one player chooses **Host Game** and shares the five-character code (or an invite
  link). The other chooses **Join Game** and enters it. The host sets the match, any change clears
  both Ready flags, and the match starts when both are Ready. Each turn is timed on the typist's own
  machine, so latency never shortens your time and hosting gives no advantage. Online matches have
  Rematch and Forfeit, and they don't count toward your career.

## Word packs

Pick a pack in Options, in vs CPU setup or in the host lobby: **Everyday** (the default, common
English words), **Sports** (words from many sports), **Dojo** (martial arts) or **Mixed** (all
three). Words are lowercase a–z: easy words have 3–5 letters, medium 6–9 and hard 10–14. The three
options always start with different letters that are not neighbours on a QWERTY keyboard. None of
the last 20 words offered comes back. No word names a shot or a direction (forehand, lob, wide,
deep, and so on), so a word never contradicts where the ball actually goes.

## Options

- **Options:** default pace, word pack and deuce rule. Master, music and effects volume. Umpire
  voice, which uses the browser's speech synthesis and needs a local English voice. Show WPM, large
  words, reduce effects (no shake or flash) and scaling: Pixel-perfect or Fit.
- **Customize:** name (up to 12 characters), skin, hair style and colour, shirt, shorts, headband
  (or none) and racket, with a live preview.

Settings, profile and career are stored in `localStorage` under `bbtennis:v1:`. In a browser mode
that blocks storage, or once a save fails (a full quota), the game says once that progress can't be
saved and plays on.

## Development

You need npm and Node `^22.22.2 || ^24.15.0 || >=26.0.0`, the versions both Vitest 5 and jsdom 30
support (the `engines` field in `package.json`; CI uses Node 24). Node 23 and 25 are not supported.
`art:export` and `e2e` also need a locally installed Google Chrome, which they drive through
`playwright-core` (no browser download).

```sh
npm ci
npm run dev        # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with hot reload |
| `npm run build` | Typecheck, then a production build into `dist/` (relative `base: './'`, so it runs from any path) |
| `npm run preview` | Serve the built `dist/` locally |
| `npm test` | All Vitest tests, including a smoke subset of the balance simulation |
| `npm run test:sim` | The full balance simulation of spec §6 (slow) |
| `npm run typecheck` | `tsc --noEmit -p .` (the game, tests and tools) and `tsc --noEmit -p tsconfig.node.json` (the Node-side tests in `tests/scripts/`) |
| `npm run art:export` | Screenshot every section of the art QA page (`tools/art.html`) to `artifacts/art/` |
| `npm run e2e` | Build the game and play it in the local Chrome, about 4 minutes (see [below](#end-to-end-run-npm-run-e2e)). Screenshots go to `artifacts/e2e/` |
| `npm run package:itch` | After `npm run build`, zip the contents of `dist/` into `black-belt-tennis-itch.zip`, with `index.html` at the zip root |

Build-time settings are Vite environment variables. Set them when you run `npm run build` (or
`npm run dev`):

| Variable | Effect |
|---|---|
| `VITE_PUBLIC_URL` | Public URL of the GitHub Pages build, ending in `/`. It enables the lobby's **Copy invite link** button (`<url>?join=CODE`), which is hidden when this is unset. The Pages workflow sets it for you |
| `VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_KEY` | Use your own PeerJS server instead of the public broker |
| `VITE_ICE_SERVERS` | A JSON array of `RTCIceServer` objects that replaces the default STUN/TURN list |

The design spec is in `docs/superpowers/specs/2026-09-26-black-belt-tennis-design.md`.

### End-to-end run (`npm run e2e`)

[`scripts/e2e.mjs`](scripts/e2e.mjs) builds the game with `vite build`, which overwrites `dist/`,
serves it with `vite preview` and plays it in your local Google Chrome through the `?e2e=1` test
hooks. A run takes about 4 minutes and has five scenarios:

1. Boot: the start gate, then the title over the attract demo.
2. Every screen at 960×540 and 1920×1080.
3. Training lesson 1, played by keyboard alone.
4. A full vs-CPU tiebreak against the White belt at Relaxed pace (the first-visit defaults), typed
   at 90 ms per key, with screenshots at the serve, toss, chase, shot choice, point call and results.
5. Online, best effort: two pages, a host and a guest, connect through the PeerJS broker and play
   2 points. When the broker is unreachable, this scenario is skipped with a warning; any other
   online failure fails the run.

Screenshots go to `artifacts/e2e/`, which each run clears first. The run prints PASS, WARN (skipped)
or FAIL for each scenario. It exits non-zero when a scenario fails (a page that logs an error fails
its scenario) or when the build, the server or Chrome can't start. The browser and the server are
always closed.

## Deploy to GitHub Pages

1. Push the repository to GitHub. On the Free plan, Pages needs a public repository.
2. Open **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. Set
   nothing else: no branch, no suggested workflow.
3. Push to `main`, or open **Actions → Deploy to GitHub Pages → Run workflow**.

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs `npm ci`, the typecheck, the
tests and the build, then deploys `dist/`. It sets `VITE_PUBLIC_URL` to the site's real address,
which `actions/configure-pages` reports as `base_url`: `https://<owner>.github.io/<repo>/` for a
project site, `https://<owner>.github.io/` for a `<owner>.github.io` repository, or your custom
domain. Invite links point at the page in every case, with nothing to edit.

## Deploy to itch.io

1. `npm run build && npm run package:itch` creates `black-belt-tennis-itch.zip`. For the invite-link
   button in the itch build, set `VITE_PUBLIC_URL` to your Pages address when you build. Invite links
   always open the Pages build.
2. On itch.io, create a project with **Kind of project: HTML**. Upload the zip and tick **This file
   will be played in the browser**.
3. Under **Embed options**, set the viewport to **960 × 540** (the 480×270 game at 2×) and turn on
   **Fullscreen button**. **SharedArrayBuffer support** is not needed, so leave it off.

You can also upload with [butler](https://itch.io/docs/butler/), which keeps versioned channels:

```sh
butler push black-belt-tennis-itch.zip <user>/<game>:html5
```

## Hosting trade-offs

| | GitHub Pages | itch.io |
|---|---|---|
| Cost | Free | Free (optional pay-what-you-want) |
| Deploy | Automatic from GitHub Actions on push | Zip upload or `butler push` (versioned channels) |
| Discovery | None — you share the URL | Browse pages, tags, jams, devlogs, comments, ratings |
| Analytics / payments | None | Built-in views/plays analytics; payments/donations |
| Page | Top-level page: focus, fullscreen, clipboard, invite links just work | Cross-origin iframe on your game page: click to focus, Space would scroll the page, clipboard may be blocked, page query strings (invite links) don't reach the game, localStorage shared with other itch games' origin |
| Repo | Free plan requires a public repo | Source can stay private |

Online play works the same on both (browser-to-browser via the PeerJS broker; no game server), and a
Pages player can join an itch host (same protocol and id namespace).

The game is built to cope with both hosts:

- storage keys carry a prefix;
- a click-to-start gate gives the page focus;
- keys are handled with `preventDefault` rules, so <kbd>Space</kbd> doesn't scroll the itch page;
- copying falls back from `navigator.clipboard` to `execCommand('copy')` to selecting the text and
  showing "Press Ctrl+C";
- fullscreen has a button, never a letter hotkey;
- invite links always point to the Pages build as `${VITE_PUBLIC_URL}?join=CODE`. The button is
  hidden when that variable is unset, and inside an iframe it reads "Copy browser invite link".

**Recommendation:** publish on both. Use Pages as the canonical link for invites and itch.io for
discovery.

## Online play notes

- **No game server.** The two browsers connect directly over WebRTC. PeerJS's free public broker
  (`0.peerjs.com`) only introduces them: the host registers as `bbtennis-<CODE>`, and the guest looks
  that code up. The broker is shared and best-effort. When it is down, the game says "Can't reach
  the connection server". For reliability, run your own
  [PeerJS server](https://github.com/peers/peerjs-server) and build with `VITE_PEER_HOST`,
  `VITE_PEER_PORT`, `VITE_PEER_PATH` and `VITE_PEER_KEY`.
- **NAT and firewalls.** Most home networks connect directly using STUN. Strict NATs, corporate
  firewalls and some mobile hotspots need a TURN relay. The defaults are Google's public STUN server
  and PeerJS's public TURN servers, which are free, shared and may be slow or unavailable. If
  players see "Couldn't connect directly (firewall/NAT) — try another network", try another network
  or add your own TURN server (for example coturn) with `VITE_ICE_SERVERS`:

  ```sh
  VITE_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]' npm run build
  ```

  An invalid value is ignored, with a warning in the browser console.
- **Invite links** (`<VITE_PUBLIC_URL>?join=CODE`) open Join with the code filled in. They need
  `VITE_PUBLIC_URL` at build time. The Pages workflow sets it, and a local or itch build without it
  hides the button, so share the code instead.
- **Versions.** Both players must run the same build. When the versions differ, the game says so
  and asks for a reload with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.
- **Trust.** Each player's machine times its own turns, which is fair among friends and inherent to
  a serverless game. Keep the game window focused while you play. The connection survives a hidden
  tab, but 8 seconds without any message ends the match.

## Credits and licences

- Fonts: **Press Start 2P**, copyright 2012 The Press Start 2P Project Authors, with Reserved Font
  Name "Press Start 2P". **Pixelify Sans**, copyright 2021 The Pixelify Sans Project Authors. Both are
  under the SIL Open Font License 1.1 and bundled through [Fontsource](https://fontsource.org/). The
  licence texts ship with the game as
  [`public/licenses/press-start-2p-OFL.txt`](public/licenses/press-start-2p-OFL.txt) and
  [`public/licenses/pixelify-sans-OFL.txt`](public/licenses/pixelify-sans-OFL.txt), served at
  `licenses/` in the build. The in-game How to Play screen credits them too.
- Networking: [PeerJS](https://peerjs.com/) (MIT), bundled, plus the public PeerJS broker and TURN
  servers for online play.
- Tier colours come from the Okabe–Ito colour-blind-safe palette.
- All art, sound and music are generated in code. Built with TypeScript, Vite and Vitest.
