# Choice Stack, Side Leaders and the Insane-Return Cheer — Design Spec

Date: 2026-09-28 · Amends `2026-09-26-black-belt-tennis-design.md` (the "main spec") and
`2026-09-27-power-meter-and-rally-pacing-design.md` (the "power-meter spec") · Agreed in chat.

## 1. Intent

Playtest feedback: "4 words on the opposing side is too much information to process." After the
chase, the local player's eyes are on the chase plate above their own head, but the choice words
appear in the far prompt band, spread across the whole width (slots x 60 / 180 / 300 / 420 at a full
meter). Reading them means a long jump up and a scan across the screen.

Two changes, plus one small fix:

1. **Choice stack.** The near typist's choice words appear as a vertical stack beside the spot the
   chase runs them to, like the near serve stack (amended after review, see §2 Anchor).
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
| Stack position | First agreed: where the chase plate was, growing upward from it (not a fixed spot mid-court). **Changed after review:** that spot hid the player when they ran forward to the ball (about 6 % of choices at Normal, 35 % at Lightning), so the stack now sits beside the hitting spot on the court-centre side, like the serve words. |
| Indicators | Leader lines that start at the plates' sides, routed so they don't overlap. |
| Opponent's choice | First agreed: unchanged, today's row just below the net on the viewer's half. **Changed after a playtest:** the opponent's words stack beside the opponent too, mirrored (easy at the bottom, nearest the rings on the viewer's half). |

## 2. The choice stack (amends main spec §4.2 Layout, power-meter spec §6 Choice layout)

- **Who gets it:** both players' choice prompts (amended after a playtest; first only the near
  player's). The near player is the one drawn at the bottom of the screen: the local player vs CPU,
  online and in Training, and player 0 in attract mode. The far player is the CPU or the online
  opponent, and player 1 in attract mode.
- **Order:** 1× plates, 3 px gaps (as the near serve stack). The near stack's rings are above it, so
  it runs in tier order from the top (easy, medium, hard, then insane when offered). The far stack's
  rings are below it, so it is the same stack mirrored top to bottom: easy at the bottom, the widest
  plate on top. Either way easy is nearest the rings.
- **Anchor** (amended after review): the hitting spot is where the chase runs the player to, the
  animator's stance for the incoming ball (`stanceFor(contact, owner, turn-start feet)`). The near
  stack's bottom edge, or the far stack's top edge, is level with the top of the player's head there.
  Every plate is centred on one column, placed on the side toward the screen centre (right at exactly
  the centre) so that the widest plate's near edge is 25 px from the player's feet column as drawn.
  That clears every frame shown while choosing (a stretch reaches 22 px from the feet seen from behind,
  23 px seen from the front) with a pixel of court to spare, so the stack never covers the player. Each
  tier's words are longer than the tier above (easy 2–4, medium 5–7, hard 8–11, insane 12–15 letters),
  so the stack is a pyramid, widest at the end away from the rings.
- **Bounds:** the stack, its leaders and its lanes shift together as one unit so that every plate
  lies within x 4–476, y 22–266.
- **Clear of the rings:** the near stack's top edge stays at least 8 px below the lowest ring centre
  it shows. A player hitting from well inside the baseline (a serve return that ran in) has a head high
  enough to break this. The stack then moves down by the difference, still beside the player. The far
  stack, mirrored, stays at least 8 px above the highest ring.
- **After a lock:** the other plates and their leaders fade out over 200 ms, as now. The locked plate
  stays where it is. With Large words it is redrawn at 2× **grown away from the player and the
  rings**: it keeps the edge facing the player and the edge facing the rings (the top for the near
  stack, the bottom for the far one), so it never covers the player. It is clamped to the plate area,
  and its leader is routed again from the doubled box.
- **Timing bar:** under the whole stack until the lock, then under the locked plate, as the serve
  stack does (2 px gap).
- **Training hint:** the "TYPE A FIRST LETTER" tag is centred on the stack's column, 2 px above its
  top plate, clamped to the plate area.
- **Name chip** (a remote or spectator's view): on the plate drawn on top before the lock (easy on
  the near stack, the widest on the far one) and on the locked plate after it.

## 3. Side leaders (amends main spec §4.2 Layout)

These rules apply to both stacks. The far stack is routed mirrored top to bottom: its leaders run
down to the rings below it, and its lanes turn below its bottom plate.

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
- **Beside the player (unit test):** for every hitting spot a near player can reach (|x| ≤ 5.8 m,
  service line to 1.2 m behind the baseline), both medium sides and 3 or 4 options, every placed plate
  stays at least 24 px from the player's feet column, on the court-centre side.

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
  - `layoutChoiceStack(lens, columnX, bottomY)` returns the stack's `PlateBox`es.
  - `besideColumn(feetX, widest)` places the stack beside the player; `growAway(box, awayX, awayY)`
    doubles a locked plate.
  - `layoutChoice` (the row) is removed.
- **`render/leaders.ts`** (new, pure): `placeChoiceStack(lens, columnX, edgeY, rings, facing)` and
  `routeStackLeaders(boxes, rings, columnX, facing)`, one polyline per plate following §3; `facing`
  'down' mirrors the stack for the far typist.
- **`render/prompts.ts`:**
  - `choicePlates` stacks both typists' choices.
  - Timing bar and hint tag as in §2.
  - `LeaderMark` becomes `{ points: {x, y}[]; tier; alpha }`. A row leader is a 2-point polyline.
- **`render/plates.ts`:** `drawLeader` draws a polyline (outline pass for the whole path, then the
  ink), still stopping at the ring's keep-out. `render/world.ts`, `ui/illustrations.ts` and
  `tools/art.ts` follow the new signature.
- **`audio/director.ts`, `render/effects.ts`:** the insane-return cheer of §4.
- **Unchanged:** `core/`, `game/`, `net/` (no `PROTO` change) and the serve layouts.

## 6. Testing

- **Layout** (`tests/render/layout.test.ts`): the stack's order, anchor, gaps, pyramid centring,
  bounds and ring-clearance shift; with Large words the locked plate grows away from the player and the rings and stays in bounds. The main
  spec's plate test (no two plates intersect, all inside x 4–476, y 22–266) also covers the stack.
- **Leaders** (new `tests/render/leaders.test.ts`): the guarantee of §3 for both stacks, the
  beside-the-player test for both, plus unit cases for the direct route, the lane route, lane nesting
  and the mirrored far stack.
- **Prompts** (`tests/render/prompts.test.ts`):
  - Both typists get stacks: easy on top for the near one, at the bottom for the far one.
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
- README "Return" paragraph: the shot words appear in a stack beside you.
- The How to Play texts don't say where the words appear, so they are unchanged. Its "choose"
  illustration already shows a stack with leaders.

## 8. Out of scope

- **Early typing** (next spec, after playtesting this change).
- The serve layouts, and any change to rules, balance, CPU, simulation or protocol.
