/* Phone-width check (run at 390 px wide by tools/ui_test.py): every page, before and after lighting the fire, loads
   without errors, without sideways scrolling, and with every control inside the screen. Resolves to {ok, log}. */
(async function () {
  const log = [], bad = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 30000);
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(200); }
    throw new Error('timed out waiting for: ' + what);
  }
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => !!e && e.getBoundingClientRect().width > 0;
  function check(name) {
    const vw = Math.min(window.innerWidth, screen.width), w = document.documentElement.scrollWidth;
    const wide = $$('body *').filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1 && !e.closest('.cf-stage'); })
      .slice(0, 3).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 2).join('.'));
    if (w > vw + 1 || wide.length) bad.push(name + ' too wide (' + w + ' > ' + vw + ') ' + wide.join(' '));
    log.push((w > vw + 1 || wide.length ? 'WIDE ' : 'ok   ') + name + ' (' + w + ')');
  }
  async function page(hash, ready) {
    if (location.hash !== hash) window.UI_READY = false;
    location.hash = hash;
    await until(() => window.UI_READY && location.hash === hash && (!ready || ready()), hash);
    await sleep(600);
  }
  try {
    await page('#fire', () => vis($('.cf-intro')));
    check('#fire before the match');
    const m = $('.anvil-role-cf-match button').getBoundingClientRect();
    if (m.bottom > innerHeight || m.top < 0) bad.push('the match button is off screen');
    $('.anvil-role-cf-match button').click();
    await until(() => vis($('.cf-hud')) && $$('.cf-tray .anvil-role-cf-wood button').length >= 5, 'controls');
    await sleep(800);
    check('#fire lit');
    const off = $$('.cf-hud button').filter((b) => vis(b)).filter((b) => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.top < 0; });
    if (off.length) bad.push('controls off screen: ' + off.map((b) => b.textContent.trim()).join(', '));
    log.push((off.length ? 'OFF  ' : 'ok   ') + 'every control is on screen');
    // the dialogs at phone width
    $$('.cf-top button').find((b) => /midnight|snow|canyon/i.test(b.textContent)).click();
    await until(() => $$('.cf-place').length === 3, 'places');
    await sleep(500); check('place picker');
    $('.cf-places-dialog .anvil-role-ic-x button').click();
    await until(() => !$('.cf-places-dialog'), 'closed');
    $$('.cf-top button').find((b) => b.getAttribute('aria-label') === 'Settings' || /Settings/.test(b.textContent)).click();
    await until(() => vis($('.cf-settings')), 'settings');
    await sleep(500); check('settings');
    $('.cf-settings .anvil-role-btn-primary button').click();
    await until(() => !$('.cf-settings'), 'closed');
    await page('#about', () => $('#ab-title'));
    check('#about');
    log.push(bad.length ? 'PROBLEMS: ' + bad.join(' | ') : 'PASSED');
    return { ok: !bad.length, log: log };
  } catch (e) {
    log.push(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
