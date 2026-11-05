/* Accessibility check (WCAG 2.2 A + AA), run inside the real app by tools/ui_test.py through tools/live/drive.mjs.
   1. axe-core (APP_MAKER/vendor/axe-core, injected by ui_test.py) on every page, signed out and signed in, light and
      dark: a "serious" or "critical" WCAG problem fails the run; smaller ones and best-practice hints are notes.
   2. Keyboard and screen-reader checks: a real main heading, every fire control named, the status line read out,
      focus moving into the dialogs, named sliders, and the Privacy & Terms page keeping Tab inside.
   The fire page is scanned before and after the match, and with each dialog open.
   Resolves to {ok, log}. Keep log lines ASCII (the Windows console). */
(async function () {
  /*AXE*/
  const PUBLIC = ['#fire', '#about'];   // every page (Campfire has no accounts)
  const log = [], bad = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, what, ms) {
    const end = Date.now() + (ms || 30000);
    while (Date.now() < end) { try { const v = fn(); if (v) return v; } catch (e) {} await sleep(150); }
    throw new Error('timed out waiting for: ' + what);
  }
  const $ = (s) => document.querySelector(s), $$ = (s) => Array.from(document.querySelectorAll(s));
  const vis = (e) => e && e.getBoundingClientRect().width > 0;
  const ascii = (s) => String(s).normalize('NFD').replace(/[^\x20-\x7e]/g, '');
  const ok = (cond, msg) => { if (cond) log.push('ok   ' + msg); else { bad.push(msg); log.push('FAIL ' + msg); } };
  function type(input, value) {
    input.focus(); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function page(hash, ready) {
    if (location.hash !== hash) window.UI_READY = false;
    location.hash = hash;
    await until(() => window.UI_READY && location.hash === hash && (!ready || ready()), hash, 60000);
    await sleep(900);
  }
  if (!window.axe) { const s = document.createElement('script'); s.textContent = window.__AXE_SRC; document.head.appendChild(s); }

  async function scan(hash, ready) {
    await page(hash, ready);
    for (const theme of ['light', 'dark']) { window.UI.setTheme(theme); await sleep(1600); /* let colour transitions (night fire page -> About) and toasts settle */ await axeRun(hash + ' ' + theme); }
    window.UI.setTheme('auto');
  }
  async function axeRun(hash) {
    const res = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    let serious = 0;
    for (const v of res.violations) {
      const wcag = v.tags.some((t) => /^wcag2/.test(t));
      const fail = wcag && (v.impact === 'serious' || v.impact === 'critical');
      const where = v.nodes.slice(0, 2).map((n) => ascii(n.target.join(' ')).slice(0, 70)).join(' | ');
      log.push((fail ? 'FAIL ' : 'note ') + hash + ' ' + v.id + ' (' + v.impact + ', ' + v.nodes.length + 'x): ' + where);
      if (fail) {
        serious++; bad.push(hash + ' ' + v.id);
        for (const n of v.nodes.slice(0, 3)) log.push('       ' + ascii(n.html).replace(/\s+/g, ' ').slice(0, 150) + ' :: ' + ascii((n.failureSummary || '').split(/\n/).slice(1).join(' ')).slice(0, 150));
      }
    }
    if (!serious) log.push('ok   ' + hash + ': no serious WCAG problems (' + res.passes.length + ' rules pass)');
  }

  try {
    // ---------------------------------------------------------------- the fire page: names for every control
    await page('#fire', () => $('.anvil-role-cf-match button'));
    ok(!!$('h1#cf-title'), 'fire: "Sit by the fire." is the main heading');
    ok($('.cf-stage canvas') && $('.cf-stage canvas').getAttribute('aria-hidden') === 'true', 'fire: the canvas is decoration for screen readers (the controls carry the meaning)');
    // ---------------------------------------------------------------- Privacy & Terms keeps Tab inside
    const lk = $$('[data-lk-open]').find(vis);
    if (lk) {
      lk.click();
      await until(() => window.LegalKit && window.LegalKit.isOpen(), 'the Privacy page');
      const behind = Array.from(document.body.children).filter((e) => e.id !== 'lk-root' && e.tagName !== 'SCRIPT');
      ok(behind.length && behind.every((e) => e.inert), 'privacy page: the app behind it is inert (Tab stays inside)');
      window.LegalKit.close();
      ok(Array.from(document.body.children).every((e) => !e.inert), 'privacy page: closing it gives the app back');
    }

    // ---------------------------------------------------------------- axe on every page, the lit fire and both dialogs
    for (const h of PUBLIC) await scan(h);
    await page('#fire', () => $('.anvil-role-cf-match button'));
    $('.anvil-role-cf-match button').click();
    await until(() => vis($('.cf-hud')) && $$('.cf-tray .anvil-role-cf-wood button').length >= 5, 'the lit fire');
    const unnamed = $$('.cf-hud button').filter(vis).filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim()));
    ok(!unnamed.length, 'lit fire: every control has a name');
    ok($('.anvil-role-cf-status-text') && /status|alert/.test($('.anvil-role-cf-status-text').getAttribute('role') || ''), 'lit fire: the status line is read out when it changes');
    await sleep(1200); await axeRun('#fire lit');
    $$('.cf-top button').find((b) => /midnight|snow|canyon/i.test(b.textContent)).click();
    await until(() => $$('.cf-place').length === 3, 'places');
    await sleep(1800); await axeRun('place picker');
    ok($('.cf-places-dialog').contains(document.activeElement), 'place picker: the keyboard focus moves into the dialog');
    $('.cf-places-dialog .anvil-role-ic-x button').click();
    await until(() => !$('.cf-places-dialog'), 'closed');
    $$('.cf-top button').find((b) => /Settings/.test(b.textContent)).click();
    await until(() => vis($('.cf-settings')), 'settings');
    await sleep(1800); await axeRun('settings');
    ok($$('.cf-settings input[type=range]').every((r) => r.getAttribute('aria-label') || r.closest('label')), 'settings: the sliders have names');
    $('.cf-settings .anvil-role-btn-primary button').click();
    await until(() => !$('.cf-settings'), 'closed');
    log.push(bad.length ? 'PROBLEMS: ' + bad.join(' | ') : 'PASSED');
    return { ok: !bad.length, log: log };
  } catch (e) {
    log.push(String(e && e.message || e));
    return { ok: false, log: log };
  }
})();
