---
name: campfire
description: Context, workflow and recipes for Campfire (folder campfire), the user's Anvil app built as native Anvil Forms (Python + HTML templates, a layout, custom components, RepeatingPanels). A real campfire simulated live in the browser (GPU fluid flames, procedural sound, three campsites), no accounts. Load this before any feature request, bug fix, restyle, content change or deploy for this app.
---

# Campfire: working on the app

**What it is:** one feature page: arrive in the dark beside a laid fire, strike a match, tend it (three woods per
place + a damp branch, stir), watch and listen. Three places (forest / snow lakeshore / desert canyon), settings
(volumes, wind, sleep timer, keep it going, quality), an About page explaining how it works. No users, no sign-in;
the server keeps the anonymous "You and N others are by a fire right now" count and seats visitors at the same
place in circles of up to six: the others sit around your fire, and waves, logs and stirs are shared slowly.

**Where it lives:**
- Folder `C:\Users\arkvi\Documents\CLAUDE\campfire\` = the git clone of **github.com/arkulinskis/campfire**, branch `master`.
  "git" layout: the folder *is* the Anvil app. Anvil pulls master; pushing is the deploy. Live: https://campfire.anvil.app
- Made from `C:\Users\arkvi\Documents\CLAUDE\APP_MAKER\template-forms` (native Anvil Forms, Nov 2026). Anvil's own agent
  skills describe the same model: `client-forms`, `data-models`, `server-code`, `client-modules`, `anvil-yaml`
  (github.com/anvil-works/anvil-agent-references; see APP_MAKER/ANVIL_NOTES.md, "Native Anvil Forms").
- **README.md** lists every feature. Keep it up to date.

**What the user wants:** "the best possible simulation of fire", truly random, crackling, logs, a realistic campsite;
"elicit a feeling, something primal"; be critical, research real techniques, not "random 3D nonsense". They offered
to A/B test for taste: use it for subjective choices (publish a comparison artifact, then AskUserQuestion). Chosen so
far: all three design directions (one per place); flame shape "B: Full body" (spread 1.2, jet 2.2) over "crisp
licking tongues". Design: Boreal midnight base (ember #ff8a3d on #07080a, parchment ink #efe6da, Cormorant Garamond
+ Inter); snow lends EB Garamond + #9cc3ff, desert Spectral + #d9a35b (html[data-place]). The fire page and its
dialogs are always night; About follows light/dark. Mobile-first, 390 px.

## Workflow for any change

1. `git pull --ff-only` (Anvil commits "Edited ..." when the user changes something in the IDE; read those commits).
2. Edit: a page's template and Python side by side (`client_code/Pages/X/form_template.html` + `__init__.py`).
3. `python tools/check.py` (no -I) -> **ALL CHECKS PASSED**: Anvil's validator (`anvil validate`, type-checks every
   template and Python file against Anvil's API), JS syntax, asset hashes (`tools/assets.py`), server tests.
   Needs the Anvil CLI once: `npm install -g @anvil-works/anvil-cli`.
4. `python -I tools/ui_test.py` (Docker Desktop running) -> **ALL UI TESTS PASSED**: the folder runs as-is in the
   open-source Anvil App Server (container `campfire-dev`) and headless Chrome walks tools/ui/flow.js, phone.js
   (true 390 px, no sideways scroll) and a11y.js (axe-core WCAG 2.2 AA on every page, light + dark, plus
   keyboard checks). Client edits show on reload; server edits need `--restart`. `--only a11y.js` runs one script.
   `--shots DIR` = screenshots of every page, desktop + phone, light + dark, guest + member: Read them.
5. Commit only your files as arkulinskis with the Co-Authored-By line; `git push origin master`.
   New tables/columns: tell the user to accept the **Schema Mismatch** alert ("The schema of the source code is correct").

## Architecture

```
anvil.yaml                 startup: module `startup`; db_schema `embers`; services: tables only (no users); head_html
                           (fonts, Prepsto, ?cftest test switch, saved place, theme assets + three.min.js + cf-*.js)
