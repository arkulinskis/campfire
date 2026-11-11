/* Where does a frame go? (python -I tools/dev/look.py js tools/dev/profile.js OUT --phone --query "q=lite&uncap=1")
   Times frames with one part of the picture switched off at a time; what a part costs = how much faster the frame
   gets without it. Meant for SwiftShader (no --gpu), which stands in for a device limited by pixel filling. */
(async function () {
  var F = window.F, sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var ring = []; for (var q = 0; q < 8; q++) ring.push({ x: Math.cos(q * 0.785) * 0.12, y: 0.12, z: Math.sin(q * 0.785) * 0.12, r: 0.06, s: 1, k: q });
  if (!F.lit) F.light();
  F.setWind(0);
  F.spots = function () { this.nSpots = ring.length; this.sootMix = 1; return ring; };
  F.updateFire = function () { this.coal = 0.5; this.coalHeat = 0.5; this.power = 1; this.match = 0; if (!this.burning) this.burning = []; };
  await sleep(8000);
  async function time(sec) { var f0 = F.frame, t0 = performance.now(); await sleep(sec * 1000); return Math.round((performance.now() - t0) / Math.max(1, F.frame - f0) * 10) / 10; }
  var W = F.world, out = {}, sec = 6;
  out.all = await time(sec);
  async function without(name, off, on) { off(); await sleep(600); out['no ' + name] = await time(sec); on(); }
  await without('trees', function () { W.trees.forEach(function (t) { t.visible = false; }); }, function () { W.trees.forEach(function (t) { t.visible = true; }); });
  await without('ground', function () { W.ground.visible = false; }, function () { W.ground.visible = true; });
  await without('sky', function () { W.sky.visible = false; }, function () { W.sky.visible = true; });
  var solid = W.scene.children.filter(function (c) { return c.isMesh && c !== W.ground && c !== W.sky && W.trees.indexOf(c) < 0; });
  await without('stones, logs, props', function () { solid.forEach(function (c) { c.visible = false; }); }, function () { solid.forEach(function (c) { c.visible = true; }); });
  await without('flames, smoke, mist (drawing)', function () { F.transp.visible = false; }, function () { F.transp.visible = true; });
  var step = F.fire.step;
  await without('flame simulation', function () { F.fire.step = function () {}; }, function () { F.fire.step = step; });
  var levels = F.post.levels;
  await without('bloom', function () { F.post.levels = levels.slice(0, 1); }, function () { F.post.levels = levels; });
  out.size = F.post.w + 'x' + F.post.h; out.quality = F.qName;
  return JSON.stringify(out);
})()
