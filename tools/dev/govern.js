/* Does the governor do its job? Three runs, each a fresh page (give the window a pixel ratio above 1 with --phone):
     python -I tools/dev/look.py js tools/dev/govern.js OUT --gpu --phone --query "q=auto&phase=gpu"
   phase=gpu   a slow graphics chip is faked: each frame waits in proportion to the pixels drawn (more with edge
               smoothing on). Giving up resolution helps, so the governor should settle where frames fit again,
               remember it, and take resolution back when the load is lifted.
   phase=cpu   a slow processor / a capped frame rate is faked: every frame takes 45 ms whatever is drawn. Nothing
               helps, so after trying, everything should be put back and the pace accepted ("capped").
   phase=guess only prints what tier a list of graphics chips would start on.
   Reports the first guess for this machine and the governor's steps in order. */
(async function () {
  var F = window.F, sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var phase = (/[?&]phase=(\w+)/.exec(location.search) || [0, 'gpu'])[1];
  try { localStorage.removeItem('campfire.perf'); } catch (e) {}
  var out = { phase: phase, gpu: F.gpuName.slice(0, 60), firstGuess: F.qName, auto: F.autoQ, steps: [] };
  if (phase === 'guess') {
    out.guesses = [['ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)', true, 8, 8], ['ANGLE (Qualcomm, Adreno (TM) 610, OpenGL ES 3.2)', true, 4, 8], ['Mali-G52 MC2', true, 3, 8], ['Mali-T830', true, 2, 4],
                   ['Apple GPU', true, 0, 6], ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', false, 8, 8], ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU Direct3D11)', false, 8, 16],
                   ['Google SwiftShader', false, 8, 8], ['', true, 0, 4], ['', false, 0, 12]].map(function (g) { return (g[0] || '(hidden)').slice(0, 34) + ' -> ' + window.CF.guessTier(g[0], g[1], g[2], g[3], g[1] ? 390 : 1400); });
    return JSON.stringify(out);
  }
  if (!F.lit) F.light();
  var onEvent = F.opts.onEvent, t0 = performance.now();
  F.opts.onEvent = function (name, data) {
    if (name === 'eased') out.steps.push(Math.round((performance.now() - t0) / 1000) + 's ' + data + ' -> ' + F.qName + ' x' + F.state().scale + ' aa' + F.state().smooth + ' ' + F.state().simHz + 'Hz');
    if (onEvent) onEvent(name, data);
  };
  var busy = setInterval(function () { F.lastInput = performance.now(); }, 1000);   // someone is using it: no 30-frame rest
  await sleep(5000);
  out.calm = { quality: F.qName, scale: F.state().scale, smooth: F.state().smooth, fps: F.state().fps, steps: out.steps.length };
  var tick = F.tick, start = F.qName;
  if (phase === 'cpu') {
    F.tick = function () { var end = performance.now() + 45; while (performance.now() < end) {} tick.call(F); };
    await sleep(50000);
    out.end = { quality: F.qName, backToStart: F.qName === start, scale: F.state().scale, smooth: F.state().smooth, simHz: F.state().simHz, acceptedMs: Math.round(F.gov.capMs) };
  } else {
    F.tick = function () { var end = performance.now() + 58 * F.post.w * F.post.h / 1e6 * (F.post.samples ? 1.3 : 1); while (performance.now() < end) {} tick.call(F); };
    await sleep(30000);
    out.settled = { quality: F.qName, scale: F.state().scale, smooth: F.state().smooth, simHz: F.state().simHz, fps: F.state().fps, size: F.post.w + 'x' + F.post.h };
    var saved = null; F.savePerf(); try { saved = JSON.parse(localStorage.getItem('campfire.perf')); } catch (e2) {}
    out.remembered = saved && { tier: saved.tier, scale: saved.scale, msaaOff: saved.msaaOff };
    F.tick = tick; var s0 = F.gov.scale;   // the load is lifted: resolution comes back a step every half minute
    await sleep(68000);
    out.recovered = { govScale: [s0, F.gov.scale], scale: F.state().scale, fps: F.state().fps };
  }
  clearInterval(busy);
  out.errors = window.HARNESS_ERRORS;
  return JSON.stringify(out);
})()