client_code/
  startup.py               legal kit setup, router.start()
  router.py                PAGES (fire, about), _form, go/href/replace, the #-link click interceptor
  state.py                 call()/call_quiet(), toast(), store, set_attr, set_control_attr, heading/live/focus/refocus
  fire.py                  the one door to the JS engine (PLACES, start, state)
  legal.py                 Privacy & Terms (installed from APP_MAKER/legal-kit; don't edit here)
  Layouts/Shell            slim header + footer; refresh("fire") adds "immersive" (both hidden)
  Pages/Fire               the fire: intro, controls, status, presence + the circle (heartbeat, news line, waves,
                           shared logs/stirs), keys (W = wave), idle fade; CF_TEST.circle test hooks
  Pages/About              how it works (static copy)
  Components/FireStage     custom component around the engine (events state_change, fire_event)
  Items/WoodButton         a wood in the tray (x-add);  Items/PlaceCard: a campsite in the picker (x-pick)
  Dialogs/Places, Settings place picker; sound/wind/sleep/auto-tend/quality (load/apply live in Settings/__init__)
server_code/               common.py (C.*), Presence.py (ember_heartbeat, circle_act), SchemaCheck.py, legal_server.py
theme/assets/              cf-*.js (the engine), three.min.js, app.css (tokens + pages + role layer), icons.css
                           (generated), app-kit.js, theme.css (spinner), icon.svg + PNGs, place-*.jpg
tools/                     check.py, assets.py, build_icons.py, make_icons.py, ui_test.py + ui/ (flow, phone, a11y),
                           live/drive.mjs (SwiftShader), testing/
```

## How things are done here

- **Page** = `client_code/Pages/X/` with `<anvil-form layout="Campfire.Layouts.Shell"><anvil-block slot="content">`
  and `class X(XTemplate)` taking `args=()` (the URL parts after `#x/`). Register it in router.py: `PAGES`, `_form`,
  and `NAV` if it belongs in the menu (max 4). Add its address to tools/ui/phone.js and its journey to flow.js.
- **The layout is reused between pages** (open_form keeps the Shell when the layout matches): anything in the Shell
  that depends on the user or the page goes in `Shell.refresh(page)`.
- **Navigation** = plain `<a href="#page">`; in code `router.go("page", arg)`; build links with `router.href`.
- **Static copy** = plain HTML in the template. **Text that changes** = a `Label` (role for the look).
- **Actions** = Anvil `Button` + `@handle("name", "click")`, roles `["btn", "btn-primary", "ic-plus"]`. Button roles
  are aliases of `.ui-btn` in app.css: `btn-primary`, `btn-ghost`, `btn-danger` + `btn-solid`, `btn-sm`, `btn-lg`,
  `btn-icon`, `btn-block`. Icons: role `ic-<name>` on Buttons/Links, `<i class="ic ic-<name>">` in HTML
  (names in app-kit.js `UI.ICONS`; add one there and run tools/build_icons.py).
- **Inputs** = TextBox / TextArea / DropDown / CheckBox (styled by app.css through `.ui input`, `.ui textarea`).
  Read `.text` / `.selected_value` / `.checked`; `pressed_enter` for Enter.
- **Plain HTML that changes** = `anvil:name="x"`, then `self.x.visible`, `self.x.classes["on"] = ...`,
  `self.x.style[...]`; attributes with `state.set_attr(self.x, "href", ...)`. Native clicks:
  `anvil:on-dom:click="self.x_click"` + `def x_click(self, event)`.
- **Lists** = `RepeatingPanel` + an `Items/` Form; never build repeated HTML strings. Bind fields in the item template
  (`bind:text="self.item['title']"`). Grid/flex CSS goes on the panel's items container: `.anvil-role-<role> > div`.
  Item -> page: `self.parent.raise_event("x-something", ...)` + `panel.add_event_handler("x-something", ...)`.
  Role `contents` lets a panel's items join the surrounding grid.
- **Dialogs** = a Form in `Dialogs/`, `alert(Form(...), buttons=[], role="app-dialog")`; it closes itself with
  `self.raise_event("x-close-alert", value=...)`. Yes/no: `confirm(text, title=..., buttons=[("Cancel", False), ("Delete", True)])`.
- **Toasts** = `state.toast(msg, "ok" | "error")` (Anvil Notification with roles).
- **Server calls** = `state.call("fn", ...)` for normal flows (expected `{"ok": False, "error"}` -> toast, returns None);
  a page that shows a friendly state instead (not found, private) calls `anvil.server.call` and checks `ok` itself.
  Server functions: `@anvil.server.callable(require_user=True)`, `C.require_user()` / `C.require_admin()`, ownership
  checks, return plain dicts (`C.ok(...)` / `C.fail("...")`), never other people's emails. Tables are `client: none`.
- **JavaScript** only for engines Python is too slow for (canvas, SVG drawing, WebGL, audio, maps, PDF): put it in
  `theme/assets/<name>.js`, load it in head_html (then `python tools/assets.py`), wrap it in one Python module
  (`from anvil.js import window`) and/or a `Components/` custom component. Little Hero Books is the worked example.

- **Accessibility (WCAG 2.2 AA, the legal bar; 2026-11-04)**: tools/ui/a11y.js runs axe-core on every page (light +
  dark, guest + member) and fails on serious problems; add new pages to its PUBLIC/MEMBER lists. The rules:
  - Text colours reach 4.5:1 on every surface: check new tokens (`--c-faint`, `--c-accent` used as text, status
    colours on their `-soft` fills). Text on good/bad/warn fills is `var(--c-on-status)` (white light, ink dark).
  - Every field has a name: wrap it in `<label class="ui-field"><span>Caption</span>...</label>`, or
    `state.set_control_attr(box, "aria-label", "...")` when the caption isn't a label (set it AFTER `.items` on a
    DropDown: Anvil rebuilds the select). Name/email/phone/password get `autocomplete` (set_control_attr).
  - The page's title Label is a heading: `state.heading(label, 1)` (one per page; Labels render as divs).
  - Toggle buttons say they're on: `.ui-seg` buttons get aria-pressed from the "on" class automatically (app-kit.js);
    elsewhere `state.set_control_attr(btn, "aria-pressed", ...)`. Never `role="tablist"` without real tabs.
  - Messages that appear are read out: roles msg-error/msg-note get role alert/status automatically; other changing
    Labels: `state.live(label)`. Hidden text just for screen readers: Label role `sr`.
  - When a click redraws a RepeatingPanel, keep the keyboard's place: give the item's button a `data-key` and call
    `state.refocus(panel, key)` after the event (PlanPlate's Items/Chip). Buttons have no `.focus()`: `state.focus(btn)`.
  - Images: content images get real alt text (photos: their caption); decorative ones `alt=""`; a Button icon image
    is set to alt="" automatically. Hidden anti-spam fields: `tabindex=-1`, `autocomplete=off`.

## The fire engine (theme/assets/cf-*.js, window.CF)

- `cf-core.js` session RNG from crypto (CF.rng), OU processes, CPU noise/curl, GLSL helpers (noise, cells, bump),
  blackbody LUT (theta 0..1.4 -> 300 + 1100 theta K; rgb = chroma, a = log luminance).
- `cf-fire.js` FireSim (one slice: curl, forces, advect, divergence, Jacobi x iters, project, react, MacCormack) and
  FireVolume (2-3 camera-facing slices; spots in 3D -> slice coords with `spread`; reduce + readPixels for the light).
  Tuning knobs: FireSim `params` (buoy, vort, turb, jet, burnK, heat, sootY, ox, coolRad, coolLin, fuelRate, expand);
  slice shader `uGain`, `uSoftLum` (luminance curve), `uBlue`; FireVolume `spread`. Measure, don't guess: the dev
  probe reads the middle slice and reports h50/h90 (flame height, m) and w80 (width); ~0.6 / 1.1 / 0.2-0.35 now.
- `cf-fx.js` Sparks (instanced streaks), Smoke (instanced puffs), Motes (fireflies/snow), Post (opaque RT with depth
  texture -> depth copy -> transparents -> 13-tap bloom -> final: haze, WB, exposure, AgX "punchy", vignette, grain).
- `cf-world.js` CF.PLACES (sky, fog, moon, exposure, woods, terrain height) + CF.buildWorld; every surface is
  MeshStandardMaterial patched by CF.patch(albedo/rough/bump/glow GLSL). Logs: CF.makeLogGeo/makeLogMat (char cracks).
- `cf-audio.js` CF.Audio (crackle bank + Hawkes scheduler, loops, place soundscapes, one-shots).
- `cf-engine.js` CF.create/CF.shared; wood model (updateFire), spots, step (sim, readback, lights, exposure, draw),
  camera + input, API: light, addLog, stir, setPlace, setWind, setVolume, setAutoTend, setSleep, sound, state, warp,
  attach, pause, setHandlers. `window.CF_TEST = {quality: 'low'}` (set by `?cftest=1`) for tests.
- `cf-people.js` CF.People (engine.people): the others in your circle. SEATS = a per-viewer arc ACROSS the fire
  (k = seat - mySeat mod 6; k = 3, the second arrival, on the seat log right of the flames, not behind them); people
  beside the camera would be huge. Person = merged geometries: legs + lap blanket (lapGeo) + lathe body + blanket
  upper arms (blanket material CF.patch BLANKET: plaid uniform), sleeves/hands/head/hat vertex-coloured. Idle
  life (rest/warm/look/sky), actions queued one at a time (wave 3.4 s, log toss 1.25 s, stir 2 s); a log/stir's
  effect fires once (`effect`), also when the queue overflows or the person leaves, so logs always land. Name tags
  = DOM buttons in `.cf-people` (inside the stage), projected every drawn frame; `hit(x, y)` for taps on bodies.
  Engine API: setCircle(json), circleAct(seat, kind, to, wood, wet), addLog(wood, wet, fromPos), onEvent('wave_to').
- Python side: `client_code/fire.py` (one door), `Components/FireStage` (custom component, events state_change and
  fire_event; set_circle, circle_act), `Pages/Fire` (UI, status text, idle fade, keys, heartbeat + circle).
- **Dev loop for looks:** a standalone harness (index.html loading three + cf-*.js, served locally) driven by
  tools/live/drive.mjs with SwiftShader; `fire.warp(sec)` ages the fire without drawing. Look at 3 frames ~1 s apart.

## Recipes

- **New table or column:** `db_schema` in anvil.yaml (same shape as the existing tables, `client: none`), then add it
  to server tests. Deploy, then the Schema Mismatch step. Personal data -> the legal kit (below).
- **New server function:** in a server module + tests in tools/testing/test_server.py (happy path, bad input,
  someone not allowed; public ones in `PUBLIC`).
- **Demo content:** DemoData.py (`is_demo=True`, `DEMO_TABLES`, children first).
- **Restyle:** tokens at the top of app.css (light and dark blocks), fonts in head_html, the spinner in theme.css
  (`python -I APP_MAKER/tools/loaders.py apply campfire <preset>`), `LEGAL_THEME` in startup.py.
- **Icon:** edit theme/assets/icon.svg, `python -I tools/make_icons.py`, then `python tools/assets.py`.

- **The circle (Presence.py):** `ember_heartbeat(sid, place, since, count)` seats/keeps you (`_join`: fullest open
  circle at the place, FILL order 0,3,1,4,2,5, unique animal name, re-pick on a seat clash) and returns
  `{circle: {id, seat, name, people: [{seat, name, look}], news, t}, others?}`; pass the last `t` as `since` (news
  re-sent for OVERLAP 20 s, the page skips seen ids). `circle_act(sid, kind, to, wood, wet)`: wave/log/stir only,
  no text. Visit codes never leave the server (look = a hash). Tests: tools/testing/test_server.py (circles, 31
  visitors -> circles of <= 6, news only to others, rate limits) and flow.js (a second visitor via
  `CF_TEST.circle.visitor(sid, kind, ...)` + `pulse()`).
- **Looking at the people:** stage a circle in a shot with `F.setCircle(json)` then `F.setCircle = () => 0` (or the
  page's own heartbeat replaces it), `p.setFade(1)`, and step `F.people.update(0.1, ...)`; call ui_test.start()
  first or the App Server serves the old files.

## Gotchas
- Headless Chrome draws ~2 frames a second with SwiftShader and dt is capped at 0.1 s, so people's animations run
  ~5x slow in tests: flow.js fast-forwards them with `F().people.update(0.4, ...)`. Visitors from a run in the
  last 3 minutes still sit in the test circle (flow.js copes, waits if the circle is full).
- The local App Server 1.18's auto-migrate lost two of four columns added to one table at once (log: "attempted to
  update nonexistent column"); each `ui_test.py --restart` added the next one. Restart until the log has no
  "schema out of date" (hosted Anvil: the Schema Mismatch step adds all of them).

- **Anvil puts a `<base href>` in the page**: a plain `<a href="#about">` resolves against the bare app address, so
  with a query string (?utm_source, ?cftest=1) the click reloads the whole app. router.py intercepts `a[href^="#"]`
  clicks and sets location.hash. Keep that.
- three's `Vector4()` defaults w to 1 (a shader branch keyed on .w ran with zero vectors -> NaN sky -> NaN env map ->
  every lit surface black). NaN anywhere in the HDR target blacks out the frame through bloom: bisect with
  readRenderTargetPixels on the opaque target.
- Polar ground grids: wind the triangles counter-clockwise seen from above or the ground is culled.
- three's polyhedra are non-indexed: computeVertexNormals is flat; CF.smoothNormals averages coincident vertices.
- A 2D fire slice pulls every tongue into one central plume (2D entrainment): widen with FireVolume.spread / weaker
  jets, measure w80. Too wide = a soft blurry bonfire.
- Headless Chrome needs `--use-angle=swiftshader --enable-unsafe-swiftshader` (tools/live/drive.mjs) or no WebGL.
  axe measures dialogs mid-fade: wait ~1.8 s before scanning one. Anvil keeps closed dialogs in the DOM: check for a
  *visible* `.anvil-modal` (Pages/Fire `_dialog_open`).
- Skulpt has no `typing`: for nullable DOM values use `anvil.js.call(window.Function("return document"))` (typed Any).
- No users service: the legal kit installer skips the consent columns (legal-kit/install.py, since 2026-11-04).

- The local App Server (1.18) lags hosted Anvil: no `HtmlComponent.attrs` (use state.set_attr), `Notification(role=)`
  raises (state.toast falls back), notifications are `.anvil-alert[data-notify]`, components are wrapped in
  `<anvil-dropzone>` (app.css: `display: contents`). app.css styles both. Test on hosted Anvil too for big changes.
- Anvil's alert() without `large=True` is a 300 px modal: our role `app-dialog` widens it.
- Headless Chrome: Anvil's service worker breaks reused profiles (drive.mjs bypasses it); phone width needs device
  emulation (`MOBILE=390,844`), windows can't go below ~500 px.
- `require_secure_passwords` rejects leaked passwords: tests use random ones.
- Heredocs in the Bash tool mangle quotes: write files with the Write tool.
- A script's `el.focus()` doesn't always match `:focus-visible`, so tests check focus rings through the CSS rules,
  not computed styles. Never put `outline: none` on `input:focus` without `:not([type=checkbox]):not([type=radio])`.
- Never write Anvil's theme-colour token pattern (percent, `color:`, name, percent) in theme.css.

## Privacy & Terms (legal kit)

From `C:/Users/arkvi/Documents/CLAUDE/APP_MAKER/legal-kit`: change `apps/campfire.json`, then there
`python -I build.py campfire && python -I install.py campfire` (writes theme/assets/legal-kit.js,
client_code/legal.py, server_code/legal_server.py and the head_html tag), then `python tools/assets.py` and deploy.
Sign-up keeps the tick box (`legal.consent_field()` in Pages/Auth). Feedback = Prepsto only ("Submit feedback").
- Client and server modules share ONE Python package: a server module can't have the same name as a client
  package or module (server `Items.py` + client `Items/` = "Cannot resolve imported module"). The template's example
  server module is `ExampleItems.py` for that reason.
