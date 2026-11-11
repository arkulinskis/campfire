/* Campfire engine, part 3: sparks, smoke, motes and the camera's eye.
   - CF.Sparks: glowing embers carried by the plume, drawn as motion-blurred streaks whose brightness is spread
     over their length (energy-conserving), coloured by their own cooling temperature (blackbody), bouncing and
     dying on the ground.
   - CF.Smoke: soft puffs that rise above the flames, lit from below by the fire and fading into the night.
   - CF.Puffs: small puffs with a will of their own (your breath in the cold, steam from the coffee pot).
   - CF.Mist: low sheets of fog that drift on the wind and catch the firelight.
   - CF.Motes: fireflies and moths (forest), snow that comes and goes (lakeshore), dust in the firelight (desert).
   - CF.Post: HDR pipeline. Opaque scene (multisampled where the device can) -> depth copy -> transparent fire -> heat haze -> physically based
     bloom (13-tap downsample / tent upsample, Jimenez 2014) -> exposure with eye adaptation -> AgX tone curve
     -> vignette + film grain (also dithers the dark gradients of a night scene). */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE;

  // ------------------------------------------------------------------ sparks
  var SPARK_VS = [
    'in vec2 corner; in vec3 iA; in vec3 iB; in vec2 iH;',
    'uniform vec2 uRes; uniform float uFocal;',
    'out float vHeat; out float vK; out vec2 vC; out float vLen; out float vW;',
    'void main(){',
    '  vec4 a = projectionMatrix * viewMatrix * vec4(iA, 1.), b = projectionMatrix * viewMatrix * vec4(iB, 1.);',
    '  if (a.w < .05 || b.w < .05 || iH.x <= 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }',
    '  vec2 hr = uRes * .5; vec2 sa = a.xy / a.w * hr, sb = b.xy / b.w * hr; vec2 d = sa - sb; float len = length(d);',
    '  vec2 dir = len > .001 ? d / len : vec2(1., 0.); vec2 n = vec2(-dir.y, dir.x);',
    '  float px = iH.y * uFocal / a.w; float w = max(px, .9);',
    '  vK = clamp(px / w, .15, 1.) * (2. * w) / (len + 2. * w);',
    '  vec2 p = mix(sb - dir * w, sa + dir * w, corner.x) + n * w * corner.y;',
    '  vec4 c = mix(b, a, corner.x); c.xy = p / hr * c.w; gl_Position = c;',
    '  vHeat = iH.x; vC = vec2(corner.x * (len + 2. * w) - w, corner.y * w); vLen = len; vW = w; }'
  ].join('\n');
  var SPARK_FS = [
    'precision highp float;',
    'in float vHeat; in float vK; in vec2 vC; in float vLen; in float vW; out vec4 outColor; uniform float uGain;',
    CF.GLSL_BB,
    'void main(){ float x = clamp(vC.x, 0., vLen); vec2 q = vec2(vC.x - x, vC.y) / vW; float f = exp(-dot(q, q) * 2.2);',
    '  vec3 c = cfBlackbody(vHeat) * uGain * vK * f; outColor = vec4(c, 1.); }'
  ].join('\n');

  function Sparks(max, bbTex) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.prev = new Float32Array(max * 3);
    this.heat = new Float32Array(max); this.cool = new Float32Array(max); this.size = new Float32Array(max);
    this.life = new Float32Array(max); this.flick = new Float32Array(max);
    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); this.aA.setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); this.aB.setUsage(THREE.DynamicDrawUsage);
    this.aH = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2); this.aH.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.aA); g.setAttribute('iB', this.aB); g.setAttribute('iH', this.aH);
    g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SPARK_VS, fragmentShader: SPARK_FS,
      uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uFocal: { value: 800 }, uGain: { value: 1 }, tBlackbody: { value: bbTex } },
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 30;
    this.geo = g; this.tmp = new THREE.Vector3();
  }
  // a burst at (x,y,z): count, speed (m/s), spread (0 = straight up, 1 = hemisphere)
  Sparks.prototype.emit = function (x, y, z, count, speed, spread, hot) {
    var R = CF.rng;
    for (var k = 0; k < count; k++) {
      if (this.n >= this.max) return;
      var i = this.n++, a = R.range(0, 6.2832), u = Math.pow(R.next(), 0.7) * (spread || 0.4);
      var s = speed * R.range(0.35, 1.15);
      this.p[i * 3] = x + R.gauss() * 0.03; this.p[i * 3 + 1] = y + R.range(0, 0.04); this.p[i * 3 + 2] = z + R.gauss() * 0.03;
      this.v[i * 3] = Math.cos(a) * u * s; this.v[i * 3 + 1] = Math.sqrt(Math.max(0, 1 - u * u)) * s; this.v[i * 3 + 2] = Math.sin(a) * u * s;
      for (var c = 0; c < 3; c++) this.prev[i * 3 + c] = this.p[i * 3 + c];
      this.heat[i] = (hot || 1.0) * R.range(0.82, 1.1);
      this.cool[i] = R.logUniform(0.45, 2.2);              // some die at once, a few rise for many seconds
      this.size[i] = R.logUniform(0.0012, 0.0045);
      this.life[i] = 0; this.flick[i] = R.chance(0.3) ? R.range(8, 22) : 0;
    }
  };
  // plume(x, y, z) -> upward air speed; wind = {x, z}
  Sparks.prototype.update = function (dt, time, plume, wind) {
    var R = CF.rng, c = this.tmp, i = 0;
    while (i < this.n) {
      var o = i * 3, x = this.p[o], y = this.p[o + 1], z = this.p[o + 2];
      this.prev[o] = x; this.prev[o + 1] = y; this.prev[o + 2] = z;
      var up = plume(x, y, z);
      CF.curl3(x * 1.7, y * 1.7 - time * 0.9, z * 1.7 + time * 0.2, c);
      var turb = 0.35 + y * 0.25;
      var ax = (wind.x * (0.3 + y * 0.4) + c.x * turb - this.v[o]) * 2.2;
      var ay = (up + c.y * turb * 0.6 - this.v[o + 1]) * 2.2 - 0.5;
      var az = (wind.z * (0.3 + y * 0.4) + c.z * turb - this.v[o + 2]) * 2.2;
      this.v[o] += ax * dt; this.v[o + 1] += ay * dt; this.v[o + 2] += az * dt;
      x += this.v[o] * dt; y += this.v[o + 1] * dt; z += this.v[o + 2] * dt;
      if (y < 0.005 && this.v[o + 1] < 0) {                // land: bounce once or twice and glow out on the ground
        y = 0.005; this.v[o + 1] *= -0.3; this.v[o] *= 0.4; this.v[o + 2] *= 0.4; this.cool[i] *= 1.8;
      }
      this.p[o] = x; this.p[o + 1] = y; this.p[o + 2] = z;
      this.life[i] += dt;
      this.heat[i] -= dt * this.cool[i] * (0.15 + this.heat[i] * this.heat[i] * 0.5);
      if (this.heat[i] < 0.42 || y > 9 || this.life[i] > 14) {   // gone: move the last one into this place
        var j = --this.n;
        if (j !== i) {
          for (var k = 0; k < 3; k++) { this.p[o + k] = this.p[j * 3 + k]; this.v[o + k] = this.v[j * 3 + k]; this.prev[o + k] = this.prev[j * 3 + k]; }
          this.heat[i] = this.heat[j]; this.cool[i] = this.cool[j]; this.size[i] = this.size[j]; this.life[i] = this.life[j]; this.flick[i] = this.flick[j];
        }
        continue;
      }
      i++;
    }
  };
  Sparks.prototype.upload = function (shutter, time) {
    var A = this.aA.array, B = this.aB.array, H = this.aH.array;
    for (var i = 0; i < this.n; i++) {
      var o = i * 3;
      for (var k = 0; k < 3; k++) { A[o + k] = this.p[o + k]; B[o + k] = this.p[o + k] - this.v[o + k] * shutter; }
      var h = this.heat[i];
      if (this.flick[i]) h *= 0.93 + 0.07 * Math.sin(time * this.flick[i] + i);
      H[i * 2] = h; H[i * 2 + 1] = this.size[i];
    }
    this.geo.instanceCount = this.n;
    this.aA.needsUpdate = this.aB.needsUpdate = this.aH.needsUpdate = true;
    this.aA.updateRange.count = this.aB.updateRange.count = this.n * 3; this.aH.updateRange.count = this.n * 2;
  };
  CF.Sparks = Sparks;

  // ------------------------------------------------------------------ smoke puffs
  var SMOKE_VS = [
    'in vec2 corner; in vec4 iP; in vec4 iS;',
    'out vec2 vUv; out float vA; out float vLit;',
    'void main(){ vec4 mv = viewMatrix * vec4(iP.xyz, 1.); float c = cos(iS.y), s = sin(iS.y);',
    '  vec2 q = corner * iS.x; mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);',
    '  gl_Position = projectionMatrix * mv; vUv = corner * .5 + .5; vA = iS.z; vLit = iS.w; }'
  ].join('\n');
  var SMOKE_FS = [
    'precision highp float; in vec2 vUv; in float vA; in float vLit; out vec4 outColor;',
    'uniform sampler2D tPuff; uniform vec3 uLit, uAmb;',
    'void main(){ float a = texture(tPuff, vUv).a * vA; vec3 c = uAmb + uLit * vLit; outColor = vec4(c * a, a); }'
  ].join('\n');
  function Smoke(max) {
    this.max = max; this.items = [];
    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); this.aP.setUsage(THREE.DynamicDrawUsage);
    this.aS = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); this.aS.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.aP); g.setAttribute('iS', this.aS); g.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SMOKE_VS, fragmentShader: SMOKE_FS,
      uniforms: { tPuff: { value: CF.puffTexture(5) }, uLit: { value: new THREE.Color(0.022, 0.013, 0.008) }, uAmb: { value: new THREE.Color(0.004, 0.0045, 0.006) } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 5;
    this.geo = g; this.acc = 0; this.c = new THREE.Vector3();
  }
  Smoke.prototype.update = function (dt, time, rate, density, wind, top) {
    var R = CF.rng;
    this.acc += dt * rate;
    while (this.acc > 1 && this.items.length < this.max) {
      this.acc -= 1;
      this.items.push({ x: R.gauss() * 0.08, y: top + R.range(-0.15, 0.1), z: R.gauss() * 0.08, vy: R.range(0.45, 0.8),
                        size: R.range(0.18, 0.3), rot: R.range(0, 6.28), spin: R.gauss() * 0.15, age: 0, life: R.range(7, 12), dens: density * R.range(0.6, 1.2) });
    }
    if (this.acc > 1) this.acc = 1;
    var c = this.c;
    for (var i = this.items.length - 1; i >= 0; i--) {
      var s = this.items[i];
      s.age += dt;
      if (s.age > s.life) { this.items.splice(i, 1); continue; }
      CF.curl3(s.x * 0.6, s.y * 0.6 - time * 0.15, s.z * 0.6, c);
      s.x += (wind.x * (0.4 + s.y * 0.2) + c.x * 0.25) * dt; s.z += (wind.z * (0.4 + s.y * 0.2) + c.z * 0.25) * dt;
      s.y += s.vy * dt; s.vy *= Math.exp(-0.06 * dt);
      s.size += dt * 0.16; s.rot += s.spin * dt;
    }
  };
  Smoke.prototype.upload = function (fireTop) {
    var P = this.aP.array, S = this.aS.array, n = this.items.length;
    for (var i = 0; i < n; i++) {
      var s = this.items[i], t = s.age / s.life;
      var a = CF.smooth(0, 0.18, t) * (1 - CF.smooth(0.45, 1, t)) * s.dens;
      P[i * 4] = s.x; P[i * 4 + 1] = s.y; P[i * 4 + 2] = s.z;
      S[i * 4] = s.size; S[i * 4 + 1] = s.rot; S[i * 4 + 2] = a; S[i * 4 + 3] = Math.exp(-Math.max(0, s.y - fireTop) * 1.1);
    }
    this.geo.instanceCount = n;
    this.aP.needsUpdate = this.aS.needsUpdate = true;
  };
  CF.Smoke = Smoke;

  // ------------------------------------------------------------------ small puffs: your breath in the cold, steam from the pot
  // The same soft sprites as the smoke, but each puff is told where it starts and how it moves.
  function Puffs(max) {
    Smoke.call(this, max);
    this.mesh.renderOrder = 6;
  }
  Puffs.prototype.emit = function (x, y, z, vx, vy, vz, size, grow, life, dens, lit) {
    if (this.items.length >= this.max) return;
    this.items.push({ x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, size: size, grow: grow, rot: CF.rng.range(0, 6.28), spin: CF.rng.gauss() * 0.3, age: 0, life: life, dens: dens, lit: lit });
  };
  Puffs.prototype.update = function (dt, wind) {
    for (var i = this.items.length - 1; i >= 0; i--) {
      var s = this.items[i];
      s.age += dt;
      if (s.age > s.life) { this.items.splice(i, 1); continue; }
      var drag = Math.exp(-1.6 * dt);
      s.vx = s.vx * drag + wind.x * 0.25 * dt; s.vz = s.vz * drag + wind.z * 0.25 * dt; s.vy = s.vy * drag + 0.12 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.size += s.grow * dt; s.rot += s.spin * dt;
    }
  };
  Puffs.prototype.upload = function () {
    var P = this.aP.array, S = this.aS.array, n = this.items.length;
    for (var i = 0; i < n; i++) {
      var s = this.items[i], t = s.age / s.life;
      P[i * 4] = s.x; P[i * 4 + 1] = s.y; P[i * 4 + 2] = s.z;
      S[i * 4] = s.size; S[i * 4 + 1] = s.rot; S[i * 4 + 2] = CF.smooth(0, 0.15, t) * (1 - CF.smooth(0.3, 1, t)) * s.dens; S[i * 4 + 3] = s.lit;
    }
    this.geo.instanceCount = n;
    this.aP.needsUpdate = this.aS.needsUpdate = true;
  };
  CF.Puffs = Puffs;

  // ------------------------------------------------------------------ mist: low sheets of fog that drift and catch the firelight
  var MIST_VS = [
    'in vec2 corner; in vec4 iP; in vec4 iS;',
    'out vec2 vUv; out float vA; out float vLit; out float vViewZ;',
    'void main(){ vec4 mv = viewMatrix * vec4(iP.xyz, 1.); float c = cos(iS.x), s = sin(iS.x);',
    '  vec2 q = corner * vec2(iP.w, iP.w * .34); mv.xy += q;',
    '  vViewZ = -mv.z; gl_Position = projectionMatrix * mv;',
    '  vec2 r = corner * .5; vUv = vec2(c * r.x - s * r.y, s * r.x + c * r.y) + .5; vA = iS.y; vLit = iS.z; }'
  ].join('\n');
  var MIST_FS = [
    'precision highp float; in vec2 vUv; in float vA; in float vLit; in float vViewZ; out vec4 outColor;',
    'uniform sampler2D tPuff, tDepth; uniform vec3 uLit, uAmb; uniform vec2 uRes; uniform float uNear, uFar;',
    'float lin(float d){ float z = d * 2. - 1.; return 2. * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }',
    'void main(){ float a = texture(tPuff, clamp(vUv, 0., 1.)).a * vA;',
    '  float sceneZ = lin(texture(tDepth, gl_FragCoord.xy / uRes).r);',
    '  a *= clamp((sceneZ - vViewZ) / 1.2, 0., 1.) * smoothstep(1.2, 3.5, vViewZ);',   // no hard line where a sheet meets the ground, none when you walk through one
    '  vec3 c = uAmb + uLit * vLit; outColor = vec4(c * a, a); }'
  ].join('\n');
  // cfg: a place's `mist` ({n, r0, r1 | lake, y0, y1, size0, size1, color, dens, fire}); scale = how many of them (quality)
  function Mist(cfg, scale) {
    var n = Math.max(1, Math.round(cfg.n * scale)), R = CF.rng;
    this.cfg = cfg; this.n = n; this.items = [];
    for (var i = 0; i < n; i++) {
      var it = { size: R.range(cfg.size0, cfg.size1), y: R.range(cfg.y0, cfg.y1), rot: R.range(0, 6.28), ph: R.range(0, 6.28), k: R.range(0.6, 1.2), drift: R.range(0.03, 0.09) };
      if (cfg.lake) { it.x = R.range(-48, 48); it.z = R.range(-42, -10); } else { var a = R.range(0, 6.28), r = R.range(cfg.r0, cfg.r1); it.x = Math.cos(a) * r; it.z = Math.sin(a) * r; }
      this.items.push(it);
    }
    var g = new THREE.InstancedBufferGeometry();
    g.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); this.aP.setUsage(THREE.DynamicDrawUsage);
    this.aS = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); this.aS.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iP', this.aP); g.setAttribute('iS', this.aS); g.instanceCount = n;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: MIST_VS, fragmentShader: MIST_FS,
      uniforms: { tPuff: { value: CF.puffTexture(9) }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.05 }, uFar: { value: 900 },
                  uLit: { value: new THREE.Color(0, 0, 0) }, uAmb: { value: new THREE.Color().fromArray(cfg.color) } },
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor
    });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    this.geo = g;
  }
  // wind = {x, z}; fire = the fire's light (the scene lamp's intensity / 4 pi: fog scatters every way); thick = 0..1.3
  Mist.prototype.update = function (dt, time, wind, fire, thick) {
    var P = this.aP.array, S = this.aS.array, c = this.cfg, R = CF.rng;
    for (var i = 0; i < this.n; i++) {
      var s = this.items[i];
      s.x += (wind.x * 0.22 + Math.cos(s.ph) * s.drift) * dt; s.z += (wind.z * 0.22 + Math.sin(s.ph) * s.drift) * dt;
      if (c.lake) {
        if (s.x > 50) s.x = -50; else if (s.x < -50) s.x = 50;
        if (s.z > -9) s.z = -42; else if (s.z < -43) s.z = -10;
      } else {
        var r = Math.hypot(s.x, s.z);
        if (r > c.r1 || r < c.r0 * 0.8) {       // drifted off, or in over the fire: it comes back in on the wind
          var a = Math.atan2(-wind.z, -wind.x) + R.range(-1.4, 1.4), rr = c.r1 * R.range(0.75, 0.97);
          if (r < c.r0 * 0.8) { a = Math.atan2(s.z, s.x) + Math.PI + R.range(-0.5, 0.5); rr = c.r1 * 0.8; }
          s.x = Math.cos(a) * rr; s.z = Math.sin(a) * rr; s.born = time;
        }
      }
      var d2 = s.x * s.x + s.z * s.z, fadeIn = s.born === undefined ? 1 : CF.smooth(0, 12, time - s.born);
      var edge = c.lake ? 1 : CF.smooth(c.r0 * 0.8, c.r0 * 1.25, Math.sqrt(d2)) * (1 - CF.smooth(c.r1 * 0.85, c.r1, Math.sqrt(d2)));
      P[i * 4] = s.x; P[i * 4 + 1] = s.y; P[i * 4 + 2] = s.z; P[i * 4 + 3] = s.size;
      S[i * 4] = s.rot; S[i * 4 + 1] = c.dens * s.k * thick * fadeIn * edge * (0.7 + 0.3 * Math.sin(time * 0.07 + s.ph));
      S[i * 4 + 2] = fire * c.fire / Math.pow(Math.max(d2, 1), 0.8);   // lit like everything else: 1 / distance^1.6
    }
    this.aP.needsUpdate = this.aS.needsUpdate = true;
  };
  Mist.prototype.prepare = function (depthTex, w, h, camera, r, g, b) {
    var u = this.mat.uniforms; u.tDepth.value = depthTex; u.uRes.value.set(w, h); u.uNear.value = camera.near; u.uFar.value = camera.far; u.uLit.value.setRGB(r, g, b);
  };
  Mist.prototype.dispose = function () { this.geo.dispose(); this.mat.dispose(); };
  CF.Mist = Mist;

  // ------------------------------------------------------------------ motes: fireflies, snow, dust, moths
  var MOTE_VS = [
    'in vec4 iM; uniform float uScale, uTime; uniform int uKind; out float vB;',
    'void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.); gl_Position = projectionMatrix * mv;',
    '  if (uKind == 0) { float ph = fract(uTime * iM.y + iM.x); vB = smoothstep(0., .08, ph) * (1. - smoothstep(.12, .35, ph)); gl_PointSize = max(2.2, uScale * .03 / -mv.z); }',
    '  else if (uKind == 2) { vB = iM.z; gl_PointSize = clamp(uScale * .017 * iM.w / -mv.z, 1.5, 9.); }',
    '  else { vB = iM.z; gl_PointSize = clamp(uScale * .011 * iM.w / -mv.z, 1., 6.); }',
    '}'
  ].join('\n');
  var MOTE_FS = [
    'precision highp float; precision highp int; in float vB; out vec4 outColor; uniform vec3 uColor; uniform int uKind; uniform vec3 uFire; uniform float uFireK;',
    'void main(){ vec2 q = gl_PointCoord * 2. - 1.; float r = dot(q, q); if (r > 1.) discard;',
    '  if (uKind == 0) { float f = exp(-r * 4.); outColor = vec4(uColor * vB * f, 1.); }',
    '  else if (uKind == 2) { float f = smoothstep(1., .3, r) * min(1., vB * 6.); outColor = vec4(uColor * uFire * vB * f, f); }',   // a moth: a pale thing that only shows in the firelight
    '  else { float f = (1. - r) * (1. - r); vec3 c = uColor + uFire * vB * uFireK; outColor = vec4(c * f * .8, f * .8); } }'
  ].join('\n');
  // kind: 'fireflies' | 'snow' | 'dust' | 'moths'; area = how far out they live (m)
  function Motes(kind, count, area) {
    this.kind = kind; this.count = count; this.area = area; this.top = kind === 'dust' ? 2.8 : 9;
    var R = CF.rng, pos = new Float32Array(count * 3), m = new Float32Array(count * 4);
    this.vel = new Float32Array(count * 3); this.base = new Float32Array(count * 3); this.moth = [];
    for (var i = 0; i < count; i++) {
      var a = R.range(0, 6.283), d = kind === 'fireflies' ? R.range(6, area) : R.range(0.5, area);
      this.base[i * 3] = pos[i * 3] = Math.cos(a) * d;
      this.base[i * 3 + 1] = pos[i * 3 + 1] = kind === 'fireflies' ? R.range(0.3, 3.5) : R.range(0, this.top);
      this.base[i * 3 + 2] = pos[i * 3 + 2] = Math.sin(a) * d;
      m[i * 4] = R.next(); m[i * 4 + 1] = R.range(0.12, 0.28); m[i * 4 + 2] = 0; m[i * 4 + 3] = R.range(0.6, 1.3);
      // a moth circles the light for a while, wanders off into the dark, and comes back
      this.moth.push({ a: a, w: R.range(1.1, 2.4) * (R.chance(0.5) ? 1 : -1), ph: R.range(0, 6.28), here: 0, want: 0, until: R.range(5, 70) });
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setAttribute('iM', new THREE.BufferAttribute(m, 4));
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: MOTE_VS, fragmentShader: MOTE_FS,
      uniforms: { uScale: { value: 600 }, uTime: { value: 0 }, uKind: { value: kind === 'fireflies' ? 0 : kind === 'moths' ? 2 : 1 },
                  uColor: { value: kind === 'fireflies' ? new THREE.Color(0.55, 0.9, 0.15) : kind === 'snow' ? new THREE.Color(0.022, 0.026, 0.034) : kind === 'moths' ? new THREE.Color(0.7, 0.64, 0.52) : new THREE.Color(0.012, 0.01, 0.008) },
                  uFire: { value: new THREE.Color(1.0, 0.45, 0.15) }, uFireK: { value: kind === 'dust' ? 0.5 : 0.3 } },
      transparent: true, depthWrite: false,
      blending: kind === 'fireflies' ? THREE.AdditiveBlending : THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor
    });
    this.points = new THREE.Points(this.geo, this.mat); this.points.frustumCulled = false; this.points.renderOrder = 4;
    this.on = true;
  }
  // how many of them are in the air (0..1): snow comes and goes
  Motes.prototype.setAmount = function (a) { this.geo.setDrawRange(0, Math.round(this.count * CF.clamp(a, 0, 1))); };
  Motes.prototype.update = function (dt, time, wind, fireLight) {
    var p = this.geo.attributes.position.array, m = this.geo.attributes.iM.array, R = CF.rng, n = this.count, i, o;
    this.mat.uniforms.uTime.value = time;
    if (this.kind === 'fireflies') {
      for (i = 0; i < n; i++) {
        o = i * 3; var t = time * 0.15 + i * 3.1;
        p[o] = this.base[o] + Math.sin(t * 1.3) * 0.8 + CF.noise3(t * 0.3, i, 0) * 1.2;
        p[o + 1] = this.base[o + 1] + Math.sin(t * 0.9 + i) * 0.3;
        p[o + 2] = this.base[o + 2] + Math.cos(t * 1.1) * 0.8;
      }
    } else if (this.kind === 'moths') {
      var lure = Math.min(1, fireLight * 2.5);
      for (i = 0; i < n; i++) {
        o = i * 3; var s = this.moth[i];
        if (time > s.until) { s.want = s.want ? 0 : 1; s.until = time + (s.want ? R.range(25, 80) : R.range(30, 140)); }
        s.here = CF.damp(s.here, s.want * lure, 0.35, dt);
        s.a += (s.w + CF.noise3(time * 0.7, i * 7.1, 2) * 2.2) * dt;
        var rad = 0.7 + 0.5 * (0.5 + 0.5 * Math.sin(time * 0.37 + s.ph)) + (1 - s.here) * 7;
        var y = 0.85 + 0.4 * Math.sin(time * 0.9 + s.ph) + CF.noise3(time * 2.3, i * 3.3, 5) * 0.2 + (1 - s.here) * 1.5;
        p[o] = Math.cos(s.a) * rad + CF.noise3(time * 3.1, i, 9) * 0.1; p[o + 1] = y; p[o + 2] = Math.sin(s.a) * rad + CF.noise3(i, time * 3.1, 4) * 0.1;
        var d = Math.max(0.35, Math.hypot(rad, y - 0.4));
        m[i * 4 + 2] = s.here * 6 * fireLight / Math.pow(d, 1.6) * (0.5 + 0.5 * Math.abs(Math.sin(time * 33 + i * 2.1)));
      }
      this.geo.attributes.iM.needsUpdate = true;
    } else {
      var fall = this.kind === 'snow' ? 0.55 : 0.04, drawn = Math.min(n, this.geo.drawRange.count === Infinity ? n : this.geo.drawRange.count);
      for (i = 0; i < drawn; i++) {
        o = i * 3;
        p[o] += (wind.x * 0.6 + CF.noise3(p[o + 1] * 0.5, i * 0.1, time * 0.2) * 0.35) * dt;
        p[o + 2] += (wind.z * 0.6 + CF.noise3(i * 0.1, p[o] * 0.5, time * 0.2) * 0.35) * dt;
        p[o + 1] -= fall * m[i * 4 + 3] * dt;
        var d2 = p[o] * p[o] + p[o + 2] * p[o + 2];
        if (this.kind === 'snow' && d2 < 1.2 && p[o + 1] < 2.2) p[o + 1] -= dt * 1.5; // melt over the fire
        if (this.kind === 'dust' && d2 < 0.5) p[o + 1] += dt * (0.5 + fireLight);    // dust is lifted by the fire's own draught
        if (p[o + 1] < 0 || p[o + 1] > this.top + 1 || d2 > this.area * this.area) {
          var a = R.range(0, 6.283), dd = Math.sqrt(R.next()) * this.area;
          p[o] = Math.cos(a) * dd; p[o + 2] = Math.sin(a) * dd; p[o + 1] = this.kind === 'snow' ? R.range(6, 9) : R.range(0.05, this.top);
        }
        var dist = Math.sqrt(d2 + Math.pow(p[o + 1] - 0.5, 2));
        m[i * 4 + 2] = fireLight / (1 + dist * dist * (this.kind === 'dust' ? 3 : 0.6));   // dust only shows close to the flames
      }
      this.geo.attributes.iM.needsUpdate = true;
    }
    this.geo.attributes.position.needsUpdate = true;
  };
  CF.Motes = Motes;

  // ------------------------------------------------------------------ post
  var DOWN_FS = [
    'precision highp float; in vec2 vUv; out vec4 outColor; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst;',
    'vec3 S(vec2 o){ return texture(tSrc, vUv + o * uTexel).rgb; }',
    'float w(vec3 c){ return 1. / (1. + dot(c, vec3(.2126, .7152, .0722)) * .25); }',
    'void main(){',
    '  vec3 a = S(vec2(-2, 2)), b = S(vec2(0, 2)), c = S(vec2(2, 2)), d = S(vec2(-2, 0)), e = S(vec2(0)), f = S(vec2(2, 0));',
    '  vec3 g = S(vec2(-2, -2)), h = S(vec2(0, -2)), i = S(vec2(2, -2)), j = S(vec2(-1, 1)), k = S(vec2(1, 1)), l = S(vec2(-1, -1)), m = S(vec2(1, -1));',
    '  vec3 r;',
    '  if (uFirst > .5) {',      // Karis average on the first level: no fireflies from single hot pixels
    '    vec3 g0 = (a + b + d + e) * .25, g1 = (b + c + e + f) * .25, g2 = (d + e + g + h) * .25, g3 = (e + f + h + i) * .25, g4 = (j + k + l + m) * .25;',
    '    float w0 = w(g0), w1 = w(g1), w2 = w(g2), w3 = w(g3), w4 = w(g4);',
    '    r = (g0 * w0 * .125 + g1 * w1 * .125 + g2 * w2 * .125 + g3 * w3 * .125 + g4 * w4 * .5) / (w0 * .125 + w1 * .125 + w2 * .125 + w3 * .125 + w4 * .5);',
    '  } else {',
    '    r = e * .125 + (a + c + g + i) * .03125 + (b + d + f + h) * .0625 + (j + k + l + m) * .125; }',
    '  outColor = vec4(max(r, vec3(0.)), 1.); }'
  ].join('\n');
  var UP_FS = [
    'precision highp float; in vec2 vUv; out vec4 outColor; uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uRadius;',
    'void main(){ vec2 t = uTexel * uRadius; vec3 s = texture(tSrc, vUv).rgb * 4.;',
    '  s += (texture(tSrc, vUv + vec2(-t.x, 0)).rgb + texture(tSrc, vUv + vec2(t.x, 0)).rgb + texture(tSrc, vUv + vec2(0, t.y)).rgb + texture(tSrc, vUv + vec2(0, -t.y)).rgb) * 2.;',
    '  s += texture(tSrc, vUv + t).rgb + texture(tSrc, vUv - t).rgb + texture(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture(tSrc, vUv + vec2(-t.x, t.y)).rgb;',
    '  outColor = vec4(s / 16., 1.); }'
  ].join('\n');
  var DEPTHCOPY_FS = [
    'precision highp float; in vec2 vUv; out vec4 outColor; uniform sampler2D tColor, tDepth;',
    'void main(){ outColor = texture(tColor, vUv); gl_FragDepth = texture(tDepth, vUv).r; }'
  ].join('\n');
  var FINAL_FS = [
    'precision highp float; in vec2 vUv; out vec4 outColor;',
    'uniform sampler2D tScene, tBloom; uniform vec3 uWB; uniform float uExposure, uBloom, uTime, uGrain, uVignette, uHazeK, uLook, uFade;',
    'uniform vec4 uHaze; uniform vec2 uRes;',
    CF.GLSL,
    'vec3 agxContrast(vec3 x){ vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + .4298 * x2 + .1191 * x - .00232; }',
    'vec3 agx(vec3 v){',
    '  mat3 m = mat3(.842479062253094, .0423282422610123, .0423756549057051, .0784335999999992, .878468636469772, .0784336, .0792237451477643, .0791661274605434, .879142973793104);',
    '  mat3 mi = mat3(1.19687900512017, -.0528968517574562, -.0529716355144438, -.0980208811401368, 1.15190312990417, -.0980434501171241, -.0990297440797205, -.0989611768448433, 1.15107367264116);',
    '  v = m * v; v = clamp(log2(max(v, vec3(1e-10))), -12.47393, 4.026069); v = (v + 12.47393) / 16.50000; v = agxContrast(v);',
    // look: a touch of "punchy" (more saturation, deeper blacks), like warm film
    '  float l = dot(v, vec3(.2126, .7152, .0722)); v = l + (v - l) * (1. + .35 * uLook); v = pow(max(v, 0.), vec3(1. + .12 * uLook));',
    '  return pow(max(mi * v, 0.), vec3(2.2)); }',
    'vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }',
    'vec3 srgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }',
    'void main(){',
    '  vec2 uv = vUv; vec2 asp = vec2(uRes.x / uRes.y, 1.);',
    '  vec2 dh = (uv - uHaze.xy) * asp / uHaze.zw; float hm = exp(-dot(dh, dh)) * uHazeK;',
    '  if (hm > .001) { vec3 q = vec3(uv * asp * vec2(55., 34.) - vec2(0., uTime * 2.2), uTime * .8);',
    '    uv += (vec2(cfNoise(q), cfNoise(q + 7.7)) - .5) * hm * .006; }',
    '  vec3 c = texture(tScene, uv).rgb; vec3 b = texture(tBloom, vUv).rgb;',
    '  c = mix(c, b, uBloom) * uExposure / uWB;',
    '  vec3 t = uLook > 1.5 ? aces(c * .8) : agx(c);',
    '  vec2 vq = (vUv - .5) * asp; t *= mix(1., smoothstep(1.25, .25, length(vq)), uVignette);',
    '  t = srgb(clamp(t, 0., 1.)) * uFade;',
    '  float gr = cfHash(vec3(gl_FragCoord.xy, fract(uTime * 7.31) * 100.)) + cfHash(vec3(gl_FragCoord.yx + 13.7, fract(uTime * 3.7) * 100.)) - 1.;',
    '  t += gr * uGrain * (.35 + .65 * (1. - dot(t, vec3(.33))));',
    '  outColor = vec4(t, 1.); }'
  ].join('\n');

  function hdrRT(w, h, depthTex, samples) {
    var t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, samples: samples || 0 });
    t.texture.generateMipmaps = false;
    if (depthTex) { t.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType); t.depthTexture.format = THREE.DepthFormat; }
    return t;
  }
  function raw(fs, uniforms, extra) {
    var m = new THREE.RawShaderMaterial(Object.assign({ glslVersion: THREE.GLSL3, vertexShader: CF.VERT_FS, fragmentShader: fs, uniforms: uniforms, depthTest: false, depthWrite: false }, extra || {}));
    return m;
  }

  // samples: 0, 2 or 4: smooth edges on everything solid (the device's own limit for this format is respected)
  function Post(renderer, samples) {
    this.r = renderer;
    var gl = renderer.getContext(), can = 0;
    try { var list = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES); for (var k = 0; list && k < list.length; k++) can = Math.max(can, list[k]); } catch (e) {}
    this.maxSamples = can; this.samples = Math.min(samples || 0, can);
    this.scene = new THREE.Scene(); this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(CF.fullscreenTriangle()); this.quad.frustumCulled = false; this.scene.add(this.quad);
    this.mDown = raw(DOWN_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.mUp = raw(UP_FS, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
                   { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, transparent: true });
    this.mCopy = raw(DEPTHCOPY_FS, { tColor: { value: null }, tDepth: { value: null } }, { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth });
    this.mFinal = raw(FINAL_FS, {
      tScene: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 0.06 }, uTime: { value: 0 },
      uGrain: { value: 0.035 }, uVignette: { value: 0.55 }, uHaze: { value: new THREE.Vector4(0.5, 0.6, 0.2, 0.3) }, uHazeK: { value: 0 },
      uRes: { value: new THREE.Vector2(1, 1) }, uLook: { value: 1 }, uFade: { value: 1 }, uWB: { value: new THREE.Vector3(1, 1, 1) }
    });
    this.levels = [];
    this.w = this.h = 0;
  }
  Post.prototype.setSamples = function (n) {
    n = Math.min(n || 0, this.maxSamples);
    if (n === this.samples) return;
    this.samples = n; var w = this.w, h = this.h; this.w = 0; if (w) this.setSize(w, h);
  };
  Post.prototype.setSize = function (w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    if (this.opaque) { this.opaque.depthTexture.dispose(); this.opaque.dispose(); this.main.dispose(); this.levels.forEach(function (l) { l.dispose(); }); }
    this.opaque = hdrRT(w, h, true, this.samples);
    this.main = hdrRT(w, h, false);
    this.levels = [];
    var lw = w, lh = h;
    for (var i = 0; i < 6; i++) {
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
      var t = new THREE.WebGLRenderTarget(lw, lh, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      t.texture.generateMipmaps = false;
      this.levels.push(t);
    }
    this.mFinal.uniforms.uRes.value.set(w, h);
  };
  Post.prototype.draw = function (mat, target) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.scene, this.cam); };
  // render: opaque(scene) then transparent(scene2) then post to the screen
  Post.prototype.render = function (scene, transparents, camera, beforeTransparent) {
    var r = this.r;
    r.autoClear = true;
    r.setRenderTarget(this.opaque); r.render(scene, camera);
    this.mCopy.uniforms.tColor.value = this.opaque.texture; this.mCopy.uniforms.tDepth.value = this.opaque.depthTexture;
    r.setRenderTarget(this.main); r.clear(true, true, false);
    this.draw(this.mCopy, this.main);
    if (beforeTransparent) beforeTransparent(this.opaque.depthTexture);
    r.autoClear = false;
    r.setRenderTarget(this.main); r.render(transparents, camera);
    r.autoClear = true;
    // bloom pyramid
    var src = this.main;
    for (var i = 0; i < this.levels.length; i++) {
      var u = this.mDown.uniforms; u.tSrc.value = src.texture; u.uTexel.value.set(1 / src.width, 1 / src.height); u.uFirst.value = i === 0 ? 1 : 0;
      this.draw(this.mDown, this.levels[i]); src = this.levels[i];
    }
    r.autoClear = false;
    for (i = this.levels.length - 1; i > 0; i--) {
      u = this.mUp.uniforms; u.tSrc.value = this.levels[i].texture; u.uTexel.value.set(1 / this.levels[i].width, 1 / this.levels[i].height);
      this.draw(this.mUp, this.levels[i - 1]);
    }
    r.autoClear = true;
    this.mFinal.uniforms.tScene.value = this.main.texture; this.mFinal.uniforms.tBloom.value = this.levels[0].texture;
    this.draw(this.mFinal, null);
  };
  CF.Post = Post;
})();
