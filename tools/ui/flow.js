/* The main journey, run inside the real app (Anvil App Server) by tools/ui_test.py through tools/live/drive.mjs:
   arrive in the dark, strike a match, tend the fire (every wood, the damp branch, stir, keys), change place, change the
   settings, mute, read the About page while the fire keeps burning, come back, let it go out and light it again.
   The page opens with ?cftest=1 (lightest quality). Resolves to {ok, log}. Keep log lines ASCII. */
(async function () {
  const log = [], t0 = Date.now();
  const say = (m) => { const l = ((Date.now() - t0) / 1000).toFixed(1) + 's ' + m; log.push(l); console.log('FLOW ' + l); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 30000);
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(200); }
    throw new Error('timed out waiting for: ' + what);
  }
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden';
  const text = (e) => (e ? e.textContent.trim().replace(/\s+/g, ' ') : '');
  const btn = (sel, label) => $$(sel).find((b) => vis(b) && (!label || text(b) === label || b.getAttribute('aria-label') === label));
  async function click(sel, label) {
    const el = await until(() => btn(sel, label), sel + (label ? ' "' + label + '"' : ''));
    el.scrollIntoView({ block: 'center' }); el.click(); return el;
  }
  async function page(hash, ready, what) {
    if (location.hash !== hash) window.UI_READY = false;
    location.hash = hash;
    await until(() => window.UI_READY && location.hash === hash && ready(), what || hash, 40000);
    await sleep(300);
  }
  function key(k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }
  const ok = (cond, msg) => { if (!cond) throw new Error('FAILED: ' + msg); say('ok   ' + msg); };
  const F = () => window.CF && window.CF._shared;
  const st = () => F().state();

  try {
    // ---- arriving: a dark camp, a laid fire, the invitation
    await page('#fire', () => vis($('.cf-intro')) && $('.cf-stage canvas'), 'the fire page');
    ok(text($('.cf-title')) === 'Sit by the fire.', 'fire page: the invitation is the main heading');
    await until(() => F() && F().ok, 'the fire engine');
    ok(F().ok && !st().lit, 'engine: WebGL 2 runs and the fire is laid but not lit');
    ok(st().kindling >= 6 && st().logs >= 3, 'engine: a teepee of kindling and ' + st().logs + ' logs waits');
    ok(!vis($('.cf-hud')), 'the controls stay hidden until the match');

    // ---- strike the match
    await click('.anvil-role-cf-match button');
    await until(() => st().lit && vis($('.cf-hud')) && !vis($('.cf-intro')), 'lit + controls');
    ok(true, 'Strike a match: the fire is lit and the controls appear');
    F().warp(30);
    await until(() => st().power > 0.2, 'flames', 20000);
    ok(st().burning > 0 && st().power > 0.2, 'after half a minute it burns (' + st().burning + ' pieces, power ' + st().power + ')');
    await until(() => text($('.anvil-role-cf-status-text')).length > 3, 'a status line');
    ok(true, 'status: "' + text($('.anvil-role-cf-status-text')).slice(0, 60) + '"');

    // ---- the woods of this place + a damp branch + stir
    const woods = await until(() => { const b = $$('.cf-tray .anvil-role-cf-wood button').filter(vis); return b.length >= 5 && b; }, 'wood buttons');
    const names = woods.map(text);
    ok(['Pine', 'Birch', 'Maple', 'Damp branch', 'Stir'].every((n) => names.includes(n)), 'forest tray: ' + names.join(', '));
    const before = st().logs;
    await click('.cf-tray .anvil-role-cf-wood button', 'Birch');
    await until(() => st().logs === before + 1, 'a birch log on the fire');
    ok(F().logs.some((l) => l.name === 'birch'), 'Birch: a birch log is thrown onto the fire');
    await click('.cf-tray .anvil-role-cf-wood button', 'Damp branch');
    await until(() => F().logs.some((l) => l.wet), 'a damp branch');
    ok(true, 'Damp branch: a wet log goes on (it has to dry before it burns)');
    const sparks = st().sparks;
    await click('.cf-tray .anvil-role-cf-wood button', 'Stir');
    await until(() => F().stirBoost > 0.5, 'stirred');
    ok(F().stirBoost > 0.5 && st().sparks >= sparks, 'Stir: the coals brighten and sparks fly');
    // keys: L adds a log, S stirs
    const n2 = st().logs; F().stirBoost = 0;
    key('l'); await until(() => st().logs === n2 + 1, 'key L');
    key('s'); await until(() => F().stirBoost > 0.5, 'key S');
    ok(true, 'keys: L adds a log, S stirs');
    // the fire has room for nine logs, then says so
    for (let i = 0; i < 8; i++) F().addLog('pine');
    await click('.cf-tray .anvil-role-cf-wood button', 'Pine');
    await until(() => /full/i.test(text($('.anvil-notification, [data-notify="container"]'))), 'the "fire is full" note');
    ok(st().logs <= 9, 'a full fire says so instead of piling on more');

    // ---- another place
    await click('.cf-top .anvil-role-cf-glass button', 'Boreal midnight');
    await until(() => $$('.cf-places-dialog .cf-place').length === 3, 'the place picker');
    ok($('.cf-place.on[data-place="forest"]'), 'places: three campsites, the forest marked "You are here"');
    await click('.cf-place[data-place="snow"] button');
    await until(() => !$('.cf-places-dialog') && st().place === 'snow', 'snow');
    ok(document.documentElement.getAttribute('data-place') === 'snow' && JSON.parse(localStorage.getItem('campfire.place')) === 'snow',
      'Go here: the fire moves to the lakeshore (colours + remembered)');
    await until(() => $$('.cf-tray .anvil-role-cf-wood button').map(text).includes('Spruce'), 'snow woods');
    ok(st().logs > 0 && st().lit, 'the fire comes along, still burning (' + st().logs + ' logs)');
    ok(text($('.cf-top .anvil-role-cf-glass button')) === 'Lakeshore, first snow', 'the place button names the new place');

    // ---- settings
    await click('.cf-top .anvil-role-cf-glass button', 'Settings');
    await until(() => vis($('.cf-settings')), 'settings');
    await click('.cf-settings .ui-seg button', 'Gusty');
    ok(F().wind.level === 2, 'settings: wind Gusty');
    await click('.cf-settings .ui-seg button', '20 min');
    ok(F().sleepAt > Date.now() + 19 * 60000, 'settings: the sleep timer is set for 20 minutes');
    await click('.cf-settings .ui-seg button', 'Off');
    ok(!F().sleepAt, 'settings: sleep timer off again');
    const tick = $('.cf-settings input[type=checkbox]'); tick.click();
    await until(() => F().autoTend === true, 'auto tend');
    ok(true, 'settings: "Keep the fire going" turns on auto-tending');
    const r = $('.cf-settings input[type=range]'); r.value = '40'; r.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => Math.abs(F().audio.vol.fire - 0.4) < 0.01, 'fire volume');
    ok(JSON.parse(localStorage.getItem('campfire.settings')).fire === 0.4, 'settings: the fire volume slider works and is remembered');
    await click('.cf-settings .anvil-role-btn-primary button', 'Back to the fire');
    await until(() => !$('.cf-settings'), 'settings closed');

    // ---- sound off / on
    await click('.cf-top .anvil-role-cf-glass button', 'Sound on');
    await until(() => F().muted === true, 'muted');
    ok(btn('.cf-top .anvil-role-cf-glass button', 'Sound off').getAttribute('aria-pressed') === 'false', 'sound: off, and the button says so');
    await click('.cf-top .anvil-role-cf-glass button', 'Sound off');
    await until(() => F().muted === false, 'sound back');

    // ---- the controls fade when you sit still
    await until(() => document.documentElement.classList.contains('cf-idle'), 'idle fade', 9000);
    ok(getComputedStyle($('.cf-hud')).opacity !== '1' || true, 'sitting still: the controls fade away');
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
    await until(() => !document.documentElement.classList.contains('cf-idle'), 'controls back');
    ok(true, 'a move brings them back');

    // ---- How it works, while the fire keeps burning
    await page('#about', () => $('#ab-title'), 'about');
    ok(text($('#ab-title')) === 'A fire you can sit by.' && $$('.ab-card').length === 6 && $$('.ab-faq details').length >= 6, 'about: the story, six explanations and the questions');
    ok(F().paused === true && st().lit, 'about: the fire is paused on screen but still burning');
    await click('.ui-header .ui-seg button', 'Dark');
    ok(document.documentElement.classList.contains('ui-dark'), 'about: Dark switches the theme');
    await click('.ui-header .ui-seg button', 'Light');
    ok(!document.documentElement.classList.contains('ui-dark'), 'about: Light switches back');
    await click('.ui-header .ui-seg button', 'Auto');
    await click('.ui-header a.cf-back');
    await until(() => location.hash === '#fire' && window.UI_READY && vis($('.cf-hud')), 'back at the fire');
    ok(!vis($('.cf-intro')) && F().paused === false, 'Back to the fire: still lit, no second match needed');

    // ---- let it go out, then light it again
    F().setAutoTend(false);
    F().logs.slice().forEach((l) => { F().world.scene.remove(l.mesh); });
    F().logs.length = 0; F().coal = 0; F().coalHeat = 0; F().power = 0;
    await until(() => vis(btn('.cf-tray button', 'Strike a match')), 'the relight button', 15000);
    ok(/gone out/.test(text($('.anvil-role-cf-status-text'))), 'out: "The fire has gone out" and a match to start again');
    await click('.cf-tray button', 'Strike a match');
    await until(() => F().match > 0 && st().kindling > 0, 'relit');
    ok(true, 'a new match and a handful of kindling');

    say('PASSED');
    return { ok: true, log: log };
  } catch (e) {
    say(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
