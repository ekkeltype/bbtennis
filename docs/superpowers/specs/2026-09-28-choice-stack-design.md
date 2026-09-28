# Choice Stack, Side Leaders and the Insane-Return Cheer — Design Spec

Date: 2026-09-28 · Amends `2026-09-26-black-belt-tennis-design.md` (the "main spec") and
`2026-09-27-power-meter-and-rally-pacing-design.md` (the "power-meter spec") · Agreed in chat.

## 1. Intent

Playtest feedback: "4 words on the opposing side is too much information to process." After the
chase, the local player's eyes are on the chase plate above their own head, but the choice words
appear in the far prompt band, spread across the whole width (slots x 60 / 180 / 300 / 420 at a full
meter). Reading them means a long jump up and a scan across the screen.

Two changes, plus one small fix:

1. **Choice stack.** The near typist's choice words appear as a vertical stack where the chase plate
   was, like the near serve stack.
2. **Side leaders.** Each plate's leader leaves from one of its sides and is routed so that no two
   leaders overlap.
3. **Cheer.** Returning an insane shot draws a cheer from the crowd.

Success criteria:
- After the chase word, the choice words appear where the eyes already are, with no screen-wide scan.
- It stays clear where each word goes: shaped, tier-coloured rings on the targets, joined to their
  plates by leaders that never cross or touch one another, another plate or another ring.
- Rules, balance, CPU, simulation and the online protocol are unchanged.

### 1.1 Decisions agreed with the user
| Topic | Decision |
|---|---|
| Scope | The stack and the cheer now. **Early typing** (the receiver may start the chase word as soon as the striker locks) is deferred to its own spec, after a playtest of this change. |
| Stack position | Where the chase plate was, growing upward from it (not a fixed spot mid-court). |
| Indicators | Leader lines that start at the plates' sides, routed so they don't overlap. |
| Opponent's choice | Unchanged: today's row just below the net, on the viewer's half. |

## 2. The choice stack (amends main spec §4.2 Layout, power-meter spec §6 Choice layout)

- **Who gets it:** the choice prompt of the **near** player (the one drawn at the bottom of the
  screen): the local player vs CPU, online and in Training, and player 0 in attract mode. The far
  player's choice prompt keeps today's row in the near band (`layoutChoice(…, 'near')`).
- **Order:** tier order from top to bottom (easy, medium, hard, then insane when offered), 1× plates,
  3 px gaps (as the near serve stack).
- **Anchor:** the bottom plate's bottom edge is the chase plate's bottom edge, 4 px above the owner's
  head where it stood when the turn began, whatever the chase plate's scale. Every plate is centred on
  the column of that head x. Each tier's words are longer than the tier above (easy 2–4, medium
  5–7, hard 8–11, insane 12–15 letters), so the stack is a pyramid, widest at the bottom.
- **Bounds:** the stack, its leaders and its lanes shift together as one unit so that every plate
  lies within x 4–476, y 22–266.
- **Below the rings:** the stack's top edge stays at least 8 px below the lowest ring centre it
  shows. Normally it is far lower: the top is around y 119 against rings at y 80–91. Only a near
  player who begins the turn about 1.6 m or more inside the baseline has a head high enough to break
  this. The stack then moves down by the difference and may cover part of the player.
- **After a lock:** the other plates and their leaders fade out over 200 ms, as now. The locked plate
  stays where it is. With Large words it is redrawn at 2× around its centre column with its **bottom
  edge kept** (it grows upward, so it never covers the head), clamped to the plate area, and its leader
  is routed again from the doubled box.
- **Timing bar:** under the whole stack until the lock, then under the locked plate, as the serve
  stack does (2 px gap).
- **Training hint:** the "TYPE A FIRST LETTER" tag is centred on the stack's column, 2 px above its
  top plate, clamped to the plate area.
