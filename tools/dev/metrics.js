/* Measure the flames instead of guessing (run with: python -I tools/dev/look.py js tools/dev/metrics.js OUT --gpu).
   Runs a standard burner (steady fuel, no wind) for a quarter of a minute, then samples the middle slice 40
   times over ten seconds and reports:
     h50, h90   height (m) below which 50% / 90% of the light is emitted      w80  width (m) holding the middle 80%
     light      the engine's own light reading     tmax  hottest theta      speed  mean upward speed in the flame (m/s)
     div        RMS of (div v - expansion) after the pressure solve, 1/s: how far the flow is from mass-conserving
     divPlume   the same, only in hot gas whose fuel is spent (no expansion there, so it should be zero)
     divLarge   the same, averaged over 8 cm blocks first: the large-scale error, the part that bends the whole plume
     fps        frames per second while sampling    passes  GPU passes per simulation step (new engine only)
   Works on the current engine and on older copies (look.py --old DIR --query "a=OLD"). */
(async function () {
  var F = window.F, THREE = window.THREE, CF = window.CF;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var bb = CF.blackbodyTexture().image.data;
  function lum(theta) { var i = Math.max(0, Math.min(255, Math.round(theta / 1.4 * 255))); return Math.exp(bb[i * 4 + 3] / 255 * 26 - 22); }
  function sstep(a, b, x) { var t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
  function fields() {
    var mid = F.fire.slices[F.fire.slices.length >> 1].sim;
    if (mid.probe) { var p = mid.probe(); return { s: p.scal, v: p.vel, nx: p.nx, ny: p.ny, W: p.W, H: p.H, expand: mid.params.expand }; }
    var nx = mid.nx, ny = mid.ny, n = nx * ny * 4, a = new Uint16Array(n), b = new Uint16Array(n), s = new Float32Array(n), v = new Float32Array(n);
    F.renderer.readRenderTargetPixels(mid.sc[0], 0, 0, nx, ny, a); F.renderer.readRenderTargetPixels(mid.vel[0], 0, 0, nx, ny, b);
    for (var i = 0; i < n; i++) { s[i] = THREE.DataUtils.fromHalfFloat(a[i]); v[i] = THREE.DataUtils.fromHalfFloat(b[i]); }
    return { s: s, v: v, nx: nx, ny: ny, W: mid.W, H: mid.H, expand: mid.params.expand };
  }
  function measure() {
    var f = fields(), nx = f.nx, ny = f.ny, rows = new Float64Array(ny), cols = new Float64Array(nx), tot = 0, tmax = 0, sp = 0, spw = 0, x, y, i;
    for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
      i = (y * nx + x) * 4; var T = f.s[i], S = f.s[i + 2], e = S * lum(T) * sstep(0.5, 0.78, T);
      rows[y] += e; cols[x] += e; tot += e; if (T > tmax) tmax = T; sp += f.v[i + 1] * e; spw += e;
    }
    function pct(arr, q) { var acc = 0; for (var k = 0; k < arr.length; k++) { acc += arr[k]; if (acc >= q * tot) return k + 0.5; } return arr.length; }
    var h = f.W / nx, div = 0, dn = 0, air = 0, an = 0, B = Math.round(0.08 / h), bw = Math.ceil(nx / B), blocks = new Float64Array(bw * Math.ceil(ny / B)), bc = new Float64Array(blocks.length);
    for (y = 1; y < ny - 1; y++) for (x = 1; x < nx - 1; x++) {
      i = (y * nx + x) * 4;
      var d = (f.v[i + 4] - f.v[i - 4] + f.v[i + nx * 4 + 1] - f.v[i - nx * 4 + 1]) / (2 * h) - f.expand * f.s[i + 1] * sstep(0.15, 0.38, f.s[i]);
      div += d * d; dn++;
      var bi = Math.floor(y / B) * bw + Math.floor(x / B); blocks[bi] += d; bc[bi]++;
      if (f.s[i + 1] < 0.002 && f.s[i] > 0.05) { air += d * d; an++; }   // hot gas with no fuel left: nothing expands here
    }
    var big = 0, bn = 0;
    for (i = 0; i < blocks.length; i++) if (bc[i] > B * B * 0.6) { var mean = blocks[i] / bc[i]; big += mean * mean; bn++; }
    return { h50: pct(rows, 0.5) / ny * f.H, h90: pct(rows, 0.9) / ny * f.H, w80: (pct(cols, 0.9) - pct(cols, 0.1)) / nx * f.W,
             tmax: tmax, speed: spw ? sp / spw : 0, div: Math.sqrt(div / dn), divPlume: Math.sqrt(air / Math.max(1, an)), divLarge: Math.sqrt(big / Math.max(1, bn)), emit: tot * h * h };
  }
  // A standard burner, so numbers from different versions and runs can be compared: eight steady fuel spots in a
  // ring, a fixed coal bed, no wind, no logs burning down, no flares. (Add ?burner=0 to measure the real fire.)
  var live = /[?&]burner=0/.test(location.search);
  if (!F.lit) F.light();
  if (live) { F.setAutoTend(true); F.warp(240); }
  else {
    var ring = []; for (var q = 0; q < 8; q++) ring.push({ x: Math.cos(q * 0.785) * 0.12, y: 0.12, z: Math.sin(q * 0.785) * 0.12, r: 0.06, s: 1, k: q });
    F.setWind(0); F.wind.g.x = 0; F.wind.gust = 0;
    F.spots = function () { this.nSpots = ring.length; this.sootMix = 1; return ring; };
    F.updateFire = function () { this.coal = 0.5; this.coalHeat = 0.5; this.power = 1; this.match = 0; if (!this.burning) this.burning = []; };
    F.wind.g.step = function () { return 0; };
    await sleep(14000);
  }
  await sleep(1500);
  var acc = {}, N = 40, k, fpsSum = 0;
  for (var j = 0; j < N; j++) { await sleep(250); var m = measure(); for (k in m) acc[k] = (acc[k] || 0) + m[k] / N; fpsSum += F.fps / N; }
  var out = {};
  for (k in acc) out[k] = Math.round(acc[k] * 1000) / 1000;
  out.fps = Math.round(fpsSum); out.light = F.state().light; out.power = F.state().power; out.quality = F.qName;
  if (F.fire.passesPerStep) out.passes = F.fire.passesPerStep();
  out.errors = window.HARNESS_ERRORS;
  return JSON.stringify(out);
})()
