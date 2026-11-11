/* Campfire engine, part 6: the fire's life and the API the app uses.
   The fire is a small model of real wood burning: each log has a species, moisture, ignition progress, mass
   and char. Heat from the flames and the coal bed reaches each log according to where it lies; wet wood must
   dry first (steam hiss), then catches, burns at its species' pace, chars, shrinks and finally collapses into
   the coal bed. A teepee falls in when its logs burn through. Untended, the fire dies down over half an hour
   to glowing coals. Burning logs feed fuel spots to the GPU flame simulation (cf-fire.js), the flames' own
   brightness is read back to light the scene, and the same numbers drive the sound (cf-audio.js).

   Around the fire, the night goes on by itself: wind gusts bend flames, trees and smoke alike; cloud drifts
   over and the stars turn (CF.Sky); mist creeps between the spruces and over the lake ice; snow starts and
   stops; moths find the light; far lightning blinks beyond the canyon rim; your breath shows in the cold.

   It runs on whatever it is given. Four picture tiers (high, medium, low, lite), picked from what the device
   says about itself and remembered for next time; on "auto" a governor watches the frame time and gives up
   render resolution first, then edge smoothing, then simulation rate, then a tier, and takes resolution back
   when there is room. Frames are capped near 60 a second (30 when a phone sits idle, or you are falling
   asleep), and when the sleep timer ends drawing stops altogether until you touch something.

   var fire = CF.create(element, {place: 'forest', quality: 'auto', onState: fn(state), onEvent: fn(name, data)})
   fire.light()  fire.addLog(species, wet)  fire.stir()  fire.setPlace(p)  fire.setWind(0..2)  fire.setVolume(which, v)
   fire.setAutoTend(bool)  fire.setSleep(minutes)  fire.state()  fire.warp(seconds)  fire.destroy()
   fire.attach(element)  fire.pause(bool)  fire.setHandlers(onState, onEvent)  fire.setQuality(name)
   fire.setCircle(json)  fire.circleAct(seat, kind, toSeat, wood, wet): the people around the fire (cf-people.js);
   onEvent('wave_to', seat) when you tap someone or their name tag.
   CF.shared(element, opts): one fire per page load (it keeps burning, and crackling, while another page is open).
   window.CF_TEST: {norender: bool, quality: name, uncap: bool (no frame cap: benchmarks)} for tests. */
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
  var V = THREE.Vector3, X = new V(1, 0, 0);
  // scratch objects: nothing is allocated while the fire burns (a phone's garbage collector is a hitch you can see)
  var _a = new V(), _b = new V(), _c = new V(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

  // ---------------------------------------------------------------- picture tiers
  // nx, ny: the flame simulation's grid (per slice); mg: the pressure solver's multigrid cycle; simHz: its tick;
  // pr / prMin: device pixels per CSS pixel, at most / at least (the governor moves between them); msaa: samples;
  // shadow: the fire's shadow map (0 = none), redrawn every shadowEvery frames; mist: share of the mist sheets.
  var ORDER = ['lite', 'low', 'medium', 'high'];
  var TIERS = {
    high:   { nx: 160, ny: 288, slices: 3, mg: { levels: 6, pre: 2, post: 2, coarse: 8 }, cubic: true, simHz: 60, pr: 1.75, prMin: 1, msaa: 4, shadow: 512, shadowEvery: 1, sparks: 1400, smoke: 44, mist: 1, moths: 5, dust: 160, snow: 1100 },
    medium: { nx: 96, ny: 160, slices: 3, mg: { levels: 6, pre: 2, post: 1, coarse: 8 }, cubic: true, simHz: 60, pr: 1.25, prMin: 0.8, msaa: 2, shadow: 256, shadowEvery: 2, sparks: 900, smoke: 30, mist: 0.8, moths: 4, dust: 120, snow: 900 },
    low:    { nx: 64, ny: 112, slices: 2, mg: { levels: 5, pre: 1, post: 1, coarse: 8 }, cubic: true, simHz: 30, pr: 1, prMin: 0.6, msaa: 0, shadow: 0, shadowEvery: 1, sparks: 500, smoke: 20, mist: 0.5, moths: 3, dust: 70, snow: 500, rest: true },
    lite:   { nx: 48, ny: 80, slices: 1, mg: { levels: 5, pre: 1, post: 1, coarse: 6 }, cubic: true, simHz: 30, pr: 0.8, prMin: 0.5, msaa: 0, shadow: 0, shadowEvery: 1, sparks: 260, smoke: 12, mist: 0, moths: 2, dust: 40, snow: 260, rest: true }
  };
  function qualityTier(q) { var t = TIERS[q] || TIERS.medium, o = { name: TIERS[q] ? q : 'medium' }; for (var k in t) o[k] = t[k]; return o; }
  CF.TIERS = TIERS;

  // A first guess from what the graphics chip and the device say about themselves. The governor corrects it.
  CF.guessTier = function (renderer, coarse, memory, cores, width) {
    var r = String(renderer || '').toLowerCase(), m;
    if (/swiftshader|llvmpipe|software|basic render|softpipe/.test(r)) return 'lite';
    var cap = memory && memory <= 2 ? 'lite' : memory && memory <= 4 ? 'low' : 'high';
    function atMost(t) { return ORDER.indexOf(t) < ORDER.indexOf(cap) ? t : cap; }
    if ((m = /adreno[^0-9]*(\d{3})/.exec(r))) { var a = +m[1]; return atMost(a >= 640 ? 'medium' : a >= 610 ? 'low' : a >= 530 && a < 600 ? 'low' : 'lite'); }
    if ((m = /mali-g(\d+)/.exec(r))) { var g = +m[1]; return atMost(g >= 610 || (g >= 76 && g < 100) ? 'medium' : g >= 52 && g < 100 ? 'low' : g >= 310 ? 'low' : 'lite'); }
    if (/immortalis|xclipse/.test(r)) return atMost('medium');
    if (/mali-t|mali-4|powervr|videocore|vivante|adreno/.test(r)) return atMost('lite');
    if (/apple/.test(r)) return atMost(coarse ? 'medium' : 'high');
    if (/intel/.test(r)) return atMost(/arc|iris/.test(r) ? 'medium' : /hd graphics (2|3|4)\d{3}|gma|g4[15]|q4[35]/.test(r) ? 'low' : 'medium');
    if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|radeon\(tm\) rx/.test(r)) return atMost(coarse ? 'medium' : 'high');
    if (/radeon|amd/.test(r)) return atMost('medium');
    // nothing recognisable (many browsers hide it): go by the kind of device
    if (coarse || (width && width < 700)) return atMost(cores && cores <= 4 ? 'low' : 'medium');
    return atMost(cores && cores < 6 ? 'medium' : 'high');
  };

  function loadPerf() {
    try { var p = JSON.parse(localStorage.getItem('campfire.perf') || 'null'); if (p && TIERS[p.tier] && Date.now() - p.at < 14 * 86400000) return p; } catch (e) {}
    return null;
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
    var r = this.renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, antialias: false, alpha: false });
    r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping;
    r.setClearColor(0x000000, 1);
    if (!CF.gpu(r).ok) { this.ok = false; this.reason = 'float-targets'; return; }   // no half-float render targets: nothing here can run
    this.ok = true;
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    this.coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    // quality: what was asked for, else what this device settled on last time, else a guess
    var asked = this.opts.quality && this.opts.quality !== 'auto' ? this.opts.quality : null, saved = loadPerf();
    this.autoQ = !asked;
    this.gov = { scale: 1, ceil: 1, ceilUntil: 0, slow: 0, good: 0, at: 0, upAt: -1e9, rest: false, simHz: 0, msaaOff: false, ft: 0, before: 0, fruitless: 0, triedTier: false, first: null, capMs: 0 };
    this.qName = asked || (saved && saved.tier) || CF.guessTier(this.gpuName, this.coarse, navigator.deviceMemory, navigator.hardwareConcurrency, window.innerWidth);
    if (!asked && saved) { this.gov.scale = CF.clamp((saved.scale || 1) + 0.1, 0.3, 1); this.gov.simHz = saved.simHz || 0; this.gov.msaaOff = !!saved.msaaOff; this.gov.rest = !!saved.rest; this.gov.capMs = saved.cap || 0; }
    if (this.test.quality) { this.qName = this.test.quality; this.autoQ = false; }
    this.q = qualityTier(this.qName); this.qName = this.q.name;
    r.shadowMap.enabled = this.q.shadow > 0; r.shadowMap.type = THREE.PCFShadowMap;
    this.bb = CF.blackbodyTexture();
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 900);
    this.cam = { yaw: CF.rng.range(-0.25, 0.25), pitch: 0.1, dist: 3.4, vyaw: 0, vpitch: 0, tdist: 3.4, target: new V(0, 0.55, 0) };
    this.time = 0; this.clockLast = performance.now(); this.frame = 0;
    this.post = new CF.Post(r, this.msaa());
    this.transp = new THREE.Scene();
    this.wind = { level: 1, g: new CF.OU(0.35, 0.22, 0.35), az: new CF.OU(CF.rng.range(0, 6.28), 0.25, 0.02), gustT: 0, gust: 0, x: 0, z: 0, sx: 0, sz: 0 };
    this.lit = false; this.logs = []; this.coal = 0; this.coalHeat = 0; this.stirBoost = 0; this.power = 0; this.pSmooth = 0;
    this.flickSmooth = 0; this.lastPower = 0; this.flicker = 0; this.exposure = 1.2; this.match = 0;
    this.hiss = new CF.OU(0.5, 0.35, 0.4); this.autoTend = false; this.sleepAt = 0; this.sleepFade = 1; this.lastLogAt = 0;
    this.startedAt = Date.now(); this.litAt = 0; this.flares = []; this.nextFlare = 4; this.coalSpots = [];
    this.spotPool = []; this.nSpots = 0; this.burning = []; this.burnPool = [];
    this.aState = { power: 0, flicker: 0, hissMod: 0, wet: 0, gust: 0, burning: this.burning, yaw: 0, dist: 3.4, heat: 0, snow: 0 };
    this.lpos = new V(0, 0.4, 0); this.lightCol = [1, 0.5, 0.2]; this.sparkWind = { x: 0, z: 0 }; this.smokeWind = { x: 0, z: 0 };
    this.asleep = false; this.waking = 1; this.lastInput = performance.now(); this.startedPerf = 0;
    this.audio = new CF.Audio(); var self = this;
    this.audio.onPop = function (log) { self.pop(log); };
    this.fps = 60; this.dispD = 16.7; this.budget = 16.7; this.lastDraw = 0; this.lastCb = performance.now();
    this.plumeK = 1;
    this.plume = function (x, y, z) { var r2 = x * x + z * z; return self.plumeK * Math.exp(-r2 / (0.06 + y * 0.1)) * Math.exp(-y / 4) + 0.35; };
    this.beforeFire = function (depthTex) {
      var p = self.post, c = self.lightCol, k = 1;
      self.fire.prepareDraw(self.camera, depthTex, p.w, p.h, self.time, 1.0, self.simAcc);
      if (self.mist) self.mist.prepare(depthTex, p.w, p.h, self.camera, c[0] * k, c[1] * k, c[2] * k);
    };
    this.buildFire();
    this.people = CF.People ? new CF.People(this) : null;   // the others in your circle (cf-people.js)
    this.setPlace(this.opts.place || 'forest', true);
    this.layTeepee();
    this.bindInput();
    this.resize();
    this.ro = new ResizeObserver(function () { self.resize(); }); this.ro.observe(el);
    this.loop = function () {
      self.raf = requestAnimationFrame(self.loop);
      var now = performance.now(), d = now - self.lastCb; self.lastCb = now;
      if (d < 100) self.dispD = CF.clamp(self.dispD * 0.95 + d * 0.05, 3, 34);   // the display's own rhythm (callbacks come once a refresh)
      if (self.asleep) return;
      // about 60 frames a second however fast the screen is (120 Hz draws every other refresh, 90 Hz every one), 30 at rest
      self.budget = self.resting(now) ? 33.4 : 16.7;
      if (!self.test.uncap && now - self.lastDraw < self.budget - 0.55 * self.dispD) return;
      self.lastDraw = now;
      self.tick();
    };
    this.raf = requestAnimationFrame(this.loop);
    this.vis = function () { self.audio.suspend(self.asleep || !!self.muted); self.clockLast = performance.now(); self.gov.slow = 0; };
    document.addEventListener('visibilitychange', this.vis);
    this.touched = function () { self.lastInput = performance.now(); if (self.asleep) self.wake(); };
    window.addEventListener('pointerdown', this.touched, { passive: true }); window.addEventListener('keydown', this.touched);
    this.leaving = function () { self.savePerf(); };
    window.addEventListener('pagehide', this.leaving);
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

  Campfire.prototype.msaa = function () { return this.gov.msaaOff ? 0 : this.q.msaa; };
  Campfire.prototype.simHz = function () { return this.gov.simHz || this.q.simHz; };
  // a phone left alone, a light tier, or someone falling asleep: half the frames, half the battery
  Campfire.prototype.resting = function (now) {
    if (this.test.quality) return false;
    return (this.q.rest || this.coarse || this.gov.rest || !!this.sleepAt) && now - this.lastInput > 6000;
  };
  Campfire.prototype.savePerf = function () {
    if (!this.autoQ || this.test.quality) return;
    try {
      localStorage.setItem('campfire.perf', JSON.stringify({ tier: this.qName, scale: Math.round(this.gov.scale * 100) / 100, simHz: this.gov.simHz, msaaOff: this.gov.msaaOff, rest: this.gov.rest, cap: Math.round(this.gov.capMs), at: Date.now() }));
    } catch (e) {}
  };

  Campfire.prototype.buildFire = function () {
    if (this.fire) { this.transp.remove(this.fire.group); this.fire.dispose(); }
    if (this.sparks) { this.transp.remove(this.sparks.mesh); this.transp.remove(this.smoke.mesh); this.transp.remove(this.puffs.mesh); }
    var q = this.q;
    this.fire = new CF.FireVolume(this.renderer, { blackbody: this.bb, nx: q.nx, ny: q.ny, slices: q.slices, W: 1.3, H: 1.3 * q.ny / q.nx, y0: -0.03, mg: q.mg, cubic: q.cubic });
    this.transp.add(this.fire.group);
    this.sparks = new CF.Sparks(q.sparks, this.bb); this.transp.add(this.sparks.mesh);
    this.smoke = new CF.Smoke(q.smoke); this.transp.add(this.smoke.mesh);
    this.puffs = new CF.Puffs(36); this.transp.add(this.puffs.mesh);
    this.simAcc = 0;
    this.lightShare = q.slices === 1 ? 2.6 : q.slices;   // the middle slice is read back: what it stands for (one slice alone carries less fuel)
  };

  // ---------------------------------------------------------------- place
  Campfire.prototype.setPlace = function (place, first) {
    if (!CF.PLACES[place]) place = 'forest';
    var r = this.renderer, R = CF.rng, q = this.q;
    if (this.world) { this.logs.forEach(function (l) { this.world.scene.remove(l.mesh); }, this); this.world.dispose(); }
    this.place = place;
    var W = this.world = CF.buildWorld(place, r, q.name), P = W.def;
    this.sky = W.skyCtl;
    // the fire's light falls off a little slower than a point's (exponent 1.6): what an eye adapted to the dark sees,
    // and why the nearest trunks glow
    var fl = this.fireLight = new THREE.PointLight(0xff8833, 0, 0, 1.6);
    fl.position.copy(this.lpos); fl.castShadow = q.shadow > 0;
    if (fl.castShadow) {
      fl.shadow.mapSize.set(q.shadow, q.shadow); fl.shadow.camera.near = 0.08; fl.shadow.camera.far = 16; fl.shadow.bias = -0.0012; fl.shadow.normalBias = 0.02;
      fl.shadow.radius = 2.4;
      fl.shadow.autoUpdate = false; fl.shadow.needsUpdate = true;
    }
    W.scene.add(fl);
    // A fire is a wide, tall lamp: nothing as small as a stone hides all of it. A twin of the light that casts no
    // shadow carries part of it, so shadows stay soft and never go black (only where there are shadows at all).
    this.fillLight = null;
    if (fl.castShadow) { this.fillLight = new THREE.PointLight(0xff8833, 0, 0, 1.6); W.scene.add(this.fillLight); }
    var cl = this.coalLight = new THREE.PointLight(0xff4410, 0, 0, 2); cl.position.set(0, 0.09, 0); W.scene.add(cl);
    var keep = this.logs; this.logs = [];
    keep.forEach(function (lg) { W.scene.add(lg.mesh); this.logs.push(lg); }, this);
    if (this.people) this.people.setWorld(W);
    // what drifts in the air here
    if (this.motes && this.motes.points) { this.transp.remove(this.motes.points); this.motes.geo.dispose(); this.motes.mat.dispose(); }
    if (this.moths) { this.transp.remove(this.moths.points); this.moths.geo.dispose(); this.moths.mat.dispose(); this.moths = null; }
    if (this.mist) { this.transp.remove(this.mist.mesh); this.mist.dispose(); this.mist = null; }
    var kind = W.motesKind;
    this.motes = kind === 'none' ? { on: false, kind: 'none' } : new CF.Motes(kind, kind === 'snow' ? q.snow : kind === 'fireflies' ? 28 : q.dust, kind === 'fireflies' ? 26 : kind === 'dust' ? 4.5 : 14);
    if (this.motes.on) this.transp.add(this.motes.points);
    if (P.moths && q.moths) { this.moths = new CF.Motes('moths', q.moths, 2); this.transp.add(this.moths.points); }
    if (P.mist && q.mist > 0) { this.mist = new CF.Mist(P.mist, q.mist); this.transp.add(this.mist.mesh); }
    // tonight's weather: it changes while you sit
    var wx = this.wx = { cloud: new CF.OU(P.cloud || 0, (P.cloud || 0) * 0.45 + 0.015, 0.012), mist: new CF.OU(0.85, 0.18, 0.01), snow: 0, snowWant: 0, snowUntil: 0, cloudNow: P.cloud || 0,
                         flashNext: 25 + R.expo(60), flash: 0, pulses: [], flashDir: new V(1, 0, 0), breath: R.range(0, 8), puffAcc: 0 };
    if (kind === 'snow') { wx.snowWant = R.chance(0.6) ? R.range(0.4, 1) : 0; wx.snow = wx.snowWant; wx.snowUntil = this.time + (wx.snowWant ? 120 : 60) + R.expo(wx.snowWant ? 300 : 360); }
    this.sky.aurora = place === 'snow' && R.chance(P.aurora || 0) ? R.range(0.6, 1.2) : 0;
    this.auroraOn = this.sky.aurora > 0;
    this.shoot = { next: 20 + R.expo(60), t: -1 };
    this.fire.setSmokeLight(0.05, 0.03, 0.02, P.smokeAmb);
    this.puffs.items.length = 0;
    this.puffs.mat.uniforms.uAmb.value.setRGB(P.smokeAmb[0] * 2.5, P.smokeAmb[1] * 2.5, P.smokeAmb[2] * 2.5);
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
    _q1.setFromUnitVectors(X, _a.copy(lg.pose.dir).normalize());
    _q2.setFromAxisAngle(X, lg.pose.roll);
    lg.mesh.quaternion.copy(_q1.multiply(_q2));
    var s = 0.4 + 0.6 * Math.sqrt(Math.max(lg.mass, 0));
    lg.mesh.scale.set(1 - (1 - lg.mass) * 0.12, s, s);
    lg.mesh.position.copy(lg.pose.pos);
  };
  // a point on the log in world space (t in -0.5..0.5 along it, up = offset towards the top side)
  Campfire.prototype.logPoint = function (lg, t, side, up, out) {
    var d = _a.copy(lg.pose.dir).normalize(), sx = -d.z, sz = d.x, sl = Math.hypot(sx, sz) || 1;
    var s = 0.4 + 0.6 * Math.sqrt(Math.max(lg.mass, 0)), k = side * lg.rad * s * 0.5 / sl;
    out.copy(lg.pose.pos).addScaledVector(d, t * lg.len);
    out.x += sx * k; out.z += sz * k; out.y += up * lg.rad * s;
    return out;
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
    for (var i = 0; i < this.logs.length; i++) {
      var o = this.logs[i];
      if (o === self || o.leaning || o.anim || o.kind) continue;
      if (self && o.pose.pos.y > self.pose.pos.y) continue;
      var os = 0.4 + 0.6 * Math.sqrt(Math.max(o.mass, 0));
      if (segDist(c, dir, lg.len, o.pose.pos, o.pose.dir, o.len) < (lg.rad * s + o.rad * os) * 1.05) y = Math.max(y, o.pose.pos.y + o.rad * os * 0.7 + lg.rad * s * 0.8);
    }
    return Math.min(y, 0.035 + lg.rad * s + 0.13);
  };
  function segDist(c1, d1, l1, c2, d2, l2) {   // rough distance between two log axes in the ground plane
    var best = 9;
    for (var i = -2; i <= 2; i++) for (var j = -2; j <= 2; j++) {
      var px = c1.x + d1.x * i / 4 * l1 * 0.9 - (c2.x + d2.x * j / 4 * l2 * 0.9), pz = c1.z + d1.z * i / 4 * l1 * 0.9 - (c2.z + d2.z * j / 4 * l2 * 0.9);
      best = Math.min(best, Math.hypot(px, pz));
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
    var p = _c.set(CF.rng.gauss() * 0.08, 0.2, CF.rng.gauss() * 0.08);
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
    var R = CF.rng, total = 0, nb = 0, i, lg;
    if (this.match > 0) { this.match = Math.max(0, this.match - dt / 9); }
    this.stirBoost *= Math.exp(-dt / 6);
    this.heatSmooth = CF.damp(this.heatSmooth || 0, Math.min(1.6, this.power), 0.4, dt);
    var available = this.heatSmooth * 1.1 + this.coal * (0.55 + 0.6 * this.stirBoost) + (this.match > 0 ? 1.2 : 0);
    var kindling = 0; for (i = 0; i < this.logs.length; i++) if (this.logs[i].kind) kindling++;
    for (i = this.logs.length - 1; i >= 0; i--) {
      lg = this.logs[i];
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
      if (lg.rate > 0.02) {
        var b = this.burnPool[nb] || (this.burnPool[nb] = {}); nb++;
        b.az = Math.atan2(lg.pose.pos.x, lg.pose.pos.z); b.rate = lg.rate * lg.sp.crackle * Math.min(1.4, scale + 0.3); b.pop = lg.sp.pop;
        b.sap = lg.sp.sap * on * (lg.wet ? 2 : 1); b.pitch = lg.sp.pitch; b.ref = lg;
      }
      // a teepee falls in when its logs burn through
      if (lg.leaning && !lg.kind && (lg.mass < 0.6 || (lg.ign > 0.8 && kindling === 0 && R.next() < dt * 0.02))) {
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
        } else kindling--;
        if (nb && this.burnPool[nb - 1].ref === lg) nb--;
        this.world.scene.remove(lg.mesh); lg.mesh.geometry.dispose(); lg.mat.dispose();
        this.logs.splice(i, 1);
        continue;
      }
      if (!lg.leaning && (this.frame + i) % 20 === 0) lg.restY = this.supportY(lg, lg.pose.pos, lg.pose.dir, lg);
      if (!lg.leaning && lg.restY !== undefined && lg.pose.pos.y > lg.restY) lg.pose.pos.y = Math.max(lg.restY, lg.pose.pos.y - dt * 0.05);
      this.applyPose(lg);
    }
    this.burning.length = nb;
    for (i = 0; i < nb; i++) this.burning[i] = this.burnPool[i];
    // coals: grow from burning wood, cool slowly
    total /= 3;   // a good fire of three or four logs = about 1
    this.coal += dt * total * 0.0012;
    this.coal *= Math.exp(-dt / (this.power > 0.15 ? 2600 : 1500));
    this.coal = Math.min(this.coal, 1.6);
    this.coalHeat = CF.damp(this.coalHeat, Math.min(1.4, this.coal * (0.75 + 0.5 * this.stirBoost)), 0.5, dt);
    this.power = total;
    // auto-tend: a log when it gets low
    if (this.autoTend && this.lit && this.time - this.lastLogAt > 70 && total < 0.9 && !(this.sleepAt && Date.now() > this.sleepAt - 15 * 60000)) this.addLog();
  };

  // flame sources for the GPU simulation (objects are reused; this.nSpots of them count)
  Campfire.prototype.spots = function (dt) {
    var out = this.spotPool, n = 0, R = CF.rng, p = _c, o, i, j, f;
    for (f = this.flares.length - 1; f >= 0; f--) { this.flares[f].t += dt; if (this.flares[f].t > this.flares[f].dur) this.flares.splice(f, 1); }
    var flare = 1; for (f = 0; f < this.flares.length; f++) flare += this.flares[f].k * Math.sin(Math.PI * this.flares[f].t / this.flares[f].dur);
    this.nextFlare -= dt;
    if (this.nextFlare < 0) { this.flares.push({ t: 0, dur: R.range(0.4, 1.4), k: R.range(0.2, 0.7) }); this.nextFlare = R.expo(7); }
    var soot = 0, sw = 0;
    for (i = 0; i < this.logs.length; i++) {
      var lg = this.logs[i];
      if (lg.anim && lg.ign < 0.3) continue;
      var on = CF.smooth(0.3, 1, lg.ign);
      if (on <= 0.01) continue;
      for (j = 0; j < lg.spots.length; j++) {
        var s = lg.spots[j];
        s.t += R.gauss() * dt * 0.03; s.side += R.gauss() * dt * 0.2;
        if (s.t < -0.47 || s.t > 0.47 || R.next() < dt * 0.04) { s.t = R.range(-0.45, 0.45); s.side = R.range(-1, 1); }
        s.side = CF.clamp(s.side, -1, 1);
        var k = Math.max(0, s.ou.step(dt));
        this.logPoint(lg, s.t, s.side, 0.75, p);
        var d2 = p.x * p.x + p.z * p.z, ex = Math.exp(-d2 / 0.4) * Math.exp(-Math.max(0, p.y - 0.18) / 0.6);
        var str = on * k * (0.25 + 0.9 * Math.min(1.3, lg.q)) * ex * (lg.kind ? 0.8 : 1) * (1 - 0.6 * lg.moisture) * flare * lg.sp.burn;
        if (str > 0.02) { o = out[n] || (out[n] = {}); n++; o.x = p.x; o.y = p.y; o.z = p.z; o.r = s.r; o.s = Math.min(str, 2.4); o.k = s.k; }
      }
      soot += lg.sp.soot * lg.rate; sw += lg.rate;
    }
    // small flames walking over the coals
    if (this.coalSpots.length < 9) this.coalSpots.push({ x: R.gauss() * 0.17, z: R.gauss() * 0.17, ou: new CF.OU(0.6, 0.6, 1.5) });
    for (i = 0; i < this.coalSpots.length; i++) {
      var c = this.coalSpots[i];
      c.x += R.gauss() * dt * 0.05; c.z += R.gauss() * dt * 0.05;
      if (Math.hypot(c.x, c.z) > 0.25 || R.next() < dt * 0.1) { c.x = R.gauss() * 0.12; c.z = R.gauss() * 0.12; }
      var cs = Math.max(0, c.ou.step(dt)) * (this.coalHeat * 0.4 + Math.min(1.2, this.power) * 0.35) * flare;
      if (cs > 0.02) { o = out[n] || (out[n] = {}); n++; o.x = c.x; o.y = 0.06; o.z = c.z; o.r = 0.045; o.s = cs; o.k = undefined; }
    }
    if (this.match > 0) {   // the match itself
      var m = Math.min(1, (1 - this.match) * 12) * this.match;
      o = out[n] || (out[n] = {}); n++; o.x = 0.02; o.y = 0.06; o.z = 0.06; o.r = 0.012; o.s = 1.4 * m; o.k = undefined;
    }
    this.sootMix = sw > 0 ? soot / sw : 1;
    this.nSpots = n;
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
  Campfire.prototype.pause = function (on) { this.paused = !!on; this.clockLast = performance.now(); this.gov.slow = 0; };
  Campfire.prototype.setHandlers = function (onState, onEvent) { this.opts.onState = onState; this.opts.onEvent = onEvent; };
  Campfire.prototype.audioUpdate = function (dt, lp, gust) {
    var s = this.aState;
    s.power = this.power * 0.7 + (lp === undefined ? this.lightPower || 0 : lp); s.flicker = this.flicker; s.hissMod = CF.clamp(this.hiss.step(dt), 0, 1.5); s.wet = this.wetSmoke();
    s.gust = gust === undefined ? this.wind.strength || 0 : gust; s.yaw = this.cam.yaw; s.dist = this.cam.dist;
    s.heat = Math.min(1.5, this.coalHeat + this.power * 0.5); s.snow = this.wx ? this.wx.snow : 0;
    this.audio.update(s);
  };

  // The governor: hold the frame rate by giving up what is missed least, and take it back when there is room.
  // Every step has to earn its keep: if frames do not get faster, the next step skips ahead (resolution does not
  // help a slow processor), and if nothing helps at all the frame rate is capped from outside (a phone's
  // power-saving mode draws 30 frames a second whatever you do): everything is put back and that pace is accepted.
  Campfire.prototype.govern = function (dt, now) {
    var g = this.gov, budget = Math.max(this.budget, g.capMs) / 1000;
    if (now - this.startedPerf < 4000 || document.hidden) return;
    g.ft = g.ft ? g.ft * 0.92 + dt * 0.08 : dt;
    var slow = dt > budget * 1.35 + 0.003;
    g.slow = slow ? g.slow + dt : Math.max(0, g.slow - dt * 0.5);
    g.good = slow ? 0 : g.good + dt;
    if (now > g.ceilUntil) g.ceil = 1;
    if (g.good > 45) { g.first = null; g.before = 0; g.fruitless = 0; g.triedTier = false; }
    if (g.slow > 1.5 && now - g.at > 2500) {
      if (g.msaaUp && now - g.upAt < 15000) { g.msaaFailed = g.msaaOff = true; this.post.setSamples(0); }   // smoothing came back too soon: off for this visit
      else {
        if (now - g.upAt < 15000) { g.ceil = Math.max(0.3, g.scale - 0.1); g.ceilUntil = now + 240000; }   // the last step up was too much: not again for a while
        this.stepDown();
      }
      g.msaaUp = false; g.slow = 0; g.good = 0; g.at = now;
    } else if (g.good > 30 && now - g.at > 30000) {
      if (g.scale < g.ceil - 0.001) { g.scale = Math.min(g.ceil, g.scale + 0.1); g.upAt = now; g.at = now; g.good = 0; g.msaaUp = false; this.resize(); this.savePerf(); }
      else if (g.msaaOff && !g.msaaFailed && g.scale > 0.99 && this.q.msaa) { g.msaaOff = false; g.msaaUp = true; g.upAt = now; g.at = now; g.good = 0; this.post.setSamples(this.msaa()); this.savePerf(); }
    }
  };
  Campfire.prototype.scaleDown = function (to) {   // false when the picture is already as coarse as the tier allows
    var g = this.gov, pr = this.pixelRatio(), old = g.scale;
    g.scale = Math.max(to, g.scale - 0.1);
    if (this.pixelRatio() < pr - 0.004) { this.resize(); return true; }
    g.scale = old; return false;
  };
  Campfire.prototype.stepDown = function () {
    var g = this.gov, q = this.q, floor = q.prMin / q.pr, what;
    if (g.before) g.fruitless = g.ft > g.before * 0.92 ? g.fruitless + 1 : 0;   // did the last step buy anything?
    if (!g.first) g.first = { tier: this.qName, scale: g.scale, simHz: g.simHz, msaaOff: g.msaaOff, rest: g.rest };
    g.before = g.ft;
    var fill = g.fruitless < 2;   // giving up pixels is still worth trying
    if (g.fruitless >= 3 && g.triedTier) {
      var f = g.first; g.scale = f.scale; g.simHz = f.simHz; g.msaaOff = f.msaaOff; g.rest = f.rest;
      g.capMs = Math.min(70, g.ft * 1000); g.first = null; g.before = 0; g.fruitless = 0; g.triedTier = false;
      if (this.qName !== f.tier) this.setQuality(f.tier, true); else { this.post.setSamples(this.msaa()); this.resize(); }
      what = 'capped';
    }
    else if (fill && g.scale > 0.81 && this.scaleDown(0.8)) what = 'scale';
    else if (fill && this.post.samples > 0) { g.msaaOff = true; this.post.setSamples(0); what = 'smoothing'; }
    else if (fill && this.scaleDown(floor)) what = 'scale';
    else if (this.simHz() > 30) { g.simHz = 30; what = 'simulation'; }
    else if (ORDER.indexOf(this.qName) > 0) { g.scale = 1; g.simHz = 0; g.msaaOff = false; g.triedTier = true; this.setQuality(ORDER[ORDER.indexOf(this.qName) - 1], true); what = 'tier'; }
    else if (!g.rest) { g.rest = true; g.triedTier = true; what = 'rest'; }
    else g.triedTier = true;
    if (what) { if (what !== 'capped') this.savePerf(); if (this.opts.onEvent) this.opts.onEvent('eased', what); }
    return what;
  };

  // the night around the fire: cloud, snow, the moon's path, far lightning, mist, moths, breath, steam
  Campfire.prototype.weather = function (dt, lp, gust) {
    var wx = this.wx, W = this.world, P = W.def, R = CF.rng, sky = this.sky, w = this.wind, cam = this.camera, i;
    // cloud wanders; snow comes with thicker cloud and goes again
    var cloud = CF.clamp(wx.cloud.step(dt), 0, 0.9);
    if (this.motes.kind === 'snow') {
      if (this.time > wx.snowUntil) { wx.snowWant = wx.snowWant ? 0 : R.range(0.35, 1); wx.snowUntil = this.time + 60 + R.expo(wx.snowWant ? 300 : 380); }
      wx.snow = CF.damp(wx.snow, wx.snowWant, 0.022, dt);
      cloud = CF.clamp(cloud * (1 - wx.snow) + (0.45 + 0.5 * wx.snow) * wx.snow, 0, 0.97);
      this.motes.setAmount(wx.snow);
    }
    sky.cloud = cloud; wx.cloudNow = cloud;
    if (this.auroraOn) sky.aurora = CF.clamp(sky.aurora + R.gauss() * dt * 0.05, 0.3, 1.3);
    sky.update(this.time);
    // the moon moves with the sky, and cloud dims it
    var up = CF.smooth(-0.03, 0.1, sky.moonDir.y) * (1 - 0.6 * cloud);
    W.moon.position.copy(sky.moonDir).multiplyScalar(40); W.moon.intensity = P.moon.intensity * 10 * up;
    // far lightning (desert): a few quick pulses, then a long quiet
    var flash = 0;
    if (P.lightning) {
      wx.flashNext -= dt;
      if (wx.flashNext < 0) {
        var n = R.int(2, 5), t0 = 0, big = R.range(0.35, 1);
        for (i = 0; i < n; i++) { wx.pulses.push({ at: this.time + t0, dur: R.range(0.05, 0.16), k: big * R.range(0.4, 1) }); t0 += R.range(0.06, 0.3); }
        var az = Math.atan2(P.lightning[2], P.lightning[0]) + R.gauss() * 0.35; wx.flashDir.set(Math.cos(az), 0, Math.sin(az));
        wx.flashNext = R.chance(0.3) ? R.range(3, 9) : 20 + R.expo(75);
        if (big > 0.6) this.audio.thunder(R.range(9, 22), big, this.audio.panFor(Math.atan2(wx.flashDir.x, wx.flashDir.z)));
      }
      for (i = wx.pulses.length - 1; i >= 0; i--) {
        var pz = wx.pulses[i], ph = (this.time - pz.at) / pz.dur;
        if (ph > 1) { wx.pulses.splice(i, 1); continue; }
        if (ph >= 0) flash = Math.max(flash, pz.k * Math.sin(Math.PI * ph));
      }
      sky.mat.uniforms.uFlash.value.set(wx.flashDir.x, 0, wx.flashDir.z, flash * 0.05);
    }
    wx.flash = flash;
    W.hemi.intensity = P.hemi[0] * 10 * (0.75 + 0.25 * up) + flash * 0.05;
    // mist: thicker in still air, lit by the fire
    if (this.mist) this.mist.update(dt, this.time, w, lp * 1.5, CF.clamp(wx.mist.step(dt), 0.3, 1.3) * (1.15 - 0.45 * Math.min(1, gust)));
    if (this.moths) this.moths.update(dt, this.time, w, lp);
    wx.puffAcc += dt;
    // your breath in the cold: out for a few seconds, about six times a minute, drifting towards the fire
    if (P.breath && this.lit) {
      wx.breath += dt;
      var cyc = wx.breath % 9.5;
      if (cyc < 3.2 && wx.puffAcc > 0.11) {
        wx.puffAcc = 0;
        cam.getWorldDirection(_a); _b.copy(cam.position).addScaledVector(_a, 0.3); _b.y -= 0.17;
        this.puffs.emit(_b.x + R.gauss() * 0.01, _b.y, _b.z + R.gauss() * 0.01, _a.x * 0.32 + R.gauss() * 0.03, 0.02 + R.gauss() * 0.02, _a.z * 0.32 + R.gauss() * 0.03,
                        0.035, 0.11, R.range(2.2, 3.2), 0.05 * Math.sin(Math.PI * cyc / 3.2), 0.3);   // lit as fog is, three metres from the fire
      }
    }
    // steam from the coffee pot when the fire is hot
    if (W.spout && this.lit) {
      var hot = CF.clamp((this.coalHeat + this.power * 0.6 - 0.45) * 1.6, 0, 1);
      if (hot > 0.05 && wx.puffAcc > 0.16) {
        wx.puffAcc = 0;
        this.puffs.emit(W.spout.x, W.spout.y, W.spout.z, R.gauss() * 0.03, R.range(0.22, 0.4), R.gauss() * 0.03, 0.014, 0.07, R.range(1.2, 2.2), 0.2 * hot, 2.2);   // and right beside it
      }
    }
    this.puffs.update(dt, w);
  };

  Campfire.prototype.step = function (dt, draw) {
    var R = CF.rng, now = this.clockLast, q = this.q, i;
    this.time += dt; this.frame++;
    CF.U.uTime.value = this.time;
    if (!this.startedPerf) this.startedPerf = now;
    this.fps = this.fps * 0.95 + (1 / dt) * 0.05;
    if (draw && this.autoQ) this.govern(dt, now);
    if (this.waking < 1) this.waking = Math.min(1, this.waking + dt / 2.5);
    // wind
    var w = this.wind, calm = this.place === 'desert' ? 0.45 : 1; w.g.mean = [0.06, 0.35, 0.7][w.level] * calm; w.g.sigma = [0.06, 0.22, 0.38][w.level] * calm;
    var gg = Math.max(0, w.g.step(dt)); w.gustT -= dt;
    if (w.gustT < 0 && w.level > 0) { w.gust = R.range(0.3, 1) * w.level; w.gustT = R.expo(30 / w.level); }
    w.gust *= Math.exp(-dt / 2.5);
    var gust = Math.min(1.5, gg + w.gust), az = w.az.step(dt);
    w.x = Math.cos(az) * gust; w.z = Math.sin(az) * gust; w.strength = gust;
    // trees answer the wind a moment later and more slowly than flames do
    w.sx = CF.damp(w.sx, w.x, 0.9, dt); w.sz = CF.damp(w.sz, w.z, 0.9, dt);
    CF.U.uWind.value.set(w.sx, w.sz, this.time);
    this.updateFire(dt);
    // flames
    var cam = this.camera;
    this.updateCamera(dt);
    if (this.people) this.people.update(dt, this.time, cam, draw);
    this.fire.orient(cam);
    this.fire.setSources(this.spots(dt), this.nSpots);
    var soot = this.sootMix || 1, along = this.fire.windAlong(w.x, w.z), coal = this.coalHeat * 2.2;
    for (i = 0; i < this.fire.slices.length; i++) {
      var fp = this.fire.slices[i].sim.params;
      fp.wind = along * 1.1; fp.sootY = 1.15 * soot; fp.coal[0] = 0; fp.coal[1] = 0.24; fp.coal[2] = coal; fp.coal[3] = 0.035;
    }
    var simDt = 1 / this.simHz(), steps = 0, most = draw ? Math.round(simDt * 120) : 1;   // up to two 60 Hz steps, or one 30 Hz step, a frame
    this.simAcc += dt;
    while (this.simAcc >= simDt && steps < most) { this.simAcc -= simDt; steps++; }
    if (this.simAcc > simDt * 3) this.simAcc = 0;
    if (steps) this.fire.step(simDt, steps, this.frame % 2 === 0 || !draw);
    var li = this.fire.readback(1);
    if (li.fresh) {
      var pw = li.power * this.lightShare;
      this.flicker = CF.clamp(Math.abs(pw - this.lastPower) * 6, 0, 1) * 0.5 + this.flicker * 0.5; this.lastPower = pw;
      this.lightPower = this.lightPower === undefined ? pw : CF.damp(this.lightPower, pw, 18, dt * 2);
      this.lightY = li.y; this.lightX = li.x; this.lightTheta = li.theta;
    }
    var lp = this.lightPower || 0;
    this.pSmooth = CF.damp(this.pSmooth, Math.min(2, lp * 2.2), 1.2, dt);
    // light from the flames and the coals
    var fl = this.fireLight, th = this.lightTheta || 0.8, lc = this.lightCol;
    if (this.frame % 4 === 0) {
      var col = CF.blackbodyRGB(CF.KELVIN(CF.clamp(th, 0.55, 1.05)) + 120), mx = Math.max(col[0], col[1], col[2]);
      lc[0] = col[0] / mx; lc[1] = col[1] / mx; lc[2] = col[2] / mx;
      var cc = CF.blackbodyRGB(1050 + 120 * this.coalHeat), cm = Math.max(cc[0], cc[1], cc[2]);
      this.coalLight.color.setRGB(cc[0] / cm, cc[1] / cm, cc[2] / cm);
      this.world.coalU.uCoalCol.value.setRGB(cc[0] / cm * 1.6, cc[1] / cm * 1.6, cc[2] / cm * 1.6);
    }
    fl.color.setRGB(lc[0], lc[1], lc[2]);
    var right = this.fire.right, lx = (this.lightX || 0) * 0.6;
    this.lpos.set(CF.damp(this.lpos.x, right.x * lx, 14, dt), CF.damp(this.lpos.y, Math.max(0.18, (this.lightY || 0.35) * 0.8), 14, dt), CF.damp(this.lpos.z, right.z * lx, 14, dt));
    if (!fl.castShadow) fl.position.copy(this.lpos);
    else if (this.frame % q.shadowEvery === 0) { fl.position.copy(this.lpos); fl.shadow.needsUpdate = true; }   // the lamp and its shadows move together
    var glow = 19 * lp + (this.match > 0 ? 0.6 * this.match : 0), fill = this.fillLight;
    fl.intensity = fill ? glow * 0.62 : glow;
    if (fill) { fill.intensity = glow * 0.38; fill.color.copy(fl.color); fill.position.set(this.lpos.x, this.lpos.y + 0.25, this.lpos.z); }
    this.coalLight.intensity = 1.6 * this.coalHeat * this.coalHeat;
    this.world.coalU.uCoalHeat.value = this.coalHeat;
    CF.U.uEmber.value.setRGB(0.5 * this.coalHeat, 0.09 * this.coalHeat, 0.01 * this.coalHeat);
    this.fire.setSmokeLight(lc[0] * 0.03 * lp, lc[1] * 0.03 * lp, lc[2] * 0.03 * lp, null);
    // sparks: a steady trickle + pops
    var trickle = 0; for (i = 0; i < this.logs.length; i++) trickle += this.logs[i].rate * this.logs[i].sp.sparks;
    this.sparkAcc = (this.sparkAcc || 0) + dt * trickle * 0.45;
    while (this.sparkAcc > 1) { this.sparkAcc -= 1; this.sparks.emit(R.gauss() * 0.12, R.range(0.15, 0.55), R.gauss() * 0.12, 1, R.range(0.6, 1.6), 0.5, R.range(0.95, 1.1)); }
    this.plumeK = 0.8 + 3.2 * Math.min(1.4, lp * 2);
    this.sparkWind.x = w.x * 1.2; this.sparkWind.z = w.z * 1.2;
    this.sparks.update(dt, this.time, this.plume, this.sparkWind);
    var damp = false; for (i = 0; i < this.logs.length; i++) if (this.logs[i].moisture > 0.3 && this.logs[i].q > 0.1) damp = true;
    this.smokeWind.x = w.x * 0.8; this.smokeWind.z = w.z * 0.8;
    this.smoke.update(dt, this.time, 1.2 + 4 * Math.min(1, this.power) + (damp ? 4 : 0), 0.06 + 0.12 * this.wetSmoke(), this.smokeWind, 0.9 + 0.5 * Math.min(1, lp * 2));
    var focal = (this.post.h || 800) / (2 * Math.tan(this.camera.fov * Math.PI / 360));
    if (this.motes.on) { this.motes.update(dt, this.time, w, lp * 2 + this.coalHeat * 0.3); this.motes.mat.uniforms.uScale.value = focal; }
    if (this.moths) { this.moths.mat.uniforms.uScale.value = focal; this.moths.mat.uniforms.uFire.value.setRGB(lc[0], lc[1], lc[2]); }
    this.updateSky(dt);
    this.weather(dt, lp, gust);
    // the eye adapts: a big fire makes the night darker around it
    var target = this.world.def.exposure * 1.25 / (0.25 + 0.9 * Math.min(1.6, this.pSmooth + this.coalHeat * 0.25));
    this.exposure = CF.damp(this.exposure, CF.clamp(target, 0.6, 3.2), 0.4, dt);
    this.sleepTick();
    // sound follows the fire
    this.audioUpdate(dt, lp, gust);
    if (!draw) return;
    // draw
    var post = this.post, W = this.world, fu = post.mFinal.uniforms;
    W.sky.position.copy(cam.position);
    this.sparks.mat.uniforms.uRes.value.set(post.w, post.h);
    this.sparks.mat.uniforms.uFocal.value = focal;
    this.sparks.mat.uniforms.uGain.value = 4.5;
    this.sparks.upload(1 / 50, this.time);
    this.smoke.upload(0.9 + lp);
    this.puffs.upload();
    this.puffs.mat.uniforms.uLit.value.setRGB(lc[0] * lp, lc[1] * lp, lc[2] * lp);   // each puff carries its own share (how near the fire it was born)
    fu.uExposure.value = this.exposure * this.sleepFade * CF.smooth(0, 1, this.waking) * (1 + this.wx.flash * 0.04); fu.uTime.value = this.time;
    var lum = 0.2126 * fl.color.r + 0.7152 * fl.color.g + 0.0722 * fl.color.b, ad = 0.3 * CF.clamp(lp * 3 + this.coalHeat * 0.4, 0, 1);
    fu.uWB.value.set(CF.lerp(1, fl.color.r / lum, ad), CF.lerp(1, fl.color.g / lum, ad), CF.lerp(1, fl.color.b / lum, ad));
    var top = _a.set(0, 0.75 + 0.4 * Math.min(1.5, lp * 2), 0).project(cam), hazeH = _b.set(0, 1.6, 0).project(cam);
    fu.uHaze.value.set(top.x * 0.5 + 0.5, (top.y + hazeH.y) * 0.25 + 0.5, 0.18 * 3.2 / this.cam.dist, Math.abs(hazeH.y - top.y) * 0.6 + 0.05);
    fu.uHazeK.value = Math.min(1, lp * 2 + this.coalHeat * 0.3);
    post.render(W.scene, this.transp, cam, this.beforeFire);
  };
  // sleep timer: fade the world out over the last five minutes, then stop drawing until someone stirs
  Campfire.prototype.sleepTick = function () {
    if (!this.sleepAt) return;
    var left = (this.sleepAt - Date.now()) / 1000;
    this.sleepFade = CF.clamp(left / 300, 0, 1);
    this.audio.setVolume('master', (this.audio.vol.masterUser !== undefined ? this.audio.vol.masterUser : 0.9) * this.sleepFade);
    if (left <= 0) {
      this.sleepAt = 0; this.autoTend = false; this.audio.suspend(true); this.asleep = true;   // the loop draws nothing from here on
      if (this.opts.onEvent) this.opts.onEvent('slept');
    }
  };
  // a touch or a key after the sleep timer has ended: the picture and the sound come back
  Campfire.prototype.wake = function () {
    if (!this.asleep) return;
    this.asleep = false; this.sleepFade = 1; this.waking = 0; this.clockLast = performance.now(); this.gov.slow = 0;
    this.audio.setVolume('master', this.audio.vol.masterUser !== undefined ? this.audio.vol.masterUser : 0.9);
    if (!this.muted) this.audio.suspend(false);
    if (this.opts.onEvent) this.opts.onEvent('woke');
  };
  Campfire.prototype.background = function () {
    var now = performance.now(), dt = Math.min(5, (now - this.clockLast) / 1000);
    this.clockLast = now;
    if (this.asleep) return;
    for (var t = 0; t < dt; t += 0.25) { this.time += 0.25; this.updateFire(0.25); }
    this.pSmooth = CF.damp(this.pSmooth, Math.min(2, this.power * 0.6), 1.2, dt);
    this.lightPower = CF.damp(this.lightPower || 0, this.power * 0.25, 1, dt);
    this.audioUpdate(dt); this.sleepTick();
  };
  Campfire.prototype.wetSmoke = function () {
    var w = 0; for (var i = 0; i < this.logs.length; i++) { var l = this.logs[i]; if (l.q > 0.1 && l.moisture > w) w = l.moisture; } return w;
  };
  Campfire.prototype.updateSky = function (dt) {
    var u = this.sky.mat.uniforms, s = this.shoot, R = CF.rng;
    s.next -= dt;
    if (s.next < 0 && s.t < 0) {
      var a = _a.set(R.gauss(), R.range(0.4, 1.2), R.gauss()).normalize(), b = _b.copy(a).add(_c.set(R.gauss() * 0.25, -R.range(0.05, 0.2), R.gauss() * 0.25)).normalize();
      u.uShootA.value.set(a.x, a.y, a.z, 0); u.uShootB.value.set(b.x, b.y, b.z, 1); s.t = 0; s.dur = R.range(0.4, 1.0);
    }
    if (s.t >= 0) {
      s.t += dt / s.dur; u.uShootA.value.w = s.t * 1.3; u.uShootB.value.w = Math.sin(Math.min(1, s.t) * Math.PI);
      if (s.t > 1.1) { s.t = -1; u.uShootB.value.w = 0; s.next = R.expo(90) + 15; }
    }
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
      self.lastInput = performance.now();
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
    function onWheel(e) { e.preventDefault(); self.lastInput = performance.now(); self.zoom(Math.exp(e.deltaY * 0.001)); }
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
  Campfire.prototype.look = function (dyaw) { this.cam.vyaw += dyaw; this.lastInput = performance.now(); };
  // device pixels drawn per CSS pixel: the tier's cap, scaled by the governor on "auto", never below the tier's floor
  Campfire.prototype.pixelRatio = function () {
    var q = this.q, dpr = window.devicePixelRatio || 1;
    return Math.max(Math.min(q.prMin, dpr), Math.min(dpr, q.pr) * (this.autoQ ? this.gov.scale : 1));
  };
  Campfire.prototype.resize = function () {
    var w = Math.max(1, this.el.clientWidth), h = Math.max(1, this.el.clientHeight), pr = this.pixelRatio();
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
  // name: 'auto' | 'high' | 'medium' | 'low' | 'lite'. auto (second argument) = the governor's own step down.
  Campfire.prototype.setQuality = function (name, auto) {
    if (this.test.quality) return;
    if (!auto) {
      var wasAuto = this.autoQ; this.autoQ = name === 'auto';
      if (name === 'auto') {
        if (wasAuto) return;
        var saved = loadPerf(); name = (saved && saved.tier) || CF.guessTier(this.gpuName, this.coarse, navigator.deviceMemory, navigator.hardwareConcurrency, window.innerWidth);
      }
      var g = this.gov; g.scale = 1; g.simHz = 0; g.msaaOff = false; g.rest = false; g.ceil = 1; g.slow = 0; g.first = null; g.before = 0; g.fruitless = 0; g.triedTier = false;
    }
    if (!TIERS[name]) name = 'medium';
    if (name === this.qName && this.fire) { this.post.setSamples(this.msaa()); this.resize(); return; }
    this.qName = name; this.q = qualityTier(name);
    this.renderer.shadowMap.enabled = this.q.shadow > 0;
    this.buildFire();
    var keepLogs = this.logs; this.logs = [];
    keepLogs.forEach(function (l) { this.world.scene.remove(l.mesh); }, this);
    this.logs = keepLogs; this.setPlace(this.place, true);
    this.post.setSamples(this.msaa());
    this.resize();
    this.startedPerf = performance.now();
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
  Campfire.prototype.setSleep = function (minutes) {
    if (this.asleep) this.wake();
    this.sleepAt = minutes > 0 ? Date.now() + minutes * 60000 : 0; this.sleepFade = 1;
    if (!minutes) this.audio.setVolume('master', this.audio.vol.masterUser !== undefined ? this.audio.vol.masterUser : 0.9);
  };
  Campfire.prototype.sound = function (on) { if (on) this.audio.start(); this.audio.suspend(!on || this.asleep); this.muted = !on; };
  Campfire.prototype.state = function () {
    var logs = this.logs.filter(function (l) { return !l.kind; }), wx = this.wx || {};
    return {
      ok: this.ok, lit: this.lit, place: this.place, placeName: (CF.PLACES[this.place] || {}).name, quality: this.qName, auto: this.autoQ,
      power: Math.round(this.power * 100) / 100, light: Math.round((this.lightPower || 0) * 1000) / 1000, coals: Math.round(this.coal * 100) / 100,
      logs: logs.length, burning: (this.burning || []).length, kindling: this.logs.length - logs.length,
      sparks: this.sparks ? this.sparks.n : 0, fps: Math.round(this.fps), minutes: this.litAt ? Math.floor((Date.now() - this.litAt) / 60000) : 0,
      woods: this.world.def.woods.map(function (k) { return { key: k, label: CF.SPECIES[k].label, note: CF.SPECIES[k].note }; }),
      sleepLeft: this.sleepAt ? Math.max(0, Math.round((this.sleepAt - Date.now()) / 60000)) : 0, autoTend: this.autoTend, asleep: this.asleep,
      aurora: !!this.auroraOn, snowing: (wx.snow || 0) > 0.15, cloud: Math.round((wx.cloudNow || 0) * 100) / 100, sound: !!(this.audio.ctx && !this.muted),
      exposure: Math.round(this.exposure * 100) / 100, simTime: Math.round(this.time), people: this.people ? this.people.count() : 0,
      scale: Math.round(this.pixelRatio() * 100) / 100, smooth: this.post.samples, simHz: this.simHz(), resting: this.resting(performance.now())
    };
  };
  // tests and screenshots: run the fire for `sec` seconds of its life without drawing
  Campfire.prototype.warp = function (sec, simEvery) {
    var n = Math.round(sec / 0.05), every = simEvery || 1;
    this.updateCamera(0.016);
    for (var i = 0; i < n; i++) {
      this.time += 0.05; CF.U.uTime.value = this.time;
      this.updateFire(0.05);
      if (i % every === 0 && n - i < 240) {   // only the last stretch needs the fluid
        this.fire.orient(this.camera); this.fire.setSources(this.spots(0.05), this.nSpots);
        this.fire.step(1 / 60, 3);
        var li = this.fire.readback(1, true); this.lightPower = li.power * this.lightShare; this.lightY = li.y; this.lightTheta = li.theta;
        this.pSmooth = CF.damp(this.pSmooth, Math.min(2, this.lightPower * 2.2), 1.2, 0.05);
      } else {
        this.pSmooth = CF.damp(this.pSmooth, Math.min(2, this.power * 0.6), 1.2, 0.05);
      }
    }
    this.clockLast = performance.now(); this.gov.slow = 0;
    return this.state();
  };
  Campfire.prototype.destroy = function () {
    cancelAnimationFrame(this.raf); clearInterval(this.stateTimer);
    document.removeEventListener('visibilitychange', this.vis);
    window.removeEventListener('pointerdown', this.touched); window.removeEventListener('keydown', this.touched); window.removeEventListener('pagehide', this.leaving);
    if (this.ro) this.ro.disconnect();
    if (this.unbind) this.unbind();
    this.audio.stop();
    if (this.fire) this.fire.dispose();
    if (this.world) this.world.dispose();
    this.renderer.dispose();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  };
})();
