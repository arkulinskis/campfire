/* Campfire engine, part 2: the flames.
   A real 2D combustion fluid simulation on the GPU, run in several independent slices that face the camera
   (the "view-oriented slices" idea from Horvath & Geiger, "Directable, high-resolution simulation of fire on the
   GPU", SIGGRAPH 2009). Each slice is a stable-fluids solver (Stam 1999) with:
     - velocity: semi-Lagrangian advection, buoyancy from heat, vorticity confinement (Fedkiw 2001), a rising
       curl-noise turbulence that is laminar at the base and breaks up towards the tips, wind, open boundaries
       (air is drawn in from the sides) and a pressure solve (Jacobi, warm-started) with combustion expansion;
     - scalars (theta = temperature, fuel = pyrolysis gas, soot, smoke): MacCormack advection with limiter
       (sharp tongues instead of blur), mixing-limited burning, soot formation + oxidation, radiative cooling.
   Fuel enters from spots anchored on the burning logs (CF.FireVolume gets them in 3D and projects them into
   each slice), so separate tongues of flame rise with dark gaps between them, as in a real campfire.
   Drawing: emission = soot * blackbody(theta) (+ faint blue where fresh gas burns), smoke absorbs and is lit
   from below, soft edges against the scene's depth. A tiny reduction pass is read back so the flames themselves
   drive the light that falls on the logs, ground and trees. */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE;
  var MAX_SPOTS = 20;

  var HEAD = [
    'precision highp float; precision highp int;',
    'in vec2 vUv; out vec4 outColor;',
    'uniform vec2 uTexel; uniform vec2 uSize; uniform float uDt;',
    'vec2 worldOf(vec2 uv){ return vec2((uv.x - .5) * uSize.x, uv.y * uSize.y); }'
  ].join('\n');

  var FS = {
    curl: [
      'uniform sampler2D tVel;',
      'void main(){ float h = uSize.x * uTexel.x;',
      '  float L = texture(tVel, vUv - vec2(uTexel.x, 0.)).y, R = texture(tVel, vUv + vec2(uTexel.x, 0.)).y;',
      '  float B = texture(tVel, vUv - vec2(0., uTexel.y)).x, T = texture(tVel, vUv + vec2(0., uTexel.y)).x;',
      '  outColor = vec4(((R - L) - (T - B)) / (2. * h), 0., 0., 1.); }'
    ],
    forces: [
      'uniform sampler2D tVel, tScal, tCurl; uniform float uTime, uSeed, uBuoy, uSmokeWeight, uVort, uTurb, uWind, uDamp, uJet;',
      'uniform vec4 uSpots[' + MAX_SPOTS + ']; uniform int uNSpots;',
      CF.GLSL,
      'void main(){',
      '  vec2 v = texture(tVel, vUv).xy; vec4 s = texture(tScal, vUv); vec2 w = worldOf(vUv); float h = uSize.x * uTexel.x;',
      '  vec2 f = vec2(0., uBuoy * s.r - uSmokeWeight * s.a);',
      '  float c = texture(tCurl, vUv).r;',
      '  float cL = abs(texture(tCurl, vUv - vec2(uTexel.x, 0.)).r), cR = abs(texture(tCurl, vUv + vec2(uTexel.x, 0.)).r);',
      '  float cB = abs(texture(tCurl, vUv - vec2(0., uTexel.y)).r), cT = abs(texture(tCurl, vUv + vec2(0., uTexel.y)).r);',
      '  vec2 gr = vec2(cR - cL, cT - cB); vec2 N = gr / (length(gr) + 1e-5);',
      '  f += uVort * h * vec2(N.y, -N.x) * c * smoothstep(.02, .25, s.r + s.a);',
      '  float hg = smoothstep(.05, .55, w.y);',
      '  vec3 q = vec3(w.x * 3.1, w.y * 3.1 - uTime * 1.9, uTime * .41 + uSeed); float e = .06;',
      '  vec2 t1 = vec2(cfNoise(q + vec3(0., e, 0.)) - cfNoise(q - vec3(0., e, 0.)), -(cfNoise(q + vec3(e, 0., 0.)) - cfNoise(q - vec3(e, 0., 0.)))) / (2. * e);',
      '  vec3 q2 = vec3(w.x * 7.3, w.y * 7.3 - uTime * 3.3, uTime * .9 - uSeed);',
      '  vec2 t2 = vec2(cfNoise(q2 + vec3(0., e, 0.)) - cfNoise(q2 - vec3(0., e, 0.)), -(cfNoise(q2 + vec3(e, 0., 0.)) - cfNoise(q2 - vec3(e, 0., 0.)))) / (2. * e);',
      '  f += uTurb * hg * (.25 + s.r) * (t1 + .45 * t2);',
      '  f.x += uWind * smoothstep(0., 1., w.y) * (.4 + s.r);',
      '  for (int i = 0; i < ' + MAX_SPOTS + '; i++) { if (i >= uNSpots) break; vec4 sp = uSpots[i]; vec2 d = w - sp.xy;',
      '    float gs = exp(-(d.x * d.x) / (2. * sp.z * sp.z) - (d.y * d.y) / (1.2 * sp.z * sp.z)); f.y += uJet * sp.w * gs; }',
      '  v += f * uDt; v /= 1. + uDamp * uDt;',
      '  if (vUv.y < uTexel.y * 1.5) v.y = max(v.y, 0.);',
      '  outColor = vec4(v, 0., 1.); }'
    ],
    advect: [
      'uniform sampler2D tVel, tSrc; uniform float uDir; uniform vec4 uDiss;',
      'void main(){ vec2 v = texture(tVel, vUv).xy; vec2 p = vUv - uDir * uDt * v / uSize;',
      '  if (p.x < 0. || p.x > 1. || p.y > 1.) { outColor = vec4(0.); return; }',
      '  outColor = texture(tSrc, vec2(p.x, max(p.y, .5 * uTexel.y))) * uDiss; }'
    ],
    macc: [
      'uniform sampler2D tVel, tPhi, tHat, tBar; uniform vec4 uDiss;',
      'void main(){ vec2 v = texture(tVel, vUv).xy; vec2 p = vUv - uDt * v / uSize;',
      '  if (p.x < 0. || p.x > 1. || p.y > 1.) { outColor = vec4(0.); return; }',
      '  vec4 r = texture(tHat, vUv) + .5 * (texture(tPhi, vUv) - texture(tBar, vUv));',
      '  ivec2 mx = ivec2(textureSize(tPhi, 0)) - 1; vec2 st = p / uTexel - .5; ivec2 c = ivec2(floor(st));',
      '  vec4 a = texelFetch(tPhi, clamp(c, ivec2(0), mx), 0), b = texelFetch(tPhi, clamp(c + ivec2(1, 0), ivec2(0), mx), 0);',
      '  vec4 d = texelFetch(tPhi, clamp(c + ivec2(0, 1), ivec2(0), mx), 0), e = texelFetch(tPhi, clamp(c + ivec2(1, 1), ivec2(0), mx), 0);',
      '  r = clamp(r, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));',
      '  outColor = max(r * uDiss, vec4(0.)); }'
    ],
    divergence: [
      'uniform sampler2D tVel, tScal; uniform float uExpand;',
      'void main(){ float h = uSize.x * uTexel.x; vec2 C = texture(tVel, vUv).xy;',
      '  vec2 L = texture(tVel, vUv - vec2(uTexel.x, 0.)).xy, R = texture(tVel, vUv + vec2(uTexel.x, 0.)).xy;',
      '  vec2 B = texture(tVel, vUv - vec2(0., uTexel.y)).xy, T = texture(tVel, vUv + vec2(0., uTexel.y)).xy;',
      '  if (vUv.y < uTexel.y) B.y = -C.y;',
      '  vec4 s = texture(tScal, vUv);',
      '  float burn = s.g * smoothstep(.15, .38, s.r);',
      '  outColor = vec4((R.x - L.x + T.y - B.y) / (2. * h) - uExpand * burn, 0., 0., 1.); }'
    ],
    jacobi: [
      'uniform sampler2D tP, tDiv;',
      'float P(vec2 uv){ return (uv.x < 0. || uv.x > 1. || uv.y > 1.) ? 0. : texture(tP, uv).r; }',
      'void main(){ float h = uSize.x * uTexel.x; float c = texture(tP, vUv).r;',
      '  float B = vUv.y < uTexel.y ? c : texture(tP, vUv - vec2(0., uTexel.y)).r;',
      '  float p = (P(vUv - vec2(uTexel.x, 0.)) + P(vUv + vec2(uTexel.x, 0.)) + B + P(vUv + vec2(0., uTexel.y)) - h * h * texture(tDiv, vUv).r) * .25;',
      '  outColor = vec4(p, 0., 0., 1.); }'
    ],
    project: [
      'uniform sampler2D tVel, tP;',
      'float P(vec2 uv){ return (uv.x < 0. || uv.x > 1. || uv.y > 1.) ? 0. : texture(tP, uv).r; }',
      'void main(){ float h = uSize.x * uTexel.x; float c = texture(tP, vUv).r;',
      '  float B = vUv.y < uTexel.y ? c : texture(tP, vUv - vec2(0., uTexel.y)).r;',
      '  vec2 g = vec2(P(vUv + vec2(uTexel.x, 0.)) - P(vUv - vec2(uTexel.x, 0.)), P(vUv + vec2(0., uTexel.y)) - B) / (2. * h);',
      '  vec2 v = texture(tVel, vUv).xy - g; if (vUv.y < uTexel.y) v.y = max(v.y, 0.);',
      '  outColor = vec4(v, 0., 1.); }'
    ],
    react: [
      'uniform sampler2D tScal; uniform float uTime, uSeed;',
      'uniform vec4 uSpots[' + MAX_SPOTS + ']; uniform int uNSpots; uniform vec4 uCoal; uniform vec4 uChem; uniform vec4 uCool; uniform vec2 uFuel;',
      CF.GLSL,
      'void main(){ vec4 s = texture(tScal, vUv); float T = s.r, F = s.g, S = s.b, M = s.a; vec2 w = worldOf(vUv);',
      '  for (int i = 0; i < ' + MAX_SPOTS + '; i++) { if (i >= uNSpots) break; vec4 sp = uSpots[i]; vec2 d = w - sp.xy;',
      '    float gs = exp(-(d.x * d.x) / (2. * sp.z * sp.z) - (d.y * d.y) / (1.2 * sp.z * sp.z)) * sp.w;',
      '    F += uDt * uFuel.x * gs; T += (uFuel.y - T) * clamp(uDt * 9. * gs, 0., 1.) * step(T, uFuel.y); }',
      // the coal bed: a band of heat at the bottom, patchy and breathing
      '  float cx = (w.x - uCoal.x) / uCoal.y; float band = exp(-cx * cx * cx * cx) * exp(-pow(max(w.y - uCoal.w, 0.) / .035, 2.)) * step(uCoal.w - .02, w.y);',
      '  float patchy = smoothstep(.3, .8, cfNoise(vec3(w.x * 9., uTime * .25, uSeed)));',
      '  T += uDt * uCoal.z * band * (.25 + 1.2 * patchy);',
      '  F += uDt * uCoal.z * band * patchy * .35;',
      // mixing-limited burning: gas burns where it is hot enough (uChem: burn rate, heat per fuel, soot yield, oxidation)
      '  float ign = smoothstep(.15, .38, T); float burn = min(F, uDt * uChem.x * F * ign);',
      '  F -= burn; T += burn * uChem.y * max(0., 1.1 - T); S += burn * uChem.z;',
      '  float ox = min(S, uDt * uChem.w * S * smoothstep(.2, .7, T) * (1.15 - smoothstep(.0, .25, F))); S -= ox; M += ox * uCool.z;',
      // radiation (theta^4) and mixing with cool air; cold soot turns into smoke
      '  T -= uDt * (uCool.x * T * T * T * T + uCool.y * T);',
      '  float cold = uDt * 3. * S * (1. - smoothstep(.3, .6, T)); S -= cold; M += cold * .6;',
      '  outColor = max(vec4(T, F, S, M), vec4(0.)); }'
    ],
    reduce: [
      'uniform sampler2D tScal; uniform float uGain;',
      CF.GLSL_BB,
      'void main(){ vec2 base = floor(vUv * 8.) / 8.; vec4 acc = vec4(0.);',
      '  for (int j = 0; j < 6; j++) for (int i = 0; i < 6; i++) {',
      '    vec2 uv = base + (vec2(float(i), float(j)) + .5) / 48.; vec4 s = texture(tScal, uv);',
      '    float L = dot(cfBlackbody(s.r), vec3(.2126, .7152, .0722)) * s.b * uGain;',
      '    acc += vec4(L, L * uv.y, L * s.r, L * uv.x); }',
      '  outColor = clamp(acc / 36. / 6., 0., 1.); }'
    ]
  };

  function rt(nx, ny, type) {
    var t = new THREE.WebGLRenderTarget(nx, ny, {
      type: type || THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping
    });
    t.texture.generateMipmaps = false;
    return t;
  }

  // shared programs (one set for all slices)
  var PROGS = null;
  function programs(bbTex) {
    if (PROGS) return PROGS;
    PROGS = {};
    Object.keys(FS).forEach(function (k) {
      var u = { uTexel: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2() }, uDt: { value: 1 / 60 } };
      PROGS[k] = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: CF.VERT_FS, fragmentShader: HEAD + '\n' + FS[k].join('\n'),
        uniforms: u, depthTest: false, depthWrite: false
      });
    });
    PROGS.reduce.uniforms.tBlackbody = { value: bbTex };
    var spots = []; for (var i = 0; i < MAX_SPOTS; i++) spots.push(new THREE.Vector4());
    ['forces', 'react'].forEach(function (k) { PROGS[k].uniforms.uSpots = { value: spots }; PROGS[k].uniforms.uNSpots = { value: 0 }; });
    return PROGS;
  }

  // ------------------------------------------------------------------ one slice
  function FireSim(renderer, o) {
    this.renderer = renderer;
    this.nx = o.nx; this.ny = o.ny; this.W = o.W; this.H = o.H;
    this.seed = o.seed || 0; this.time = o.seed * 13.1 || 0;
    this.vel = [rt(o.nx, o.ny), rt(o.nx, o.ny)];
    this.sc = [rt(o.nx, o.ny), rt(o.nx, o.ny), rt(o.nx, o.ny), rt(o.nx, o.ny)];
    this.p = [rt(o.nx, o.ny), rt(o.nx, o.ny)];
    this.div = rt(o.nx, o.ny); this.curl = rt(o.nx, o.ny);
    this.spots = [];
    this.params = {
      buoy: 6.0, smokeWeight: 0.3, vort: 8, turb: 4.6, wind: 0, damp: 0.7, jet: 2.2,
      burnK: 5, heat: 4.5, sootY: 1.4, ox: 11, coolRad: 2.0, coolLin: 1.35, smokeY: 0.35,
      fuelRate: 4, preheat: 0.42, coal: new THREE.Vector4(0, 0.22, 0, 0.03), expand: 1.5, iters: 22
    };
  }
  FireSim.prototype.pass = function (name, target, set) {
    var m = PROGS[name], u = m.uniforms;
    u.uTexel.value.set(1 / this.nx, 1 / this.ny); u.uSize.value.set(this.W, this.H);
    if (set) set(u);
    CF._fsMesh.material = m;
    this.renderer.setRenderTarget(target);
    this.renderer.render(CF._fsScene, CF._fsCam);
  };
  FireSim.prototype.setSpots = function (u) {
    var arr = u.uSpots.value, n = Math.min(this.spots.length, MAX_SPOTS);
    for (var i = 0; i < n; i++) { var s = this.spots[i]; arr[i].set(s[0], s[1], s[2], s[3]); }
    u.uNSpots.value = n;
  };
  FireSim.prototype.step = function (dt) {
    var self = this, P = this.params, U = function (o) { return function (u) { for (var k in o) { if (!u[k]) u[k] = { value: o[k] }; else u[k].value = o[k]; } }; };
    this.time += dt;
    var tex = function (r) { return r.texture; };
    var dv = function (u) { u.uDt.value = dt; };
    // velocity
    this.pass('curl', this.curl, function (u) { dv(u); U({ tVel: tex(self.vel[0]) })(u); });
    this.pass('forces', this.vel[1], function (u) {
      dv(u); self.setSpots(u);
      U({ tVel: tex(self.vel[0]), tScal: tex(self.sc[0]), tCurl: tex(self.curl), uTime: self.time, uSeed: self.seed,
          uBuoy: P.buoy, uSmokeWeight: P.smokeWeight, uVort: P.vort, uTurb: P.turb, uWind: P.wind, uDamp: P.damp, uJet: P.jet })(u);
    });
    this.vel.reverse();
    var one = new THREE.Vector4(1, 1, 1, 1);
    this.pass('advect', this.vel[1], function (u) { dv(u); U({ tVel: tex(self.vel[0]), tSrc: tex(self.vel[0]), uDir: 1, uDiss: new THREE.Vector4(0.998, 0.998, 1, 1) })(u); });
    this.vel.reverse();
    this.pass('divergence', this.div, function (u) { dv(u); U({ tVel: tex(self.vel[0]), tScal: tex(self.sc[0]), uExpand: P.expand })(u); });
    for (var i = 0; i < P.iters; i++) {
      this.pass('jacobi', this.p[1], function (u) { dv(u); U({ tP: tex(self.p[0]), tDiv: tex(self.div) })(u); });
      this.p.reverse();
    }
    this.pass('project', this.vel[1], function (u) { dv(u); U({ tVel: tex(self.vel[0]), tP: tex(self.p[0]) })(u); });
    this.vel.reverse();
    // scalars: sources + chemistry, then MacCormack advection
    this.pass('react', this.sc[1], function (u) {
      dv(u); self.setSpots(u);
      U({ tScal: tex(self.sc[0]), uTime: self.time, uSeed: self.seed, uCoal: P.coal,
          uChem: new THREE.Vector4(P.burnK, P.heat, P.sootY, P.ox), uCool: new THREE.Vector4(P.coolRad, P.coolLin, P.smokeY, 0),
          uFuel: new THREE.Vector2(P.fuelRate, P.preheat) })(u);
    });
    var s = this.sc, A = s[1];
    this.pass('advect', s[2], function (u) { dv(u); U({ tVel: tex(self.vel[0]), tSrc: tex(A), uDir: 1, uDiss: one })(u); });
    this.pass('advect', s[3], function (u) { dv(u); U({ tVel: tex(self.vel[0]), tSrc: tex(s[2]), uDir: -1, uDiss: one })(u); });
    this.pass('macc', s[0], function (u) {
      dv(u); U({ tVel: tex(self.vel[0]), tPhi: tex(A), tHat: tex(s[2]), tBar: tex(s[3]), uDiss: new THREE.Vector4(0.999, 0.996, 0.995, 0.993) })(u);
    });
  };
  FireSim.prototype.dispose = function () {
    [].concat(this.vel, this.sc, this.p, [this.div, this.curl]).forEach(function (r) { r.dispose(); });
  };
  CF.FireSim = FireSim;

  // ------------------------------------------------------------------ slice drawing material
  var SLICE_VS = [
    'out vec2 vUv; out float vViewZ;',
    'void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }'
  ].join('\n');
  var SLICE_FS = [
    'precision highp float;',
    'in vec2 vUv; in float vViewZ; out vec4 outColor;',
    'uniform sampler2D tScal, tDepth; uniform vec2 uRes, uTexel; uniform float uSoftLum, uNear, uFar, uGain, uBlue, uSmokeK, uTime, uSoft, uSeed, uAlpha;',
    'uniform vec3 uSmokeLit, uSmokeAmb;',
    CF.GLSL, CF.GLSL_BB,
    'float lin(float d){ float z = d * 2. - 1.; return 2. * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }',
    'void main(){',
    '  vec3 q = vec3(vUv * vec2(26., 44.) - vec2(0., uTime * 2.6), uTime * .7 + uSeed);',
    '  vec2 warp = (vec2(cfNoise(q), cfNoise(q + 19.1)) - .5) * uTexel * 2.2 * smoothstep(.02, .3, vUv.y);',
    '  vec4 s = texture(tScal, vUv + warp);',
    '  float hy = smoothstep(.03, .25, vUv.y);',
    '  vec3 dq = vec3(vUv.x * 24., vUv.y * 30. - uTime * 3.4, uTime * .9 + uSeed);',
    '  float det = cfFbm3(dq + vec3(cfNoise(dq * .5) * 1.5, 0., 0.));',
    '  float S = s.b * mix(1., .35 + 1.3 * det, hy * .85);',
    '  float Tv = s.r * (1. + (cfNoise(dq * 1.7 + 5.) - .5) * .1 * hy);',
    '  vec3 bb = cfBlackbody(Tv); float bl = dot(bb, vec3(.2126, .7152, .0722));',
    '  vec3 E = bb * pow(bl, uSoftLum - 1.) * (1. - exp(-S * 2.2)) * uGain * smoothstep(.5, .78, Tv);',
    '  float young = s.g * smoothstep(.16, .4, s.r) * (1. - smoothstep(.1, .6, s.b * 3.));',
    '  E += vec3(.18, .32, 1.) * young * uBlue;',
    '  float edge = smoothstep(0., .1, vUv.x) * smoothstep(1., .9, vUv.x) * smoothstep(1., .8, vUv.y) * smoothstep(0., .015, vUv.y);',
    '  float sceneZ = lin(texture(tDepth, gl_FragCoord.xy / uRes).r);',
    '  float soft = clamp((sceneZ - vViewZ) / uSoft, 0., 1.);',
    '  float a = 1. - exp(-(s.a * uSmokeK + s.b * .35));',
    '  vec3 smoke = mix(uSmokeAmb, uSmokeLit, clamp(1.15 - vUv.y * 1.4, 0., 1.)) + cfBlackbody(s.r) * .02;',
    '  float k = edge * soft * uAlpha;',
    '  outColor = vec4((E + smoke * a) * k, a * k); }'
  ].join('\n');

  // ------------------------------------------------------------------ the whole fire: N slices + readback
  function FireVolume(renderer, o) {
    this.renderer = renderer;
    this.bb = o.blackbody;
    programs(this.bb);
    if (!CF._fsScene) {
      CF._fsScene = new THREE.Scene(); CF._fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      CF._fsMesh = new THREE.Mesh(CF.fullscreenTriangle(), PROGS.curl); CF._fsMesh.frustumCulled = false;
      CF._fsScene.add(CF._fsMesh);
    }
    this.W = o.W || 1.3; this.H = o.H || 2.2; this.y0 = o.y0 || -0.03; this.spread = o.spread || 1.2;
    this.group = new THREE.Group();
    this.slices = [];
    var n = o.slices || 3, depths = n === 1 ? [0] : n === 2 ? [-0.1, 0.11] : [-0.17, 0.0, 0.16];
    var scales = [0.94, 1.0, 0.9];
    for (var i = 0; i < n; i++) {
      var sim = new FireSim(renderer, { nx: o.nx, ny: o.ny, W: this.W * scales[i], H: this.H * scales[i], seed: CF.rng.range(0, 100) });
      var mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: SLICE_VS, fragmentShader: SLICE_FS,
        uniforms: {
          tScal: { value: null }, tDepth: { value: null }, tBlackbody: { value: this.bb }, uRes: { value: new THREE.Vector2(1, 1) },
          uTexel: { value: new THREE.Vector2(1 / o.nx, 1 / o.ny) }, uNear: { value: 0.1 }, uFar: { value: 400 }, uGain: { value: 1 },
          uBlue: { value: 0.04 }, uSoftLum: { value: 0.86 }, uSmokeK: { value: 2.0 }, uTime: { value: 0 }, uSoft: { value: 0.12 }, uSeed: { value: i * 7.3 },
          uSmokeLit: { value: new THREE.Color(0.05, 0.03, 0.02) }, uSmokeAmb: { value: new THREE.Color(0.004, 0.005, 0.007) },
          uAlpha: { value: n === 1 ? 1 : 1 / Math.sqrt(n) * 1.1 }
        },
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor
      });
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      mesh.frustumCulled = false; mesh.renderOrder = 10 + i;
      this.group.add(mesh);
      this.slices.push({ sim: sim, mesh: mesh, depth: depths[i], scale: scales[i] });
    }
    this.reduceRT = rt(8, 8, THREE.UnsignedByteType);
    this.readBuf = new Uint8Array(8 * 8 * 4);
    this.light = { power: 0, x: 0, y: 0.35, theta: 0.5, fresh: false };
    this.frame = 0;
    this.right = new THREE.Vector3(1, 0, 0); this.fwd = new THREE.Vector3(0, 0, 1);
  }
  // spots3d: [{x, y, z, r, s}] in world metres (fire centre at the origin)
  FireVolume.prototype.setSources = function (spots3d) {
    var self = this;
    var ns = this.slices.length;
    this.slices.forEach(function (sl, si) {
      var arr = [];
      spots3d.forEach(function (sp, k) {
        if (ns > 1 && sp.k !== undefined && (sp.k % ns) !== si && sp.s < 1.6) return;
        var along = sp.x * self.right.x + sp.z * self.right.z;
        var depth = sp.x * self.fwd.x + sp.z * self.fwd.z;
        var dd = depth - sl.depth, wgt = Math.exp(-dd * dd / (2 * 0.2 * 0.2));
        if (wgt * sp.s < 0.02) return;
        arr.push([along * self.spread / sl.scale, (sp.y - self.y0) / sl.scale, sp.r * (0.85 + 0.2 * self.spread), sp.s * wgt]);
      });
      arr.sort(function (a, b) { return b[3] - a[3]; });
      sl.sim.spots = arr.slice(0, MAX_SPOTS);
    });
  };
  FireVolume.prototype.setParams = function (fn) { this.slices.forEach(function (sl, i) { fn(sl.sim.params, i); }); };
  FireVolume.prototype.orient = function (camera) {
    // slices face the camera around the vertical axis
    var dx = camera.position.x, dz = camera.position.z, len = Math.hypot(dx, dz) || 1;
    this.fwd.set(dx / len, 0, dz / len); this.right.set(this.fwd.z, 0, -this.fwd.x);
    var yaw = Math.atan2(this.fwd.x, this.fwd.z), self = this;
    this.slices.forEach(function (sl) {
      var W = self.W * sl.scale, H = self.H * sl.scale;
      sl.mesh.scale.set(W, H, 1);
      sl.mesh.rotation.set(0, yaw, 0);
      sl.mesh.position.set(self.fwd.x * sl.depth, self.y0 + H / 2, self.fwd.z * sl.depth);
    });
  };
  FireVolume.prototype.windAlong = function (wx, wz) { return wx * this.right.x + wz * this.right.z; };
  FireVolume.prototype.step = function (dt) {
    var r = this.renderer, prev = r.getRenderTarget();
    this.slices.forEach(function (sl) { sl.sim.step(dt); });
    r.setRenderTarget(prev);
  };
  FireVolume.prototype.readback = function (gain) {
    var r = this.renderer, prev = r.getRenderTarget(), mid = this.slices[Math.floor(this.slices.length / 2)].sim, self = this;
    PROGS.reduce.uniforms.tScal = { value: mid.sc[0].texture };
    PROGS.reduce.uniforms.uGain = { value: gain || 1 };
    PROGS.reduce.uniforms.uTexel.value.set(1 / 8, 1 / 8);
    CF._fsMesh.material = PROGS.reduce;
    r.setRenderTarget(this.reduceRT); r.render(CF._fsScene, CF._fsCam);
    r.readRenderTargetPixels(this.reduceRT, 0, 0, 8, 8, this.readBuf);
    r.setRenderTarget(prev);
    var L = 0, ly = 0, lt = 0, lx = 0, b = this.readBuf;
    for (var i = 0; i < 64; i++) { L += b[i * 4]; ly += b[i * 4 + 1]; lt += b[i * 4 + 2]; lx += b[i * 4 + 3]; }
    var li = this.light;
    li.power = L / 255 / 64 * 6 * 36 / 36 * 1;    // mean luminance over the slice (x6 undoes the packing)
    if (L > 0) { li.y = self.y0 + ly / L * mid.H; li.x = (lx / L - 0.5) * mid.W; li.theta = lt / L; }
    li.fresh = true;
    return li;
  };
  FireVolume.prototype.prepareDraw = function (camera, depthTex, w, h, time, gain) {
    this.orient(camera);
    var sorted = this.slices.slice().sort(function (a, b) { return b.depth - a.depth; });  // far first (fwd points to the camera)
    sorted.forEach(function (sl, i) {
      var u = sl.mesh.material.uniforms;
      u.tScal.value = sl.sim.sc[0].texture; u.tDepth.value = depthTex; u.uRes.value.set(w, h);
      u.uNear.value = camera.near; u.uFar.value = camera.far; u.uTime.value = time; u.uGain.value = gain;
      sl.mesh.renderOrder = 10 + i;
    });
  };
  FireVolume.prototype.setSmokeLight = function (lit, amb) {
    this.slices.forEach(function (sl) { sl.mesh.material.uniforms.uSmokeLit.value.copy(lit); sl.mesh.material.uniforms.uSmokeAmb.value.copy(amb); });
  };
  FireVolume.prototype.dispose = function () {
    this.slices.forEach(function (sl) { sl.sim.dispose(); sl.mesh.geometry.dispose(); sl.mesh.material.dispose(); });
    this.reduceRT.dispose();
  };
  CF.FireVolume = FireVolume;
  CF.FIRE_MAX_SPOTS = MAX_SPOTS;
})();
