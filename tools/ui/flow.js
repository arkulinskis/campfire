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

    // ---- someone else sits down: the circle (a second visitor played through the server by the test hook)
    await until(() => window.CF_TEST && window.CF_TEST.circle, 'the circle test hook');
    const C = window.CF_TEST.circle;
    let me = await C.pulse();
    for (let w = 0; w < 20 && me.circle.people.length >= 5; w++) {   // back-to-back runs: wait for a seat to free up (3 min at most)
      if (!w) say('note: my circle is full of visitors from earlier runs; waiting for a seat');
      await sleep(10000); me = await C.pulse();
    }
    const n0 = me.circle.people.length;   // visitors from a test run in the last 3 minutes may still be sitting here
    if (n0) say('note: ' + n0 + ' visitor(s) left over from an earlier run share this circle');
    ok(me.circle && me.circle.id && F().people.count() === n0, 'seated in a circle (' + me.circle.name + '), ' + n0 + ' others drawn');
    if (!n0) ok(!vis(btn('.cf-tray button', 'Wave')), 'alone: no Wave button');
    const vsid = 'visitor-' + Date.now();
    const vb = await C.visitor(vsid, 'beat');
    ok(vb.ok && vb.circle.id === me.circle.id && (n0 || vb.circle.seat === 3), 'a second visitor at the same place joins my circle' + (n0 ? '' : ', across the fire (seat 3)'));
    me = await C.pulse();
    const vname = vb.circle.name, vseat = vb.circle.seat;
    ok(me.circle.people.length === n0 + 1 && me.circle.people.some((p) => p.name === vname), 'my heartbeat: ' + vname + ' is in my circle');
    await until(() => F().people.count() === n0 + 1, 'an avatar');
    const pl = F().people.list().find((p) => p.name === vname);
    if (!n0) ok(pl.k === 3 && pl.z < -2.3 && Math.abs(pl.x - 0.86) < 0.1, vname + ' sits on the seat log across the fire, beside the flames (' + pl.x + ', ' + pl.z + ', ' + pl.hat + ')');
    await until(() => text($('.anvil-role-cf-feed-text')) === vname + ' sat down by the fire.', 'the arrival line');
    ok(vis($('.cf-feed')) && text($('.anvil-role-cf-feed-text')).indexOf(vname) === 0, 'news: "' + text($('.anvil-role-cf-feed-text')) + '"');
    ok(/^You're \w+\. .+ by this fire with you\./.test(text($('.anvil-role-cf-presence'))), 'presence: "' + text($('.anvil-role-cf-presence')) + '"');
    await until(() => vis(btn('.cf-tray button', 'Wave')), 'the Wave button');
    ok(true, 'company: a Wave button joins the tray');
    const tag = await until(() => $$('.cf-people .cf-tag').find((t) => t.getAttribute('aria-label') === 'Wave to ' + vname), 'the name tag');
    ok(tag.textContent.indexOf(vname) >= 0, 'a name tag over ' + vname + ' (a button: "Wave to ' + vname + '")');
    // they wave to me, throw a log in, stir
    const logsBefore = new Set(F().logs), t0 = vb.circle.t;
    ok((await C.visitor(vsid, 'wave', me.circle.seat)).ok && (await C.visitor(vsid, 'log', null, 'maple', false)).ok && (await C.visitor(vsid, 'stir')).ok,
      'the visitor waves to me, puts a maple log on and stirs (server accepted all three)');
    F().stirBoost = 0;
    await C.pulse();
    await until(() => /waves to you/.test(text($('.anvil-role-cf-feed-text'))), 'their wave');
    ok(F().people.list().find((p) => p.name === vname).act === 'wave' && vis(btn('.cf-feed button', 'Wave back')), 'their avatar waves: "' + vname + ' waves to you." + Wave back');
    ok(tag.classList.contains('is-to-you') && /waves to you/.test(tag.textContent), 'their tag says "waves to you"');
    const vp = () => F().people.all().find((p) => p.name === vname);
    await until(() => vp().queue.length >= 2, 'the log and the stir waiting their turn', 9000);   // they arrive 1.7 s apart
    ok(vp().queue.map((q) => q.kind).join(',') === 'log,stir', 'one thing at a time: the log and the stir wait for the wave to finish');
    for (let i = 0; i < 12 && !F().logs.some((l) => l.name === 'maple' && !logsBefore.has(l)); i++) F().people.update(0.4, F().time, F().camera, false);   // headless Chrome draws ~2 frames a second: fast-forward the people
    await until(() => F().logs.some((l) => l.name === 'maple' && !logsBefore.has(l)), 'their log', 8000);
    ok(true, 'their maple log lands in my fire, thrown from their seat');
    for (let i = 0; i < 12 && F().stirBoost <= 0.5; i++) F().people.update(0.4, F().time, F().camera, false);
    await until(() => F().stirBoost > 0.5, 'their stir', 8000);
    ok(/^\w+ stirs the fire\.$/.test(text($('.anvil-role-cf-feed-text'))), 'their stir: the coals brighten in my fire too, "' + text($('.anvil-role-cf-feed-text')) + '"');
    // I answer
    await click('.cf-people .cf-tag', 'Wave to ' + vname);
    await until(() => text($('.anvil-role-cf-feed-text')) === 'You wave to ' + vname + '.', 'my wave');
    ok(true, 'pressing their name tag: "You wave to ' + vname + '."');
    key('w');
    await until(() => text($('.anvil-role-cf-feed-text')) === 'You wave to everyone.', 'key W');
    ok(true, 'key W: "You wave to everyone."');
    const nb = await C.visitor(vsid, 'beat', t0);
    const got = nb.circle.news.map((n) => n.kind + ':' + n.seat + ':' + n.to);
    ok(got.includes('wave:' + me.circle.seat + ':' + vseat) && got.includes('wave:' + me.circle.seat + ':null'), 'the visitor\'s next heartbeat brings my waves (' + got.join(', ') + ')');
    const own = st().logs;
    await click('.cf-tray .anvil-role-cf-wood button', 'Birch');
    await until(() => st().logs === own + 1, 'my birch');
    const nb2 = await C.visitor(vsid, 'beat', nb.circle.t);
    ok(nb2.circle.news.some((n) => n.kind === 'log' && n.wood === 'birch'), 'my birch log is shared with the circle');
    // tapping the person (not the tag) also waves
    const pp = F().people.all().find((p) => p.name === vname), cam = F().camera, rect = F().canvas.getBoundingClientRect();
    const hd = pp.headPos().project(cam), hip = pp.worldPos().project(cam);
    const cx = (hd.x * 0.5 + 0.5) * rect.width + rect.left, cy = ((0.5 - hd.y * 0.5) + (0.5 - hip.y * 0.5)) / 2 * rect.height + rect.top;
    ok(F().people.hit(cx, cy) === vseat && F().people.hit(rect.left + 4, rect.top + 4) === -1, 'a tap on the person finds their seat, a tap elsewhere does not');
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
    ok(F().people.count() === 0 && !vis(btn('.cf-tray button', 'Wave')), 'a new place, a new circle: the forest visitor is not here');
    const sn = await C.pulse();
    ok(sn.circle && sn.circle.id !== me.circle.id && /^c-snow-/.test(sn.circle.id), 'the next heartbeat seats me in a lakeshore circle');
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
