/* Campfire engine, part 7: the people sitting around your fire.
   Up to five others from your circle (Presence.py on the server seats six per fire) sit on log rounds (rocks in the
   desert, the seat log across the fire) around the stone ring, wrapped in wool blankets, lit only by the fire. Each
   one keeps to themselves: breathes, warms their hands, glances at someone, looks up at the sky. What they do
   arrives slowly (with the next heartbeat) and is played here: a wave (to you, to someone, to everyone), a log
   tossed into the fire from where they sit, a stir. A name tag over each person is a button: press it, or tap the
   person, to wave to them.

   var people = new CF.People(engine)      (the engine makes one: engine.people)
   people.set(mySeat, [{seat, name, look}])  who sits where (seats 0..5; yours is where the camera is)
   people.act(seat, 'wave'|'log'|'stir', toSeat, wood, wet)
   people.update(dt, time, camera)  people.setWorld(world)  people.attach(el)  people.hit(clientX, clientY) -> seat
   people.list() -> for tests: [{seat, name, k, x, z, act, fade, shown}] */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE, V = THREE.Vector3;
  var DEG = Math.PI / 180;

  // where each seat is, counted round from yours (k = 0 is you, by the camera at +z). Everyone sees the others across
  // the fire in an arc (angle in degrees, radius in m): the ones beside you would be too close to the camera to read.
  // k = 3 (the second person to arrive) sits on the seat log, to one side of the flames rather than hidden behind them.
  var SEATS = [null, [106, 2.0], [135, 2.2], [168, 2.42], [222, 2.15], [254, 2.0]];
  var FIRE = new V(0, 0.42, 0);

  // looks: wool blankets, jackets, skin, hair (linear colours, lit only by firelight)
  var BLANKETS = [[0.30, 0.05, 0.04], [0.30, 0.19, 0.06], [0.07, 0.15, 0.09], [0.06, 0.09, 0.17], [0.19, 0.17, 0.15],
                  [0.17, 0.08, 0.13], [0.25, 0.11, 0.05], [0.33, 0.29, 0.22]];
  var STRIPES = [[0.02, 0.02, 0.02], [0.4, 0.33, 0.12], [0.36, 0.05, 0.04], [0.5, 0.48, 0.42]];
  var JACKETS = [[0.05, 0.06, 0.09], [0.09, 0.06, 0.04], [0.06, 0.08, 0.05], [0.12, 0.03, 0.03], [0.04, 0.04, 0.045], [0.14, 0.11, 0.07]];
  var SKIN = [[0.52, 0.36, 0.27], [0.44, 0.28, 0.19], [0.33, 0.19, 0.12], [0.22, 0.12, 0.075], [0.13, 0.075, 0.05], [0.56, 0.42, 0.34]];
  var HAIR = [[0.02, 0.015, 0.012], [0.06, 0.035, 0.02], [0.13, 0.08, 0.04], [0.25, 0.2, 0.15], [0.03, 0.03, 0.03]];
  var HATS = { forest: ['beanie', 'hood', 'bare', 'beanie'], snow: ['beanie', 'hood', 'beanie', 'hood'], desert: ['brim', 'bare', 'hood', 'brim'] };

  var BLANKET = [
    'vec2 pp = vec2(vOP.x * .7 + vOP.z * .7, vOP.y) * 10.;',
    'float sa = step(.72, fract(pp.x)), sb = step(.72, fract(pp.y));',
    'float th = step(.94, fract(pp.x * 2. + .37)) + step(.94, fract(pp.y * 2. + .37));',
    'float wool = cfNoise(vOP * 90.) * .5 + .5;',
    'vec3 plaid = col * (1. - .42 * max(sa, sb)) * (1. - .2 * sa * sb) + uStripe * min(th, 1.) * .55;',
    'col = mix(col, plaid, uPlaid) * (.85 + .25 * wool);',
    'h = wool; rough = .95;'
  ].join('\n');

  function limb(a, b, r) {   // a capsule from point a to point b
    var d = b.clone().sub(a), len = d.length();
    var g = new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V(0, 1, 0), d.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return g;
  }
  function tinted(g, c) { return CF.tint(g, c[0], c[1], c[2]); }

  // the blanket's lap: from the waist over the knees, then hanging down towards the boots (h = seat height)
  function lapGeo(h, seed) {
    var curve = new THREE.CatmullRomCurve3([[h + 0.16, -0.04], [h + 0.175, 0.2], [h + 0.16, 0.42], [h + 0.04, 0.535], [h - 0.12, 0.565], [0.2, 0.575]]
      .map(function (p) { return new V(0, p[0], p[1]); }));
    var NU = 10, NV = 22, pos = [], idx = [], P = new V(), rng = CF.fixedRng(seed);
    var ph = rng.range(0, 6);
    for (var j = 0; j <= NV; j++) {
      var s = j / NV; curve.getPointAt(s, P);
      var hang = CF.smooth(0.55, 0.8, s), half = 0.25 + 0.05 * s;
      for (var i = 0; i <= NU; i++) {
        var u = i / NU * 2 - 1, x = u * half;
        var y = P.y - 0.035 * (1 - Math.abs(u)) * (1 - hang) * CF.smooth(0.15, 0.4, s);        // sags between the knees
        var z = P.z + hang * (0.018 * Math.sin(u * 9 + ph) + 0.012 * Math.sin(u * 17 + ph * 2));  // folds where it hangs
        y -= 0.06 * u * u * CF.smooth(0.2, 0.5, s) * (1 - hang * 0.5);                             // the sides fall away
        pos.push(x, y, z);
      }
    }
    for (j = 0; j < NV; j++) for (i = 0; i < NU; i++) { var a = j * (NU + 1) + i; idx.push(a, a + NU + 1, a + 1, a + 1, a + NU + 1, a + NU + 2); }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  }

  var bodyGeo = null;
  function body() {   // a person wrapped in a blanket, sitting: hips at y = 0, facing +z
    if (bodyGeo) return bodyGeo;
    var prof = [[0.001, -0.03], [0.24, -0.03], [0.275, 0.05], [0.26, 0.18], [0.228, 0.32], [0.208, 0.44], [0.188, 0.5],
                [0.135, 0.56], [0.075, 0.6], [0.056, 0.635], [0.001, 0.645]].map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var g = new THREE.LatheGeometry(prof, 28);
    g.scale(1, 1, 0.74); g.translate(0, 0, 0.02);
    // the blanket's folds: a little lumpy, lower hem uneven
    var p = g.attributes.position, v = new V();
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      var a = Math.atan2(v.x, v.z), k = 1 + 0.035 * Math.sin(a * 7 + v.y * 9) + 0.02 * CF.noise3(v.x * 6, v.y * 6, v.z * 6);
      p.setXYZ(i, v.x * k, v.y, v.z * k);
    }
    g.computeVertexNormals();
    bodyGeo = g; return g;
  }

  function Person(people, info, k) {
    this.people = people; this.seat = info.seat; this.name = info.name; this.look = info.look | 0; this.k = k;
    var rng = CF.fixedRng(this.look + 17), place = people.place;
    var W = people.world, ang = SEATS[k][0] * DEG;
    var x = Math.sin(ang) * SEATS[k][1], z = Math.cos(ang) * SEATS[k][1], seatH = 0.38, prop = null;
    if (k === 3) { x = 0.86; z = -2.46; seatH = 0.32; }   // the seat log across the fire (it lies from x -0.6 to 1.2)
    else if (place === 'desert') {
      prop = new THREE.Mesh(CF.rockGeo(0.27, 70 + k, 0.82), CF.rockMat([0.26, 0.13, 0.07], [0, 0, 0], 0, 0));
      prop.position.y = 0.11; seatH = 0.33;
    } else {
      var lg = CF.makeLogGeo(0.37, 0.165, false, 300 + k); lg.rotateZ(Math.PI / 2); lg.translate(0, 0.185, 0);
      prop = new THREE.Mesh(lg, CF.makeLogMat({ bark: place === 'snow' ? [0.6, 0.58, 0.54] : [0.13, 0.09, 0.06], wood: [0.62, 0.48, 0.32], birch: place === 'snow' }, 30 + k));
      prop.rotation.y = rng.range(0, 6.28);
    }
    var gy = W && W.height ? W.height(x, z) : 0;
    var root = this.root = new THREE.Group();
    root.position.set(x, gy, z); root.rotation.y = Math.atan2(-x, -z);
    if (prop) { prop.castShadow = prop.receiveShadow = true; root.add(prop); this.prop = prop; }

    var blanket = BLANKETS[rng.int(0, BLANKETS.length - 1)], jacket = JACKETS[rng.int(0, JACKETS.length - 1)];
    var skin = SKIN[rng.int(0, SKIN.length - 1)], hair = HAIR[rng.int(0, HAIR.length - 1)];
    var trousers = rng.pick([[0.04, 0.045, 0.06], [0.07, 0.06, 0.045], [0.05, 0.05, 0.05], [0.09, 0.07, 0.05]]), boots = [0.05, 0.035, 0.025];
    var hands = place === 'snow' && rng.chance(0.6) ? rng.pick([[0.3, 0.05, 0.04], [0.2, 0.2, 0.19], [0.05, 0.05, 0.07]]) : skin;
    this.mBody = CF.patch(new THREE.MeshStandardMaterial({ color: new THREE.Color().fromArray(blanket), roughness: 0.95, side: THREE.DoubleSide }),
      { key: 'blanket', albedo: BLANKET, bump: 0.0035, uniforms: { uPlaid: { value: rng.chance(0.55) ? 1 : 0 }, uStripe: { value: new THREE.Color().fromArray(rng.pick(STRIPES)) } },
        decl: 'uniform float uPlaid; uniform vec3 uStripe;' });
    this.mPart = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 });
    this.mats = [this.mBody, this.mPart];

    // legs: thighs forward, shins down to the ground, boots
    var h = seatH, legs = [];
    [-1, 1].forEach(function (s) {
      var hip = new V(0.1 * s, h + 0.05, 0.03), knee = new V(0.12 * s, h + 0.055, 0.42), ankle = new V(0.13 * s, 0.1, 0.47);
      legs.push(tinted(limb(hip, knee, 0.062), trousers), tinted(limb(knee, ankle, 0.054), trousers));
      var boot = new THREE.CapsuleGeometry(0.052, 0.13, 4, 8); boot.rotateX(Math.PI / 2); boot.scale(1, 0.85, 1); boot.translate(0.135 * s, 0.05, 0.52);
      legs.push(tinted(boot, boots));
    });
    var legMesh = new THREE.Mesh(CF.merge(legs), this.mPart); legMesh.castShadow = legMesh.receiveShadow = true; root.add(legMesh);
    var lap = new THREE.Mesh(lapGeo(h, this.look), this.mBody); lap.castShadow = lap.receiveShadow = true; root.add(lap);

    // torso (leans towards the fire), head, arms
    var torso = this.torso = new THREE.Group(); torso.position.set(0, h, 0); root.add(torso);
    var bm = new THREE.Mesh(body(), this.mBody); bm.castShadow = bm.receiveShadow = true; torso.add(bm);
    var sc = rng.range(0.94, 1.06); torso.scale.setScalar(sc); this.scale = sc;
    var head = this.head = new THREE.Group(); head.position.set(0, 0.64, 0.035); torso.add(head);
    var hp = [], hs = new THREE.SphereGeometry(0.093, 22, 16); hs.scale(0.94, 1.1, 1.02); hs.translate(0, 0.085, 0); hp.push(tinted(hs, skin));
    var nose = new THREE.SphereGeometry(0.018, 8, 6); nose.scale(0.8, 1, 1.1); nose.translate(0, 0.075, 0.093); hp.push(tinted(nose, skin));
    var hat = this.hat = rng.pick(HATS[place] || HATS.forest), g;
    if (hat === 'beanie') {
      var wool = rng.pick([blanket, [0.32, 0.05, 0.04], [0.28, 0.24, 0.18], [0.06, 0.08, 0.14]]);
      g = new THREE.SphereGeometry(0.104, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.52); g.scale(1, 1.15, 1.04); g.translate(0, 0.098, -0.004); hp.push(tinted(g, wool));
      g = new THREE.TorusGeometry(0.098, 0.017, 6, 22); g.rotateX(Math.PI / 2); g.translate(0, 0.1, -0.004); hp.push(tinted(g, wool));
      if (rng.chance(0.5)) { g = new THREE.SphereGeometry(0.032, 10, 8); g.translate(0, 0.225, -0.01); hp.push(tinted(g, wool)); }
    } else if (hat === 'hood') {
      g = new THREE.SphereGeometry(0.13, 22, 14, 0, Math.PI * 2, 0, Math.PI * 0.6); g.rotateX(-0.62); g.scale(1, 1.08, 1.05); g.translate(0, 0.07, -0.02); hp.push(tinted(g, jacket));
    } else if (hat === 'brim') {
      var felt = rng.pick([[0.16, 0.11, 0.07], [0.07, 0.06, 0.05], [0.24, 0.2, 0.15]]);
      g = new THREE.CylinderGeometry(0.17, 0.17, 0.012, 24); g.translate(0, 0.158, 0); hp.push(tinted(g, felt));
      g = new THREE.CylinderGeometry(0.075, 0.09, 0.1, 18); g.translate(0, 0.21, 0); hp.push(tinted(g, felt));
    } else {
      g = new THREE.SphereGeometry(0.1, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.47); g.rotateX(-0.32); g.translate(0, 0.098, -0.012); hp.push(tinted(g, hair));
      if (rng.chance(0.45)) { g = new THREE.CapsuleGeometry(0.07, 0.1, 4, 10); g.scale(1.1, 1, 0.6); g.translate(0, 0.03, -0.06); hp.push(tinted(g, hair)); }
    }
    var hm = new THREE.Mesh(CF.merge(hp), this.mPart); hm.castShadow = true; head.add(hm);
    var self = this;
    this.arms = [-1, 1].map(function (s) {   // s = -1: the person's right arm (they face +z, so their left is +x)
      var sh = new THREE.Group(); sh.position.set(0.19 * s, 0.5, 0.0); torso.add(sh);
      // the blanket wraps the shoulders and upper arms; a sleeve and a hand come out of it
      var ua = limb(new V(0, 0.0, 0), new V(0, -0.22, 0), 0.072); ua.scale(1, 1, 0.9);
      var up = new THREE.Mesh(ua, self.mBody); sh.add(up);
      var el = new THREE.Group(); el.position.set(0, -0.25, 0); sh.add(el);
      var fg = [tinted(limb(new V(0, 0.02, 0), new V(0, -0.19, 0), 0.044), jacket)];
      var cuff = new THREE.TorusGeometry(0.044, 0.012, 5, 14); cuff.rotateX(Math.PI / 2); cuff.translate(0, -0.2, 0); fg.push(tinted(cuff, jacket));
      var hand = new THREE.SphereGeometry(0.036, 12, 10); hand.scale(0.78, 1.2, 1.1); hand.translate(0, -0.245, 0.006); fg.push(tinted(hand, hands));
      var thumb = new THREE.SphereGeometry(0.014, 6, 5); thumb.scale(1, 1.6, 1); thumb.translate(-0.022 * s, -0.232, 0.02); fg.push(tinted(thumb, hands));
      var lo = new THREE.Mesh(CF.merge(fg), self.mPart); el.add(lo);
      up.castShadow = lo.castShadow = true;
      return { s: s, sh: sh, el: el };
    });
    // motion
    this.pose = { rx: -0.45, rz: 0.08, re: -1.15, lx: -0.45, lz: 0.08, le: -1.15, lean: 0.12, hy: 0, hp: 0.25, ty: 0 };
    this.target = Object.assign({}, this.pose);
    this.idle = { kind: 'rest', until: 0, look: null };
    this.act = null; this.queue = []; this.fade = 0; this.leaving = false; this.phase = rng.range(0, 6.28);
    this.setFade(0);
  }
  Person.prototype.setFade = function (f) {
    this.fade = f;
    var tr = f < 0.999;
    this.mats.forEach(function (m) {
      if (m.transparent !== tr) { m.transparent = tr; m.needsUpdate = true; }
      m.opacity = f; m.depthWrite = f > 0.5;
    });
    if (this.prop) this.prop.visible = true;
  };
  Person.prototype.worldPos = function (out) { return this.root.getWorldPosition(out || new V()); };
  Person.prototype.headPos = function (out) { return this.head.localToWorld((out || new V()).set(0, 0.09, 0)); };
  Person.prototype.handPos = function (out) { return this.arms[0].el.localToWorld((out || new V()).set(0, -0.245, 0)); };
  // where someone else (or you, seat = me) is, so this person can turn to them
  Person.prototype.aim = function (pos) {
    var p = this.root.worldToLocal(pos.clone());
    var hy = Math.atan2(p.x, p.z), d = Math.hypot(p.x, p.z), hp = -Math.atan2(p.y - 1.0, d);
    return { hy: CF.clamp(hy, -1.25, 1.25), hp: CF.clamp(hp, -0.5, 0.5), ty: CF.clamp(hy * 0.32, -0.45, 0.45) };
  };
  // one thing at a time: what arrives while they're busy waits its turn (a log always lands, even if the queue is long)
  Person.prototype.play = function (kind, toPos, extra) {
    var a = { kind: kind, t: 0, dur: kind === 'wave' ? 3.4 : kind === 'log' ? 1.25 : 2.0, to: toPos, extra: extra || {}, fired: false };
    if (!this.act) { this.act = a; return; }
    this.queue.push(a);
    if (this.queue.length > 3) this.effect(this.queue.shift());
  };
  Person.prototype.effect = function (a) {   // what an action does to the fire (once)
    if (a.fired) return; a.fired = true;
    var E = this.people.engine;
    if (a.kind === 'log') E.addLog(a.extra.wood, a.extra.wet, this.handPos());
    else if (a.kind === 'stir') E.stir(true);
  };
  Person.prototype.update = function (dt, time, cam) {
    var P = this.people, R0 = CF.rng, T = this.target, a = this.act;
    // fade in / out
    if (this.leaving) { this.setFade(Math.max(0, this.fade - dt / 2.2)); }
    else if (this.fade < 1) { this.setFade(Math.min(1, this.fade + dt / 2.6)); }
    // idle life: rest, warm hands, glance at someone, look at the sky
    if (!a && time > this.idle.until) {
      var roll = R0.next(), kind = roll < 0.36 ? 'rest' : roll < 0.68 ? 'warm' : roll < 0.9 ? 'look' : 'sky';
      this.idle = { kind: kind, until: time + R0.range(5, 16), look: kind === 'look' ? P.randomLookTarget(this) : null };
    }
    var rest = { rx: -0.45, rz: 0.08, re: -1.15, lx: -0.45, lz: 0.08, le: -1.15, lean: 0.12 };
    var warm = { rx: -1.12, rz: 0.12, re: -0.42, lx: -1.12, lz: 0.12, le: -0.42, lean: 0.2 };
    var base = this.idle.kind === 'warm' ? warm : rest, look = { hy: 0, hp: 0.28, ty: 0 };
    if (this.idle.kind === 'look' && this.idle.look) look = this.aim(this.idle.look);
    if (this.idle.kind === 'sky') look = { hy: 0.3 * Math.sin(this.phase), hp: -0.55, ty: 0 };
    if (this.idle.kind !== 'look' && this.idle.kind !== 'sky') { var f = this.aim(FIRE); look = { hy: f.hy, hp: 0.3, ty: 0 }; }
    Object.assign(T, base, look);
    var rate = 2.2;
    if (a) {
      a.t += dt; var u = a.t / a.dur, aim = a.to ? this.aim(a.to) : { hy: 0, hp: 0.05, ty: 0 };
      if (a.kind === 'wave') {   // right arm up, the hand swings; turned to whoever it's for
        rate = 7;
        var up = u < 0.85;
        T.rx = up ? 0.3 : rest.rx; T.rz = up ? 2.45 : rest.rz;   // rz swings the right arm out and up (-x side) T.re = up ? -0.25 + 0.05 * Math.sin(a.t * 3) : rest.re;
        T.hy = aim.hy; T.hp = aim.hp; T.ty = aim.ty; T.lean = 0.05;
        this.waveSwing = up && u > 0.12 ? Math.sin(a.t * 9.5) * 0.5 : 0;
      } else if (a.kind === 'log') {   // wind back, toss, follow through
        rate = 9;
        T.rx = u < 0.35 ? 0.75 : u < 0.62 ? -1.85 : rest.rx; T.rz = 0.15; T.re = u < 0.35 ? -0.9 : -0.15;
        T.lean = u < 0.35 ? 0.0 : 0.32; var fi = this.aim(FIRE); T.hy = fi.hy; T.hp = 0.35; T.ty = 0;
        if (u > 0.5) this.effect(a);
      } else if (a.kind === 'stir') {   // lean in, both hands low, working the coals
        rate = 5;
        T.rx = T.lx = -0.95 + 0.18 * Math.sin(a.t * 6); T.rz = T.lz = 0.1; T.re = T.le = -0.3; T.lean = 0.36; T.hp = 0.45;
        if (u > 0.3) this.effect(a);
      }
      if (u >= 1) { this.effect(a); this.act = this.queue.shift() || null; this.waveSwing = 0; }
    }
    var p = this.pose, k = 1 - Math.exp(-rate * dt), kh = 1 - Math.exp(-3 * dt);
    ['rx', 'rz', 're', 'lx', 'lz', 'le', 'lean'].forEach(function (n) { p[n] += (T[n] - p[n]) * k; });
    ['hy', 'hp', 'ty'].forEach(function (n) { p[n] += (T[n] - p[n]) * kh; });
    var breath = Math.sin(time * 1.45 + this.phase);
    this.torso.rotation.set(p.lean + breath * 0.008, p.ty, 0);
    this.torso.scale.set(this.scale, this.scale * (1 + breath * 0.007), this.scale);
    this.head.rotation.set(p.hp + Math.sin(time * 0.3 + this.phase) * 0.02, p.hy - p.ty, 0);
    var R = this.arms[0], L = this.arms[1];
    R.sh.rotation.set(p.rx, 0, -p.rz); R.el.rotation.set(p.re, 0, this.waveSwing || 0);
    L.sh.rotation.set(p.lx, 0, p.lz); L.el.rotation.set(p.le, 0, 0);
    // never stand inside someone: the camera walking through a person hides them
    var near = this.worldPos(P.tmp).distanceTo(cam.position) < 0.8;
    this.root.visible = !near && this.fade > 0.01;
  };
  Person.prototype.dispose = function () {
    if (this.act) this.effect(this.act);   // their log still lands
    this.queue.forEach(this.effect, this); this.queue = [];
    if (this.root.parent) this.root.parent.remove(this.root);
    this.root.traverse(function (o) { if (o.geometry && o.geometry !== bodyGeo) o.geometry.dispose(); });
    this.mats.forEach(function (m) { m.dispose(); });
    if (this.prop && this.prop.material) this.prop.material.dispose();
    if (this.tag && this.tag.parentNode) this.tag.parentNode.removeChild(this.tag);
  };

  function People(engine) {
    this.engine = engine; this.me = 0; this.byKey = {}; this.tmp = new V(); this.place = engine.place || 'forest';
    var tags = this.tags = document.createElement('div'); tags.className = 'cf-people';
    if (engine.el) engine.el.appendChild(tags);
  }
  CF.People = People;
  People.prototype.attach = function (el) { if (this.tags.parentNode !== el) el.appendChild(this.tags); };
  People.prototype.setWorld = function (W) {
    this.world = W; this.place = W.place;
    var keep = this.all().map(function (p) { return { seat: p.seat, name: p.name, look: p.look, fade: p.fade }; });
    this.clear();
    keep.forEach(function (i) { var p = this.add(i); p.setFade(i.fade); }, this);
  };
  People.prototype.all = function () { var self = this; return Object.keys(this.byKey).map(function (k) { return self.byKey[k]; }); };
  People.prototype.clear = function () { this.all().forEach(function (p) { p.dispose(); }); this.byKey = {}; };
  People.prototype.add = function (info) {
    var k = ((info.seat - this.me) % 6 + 6) % 6;
    var p = new Person(this, info, k);
    if (this.world) this.world.scene.add(p.root);
    var tag = p.tag = document.createElement('button');
    tag.type = 'button'; tag.className = 'cf-tag'; tag.setAttribute('aria-label', 'Wave to ' + info.name);
    tag.innerHTML = '<span class="cf-tag-name"></span><span class="cf-tag-note" aria-hidden="true"></span>';
    tag.firstChild.textContent = info.name;
    var self = this;
    tag.addEventListener('click', function (e) { e.stopPropagation(); if (self.engine.opts.onEvent) self.engine.opts.onEvent('wave_to', p.seat); });
    this.tags.appendChild(tag);
    this.byKey[info.seat + ':' + info.name] = p;
    return p;
  };
  // who sits where: arrivals fade in, people who left fade away
  People.prototype.set = function (me, list) {
    var self = this;
    if (me !== this.me) { this.me = me; this.clear(); }
    var want = {};
    (list || []).forEach(function (i) {
      if (i.seat === me) return;
      var key = i.seat + ':' + i.name; want[key] = true;
      var p = self.byKey[key];
      if (p && p.leaving) p.leaving = false;
      if (!p) self.add(i);
    });
    Object.keys(this.byKey).forEach(function (key) { if (!want[key]) self.byKey[key].leaving = true; });
  };
  People.prototype.bySeat = function (seat) { return this.all().filter(function (p) { return p.seat === seat && !p.leaving; })[0] || null; };
  People.prototype.seatPos = function (seat) {   // a seat's head position (yours = the camera)
    if (seat === this.me) return this.engine.camera.position.clone();
    var p = this.bySeat(seat); return p ? p.headPos() : null;
  };
  People.prototype.randomLookTarget = function (who) {
    var others = this.all().filter(function (p) { return p !== who && !p.leaving; }).map(function (p) { return p.headPos(); });
    others.push(this.engine.camera.position.clone(), this.engine.camera.position.clone());   // people look at you now and then
    return CF.rng.pick(others);
  };
  People.prototype.act = function (seat, kind, to, wood, wet) {
    var p = this.bySeat(seat);
    if (!p) {   // someone we can't see (just arrived): the log still lands
      if (kind === 'log') this.engine.addLog(wood, wet);
      else if (kind === 'stir') this.engine.stir(true);
      return false;
    }
    var toPos = kind === 'wave' ? (to === null || to === undefined || to < 0 ? this.engine.camera.position.clone().lerp(FIRE, 0.6) : this.seatPos(to)) : null;
    p.play(kind, toPos, { wood: wood, wet: wet });
    if (p.tag) {
      var note = p.tag.lastChild, cls = kind === 'wave' ? (to === this.me ? 'waves to you' : 'waves') : kind === 'log' ? 'adds a log' : 'stirs the fire';
      note.textContent = cls; p.tag.classList.add('is-acting'); p.tag.classList.toggle('is-to-you', kind === 'wave' && to === this.me);
      clearTimeout(p.tagTimer); p.tagTimer = setTimeout(function () { p.tag.classList.remove('is-acting', 'is-to-you'); }, 5200);
    }
    return true;
  };
  People.prototype.update = function (dt, time, cam, draw) {
    var self = this, el = this.engine.el, w = el.clientWidth, h = el.clientHeight, v = this.tmp;
    this.all().forEach(function (p) {
      p.update(dt, time, cam);
      if (p.leaving && p.fade <= 0) { p.dispose(); delete self.byKey[p.seat + ':' + p.name]; return; }
      if (!draw || !p.tag) return;
      p.headPos(v); v.y += 0.3; v.project(cam);
      var show = p.root.visible && v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 && !p.leaving;
      p.tag.classList.toggle('is-hidden', !show);
      if (show) p.tag.style.transform = 'translate(' + Math.round((v.x * 0.5 + 0.5) * w) + 'px,' + Math.round((0.5 - v.y * 0.5) * h) + 'px) translate(-50%, -100%)';
    });
  };
  // a tap on a person (not on a tag): which seat, or -1
  People.prototype.hit = function (cx, cy) {
    var rect = this.engine.canvas.getBoundingClientRect(), cam = this.engine.camera, best = -1, bestD = 1e9, a = new V(), b = new V();
    this.all().forEach(function (p) {
      if (!p.root.visible || p.leaving) return;
      p.headPos(a).project(cam); p.worldPos(b).project(cam);
      if (a.z > 1) return;
      var ax = (a.x * 0.5 + 0.5) * rect.width + rect.left, ay = (0.5 - a.y * 0.5) * rect.height + rect.top - 12;
      var by = (0.5 - b.y * 0.5) * rect.height + rect.top, half = Math.max(16, (by - ay) * 0.36);
      if (cy >= ay - 10 && cy <= by && Math.abs(cx - ax) <= half) {
        var d = Math.abs(cx - ax); if (d < bestD) { bestD = d; best = p.seat; }
      }
    });
    return best;
  };
  People.prototype.count = function () { return this.all().filter(function (p) { return !p.leaving; }).length; };
  People.prototype.list = function () {
    return this.all().map(function (p) {
      var w = p.worldPos();
      return { seat: p.seat, name: p.name, k: p.k, x: Math.round(w.x * 100) / 100, z: Math.round(w.z * 100) / 100, hat: p.hat,
               act: p.act ? p.act.kind : null, fade: Math.round(p.fade * 100) / 100, shown: p.root.visible, leaving: p.leaving };
    });
  };
})();
