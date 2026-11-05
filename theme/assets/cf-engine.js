/* Campfire engine, part 6: the fire's life and the API the app uses.
   The fire is a small model of real wood burning: each log has a species, moisture, ignition progress, mass
   and char. Heat from the flames and the coal bed reaches each log according to where it lies; wet wood must
   dry first (steam hiss), then catches, burns at its species' pace, chars, shrinks and finally collapses into
   the coal bed. A teepee falls in when its logs burn through. Untended, the fire dies down over half an hour
   to glowing coals. Burning logs feed fuel spots to the GPU flame simulation (cf-fire.js), the flames' own
   brightness is read back to light the scene, and the same numbers drive the sound (cf-audio.js).

   var fire = CF.create(element, {place: 'forest', quality: 'auto', onState: fn(state), onEvent: fn(name, data)})
   fire.light()  fire.addLog(species, wet)  fire.stir()  fire.setPlace(p)  fire.setWind(0..2)  fire.setVolume(which, v)
   fire.setAutoTend(bool)  fire.setSleep(minutes)  fire.state()  fire.warp(seconds)  fire.destroy()
   fire.attach(element)  fire.pause(bool)  fire.setHandlers(onState, onEvent)
   fire.setCircle(json)  fire.circleAct(seat, kind, toSeat, wood, wet): the people around the fire (cf-people.js);
   onEvent('wave_to', seat) when you tap someone or their name tag.
   CF.shared(element, opts): one fire per page load (it keeps burning, and crackling, while another page is open).
   window.CF_TEST: {norender: bool} for tests. */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE;

  CF.SPECIES = {
    pine:     { label: 'Pine', note: 'resin: loud pops, lots of sparks', bark: [0.13, 0.085, 0.055], wood: [0.6, 0.45, 0.28], burn: 1.35, life: 11, ignite: 1.3, crackle: 3.2, pop: 0.45, sap: 0.9, soot: 1.25, sparks: 1.7, pitch: 1.0 },
    spruce:   { label: 'Spruce', note: 'the crackliest wood there is', bark: [0.16, 0.1, 0.065], wood: [0.62, 0.5, 0.33], burn: 1.4, life: 10, ignite: 1.4, crackle: 4.0, pop: 0.55, sap: 0.7, soot: 1.2, sparks: 1.9, pitch: 1.1 },
    birch:    { label: 'Birch', note: 'bark flares fast, bright and clean', bark: [0.6, 0.58, 0.54], wood: [0.66, 0.55, 0.4], birch: true, burn: 1.2, life: 12, ignite: 1.9, crackle: 1.3, pop: 0.12, sap: 0.15, soot: 0.95, sparks: 0.7, pitch: 0.95 },
    maple:    { label: 'Maple', note: 'slow, steady, long coals', bark: [0.18, 0.15, 0.12], wood: [0.62, 0.47, 0.31], burn: 0.8, life: 18, ignite: 0.75, crackle: 0.9, pop: 0.15, sap: 0.3, soot: 0.85, sparks: 0.5, pitch: 0.85 },
    ash:      { label: 'Ash', note: 'burns well, quiet and even', bark: [0.2, 0.18, 0.15], wood: [0.68, 0.58, 0.42], burn: 1.0, life: 15, ignite: 1.0, crackle: 0.8, pop: 0.1, sap: 0.1, soot: 0.8, sparks: 0.5, pitch: 0.9 },
    mesquite: { label: 'Mesquite', note: 'dense and hot, deep red coals', bark: [0.15, 0.1, 0.07], wood: [0.5, 0.28, 0.17], burn: 0.75, life: 20, ignite: 0.7, crackle: 1.8, pop: 0.3, sap: 0.2, soot: 0.9, sparks: 1.1, pitch: 0.8 },
    juniper:  { label: 'Juniper', note: 'snaps and spits, fragrant', bark: [0.24, 0.15, 0.1], wood: [0.6, 0.38, 0.25], burn: 1.3, life: 9, ignite: 1.5, crackle: 2.8, pop: 0.4, sap: 0.4, soot: 1.0, sparks: 1.4, pitch: 1.15 },
    pinon:    { label: 'Piñon', note: 'sweet pine smoke, lively', bark: [0.17, 0.11, 0.07], wood: [0.62, 0.46, 0.3], burn: 1.25, life: 11, ignite: 1.3, crackle: 2.6, pop: 0.35, sap: 0.7, soot: 1.15, sparks: 1.4, pitch: 1.0 },
    kindling: { label: 'Kindling', bark: [0.3, 0.22, 0.15], wood: [0.66, 0.53, 0.36], burn: 2.6, life: 1.6, ignite: 5, crackle: 3.0, pop: 0.2, sap: 0.1, soot: 1.0, sparks: 1.0, pitch: 1.35 }
  };
  var KIND = { forest: 'pine', snow: 'spruce', desert: 'pinon' };
  var V = THREE.Vector3, X = new V(1, 0, 0);

  function qualityTier(q) {
    if (q === 'high') return { name: 'high', nx: 144, ny: 248, slices: 3, shadow: 1024, pr: 1.75, sparks: 1400, smoke: 44, iters: 22 };
    if (q === 'low') return { name: 'low', nx: 64, ny: 112, slices: 2, shadow: 0, pr: 1, sparks: 500, smoke: 20, iters: 12 };
    return { name: 'medium', nx: 88, ny: 152, slices: 3, shadow: 512, pr: 1.25, sparks: 900, smoke: 30, iters: 16 };
  }

  function Campfire(el, opts) {
    this.el = el; this.opts = opts || {};
    this.test = window.CF_TEST || {};
    var canvas = document.createElement('canvas');
    canvas.className = 'cf-canvas'; canvas.setAttribute('aria-hidden', 'true');
    el.appendChild(canvas); this.canvas = canvas;
    var gl = null;
    try { gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' }); } catch (e) {}
    if (!gl) { this.ok = false; this.reason = 'webgl2'; return; }
    this.ok = true;
    var r = this.renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: false, alpha: false });
    r.useLegacyLights = false; r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping;
    r.setClearColor(0x000000, 1);
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    this.qName = this.opts.quality && this.opts.quality !== 'auto' ? this.opts.quality : (coarse || window.innerWidth < 700 ? 'medium' : 'high');
    this.autoQ = !this.opts.quality || this.opts.quality === 'auto';
    if (this.test.quality) { this.qName = this.test.quality; this.autoQ = false; }
    this.q = qualityTier(this.qName);
    r.shadowMap.enabled = this.q.shadow > 0; r.shadowMap.type = THREE.PCFShadowMap;
    this.bb = CF.blackbodyTexture();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 900);
    this.cam = { yaw: CF.rng.range(-0.25, 0.25), pitch: 0.1, dist: 3.4, vyaw: 0, vpitch: 0, tdist: 3.4, target: new V(0, 0.55, 0) };
    this.time = 0; this.clockLast = performance.now(); this.frame = 0;
    this.post = new CF.Post(r);
    this.transp = new THREE.Scene();
    this.wind = { level: 1, g: new CF.OU(0.35, 0.22, 0.35), az: new CF.OU(CF.rng.range(0, 6.28), 0.25, 0.02), gustT: 0, gust: 0, x: 0, z: 0 };
    this.lit = false; this.logs = []; this.coal = 0; this.coalHeat = 0; this.stirBoost = 0; this.power = 0; this.pSmooth = 0;
    this.flickSmooth = 0; this.lastPower = 0; this.flicker = 0; this.exposure = 1.2; this.match = 0;
    this.hiss = new CF.OU(0.5, 0.35, 0.4); this.autoTend = false; this.sleepAt = 0; this.sleepFade = 1; this.lastLogAt = 0;
    this.startedAt = Date.now(); this.litAt = 0; this.flares = []; this.nextFlare = 4; this.coalSpots = [];
    this.audio = new CF.Audio(); var self = this;
    this.audio.onPop = function (log) { self.pop(log); };
    this.fps = 60; this.slowFor = 0;
    this.buildFire();
    this.people = CF.People ? new CF.People(this) : null;   // the others in your circle (cf-people.js)
    this.setPlace(this.opts.place || 'forest', true);
    this.layTeepee();
    this.bindInput();
    if (this.test.autolight) this.lit = true, this.litAt = Date.now();
    this.resize();
    this.ro = new ResizeObserver(function () { self.resize(); }); this.ro.observe(el);
    this.loop = function () { self.raf = requestAnimationFrame(self.loop); self.tick(); };
    this.raf = requestAnimationFrame(this.loop);
    this.vis = function () { self.audio.suspend(false); self.clockLast = performance.now(); };
    document.addEventListener('visibilitychange', this.vis);
    this.stateTimer = setInterval(function () {
      if (document.hidden) self.background();   // no animation frames in a background tab: the fire burns on here
      if (self.opts.onState) self.opts.onState(self.state());
    }, 1000);
  }
  CF.create = function (el, opts) { return new Campfire(el, opts); };
  CF.shared = function (el, opts) {
    if (CF._shared && CF._shared.ok) { CF._shared.attach(el); CF._shared.setHandlers(opts.onState, opts.onEvent); CF._shared.pause(false); return CF._shared; }
    CF._shared = new Campfire(el, opts);
    return CF._shared;
  };
  CF.Campfire = Campfire;

  Campfire.prototype.buildFire = function () {
    if (this.fire) { this.transp.remove(this.fire.group); this.fire.dispose(); }
    if (this.sparks) { this.transp.remove(this.sparks.mesh); this.transp.remove(this.smoke.mesh); }
    var q = this.q;
    this.fire = new CF.FireVolume(this.renderer, { blackbody: this.bb, nx: q.nx, ny: q.ny, slices: q.slices, W: 1.3, H: 2.25, y0: -0.03 });
    var iters = q.iters; this.fire.setParams(function (p) { p.iters = iters; });
    this.transp.add(this.fire.group);
    this.sparks = new CF.Sparks(q.sparks, this.bb); this.transp.add(this.sparks.mesh);
    this.smoke = new CF.Smoke(q.smoke); this.transp.add(this.smoke.mesh);
  };

  // ---------------------------------------------------------------- place
  Campfire.prototype.setPlace = function (place, first) {
    if (!CF.PLACES[place]) place = 'forest';
    var r = this.renderer;
    if (this.world) { this.logs.forEach(function (l) { this.world.scene.remove(l.mesh); }, this); this.world.dispose(); }
    this.place = place;
    var W = this.world = CF.buildWorld(place, r, this.q.name);
    var fl = this.fireLight = new THREE.PointLight(0xff8833, 0, 0, 2);
    fl.position.set(0, 0.4, 0); fl.castShadow = this.q.shadow > 0;
    if (fl.castShadow) { fl.shadow.mapSize.set(this.q.shadow, this.q.shadow); fl.shadow.camera.near = 0.08; fl.shadow.camera.far = 24; fl.shadow.bias = -0.0025; fl.shadow.normalBias = 0.02; fl.shadow.radius = 2; }
    W.scene.add(fl);
    var cl = this.coalLight = new THREE.PointLight(0xff4410, 0, 0, 2); cl.position.set(0, 0.09, 0); W.scene.add(cl);
    var keep = this.logs; this.logs = [];
    keep.forEach(function (lg) { W.scene.add(lg.mesh); this.logs.push(lg); }, this);
    if (this.people) this.people.setWorld(W);
    if (this.motes) this.transp.remove(this.motes.points);
    this.motes = W.motesKind === 'none' ? { on: false, kind: 'none' } : new CF.Motes(W.motesKind, W.motesKind === 'snow' ? (this.q.name === 'low' ? 500 : 1100) : W.motesKind === 'fireflies' ? 28 : 160, W.motesKind === 'fireflies' ? 26 : 14);
    if (W.motesKind === 'snow') this.motes.on = CF.rng.chance(0.6);
    if (this.motes.on) this.transp.add(this.motes.points);
    this.motesScale = true;
    var sky = W.sky.material.uniforms;
    sky.uAurora.value = place === 'snow' && CF.rng.chance(W.def.aurora || 0) ? CF.rng.range(0.6, 1.2) : 0;
    this.auroraOn = sky.uAurora.value > 0;
    this.shoot = { next: 20 + CF.rng.expo(60), t: -1 };
    this.fire.setSmokeLight(new THREE.Color(0.05, 0.03, 0.02), new THREE.Color().fromArray(W.def.smokeAmb));
    this.audio.setPlace(place);
    if (!first && this.opts.onEvent) this.opts.onEvent('place', place);
  };

  // ---------------------------------------------------------------- logs
  Campfire.prototype.makeLog = function (spName, o) {
    var sp = CF.SPECIES[spName] || CF.SPECIES.pine, R = CF.rng, seed = R.int(1, 99999);
    var kind = spName === 'kindling';
    var len = o.len || (kind ? R.range(0.32, 0.42) : R.range(0.46, 0.62)), rad = o.rad || (kind ? R.range(0.009, 0.016) : R.range(0.045, 0.075));
    var split = !kind && R.chance(0.55);
    var geo = CF.makeLogGeo(len, rad, split, seed), mat = CF.makeLogMat({ bark: sp.bark, wood: sp.wood, birch: sp.birch, wet: o.wet }, seed % 97);
    var mesh = new THREE.Mesh(geo, mat); mesh.castShadow = true; mesh.receiveShadow = true;
    var lg = {
      sp: sp, name: spName, mesh: mesh, mat: mat, len: len, rad: rad, kind: kind, wet: !!o.wet,
      moisture: o.wet ? 1 : R.range(0, 0.12), ign: 0, mass: 1, char: o.char || 0, heat: 0, q: 0, rate: 0,
      pose: { pos: new V(), dir: new V(1, 0, 0), roll: R.range(0, 6.28) }, leaning: !!o.leaning, spots: [], anim: null, born: this.time
    };
    var n = Math.max(2, Math.round(len / (kind ? 0.14 : 0.11)));
    for (var i = 0; i < n; i++) lg.spots.push({ t: R.range(-0.45, 0.45), side: R.range(-1, 1), ou: new CF.OU(1, 0.75, 1.3), r: R.range(0.045, 0.075) * (kind ? 0.6 : 1), k: R.int(0, 5) });
    return lg;
  };
  Campfire.prototype.applyPose = function (lg) {
    var q = new THREE.Quaternion().setFromUnitVectors(X, lg.pose.dir.clone().normalize());
    var roll = new THREE.Quaternion().setFromAxisAngle(X, lg.pose.roll);
    lg.mesh.quaternion.copy(q.multiply(roll));
    var s = 0.4 + 0.6 * Math.sqrt(Math.max(lg.mass, 0));
    lg.mesh.scale.set(1 - (1 - lg.mass) * 0.12, s, s);
    lg.mesh.position.copy(lg.pose.pos);
  };
  // a point on the log in world space (t in -0.5..0.5 along it, up = offset towards the top side)
  Campfire.prototype.logPoint = function (lg, t, side, up, out) {
    var d = lg.pose.dir.clone().normalize(), sideV = new V(-d.z, 0, d.x).normalize();
    var s = 0.4 + 0.6 * Math.sqrt(Math.max(lg.mass, 0));
    return out.copy(lg.pose.pos).addScaledVector(d, t * lg.len).addScaledVector(sideV, side * lg.rad * s * 0.5).add(new V(0, up * lg.rad * s, 0));
  };
  Campfire.prototype.layTeepee = function () {
    var R = CF.rng, n = 9, a0 = R.range(0, 6.28);
    for (var i = 0; i < n; i++) {   // kindling teepee
      var a = a0 + i / n * 6.283 + R.gauss() * 0.1, lg = this.makeLog('kindling', { leaning: true });
      var base = new V(Math.cos(a) * 0.15, 0.03, Math.sin(a) * 0.15), top = new V(Math.cos(a + 2.5) * 0.02, 0.33 + R.range(-0.03, 0.03), Math.sin(a + 2.5) * 0.02);
      lg.pose.dir.copy(top.clone().sub(base)).normalize(); lg.len = Math.min(lg.len, top.distanceTo(base) * 1.1);
      lg.pose.pos.copy(base).addScaledVector(lg.pose.dir, lg.len * 0.5);
      this.addLogMesh(lg);
    }
    var sp = this.world.def.woods, m = R.int(3, 4);
    for (i = 0; i < m; i++) {   // logs leaning around it
      a = a0 + 0.3 + i / m * 6.283 + R.gauss() * 0.15;
      lg = this.makeLog(R.pick(sp), { leaning: true });
      base = new V(Math.cos(a) * 0.27, 0.04, Math.sin(a) * 0.27); top = new V(Math.cos(a + 3) * 0.03, 0.44 + R.range(-0.03, 0.04), Math.sin(a + 3) * 0.03);
      lg.pose.dir.copy(top.clone().sub(base)).normalize();
      lg.pose.pos.copy(base).addScaledVector(lg.pose.dir, lg.len * 0.5 - 0.02);
      this.addLogMesh(lg);
    }
  };
  Campfire.prototype.addLogMesh = function (lg) { this.applyPose(lg); this.world.scene.add(lg.mesh); this.logs.push(lg); };
  // where a new log comes to rest: across the coal bed, on top of what is there
  Campfire.prototype.restPose = function (lg) {
    var R = CF.rng, best = null;
    for (var tries = 0; tries < 14; tries++) {
      var a = R.range(0, 3.1416), off = new V(R.gauss() * 0.13, 0, R.gauss() * 0.13), dir = new V(Math.cos(a), R.range(-0.06, 0.06), Math.sin(a)).normalize();
      var y = this.supportY(lg, off, dir, null);
      var score = y + Math.hypot(off.x, off.z) * 0.25;
      if (!best || score < best.score) best = { score: score, pos: new V(off.x, y, off.z), dir: dir };
    }
    return best;
  };
  Campfire.prototype.supportY = function (lg, c, dir, self) {
    var s = 0.4 + 0.6 * Math.sqrt(Math.max(lg.mass, 0)), y = 0.035 + lg.rad * s;
    this.logs.forEach(function (o) {
      if (o === self || o.leaning || o.anim || o.kind) return;
      if (self && o.pose.pos.y > self.pose.pos.y) return;
      var os = 0.4 + 0.6 * Math.sqrt(Math.max(o.mass, 0));
      if (segDist(c, dir, lg.len, o.pose.pos, o.pose.dir, o.len) < (lg.rad * s + o.rad * os) * 1.05) y = Math.max(y, o.pose.pos.y + o.rad * os * 0.7 + lg.rad * s * 0.8);
    });
    return Math.min(y, 0.035 + lg.rad * s + 0.13);
  };
  function segDist(c1, d1, l1, c2, d2, l2) {   // rough distance between two log axes in the ground plane
    var best = 9;
    for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++) {
      var p = c1.clone().addScaledVector(d1, i / 4 * l1 * 0.9), q = c2.clone().addScaledVector(d2, j / 4 * l2 * 0.9);
      best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
    }
    return best;
  }
  // from: where the throw starts (someone else's hand); without it, from in front of you
  Campfire.prototype.addLog = function (spName, wet, from) {
    if (this.logs.filter(function (l) { return !l.kind; }).length >= 9) return false;
    var name = CF.SPECIES[spName] && spName !== 'kindling' ? spName : CF.rng.pick(this.world.def.woods);
    var lg = this.makeLog(name, { wet: wet }), rest = this.restPose(lg);
    // thrown in along an arc
    var c = this.camera.position, start = from ? new V(from.x, from.y, from.z) : new V(c.x * 0.75, 0.55, c.z * 0.75);
    lg.pose.dir.copy(rest.dir); lg.pose.pos.copy(start);
    lg.anim = { t: 0, dur: 0.85, from: start.clone(), to: rest.pos.clone(), dir: rest.dir.clone(), roll0: lg.pose.roll, roll1: lg.pose.roll + CF.rng.range(-2, 2) };
    this.addLogMesh(lg);
    this.lastLogAt = this.time;
    if (this.opts.onEvent) this.opts.onEvent('log', name);
    return true;
  };
  Campfire.prototype.stir = function () {
    this.stirBoost = Math.min(1.6, this.stirBoost + 1);
    var R = CF.rng;
    this.sparks.emit(R.gauss() * 0.08, 0.1, R.gauss() * 0.08, Math.round(50 + 70 * Math.min(1, this.coal + this.power)), 3.2, 0.5, 1.15);
    this.flares.push({ t: 0, dur: 1.4, k: 1.5 });
    this.logs.forEach(function (lg) { if (!lg.anim && !lg.leaning) { lg.pose.pos.x += R.gauss() * 0.015; lg.pose.pos.z += R.gauss() * 0.015; } });
    this.audio.stir();
    if (this.opts.onEvent) this.opts.onEvent('stir');
  };
  Campfire.prototype.pop = function (log) {
    var p = new V(R0(), 0.2, R0());
    function R0() { return CF.rng.gauss() * 0.08; }
    if (log && log.ref) this.logPoint(log.ref, CF.rng.range(-0.4, 0.4), 0, 1, p);
    this.sparks.emit(p.x, p.y, p.z, CF.rng.int(3, 14), CF.rng.range(2, 4.5), 0.75, 1.1);
  };
  Campfire.prototype.light = function () {
    this.audio.start();
    if (this.lit && this.power < 0.05 && this.coal < 0.08) {   // gone out: a fresh handful of kindling and another match
      var R = CF.rng, a0 = R.range(0, 6.28);
      for (var i = 0; i < 6; i++) {
        var a = a0 + i / 6 * 6.283, lg = this.makeLog('kindling', { leaning: true });
        var base = new V(Math.cos(a) * 0.13, 0.03, Math.sin(a) * 0.13), top = new V(0, 0.28, 0);
        lg.pose.dir.copy(top.clone().sub(base)).normalize(); lg.len = Math.min(lg.len, top.distanceTo(base) * 1.1);
        lg.pose.pos.copy(base).addScaledVector(lg.pose.dir, lg.len * 0.5); this.addLogMesh(lg);
      }
      this.match = 1; var me = this; setTimeout(function () { me.audio.match(); }, 60);
      return;
    }
    if (this.lit) return;
    this.lit = true; this.litAt = Date.now(); this.match = 1;
    var self = this;
    setTimeout(function () { self.audio.match(); }, 60);
    if (this.opts.onEvent) this.opts.onEvent('lit');
  };

  // ---------------------------------------------------------------- simulation of the wood
  Campfire.prototype.updateFire = function (dt) {
    var R = CF.rng, self = this, total = 0, burning = [], heatAll = 0;
    if (this.match > 0) { this.match = Math.max(0, this.match - dt / 9); }
    this.stirBoost *= Math.exp(-dt / 6);
    this.heatSmooth = CF.damp(this.heatSmooth || 0, Math.min(1.6, this.power), 0.4, dt);
    var available = this.heatSmooth * 1.1 + this.coal * (0.55 + 0.6 * this.stirBoost) + (this.match > 0 ? 1.2 : 0);
    for (var i = this.logs.length - 1; i >= 0; i--) {
      var lg = this.logs[i];
      if (lg.anim) {   // flying / falling
        var A = lg.anim; A.t += dt / A.dur; var t = Math.min(1, A.t), e = t * t * (3 - 2 * t);
        lg.pose.pos.lerpVectors(A.from, A.to, e); lg.pose.pos.y += Math.sin(t * Math.PI) * (A.arc === undefined ? 0.35 : A.arc);
        if (A.dir) lg.pose.dir.lerpVectors(A.dir0 || A.dir, A.dir, A.dir0 ? e : 1).normalize();
        lg.pose.roll = A.roll0 + (A.roll1 - A.roll0) * e;
        if (t >= 1) {
          lg.anim = null; lg.leaning = false;
          this.audio.logDrop(this.audio.panFor(Math.atan2(lg.pose.pos.x, lg.pose.pos.z)));
          this.sparks.emit(lg.pose.pos.x, lg.pose.pos.y, lg.pose.pos.z, Math.round(25 + 50 * Math.min(1, this.coal + this.power)), 2.6, 0.7, 1.1);
          this.flares.push({ t: 0, dur: 1.0, k: 0.9 });
        }
        this.applyPose(lg); continue;
      }
      // heat reaching this log
      var d = Math.hypot(lg.pose.pos.x, lg.pose.pos.z), low = lg.pose.pos.y;
      var expo = Math.exp(-d * d / 0.05) * Math.exp(-Math.max(0, low - 0.1) / 0.45);
      var q = available * expo * (lg.kind ? 1.6 : 1);
      if (lg.kind && this.match > 0) q += this.match * 2.2 * Math.exp(-d * d / 0.03);
      lg.q = q;
      if (q > 0.1 && lg.moisture > 0) lg.moisture = Math.max(0, lg.moisture - dt * (q - 0.05) * (lg.wet ? 0.012 : 0.05));
      if (lg.moisture < 0.18 && q > 0.12) lg.ign = Math.min(1, lg.ign + dt * lg.sp.ignite * (q - 0.1) * (lg.kind ? 0.35 : 0.035));
      else if (q < 0.05) lg.ign = Math.max(0, lg.ign - dt * 0.003);
      var on = CF.smooth(0.35, 1, lg.ign);
      lg.rate = on * lg.sp.burn * (0.3 + 0.7 * Math.min(1, q * 1.2)) * (1 - 0.5 * lg.moisture);
      lg.mass -= dt * lg.rate / (lg.sp.life * 60);
      lg.char = Math.min(1, Math.max(lg.char, lg.ign * 0.5 + (1 - lg.mass) * 0.9));
      lg.heat = CF.damp(lg.heat, Math.min(1, on * (0.35 + 0.8 * q)), 1.5, dt);
      var u = lg.mat.userData.u; u.uChar.value = lg.char; u.uHeat.value = lg.heat; u.uWetK.value = Math.min(1, lg.moisture * 1.6);
      var scale = (lg.len / 0.5) * (lg.rad / 0.06);
      if (lg.kind) scale = 0.12;
      total += lg.rate * scale;
      heatAll += lg.heat;
      if (lg.rate > 0.02) burning.push({ az: Math.atan2(lg.pose.pos.x, lg.pose.pos.z), rate: lg.rate * lg.sp.crackle * Math.min(1.4, scale + 0.3), pop: lg.sp.pop, sap: lg.sp.sap * on * (lg.wet ? 2 : 1), pitch: lg.sp.pitch, ref: lg });
      // a teepee falls in when its logs burn through
      if (lg.leaning && !lg.kind && (lg.mass < 0.6 || (lg.ign > 0.8 && this.logs.filter(function (k) { return k.kind; }).length === 0 && R.next() < dt * 0.02))) {
        var rest = this.restPose(lg), dir0 = lg.pose.dir.clone();
        lg.anim = { t: 0, dur: 0.55, from: lg.pose.pos.clone(), to: rest.pos, dir0: dir0, dir: rest.dir, roll0: lg.pose.roll, roll1: lg.pose.roll + R.range(-0.6, 0.6), arc: 0.02 };
        this.audio.collapse(this.audio.panFor(Math.atan2(lg.pose.pos.x, lg.pose.pos.z)));
      }
      if (lg.mass < (lg.kind ? 0.05 : 0.1)) {   // collapses into coals
        this.coal = Math.min(1.6, this.coal + scale * 0.12 * (lg.kind ? 0.15 : 1));
        if (!lg.kind) {
          this.sparks.emit(lg.pose.pos.x, lg.pose.pos.y, lg.pose.pos.z, 40, 2.4, 0.8, 1.1);
          this.audio.collapse(this.audio.panFor(Math.atan2(lg.pose.pos.x, lg.pose.pos.z)));
          if (this.opts.onEvent) this.opts.onEvent('collapse');
        }
        this.world.scene.remove(lg.mesh); lg.mesh.geometry.dispose(); lg.mat.dispose();
        this.logs.splice(i, 1);
        continue;
      }
      if (!lg.leaning && (this.frame + i) % 20 === 0) lg.restY = this.supportY(lg, lg.pose.pos, lg.pose.dir, lg);
      if (!lg.leaning && lg.restY !== undefined && lg.pose.pos.y > lg.restY) lg.pose.pos.y = Math.max(lg.restY, lg.pose.pos.y - dt * 0.05);
      this.applyPose(lg);
    }
    // coals: grow from burning wood, cool slowly
    total /= 3;   // a good fire of three or four logs = about 1
    this.coal += dt * total * 0.0012;
    this.coal *= Math.exp(-dt / (this.power > 0.15 ? 2600 : 1500));
    this.coal = Math.min(this.coal, 1.6);
    this.coalHeat = CF.damp(this.coalHeat, Math.min(1.4, this.coal * (0.75 + 0.5 * this.stirBoost)), 0.5, dt);
    this.power = total;
    this.burning = burning;
    // auto-tend: a log when it gets low
    if (this.autoTend && this.lit && this.time - this.lastLogAt > 70 && total < 0.9 && !(this.sleepAt && Date.now() > this.sleepAt - 15 * 60000)) this.addLog();
  };

  // flame sources for the GPU simulation
  Campfire.prototype.spots = function (dt) {
    var out = [], R = CF.rng, p = new V(), self = this;
    for (var f = this.flares.length - 1; f >= 0; f--) { this.flares[f].t += dt; if (this.flares[f].t > this.flares[f].dur) this.flares.splice(f, 1); }
    var flare = 1; this.flares.forEach(function (fl) { flare += fl.k * Math.sin(Math.PI * fl.t / fl.dur); });
    this.nextFlare -= dt;
    if (this.nextFlare < 0) { this.flares.push({ t: 0, dur: R.range(0.4, 1.4), k: R.range(0.2, 0.7) }); this.nextFlare = R.expo(7); }
    var soot = 0, sw = 0;
    this.logs.forEach(function (lg) {
      if (lg.anim && lg.ign < 0.3) return;
      var on = CF.smooth(0.3, 1, lg.ign);
      if (on <= 0.01) return;
      lg.spots.forEach(function (s) {
        s.t += R.gauss() * dt * 0.03; s.side += R.gauss() * dt * 0.2;
        if (s.t < -0.47 || s.t > 0.47 || R.next() < dt * 0.04) { s.t = R.range(-0.45, 0.45); s.side = R.range(-1, 1); }
        s.side = CF.clamp(s.side, -1, 1);
        var k = Math.max(0, s.ou.step(dt));
        self.logPoint(lg, s.t, s.side, 0.75, p);
        var d2 = p.x * p.x + p.z * p.z, ex = Math.exp(-d2 / 0.4) * Math.exp(-Math.max(0, p.y - 0.18) / 0.6);
        var str = on * k * (0.25 + 0.9 * Math.min(1.3, lg.q)) * ex * (lg.kind ? 0.8 : 1) * (1 - 0.6 * lg.moisture) * flare * lg.sp.burn;
        if (str > 0.02) out.push({ x: p.x, y: p.y, z: p.z, r: s.r, s: Math.min(str, 2.4), k: s.k });
      });
      soot += lg.sp.soot * lg.rate; sw += lg.rate;
    });
    // small flames walking over the coals
    if (this.coalSpots.length < 9) this.coalSpots.push({ x: R.gauss() * 0.17, z: R.gauss() * 0.17, ou: new CF.OU(0.6, 0.6, 1.5) });
    this.coalSpots.forEach(function (c) {
      c.x += R.gauss() * dt * 0.05; c.z += R.gauss() * dt * 0.05;
      if (Math.hypot(c.x, c.z) > 0.25 || R.next() < dt * 0.1) { c.x = R.gauss() * 0.12; c.z = R.gauss() * 0.12; }
      var s = Math.max(0, c.ou.step(dt)) * (self.coalHeat * 0.4 + Math.min(1.2, self.power) * 0.35) * flare;
      if (s > 0.02) out.push({ x: c.x, y: 0.06, z: c.z, r: 0.045, s: s });
    });
    if (this.match > 0) {   // the match itself
      var m = Math.min(1, (1 - this.match) * 12) * this.match;
      out.push({ x: 0.02, y: 0.06, z: 0.06, r: 0.012, s: 1.4 * m });
    }
    this.sootMix = sw > 0 ? soot / sw : 1;
    return out;
  };

  // ---------------------------------------------------------------- the frame
  Campfire.prototype.tick = function () {
    var now = performance.now(), dt = Math.min(0.1, (now - this.clockLast) / 1000);
    this.clockLast = now;
    if (dt <= 0) return;
    if (this.paused) { this.time += dt; CF.U.uTime.value = this.time; this.updateFire(dt); this.audioUpdate(dt); return; }
    this.step(dt, !this.test.norender);
  };
  Campfire.prototype.attach = function (el) {
    if (el === this.el) return;
    if (this.ro) this.ro.disconnect();
    this.unbind(); this.el = el; el.appendChild(this.canvas); this.bindInput();
    if (this.people) this.people.attach(el);
    var self = this; this.ro = new ResizeObserver(function () { self.resize(); }); this.ro.observe(el); this.resize();
  };
  Campfire.prototype.pause = function (on) { this.paused = !!on; this.clockLast = performance.now(); };
  Campfire.prototype.setHandlers = function (onState, onEvent) { this.opts.onState = onState; this.opts.onEvent = onEvent; };
  Campfire.prototype.audioUpdate = function (dt) {
    this.audio.update({ power: this.power * 0.7 + (this.lightPower || 0), flicker: this.flicker, hissMod: CF.clamp(this.hiss.step(dt), 0, 1.5), wet: this.wetSmoke(),
                        gust: this.wind.strength || 0, burning: this.burning || [], yaw: this.cam.yaw, dist: this.cam.dist });
  };
  Campfire.prototype.step = function (dt, draw) {
    var self = this, R = CF.rng;
    this.time += dt; this.frame++;
    CF.U.uTime.value = this.time;
    // fps watch (auto quality steps down once if the device struggles)
    this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
    if (draw && this.autoQ && this.time > 4) {
      this.slowFor = this.fps < 28 ? this.slowFor + dt : 0;
      if (this.slowFor > 3 && this.qName !== 'low') { this.setQuality(this.qName === 'high' ? 'medium' : 'low', true); this.slowFor = -6; }
    }
    // wind
    var w = this.wind, calm = this.place === 'desert' ? 0.45 : 1; w.g.mean = [0.06, 0.35, 0.7][w.level] * calm; w.g.sigma = [0.06, 0.22, 0.38][w.level] * calm;
    var gg = Math.max(0, w.g.step(dt)); w.gustT -= dt;
    if (w.gustT < 0 && w.level > 0) { w.gust = R.range(0.3, 1) * w.level; w.gustT = R.expo(30 / w.level); }
    w.gust *= Math.exp(-dt / 2.5);
    var gust = Math.min(1.5, gg + w.gust), az = w.az.step(dt);
    w.x = Math.cos(az) * gust; w.z = Math.sin(az) * gust; w.strength = gust;
    this.updateFire(dt);
    // flames
    var cam = this.camera;
    this.updateCamera(dt);
    if (this.people) this.people.update(dt, this.time, cam, draw);
    this.fire.orient(cam);
    this.fire.setSources(this.spots(dt));
    var soot = this.sootMix || 1, along = this.fire.windAlong(w.x, w.z), q = this.q;
    this.fire.setParams(function (p) {
      p.wind = along * 1.1; p.sootY = 1.15 * soot; p.coal.set(0, 0.24, self.coalHeat * 2.2, 0.035);
    });
    this.simAcc = (this.simAcc || 0) + dt;
    var simDt = 1 / 60, steps = 0;
    while (this.simAcc >= simDt && steps < (draw ? 2 : 1)) { this.fire.step(simDt); this.simAcc -= simDt; steps++; }
    if (this.simAcc > simDt * 3) this.simAcc = 0;
    if (steps && (this.frame % 2 === 0 || !draw)) {
      var li = this.fire.readback(1);
      var pw = li.power * q.slices;
      this.flicker = CF.clamp(Math.abs(pw - this.lastPower) * 6, 0, 1) * 0.5 + this.flicker * 0.5; this.lastPower = pw;
      this.lightPower = this.lightPower === undefined ? pw : CF.damp(this.lightPower, pw, 18, dt * 2);
      this.lightY = li.y; this.lightX = li.x; this.lightTheta = li.theta;
    }
    var lp = this.lightPower || 0;
    this.pSmooth = CF.damp(this.pSmooth, Math.min(2, lp * 2.2), 1.2, dt);
    // light from the flames and the coals
    var fl = this.fireLight, th = this.lightTheta || 0.8;
    var col = CF.blackbodyRGB(CF.KELVIN(CF.clamp(th, 0.55, 1.05)) + 120), mx = Math.max(col[0], col[1], col[2]);
    fl.color.setRGB(col[0] / mx, col[1] / mx, col[2] / mx);
    var right = this.fire.right;
    fl.position.set(right.x * (this.lightX || 0) * 0.6, Math.max(0.18, (this.lightY || 0.35) * 0.8), right.z * (this.lightX || 0) * 0.6);
    fl.intensity = 19 * lp + (this.match > 0 ? 0.6 * this.match : 0);
    var coalCol = CF.blackbodyRGB(1050 + 120 * this.coalHeat), cm = Math.max(coalCol[0], coalCol[1], coalCol[2]);
    this.coalLight.color.setRGB(coalCol[0] / cm, coalCol[1] / cm, coalCol[2] / cm);
    this.coalLight.intensity = 1.6 * this.coalHeat * this.coalHeat;
    this.world.coalU.uCoalHeat.value = this.coalHeat;
    this.world.coalU.uCoalCol.value.setRGB(coalCol[0] / cm * 1.6, coalCol[1] / cm * 1.6, coalCol[2] / cm * 1.6);
    CF.U.uEmber.value.setRGB(0.5 * this.coalHeat, 0.09 * this.coalHeat, 0.01 * this.coalHeat);
    this.fire.setSmokeLight(new THREE.Color(col[0] / mx * 0.03 * lp, col[1] / mx * 0.03 * lp, col[2] / mx * 0.03 * lp), new THREE.Color().fromArray(this.world.def.smokeAmb));
    // sparks: a steady trickle + pops
    var trickle = 0; this.logs.forEach(function (lg) { trickle += lg.rate * lg.sp.sparks; });
    this.sparkAcc = (this.sparkAcc || 0) + dt * trickle * 0.45;
    while (this.sparkAcc > 1) { this.sparkAcc -= 1; this.sparks.emit(R.gauss() * 0.12, R.range(0.15, 0.55), R.gauss() * 0.12, 1, R.range(0.6, 1.6), 0.5, R.range(0.95, 1.1)); }
    var plume = function (x, y, z) { var r2 = x * x + z * z; return (0.8 + 3.2 * Math.min(1.4, lp * 2)) * Math.exp(-r2 / (0.06 + y * 0.1)) * Math.exp(-y / 4) + 0.35; };
    this.sparks.update(dt, this.time, plume, { x: w.x * 1.2, z: w.z * 1.2 });
    this.smoke.update(dt, this.time, 1.2 + 4 * Math.min(1, this.power) + (this.logs.some(function (l) { return l.moisture > 0.3 && l.q > 0.1; }) ? 4 : 0), 0.06 + 0.12 * this.wetSmoke(), { x: w.x * 0.8, z: w.z * 0.8 }, 0.9 + 0.5 * Math.min(1, lp * 2));
    if (this.motes.on) { this.motes.update(dt, this.time, { x: w.x, z: w.z }, lp * 2 + this.coalHeat * 0.3); this.motes.mat.uniforms.uScale.value = (this.post.h || 800) / (2 * Math.tan(this.camera.fov * Math.PI / 360)); }
    this.updateSky(dt);
    // the eye adapts: a big fire makes the night darker around it
    var target = this.world.def.exposure * 1.25 / (0.25 + 0.9 * Math.min(1.6, this.pSmooth + this.coalHeat * 0.25));
    this.exposure = CF.damp(this.exposure, CF.clamp(target, 0.6, 3.2), 0.4, dt);
    this.sleepTick();
    // sound follows the fire
    var hm = this.hiss.step(dt);
    this.audio.update({ power: this.power * 0.7 + lp, flicker: this.flicker, hissMod: CF.clamp(hm, 0, 1.5), wet: this.wetSmoke(), gust: gust,
                        burning: this.burning || [], yaw: this.cam.yaw, dist: this.cam.dist });
    if (!draw) return;
    // draw
    var post = this.post, W = this.world, fu = post.mFinal.uniforms;
    W.sky.position.copy(cam.position);
    this.sparks.mat.uniforms.uRes.value.set(post.w, post.h);
    this.sparks.mat.uniforms.uFocal.value = post.h / (2 * Math.tan(cam.fov * Math.PI / 360));
    this.sparks.mat.uniforms.uGain.value = 4.5;
    this.sparks.upload(1 / 50, this.time);
    this.smoke.upload(0.9 + lp);
    fu.uExposure.value = this.exposure * this.sleepFade; fu.uTime.value = this.time;
    var lum = 0.2126 * fl.color.r + 0.7152 * fl.color.g + 0.0722 * fl.color.b, ad = 0.3 * CF.clamp(lp * 3 + this.coalHeat * 0.4, 0, 1);
    fu.uWB.value.set(CF.lerp(1, fl.color.r / lum, ad), CF.lerp(1, fl.color.g / lum, ad), CF.lerp(1, fl.color.b / lum, ad));
    var top = new V(0, 0.75 + 0.4 * Math.min(1.5, lp * 2), 0).project(cam);
    var hazeH = new V(0, 1.6, 0).project(cam);
    fu.uHaze.value.set(top.x * 0.5 + 0.5, (top.y + hazeH.y) * 0.25 + 0.5, 0.18 * 3.2 / this.cam.dist, Math.abs(hazeH.y - top.y) * 0.6 + 0.05);
    fu.uHazeK.value = Math.min(1, lp * 2 + this.coalHeat * 0.3);
    var self2 = this;
    post.render(W.scene, this.transp, cam, function (depthTex) { self2.fire.prepareDraw(cam, depthTex, post.w, post.h, self2.time, 1.0); });
  };
  // sleep timer: fade the world out over the last five minutes
  Campfire.prototype.sleepTick = function () {
    if (!this.sleepAt) return;
    var left = (this.sleepAt - Date.now()) / 1000;
    this.sleepFade = CF.clamp(left / 300, 0, 1);
    this.audio.setVolume('master', (this.audio.vol.masterUser !== undefined ? this.audio.vol.masterUser : 0.9) * this.sleepFade);
    if (left <= 0) { this.sleepAt = 0; this.autoTend = false; this.audio.suspend(true); if (this.opts.onEvent) this.opts.onEvent('slept'); }
  };
  Campfire.prototype.background = function () {
    var now = performance.now(), dt = Math.min(5, (now - this.clockLast) / 1000);
    this.clockLast = now;
    for (var t = 0; t < dt; t += 0.25) { this.time += 0.25; this.updateFire(0.25); }
    this.pSmooth = CF.damp(this.pSmooth, Math.min(2, this.power * 0.6), 1.2, dt);
    this.lightPower = CF.damp(this.lightPower || 0, this.power * 0.25, 1, dt);
    this.audioUpdate(dt); this.sleepTick();
  };
  Campfire.prototype.wetSmoke = function () {
    var w = 0; this.logs.forEach(function (l) { if (l.q > 0.1) w = Math.max(w, l.moisture); }); return w;
  };
  Campfire.prototype.updateSky = function (dt) {
    var u = this.world.sky.material.uniforms, s = this.shoot, R = CF.rng;
    s.next -= dt;
    if (s.next < 0 && s.t < 0) {
      var a = new V(R.gauss(), R.range(0.4, 1.2), R.gauss()).normalize(), b = a.clone().add(new V(R.gauss() * 0.25, -R.range(0.05, 0.2), R.gauss() * 0.25)).normalize();
      u.uShootA.value.set(a.x, a.y, a.z, 0); u.uShootB.value.set(b.x, b.y, b.z, 1); s.t = 0; s.dur = R.range(0.4, 1.0);
    }
    if (s.t >= 0) {
      s.t += dt / s.dur; u.uShootA.value.w = s.t * 1.3; u.uShootB.value.w = Math.sin(Math.min(1, s.t) * Math.PI);
      if (s.t > 1.1) { s.t = -1; u.uShootB.value.w = 0; s.next = R.expo(90) + 15; }
    }
    if (this.auroraOn) u.uAurora.value = CF.clamp(u.uAurora.value + R.gauss() * dt * 0.05, 0.3, 1.3);
  };

  // ---------------------------------------------------------------- camera + input
  Campfire.prototype.updateCamera = function (dt) {
    var c = this.cam, cam = this.camera;
    c.yaw += c.vyaw * dt; c.pitch += c.vpitch * dt;
    c.vyaw *= Math.exp(-dt * 4); c.vpitch *= Math.exp(-dt * 4);
    c.pitch = CF.clamp(c.pitch, 0.03, 0.6);
    c.dist = CF.damp(c.dist, c.tdist, 4, dt);
    var bob = Math.sin(this.time * 0.9) * 0.004 + Math.sin(this.time * 0.37) * 0.006;
    var tgt = c.target, cp = Math.cos(c.pitch);
    cam.position.set(tgt.x + Math.sin(c.yaw) * cp * c.dist, tgt.y + Math.sin(c.pitch) * c.dist + 0.12 + bob, tgt.z + Math.cos(c.yaw) * cp * c.dist);
    var gy = this.world.height(cam.position.x, cam.position.z);
    if (cam.position.y < gy + 0.35) cam.position.y = gy + 0.35;
    cam.lookAt(tgt.x, tgt.y + 0.08, tgt.z);
  };
  Campfire.prototype.bindInput = function () {
    var self = this, el = this.el, pts = new Map(), moved = 0, lastPinch = 0, downAt = 0;
    function onDown(e) {
      if (e.target !== self.canvas) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; downAt = performance.now();
      try { self.canvas.setPointerCapture(e.pointerId); } catch (er) {}
    }
    function onMove(e) {
      var p = pts.get(e.pointerId); if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (pts.size === 2) {
        var arr = Array.from(pts.values()), d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
        if (lastPinch) self.zoom(lastPinch / d); lastPinch = d; return;
      }
      var k = 3.2 / Math.max(300, el.clientWidth);
      self.cam.yaw -= dx * k * 1.2; self.cam.pitch += dy * k * 0.8;
      self.cam.vyaw = -dx * k * 30; self.cam.vpitch = 0;
    }
    function onUp(e) {
      var wasTap = pts.has(e.pointerId) && moved < 8 && performance.now() - downAt < 400 && pts.size === 1;
      pts.delete(e.pointerId); if (pts.size < 2) lastPinch = 0;
      if (wasTap && self.lit && self.people) {   // a tap on someone waves to them
        var who = self.people.hit(e.clientX, e.clientY);
        if (who >= 0) { if (self.opts.onEvent) self.opts.onEvent('wave_to', who); return; }
      }
      if (wasTap && self.lit) {   // a tap on the flames stirs the fire
        var rect = self.canvas.getBoundingClientRect(), x = (e.clientX - rect.left) / rect.width * 2 - 1, y = -((e.clientY - rect.top) / rect.height * 2 - 1);
        var c = new V(0, 0.35, 0).project(self.camera);
        if (Math.abs(x - c.x) < 0.22 && Math.abs(y - c.y) < 0.35) self.stir();
      }
    }
    function onWheel(e) { e.preventDefault(); self.zoom(Math.exp(e.deltaY * 0.001)); }
    this.canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp); window.addEventListener('pointercancel', onUp);
    this.canvas.addEventListener('wheel', onWheel, { passive: false });
    this.canvas.style.touchAction = 'none';
    this.unbind = function () {
      self.canvas.removeEventListener('pointerdown', onDown); window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); self.canvas.removeEventListener('wheel', onWheel);
    };
  };
  Campfire.prototype.zoom = function (f) { this.cam.tdist = CF.clamp(this.cam.tdist * f, 1.5, 6.5); };
  Campfire.prototype.look = function (dyaw) { this.cam.vyaw += dyaw; };
  Campfire.prototype.resize = function () {
    var w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight), pr = Math.min(window.devicePixelRatio || 1, this.q.pr);
    this.renderer.setPixelRatio(1); this.renderer.setSize(Math.round(w * pr), Math.round(h * pr), false);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    var aspect = w / h; this.camera.aspect = aspect;
    var hfov = 62 * Math.PI / 180, vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect) * 180 / Math.PI;
    var portrait = aspect < 0.8;
    this.camera.fov = CF.clamp(vfov, 40, portrait ? 64 : 78);
    if (portrait && !this.portrait) { this.cam.tdist = 3.0; this.cam.target.y = 0.68; }
    if (!portrait && this.portrait) { this.cam.tdist = 3.4; this.cam.target.y = 0.55; }
    this.portrait = portrait;
    this.camera.updateProjectionMatrix();
    this.post.setSize(Math.round(w * pr), Math.round(h * pr));
  };

  // ---------------------------------------------------------------- the API
  Campfire.prototype.setQuality = function (name, auto) {
    if (this.test.quality) return;
    if (!auto) this.autoQ = name === 'auto';
    if (name === 'auto') name = this.qName;
    if (name === this.qName && this.fire) return;
    this.qName = name; this.q = qualityTier(name);
    this.renderer.shadowMap.enabled = this.q.shadow > 0;
    this.buildFire();
    var keepLogs = this.logs; this.logs = [];
    keepLogs.forEach(function (l) { this.world.scene.remove(l.mesh); }, this);
    this.logs = keepLogs; this.setPlace(this.place, true);
    this.resize();
    if (this.opts.onEvent) this.opts.onEvent('quality', name);
  };
  // the circle: who sits around this fire (JSON {seat, people: [{seat, name, look}]}, or '' for nobody) and what they do
  Campfire.prototype.setCircle = function (json) {
    if (!this.people) return 0;
    var c = json ? JSON.parse(json) : null;
    this.people.set(c ? c.seat : this.people.me, c ? c.people : []);
    return this.people.count();
  };
  Campfire.prototype.circleAct = function (seat, kind, to, wood, wet) {
    return this.people ? this.people.act(seat | 0, String(kind), to === null || to === undefined ? -1 : to | 0, wood || null, !!wet) : false;
  };
  Campfire.prototype.setWind = function (level) { this.wind.level = CF.clamp(level | 0, 0, 2); };
  Campfire.prototype.setVolume = function (which, v) { if (which === 'master') this.audio.vol.masterUser = v; this.audio.setVolume(which, v); };
  Campfire.prototype.setAutoTend = function (on) { this.autoTend = !!on; };
  Campfire.prototype.setSleep = function (minutes) { this.sleepAt = minutes > 0 ? Date.now() + minutes * 60000 : 0; this.sleepFade = 1; if (!minutes) this.audio.setVolume('master', this.audio.vol.masterUser !== undefined ? this.audio.vol.masterUser : 0.9); };
  Campfire.prototype.sound = function (on) { if (on) this.audio.start(); this.audio.suspend(!on); this.muted = !on; };
  Campfire.prototype.state = function () {
    var logs = this.logs.filter(function (l) { return !l.kind; });
    return {
      ok: this.ok, lit: this.lit, place: this.place, placeName: (CF.PLACES[this.place] || {}).name, quality: this.qName,
      power: Math.round(this.power * 100) / 100, light: Math.round((this.lightPower || 0) * 1000) / 1000, coals: Math.round(this.coal * 100) / 100,
      logs: logs.length, burning: (this.burning || []).length, kindling: this.logs.length - logs.length,
      sparks: this.sparks ? this.sparks.n : 0, fps: Math.round(this.fps), minutes: this.litAt ? Math.floor((Date.now() - this.litAt) / 60000) : 0,
      woods: this.world.def.woods.map(function (k) { return { key: k, label: CF.SPECIES[k].label, note: CF.SPECIES[k].note }; }),
      sleepLeft: this.sleepAt ? Math.max(0, Math.round((this.sleepAt - Date.now()) / 60000)) : 0, autoTend: this.autoTend,
      aurora: !!this.auroraOn, snowing: !!(this.motes && this.motes.on && this.motes.kind === 'snow'), sound: !!(this.audio.ctx && !this.muted),
      exposure: Math.round(this.exposure * 100) / 100, simTime: Math.round(this.time), people: this.people ? this.people.count() : 0
    };
  };
  // tests and screenshots: run the fire for `sec` seconds of its life without drawing
  Campfire.prototype.warp = function (sec, simEvery) {
    var n = Math.round(sec / 0.05), every = simEvery || 1;
    this.updateCamera(0.016);
    for (var i = 0; i < n; i++) {
      var draw = false;
      this.time += 0.05; CF.U.uTime.value = this.time;
      this.updateFire(0.05);
      if (i % every === 0 && n - i < 240) {   // only the last stretch needs the fluid
        this.fire.orient(this.camera); this.fire.setSources(this.spots(0.05));
        this.fire.step(1 / 60); this.fire.step(1 / 60); this.fire.step(1 / 60);
        var li = this.fire.readback(1); this.lightPower = li.power * this.q.slices; this.lightY = li.y; this.lightTheta = li.theta;
        this.pSmooth = CF.damp(this.pSmooth, Math.min(2, this.lightPower * 2.2), 1.2, 0.05);
      } else {
        this.pSmooth = CF.damp(this.pSmooth, Math.min(2, this.power * 0.6), 1.2, 0.05);
      }
    }
    return this.state();
  };
  Campfire.prototype.destroy = function () {
    cancelAnimationFrame(this.raf); clearInterval(this.stateTimer);
    document.removeEventListener('visibilitychange', this.vis);
    if (this.ro) this.ro.disconnect();
    if (this.unbind) this.unbind();
    this.audio.stop();
    if (this.fire) this.fire.dispose();
    if (this.world) this.world.dispose();
    this.renderer.dispose();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };
})();