- **Name chip** (a spectator's or remote view of the near typist): as on any plate, on the top plate
  before the lock and on the locked plate after it.

## 3. Side leaders (amends main spec §4.2 Layout)

These rules apply to the stack only. The far typist's row keeps today's straight leaders from each
plate's bottom centre.

- **Sides.** In screen terms, *medium's side* is the side of medium's ring relative to hard's ring
  (they are on opposite sides of the court). The medium and insane leaders leave from their plates'
  edge on medium's side, and the hard leader from the other edge. The easy leader leaves from the edge
  facing its ring. When the ring is exactly on the stack's column, easy uses hard's side.
- **Start point:** the middle row of the plate's side, just outside its 1 px halo.
- **Routes** are made of horizontal, vertical and (only for the last segment of a lane route) straight
  diagonal pieces, drawn 1 px in the tier colour with a 1 px near-black outline, stopping at the ring's
  keep-out, as now:
  - **Direct route:** when the ring lies farther out than the plate's start edge, the leader runs
    horizontally out to the ring's x, then vertically to the ring.
  - **Lane route:** otherwise, a short stub runs out to a lane beside the stack, up the lane to above
    the stack's top plate, then straight to the ring.
  - **Lanes** on each side are 4 px apart, so a 1 px gap of court shows between two outlines. Lower
    plates take the outer lanes.
- **Why right angles:** straight diagonals from the sides cross when the stack is off-centre, which is
  the usual case on a serve return (the receiver stands about 80 px to one side). The rings sit in a
  narrow region of the far half, so their left-to-right order is fixed by the target rules; the side
  rule above always matches it, which makes a non-crossing routing possible wherever the stack stands.
- **Guarantee (unit test):** it covers every stack column x from 4 to 476, head heights for every
  near-player depth from the service line to 1.2 m behind the baseline (the "below the rings" rule of
  §2 applies), every word length in each tier's band, both medium sides, and 3 or 4 options. In every
  case:
  - No two leaders' outlined pixels overlap.
  - No leader pixel (outline included) enters another plate's box grown by 1 px (its halo), or another
    ring's keep-out area.
  - Every plate is inside the plate area.

  If routing cannot meet this for some case, implementation stops and the case goes to the user. No
  condition is dropped quietly.

## 4. Cheer for an insane return (amends main spec §4.4, power-meter spec §6 Audio)

- **When:** at the `strike` of a return turn whose chase word is insane (the incoming shot was an
  insane serve or rally shot).
- **Sound:** applause, following the home-crowd rule the points use. It is at full gain when the
  returner is the viewer or the viewer is a spectator, and at polite gain (0.5) when the opponent
  returned the viewer's insane shot.
- **Crowd:** excitement rises to the point level (`EXCITE.point`, 0.7), so the crowd raises its arms.
- **Outcome:** it plays whatever the return's own outcome turns out to be, so an OUT or NET is never
  given away before its call.
- **Other sounds:** it adds to the strike's own sounds: an insane return of an insane shot still
  plays the heavy hit and the "ooh".
- **Protocol:** unchanged. The chase word of a return turn is public, so the director and effects
  read its tier from the turn with the event's id (`state.turn` or `state.lastTurn`). No new event,
  field or `PROTO` bump.
- Muted in attract mode, as every sound is.

## 5. Architecture changes

- **`render/layout.ts`:**
  - A new `layoutChoiceStack(lens, columnX, bottomY, large)` returns the stack's `PlateBox`es.
  - `layoutChoice` stays for the far typist's row.
- **`render/leaders.ts`** (new, pure): `routeStackLeaders(boxes, rings, tiers)` returns one
  polyline per plate, following §3.
- **`render/prompts.ts`:**
  - `choicePlates` uses the stack and its routes when `d.owner === f.near`, and the row otherwise.
  - Timing bar and hint tag as in §2.
  - `LeaderMark` becomes `{ points: {x, y}[]; tier; alpha }`. A row leader is a 2-point polyline.
- **`render/plates.ts`:** `drawLeader` draws a polyline (outline pass for the whole path, then the
  ink), still stopping at the ring's keep-out. `render/world.ts`, `ui/illustrations.ts` and
  `tools/art.ts` follow the new signature.
- **`audio/director.ts`, `render/effects.ts`:** the insane-return cheer of §4.
- **Unchanged:** `core/`, `game/`, `net/` (no `PROTO` change), the serve layouts and the far typist's
  row.

## 6. Testing

- **Layout** (`tests/render/layout.test.ts`): the stack's order, anchor, gaps, pyramid centring,
  bounds and below-the-rings shift; with Large words the locked plate keeps its bottom edge and stays in bounds. The main
  spec's plate test (no two plates intersect, all inside x 4–476, y 22–266) also covers the stack.
- **Leaders** (new `tests/render/leaders.test.ts`): the exhaustive guarantee of §3, plus unit cases
  for the direct route, the lane route and lane nesting.
- **Prompts** (`tests/render/prompts.test.ts`):
  - The near typist gets the stack and the far typist the row.
  - The timing bar sits under the stack, then under the locked plate.
  - The hint tag sits above the stack.
  - Leaders fade with their plates.
- **Audio** (`tests/audio/director.test.ts`):
  - Applause at the strike returning an insane shot: full gain for the viewer or a spectator, polite
    gain for the opponent.
  - None when returning other tiers.
  - Nothing in attract mode.
- **Effects:** excitement reaches the point level at an insane return.
- **Visual:**
  - The art QA page (`tools/art.html`) shows a 3- and a 4-plate stack at both medium sides, centred
    and near each screen edge.
  - A devshot of a 4-plate stack in a live match.
  - The e2e `4-match-choice.png` shows the stack.
- `npm run typecheck`, `npm test` and `npm run build` pass. `npm run e2e` passes.

## 7. Docs to update on completion

- Main spec §4.2 Layout (choice plates, leaders) and §4.4 Audio, each pointing to this spec.
- README "Return" paragraph: the shot words appear above you, where the chase word was.
- The How to Play texts don't say where the words appear, so they are unchanged. Its "choose"
  illustration already shows a stack with leaders.

## 8. Out of scope

- **Early typing** (next spec, after playtesting this change).
- The far typist's row, the serve layouts, and any change to rules, balance, CPU, simulation or
  protocol.
