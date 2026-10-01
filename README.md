# Iron Nomad: Road to Haven

A two-player, shared-screen survival-convoy game for the browser. Two scavengers start on matching 50cc scrap mopeds and
grow into a war convoy, driving north toward a sanctuary called Haven. The vehicle is the character: every upgrade changes
where you can go, how loud you are, and who wants to kill you.

This is the **vertical slice** defined in section 2 of the *Game Design & Technical Blueprint*: Tiers 1 to 3, wasteland and
city legs, a Dusk Bell, one camp night per leg, the Mechanic mercenary, full split-screen and two-gamepad play. Everything
the blueprint puts in "Beta" and "Final" is listed under [What is not in the slice](#what-is-not-in-the-slice).

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:5174  (or $PORT)
npm run build        # typecheck + production bundle in dist/
npm test             # 110 unit and simulation tests (Vitest)
```

Chrome or Edge are the reference browsers. Gamepads are only exposed to secure contexts, so use `localhost`, `127.0.0.1`
or HTTPS. Add `?debug` to the URL for a frame-time and draw-call readout and data validation at boot.

## Play

Plug in two Xbox-layout pads and press **A** to join, or share the keyboard. Anyone can press **Start** to begin. A seat
without a pad falls back to the keyboard, so you can also play on one keyboard (Player 1 on the left side, Player 2 on the
right).

### The loop

Each leg runs the same five steps, and every decision is shared:

1. **Dawn Ledger** (shared clipboard, two coloured cursors): repair, rebuild a vehicle into the next tier, upgrade five
   module slots, craft ammo and gear, hire crew, pay or short their loot cut, then pick the next road.
2. **Route choice**: two roads per junction, a wasteland road (fuel, parts, ambushes) or a city road (tech, medicine, hordes).
3. **Travel**: drive the road, dismount at scavenge zones, handle ambushes and the Roadside Encounters.
4. **Dusk Bell**: a visible clock. Reach the end of the road, then vote on a camp site and hot or cold camp.
5. **Camp**: three minutes to build defenses, then a three-wave night raid. Dawn leads straight back to the Ledger.

### Rules worth knowing

- **Signature** is the one aggro rule. Engines are **Noise** (heard by the infected in cities) and **Dust** (seen by raiders on
  the road). The meter in the top-left shows your current level. Horns, gunshots, sprinting and night headlights make it worse.
  Parking and walking is quiet.
- **Shared stocks**: Fuel, Rations, Scrap, Parts, Tech, Medicine. Fuel and Rations are one pool for both players.
- **Tether**: stay within about 300 m of your partner. The trailing player gets a slipstream bonus; the leader slows when the
  gap grows.
- **Downed, not dead**: at 0 HP you crawl for 20 s. Your partner can revive you (hold A, faster with a medkit). The run ends
  only when both of you are down, or the last vehicle is lost.
- **Crew** have a Loyalty meter and a loot cut that is withheld from every pickup. Betrayal is telegraphed by two radio
  warnings and a camp dispute before anyone deserts.
- **Roadside Encounters** are decided by both players voting in their own half. If you disagree the Encounter Lead decides, and
  overriding your partner costs a point of Trust. Three hidden axes (Mercy, Trust, Notoriety) decide the ending.

### Controls

| | On foot | Driving | Gunner (Tier 3 bed) | Camp build |
|---|---|---|---|---|
| Left stick | Move | Steer | | Move |
| Right stick | Aim / look | Free look | Aim gun | Aim reticle |
| RT / LT | Fire / aim | Throttle / brake | Fire / zoom | Place / remove |
| RB | Tap melee, hold takedown | Fire front gun | Fire | Next element |
| LB | Swap tool | | | Previous element |
| A | Interact (hold: loot, repair, refuel, revive) | Handbrake | | Rotate |
| B | Crouch | Tap lights, hold engine off | | Hold: ready for night |
| X | Reload (hold: swap utility) | Tap horn, hold siren | | Assign watch post |
| Y | Enter vehicle (hold: bail out) | Exit (hold: bail at speed) | Exit | |
| D-pad | Tap ping, hold command wheel | | | |
| L3 / R3 | Sprint / reset camera | Camera distance / look back | | |
| Start / Back | Pause / hold for convoy sheet | | | |

**Keyboard**: Player 1 uses `W A S D` to move, `Q E` to aim, `F` to fire, `G` to interact, `R` for vehicles, `C` for
crouch and lights, `Shift` for sprint and handbrake, `Tab` for the command wheel, `V` to swap tools, `T` to reload or
honk, `Z X` to cycle build elements, hold `Space` for the convoy sheet. Player 2 uses the arrow keys, `[ ]` to aim, `Right
Shift` to fire, `/` to interact, `Enter` for vehicles, `.` for crouch and lights, `Right Ctrl` for sprint and handbrake,
`Backspace` for the wheel, `N` to swap tools, `,` to reload, `; '` to cycle build elements, hold `\` for the convoy sheet. Keyboard players get stronger
aim assist. `Esc` pauses. The in-game Controls screen has the full table.

## How it is built

TypeScript, Vite, three.js (WebGL2) and Rapier (WASM). Pinned versions are in `package.json`; the three.js and Rapier APIs
move between releases, so check any call against the pinned versions before reusing it.

```
src/
  core/      math, seeded RNG and noise, event bus
  data/      JSON tables (vehicles, enemies, mercs, structures, legs, encounters, strings) + typed access + validation
  sim/       pure rules with no engine imports: resources, loyalty, signature grid, raid threat, endings, damage, day clock
  physics/   Rapier world wrapper and the data-driven raycast vehicle controller
  world/     deterministic terrain, leg layout (city grid, set pieces) and per-chunk content
  render/    renderer (one scene, two cameras), chunk meshes, procedural models, instanced zombies, particles, camera
  game/      scene runtime, entities (player, vehicle, zombies, raiders, crew), combat, leg scene, camp scene, game loop
  ui/        HUD, shared-cursor focus UI, overlays (title, votes, report), the Dawn Ledger, styles
  input/     gamepad and keyboard sampling into per-player intents
  audio/     procedural Web Audio: engines, weapons, stems that crossfade by state
  save/      IndexedDB (with a localStorage mirror), written at every Dawn Ledger
tests/       Vitest suites for the sim, vehicle physics, world generation and game logic
```

Decisions that follow the blueprint:

- **Fixed 60 Hz simulation** with an accumulator clamped to five steps, rendering with interpolation. Input is sampled into
  one `PlayerIntent` per player; the sim never reads devices.
- **One renderer, one scene, two cameras** with a viewport and scissor per player. The screen splits left and right by
  default; Settings switches to the blueprint's top/bottom strips. Horizontal FOV is fixed at 100 degrees and the vertical
  FOV is derived (37 degrees for a 1920x540 strip), with a 32 degree floor. A 4 px divider separates the halves.
  Shadows are re-aimed at each player before each render. Resolution adapts to hold frame time, using one shared scale so the
  halves always match.
- **Rapier raycast vehicle controller** for every vehicle, parameterised from `vehicles.json`. Two-wheelers are held upright
  by a PD torque about the roll axis. Terrain is a heightfield per 128 m chunk, streamed around both players.
- **Zombies are logical, not rigid bodies**: a 20 Hz AI with Dormant, Wander, Investigate, Chase and Swarm states, hearing by
  lookup in a 16 m Signature grid, and a horde cascade at five chasers. They render as one instanced, animated mesh. Vehicles
  plow them through a volume in front of the chassis (about 3% speed lost per zombie on Tier 3).
- **Data first**: rules live in JSON and are checked by `validateData()` in the test suite.
- **All text is a key** into `strings.en.json`.
- **Accessibility**: player colours are an orange/blue pair that stays distinct for colour-blind players; the Signature meter
  uses hatching and block width as well as colour; UI scale 80 to 150%; per-player rumble and aim assist; Drain, Aggro and
  Damage sliders; pause on controller disconnect.

### Deliberate deviations

- The on-foot camera sits 4.9 m back and 2.15 m up rather than the blueprint's 3.2 m and 1.6 m. On a 3.5:1 strip the
  character filled most of the height at 3.2 m.
- Vehicle braking and the speed-sensitive steering limit are applied as controlled decelerations and lateral-acceleration caps
  rather than raw wheel brake force, because Rapier's wheel brake units vary several times between vehicles and a full-lock
  steer at speed spins a raycast vehicle out. A small yaw-rate assist catches slides.
- bitECS and recast-navigation are not used: the slice's crowd size and open streets are handled by plain arrays, a spatial
  hash and steering with obstacle push-out. They are a drop-in for the Beta if crowds and interiors demand them.
- Rapier stays on the main thread (the blueprint's stretch goal is a Worker).
- Assets are procedural (boxes, prisms and canvas textures in a welded-scrap style) so the project has no binary files.

## What is not in the slice

Per the blueprint's cut order and scope plan, these are Beta or Final work and are not built yet:

- Tier 4 and 5 vehicles (the data and physics parameters exist, the models, turret, plow, docking and flamethrowers do not)
- The Scout, Scavenger and Heavy Vanguard (their data and hiring rows exist and are disabled)
- Legs 4 to 14, Waypoints beyond Rustgate, run modifiers, dust storms, walk-in building interiors
- A controller remap wizard and hold-or-toggle options beyond the crouch default
- Localization beyond English, and WebGPU

The campaign ends at **Rustgate** after three legs, with a summary and a hint about which ending your choices lean toward. All
five endings are implemented and unit tested in `sim/endings.ts`.

## Tests

`npm test` runs the data validation, loyalty bands, resource ledger and loot cuts, Signature grid, raid threat and wave
planning, ending selection, day clock, damage model, vehicle handling (acceleration, braking, turning, ride height and a
stability regression), world generation (determinism, seams, passages, barricades, set pieces) and game logic (obstacle index,
campaign save round trip, input helpers, camera FOV).

The page also exposes `window.__game` with `advance(seconds)` for running the simulation deterministically from the console,
which is how most of the in-browser checks were done.
