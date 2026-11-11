/* How fast is a frame? (python -I tools/dev/look.py js tools/dev/bench.js OUT --gpu --query "q=low&uncap=1")
   Runs the standard burner (see metrics.js), then times 6 seconds of frames with the frame cap off and reports
   frames per second, milliseconds per frame, three.js draw calls per frame, GPU passes per simulation step and
   the size of the picture. Works on older copies of the engine too (--old DIR --query "a=OLD&...").
   On SwiftShader (no --gpu) the number is a rough stand-in for a device limited by how many pixels it can fill. */
(async function () {
  var F = window.F, sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var ring = []; for (var q = 0; q < 8; q++) ring.push({ x: Math.cos(q * 0.785) * 0.12, y: 0.12, z: Math.sin(q * 0.785) * 0.12, r: 0.06, s: 1, k: q });
  if (!F.lit) F.light();
  F.setWind(0);
  F.spots = function () { this.nSpots = ring.length; this.sootMix = 1; return ring; };
  F.updateFire = function () { this.coal = 0.5; this.coalHeat = 0.5; this.power = 1; this.match = 0; if (!this.burning) this.burning = []; };
  var wait = /[?&]settle=(\d+)/.exec(location.search);
  await sleep(wait ? +wait[1] : 9000);
  var info = F.renderer.info; info.autoReset = false; info.reset();
  var f0 = F.frame, t0 = performance.now();
  await sleep(6000);
  var frames = F.frame - f0, sec = (performance.now() - t0) / 1000, st = F.state();
  var out = { quality: st.quality, fps: Math.round(frames / sec * 10) / 10, ms: Math.round(sec / frames * 1e4) / 10,
              calls: Math.round(info.render.calls / frames), tris: Math.round(info.render.triangles / frames),
              size: F.post.w + 'x' + F.post.h, simGrid: F.q.nx + 'x' + F.q.ny + ' x' + F.q.slices };
  if (F.fire.passesPerStep) { out.simPasses = F.fire.passesPerStep(); out.smooth = st.smooth; out.simHz = st.simHz; }
  else { out.simPasses = F.q.slices * (9 + F.q.iters) + ' (three.js passes)'; }
  out.errors = window.HARNESS_ERRORS;
  return JSON.stringify(out);
})()
