/* Does the sound engine hold together? (python -I tools/dev/look.py js tools/dev/sound.js OUT --gpu)
   Nobody can listen in a test, so this measures instead: for each place it starts the sound, plays every one-shot
   the place has (owls, wolves, thunder ...) and reports the level of the mix before the limiter: rms and peak, both
   as a fraction of full scale. Healthy: rms about 0.02 to 0.2, peak well under 1, no NaN, no errors. */
(async function () {
  var F = window.F, A = F.audio, sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var out = {}, errors = [];
  if (!F.lit) F.light();
  F.sound(true);
  await sleep(500);
  if (!A.ctx) return JSON.stringify({ error: 'no AudioContext' });
  var an = A.ctx.createAnalyser(); an.fftSize = 2048; A.master.connect(an);
  var buf = new Float32Array(2048);
  async function listen(sec) {
    var sum = 0, n = 0, peak = 0, bad = 0, end = performance.now() + sec * 1000;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(buf);
      for (var i = 0; i < buf.length; i++) { var v = buf[i]; if (!isFinite(v)) { bad++; continue; } sum += v * v; n++; if (Math.abs(v) > peak) peak = Math.abs(v); }
      await sleep(40);
    }
    return { rms: Math.round(Math.sqrt(sum / Math.max(1, n)) * 1000) / 1000, peak: Math.round(peak * 1000) / 1000, bad: bad };
  }
  F.warp(200);
  var places = { forest: ['owl', 'snap'], snow: ['ice', 'wolf', 'toot', 'frost'], desert: ['coyote', 'snap', 'poorwill'] };
  for (var p in places) {
    F.setPlace(p);
    await sleep(2500);
    var o = { fire: await listen(2.5) };
    var t = A.ctx.currentTime + 0.1;
    places[p].forEach(function (k, i) { try { A[k](t + i * 0.4, (i % 2 ? 0.5 : -0.5)); } catch (e) { errors.push(p + '.' + k + ': ' + e.message); } });
    if (p === 'desert') { try { A.thunder(0.2, 1, 0.3); } catch (e2) { errors.push('thunder: ' + e2.message); } }
    o.calls = await listen(5);
    o.brook = !!A.brook; o.pot = !!A.pot; o.state = A.ctx.state;
    out[p] = o;
  }
  out.errors = errors.concat(window.HARNESS_ERRORS);
  return JSON.stringify(out);
})()
