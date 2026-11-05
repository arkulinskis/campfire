# Campfire

A real campfire, simulated live in the browser: flames from a GPU fluid simulation, crackles made by chance, logs that
dry, catch, char, glow and fall into the coals. You arrive in the dark beside a laid fire, strike a match, and tend it,
at one of three campsites. No accounts, no sign-up. Built on [Anvil](https://anvil.works) as native Anvil Forms; the
fire itself is a JavaScript engine (three.js r158 + Campfire's own simulation, world and sound) in `theme/assets/cf-*.js`.

- **App repo:** github.com/arkulinskis/campfire (branch `master`). Anvil pulls `master`.
- **Live:** https://campfire.anvil.app

## What it does

**The fire**
- Flames are a 2D combustion fluid simulation on the GPU (stable fluids, MacCormack advection, vorticity confinement,
  buoyancy, rising curl-noise turbulence, combustion expansion, open boundaries), run in 2-3 slices that face the
  camera (Horvath & Geiger 2009). Fuel enters from random spots on the burning logs. Colour = soot x blackbody
  (Planck + CIE 1931, Wyman 2013), faint blue where fresh gas burns, smoke lit from below, soft edges against the scene.
- The simulation's own brightness is read back every two frames and drives the fire light (colour, intensity,
  position: the shadows move) and the coal light; the eye adapts (auto exposure) and partly white-balances to firelight.
- Wood model: each log has a species (3 per place), moisture, ignition, mass and char; heat from flames + coals
  reaches it by position. Wet wood dries first (steam hiss, white smoke). Logs shrink, char with glowing alligator
  cracks, collapse into the coal bed; a teepee falls in; untended fires die down over ~30 min; a dead fire can be
  relit with a fresh handful of kindling.
- Sparks: motion-blurred, energy-conserving streaks, cooling by blackbody, carried by the plume and curl noise,
  bouncing on the ground; bursts on pops, log drops, stirring and collapses. Smoke puffs above the flames.
- Post: HDR, physically based bloom, heat haze above the fire, AgX tone curve with a "punchy" look, vignette, film grain.
- Randomness from `crypto.getRandomValues` (xoshiro128**), so no two fires are the same.

**Sound (no recordings, Web Audio)**
- Fire after Farnell's *Designing Sound*: crackles from a synthesised bank, timed by a self-exciting (Hawkes) process
  per burning log and species, panned to the log; big pops throw sparks; hiss; lapping/roar following the flames'
  flicker; sap whistles; steam hiss for damp wood; match strike, log drop, stir, collapse.
- Night: crickets at Dolbear's law rate (forest, desert), wind gusts shared with the flames, owl + twig snaps (forest),
  ice singing/booms + wolves (snow), coyotes with canyon echo (desert); reverb per place. Keeps going in background tabs.

**Three places** (`html[data-place]` also changes the accent colour and heading font)
- Boreal midnight: spruce, canvas tent, stump with axe, fireflies, Milky Way, no moon. Woods: pine, birch, maple.
- Lakeshore, first snow: frozen lake, far treeline, birches, overturned canoe, full moon, falling snow (some visits),
  northern lights (some visits). Woods: birch, spruce, ash.
- Desert canyon: canyon walls, boulders, dead juniper, bedroll, coffee pot, quarter moon, calmer wind. Woods:
  mesquite, juniper, piñon.

**The page**
- `#fire`: "Sit by the fire." + Strike a match (unlocks audio) -> controls: the three woods + Damp branch, Stir,
  place, sound, settings, full screen. Controls fade after 4.5 s of stillness. Keys L / S / M / F / P. Tap the
  flames to stir. Drag to walk around, wheel/pinch to lean in. Status line ("Burning well. · 12 minutes by the fire").
- "You and N others are by a fire right now": anonymous heartbeat (random code per page load, table `embers`).

**The circle: people around your fire** (since 2026-11-05)
- Everyone by a fire at the same campsite is seated in a circle of at most six (the fullest circle with room, else a
  new one), so hundreds of visitors make many small circles. The second person sits across the fire from the first.
- The others sit around your fire as figures wrapped in wool blankets (plaid or plain, beanies, hoods, brim hats in
  the desert) on log rounds (rocks in the desert; the second person on the seat log), lit only by the firelight.
  They breathe, warm their hands, glance at each other or at you, look up at the sky. Each gets an animal name for
  the visit (Fox, Heron, Wren...); their look comes from their random visit code. Nothing identifies anyone.
- Slow, not live: the browser checks in every 15 s with company (30 s alone, 60 s in a background tab) and plays
  what the circle did since, one thing at a time per person: a wave (to everyone, to one person, to you), a log
  tossed into the fire from where they sit (it lands in YOUR fire too, the same wood, damp or not), a stir.
- Wave: the Wave button (W) waves to everyone; press someone's name tag or tap them to wave to them; "Heron waves
  to you." comes with a Wave back button. A news line at the top (visible even while the controls are faded)
  says who sat down, left, waved, added a log or stirred. Your logs and stirs are shared with your circle.
- No text, no chat. News is kept for ten minutes (table `circle_news`).
- Settings dialog: fire / night volumes, wind (still / breeze / gusty), sleep timer (20/45/90 min, the fire burns down
  and the sound fades over the last 5 min), keep the fire going (auto-tend), picture quality (auto steps down).
- Place picker dialog with real renders of each place (`theme/assets/place-*.jpg`).
- `#about`: how it works, the three places, things to try, questions, the research it stands on. The fire keeps
  burning (paused on screen, sound on) while it is open.
- Privacy & Terms (legal kit, no accounts) and Submit feedback (Prepsto `44beb5s`) in the intro, settings and footer.

## Setting it up in Anvil (once)

1. Anvil editor: **Create app → Clone from GitHub**, paste `https://github.com/arkulinskis/campfire`.
2. Accept the **Schema Mismatch** alert with **"The schema of the source code is correct"** (creates `embers` and `circle_news`).
3. **Run**, then **Publish**. There is no Users service and nobody to sign up.

<!-- libraries:start -->
## Libraries and outside services

What this project uses besides its own code. Generated by `APP_MAKER/tools/libraries.py`; to change it, edit `APP_MAKER/libraries/catalog.py` and re-run the script.

| Name | How it gets in | Used here for |
|---|---|---|
| [three.js](https://threejs.org) r158 | Copied into the app | Draws 3D scenes in the browser: shapes, lights, cameras, textures and VR. |
| [Google Fonts](https://fonts.google.com) | Loaded from a CDN | Cormorant Garamond, EB Garamond, Inter, Spectral |

**Built into the browser:** Canvas 2D, WebGL, Web Audio API, localStorage, Fullscreen.

**Anvil platform:** Anvil, Anvil Data Tables, Anvil JS bridge (anvil.js), Anvil Users.

**Build and test tools (not shipped):** axe-core, Node.js, PyYAML, Headless Chrome (DevTools Protocol).

<!-- libraries:end -->

## Working on it

See `.claude/skills/campfire/SKILL.md`. In short:

```
python tools/check.py                    # Anvil's validator, JS syntax, asset hashes, server tests -> ALL CHECKS PASSED
python -I tools/ui_test.py               # the real app in the Anvil App Server (Docker) driven by headless Chrome (SwiftShader WebGL)
python -I tools/ui_test.py --shots DIR   # + screenshots (desktop/phone, light/dark, unlit/lit)
git push origin master                   # deploy
```

## Project layout

```
client_code/    startup.py, router.py, state.py, fire.py (the door to the engine), legal.py;
                Layouts/Shell, Pages/Fire + About, Components/FireStage, Items/WoodButton + PlaceCard, Dialogs/Places + Settings
server_code/    common.py, Presence.py (others by a fire, circles of six, waves/logs/stirs), SchemaCheck.py, legal_server.py
theme/assets/   cf-core.js (random, noise, blackbody), cf-fire.js (the GPU combustion sim), cf-fx.js (sparks, smoke,
                motes, post), cf-world.js (the three places, materials), cf-audio.js (sound), cf-people.js (the people in
                your circle), cf-engine.js (wood model, camera, API), three.min.js (r158), app.css, app-kit.js, theme.css (spinner), icons, place-*.jpg
tools/          check.py, assets.py, build_icons.py, make_icons.py, ui_test.py + ui/ (flow, phone, a11y), live/drive.mjs, testing/
```
