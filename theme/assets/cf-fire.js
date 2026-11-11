/* Campfire engine, part 2: the flames.
   A real 2D combustion fluid simulation on the GPU, run in several independent slices that face the camera
   (the "view-oriented slices" idea from Horvath & Geiger, "Directable, high-resolution simulation of fire on the
   GPU", SIGGRAPH 2009). Each slice is a stable-fluids solver (Stam 1999) with:
     - velocity: semi-Lagrangian advection, buoyancy from heat, vorticity confinement (Fedkiw 2001), a rising
       curl-noise turbulence that is laminar at the base and breaks up towards the tips, wind, open boundaries
       (air is drawn in from the sides) and a pressure solve with combustion expansion. The pressure solve is a
       multigrid V-cycle (damped-Jacobi smoothing on three grids, warm-started): it couples the whole plume in
       one step, so the flames neck, roll up and puff the way buoyant fires do, at a third of the old cost;
     - scalars (theta = temperature, fuel = pyrolysis gas, soot, smoke): MacCormack advection with limiter
       (sharp tongues instead of blur), mixing-limited burning, soot formation + oxidation, radiative cooling.
   Fuel enters from spots anchored on the burning logs (CF.FireVolume gets them in 3D and projects them into
   each slice), so separate tongues of flame rise with dark gaps between them, as in a real campfire.

   The simulation runs on bare WebGL 2 (CF.Gpu: its own programs, framebuffers and textures, one- and
   two-channel half-float where that is all a field needs) and only hands the finished fields to three.js. A
   step is about 15 small passes per slice with no JavaScript allocations, which matters on phones, where the
   cost of *issuing* passes rivals the cost of drawing them.

   Drawing: each slice is rebuilt at screen resolution with a bicubic (Catmull-Rom) filter, moved forward along
   the simulated velocity to the exact moment of the frame (so the picture is smooth whatever rate the
   simulation ticks at), and given fine detail that is carried by that same velocity (two cross-faded phases of
   a noise texture, the "flow map" technique), so small wrinkles roll with the eddies instead of sliding
   straight up. Emission = soot * blackbody(theta) with a burn-out edge (+ faint blue where fresh gas burns);
   smoke absorbs and is lit from below; soft edges against the scene's depth. A tiny reduction pass is read
   back without stalling the GPU (pixel buffer + fence) so the flames themselves drive the light that falls on
   the logs, ground and trees. */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE;
  var MAX_SPOTS = 20;

  // ------------------------------------------------------------------ a small bare-WebGL2 pass runner
  var VS = '#version 300 es\nlayout(location = 0) in vec2 p; out vec2 vUv; void main(){ vUv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }';
  var HEAD = [
    '#version 300 es',
    'precision highp float; precision highp int; precision highp sampler2D;',
    'in vec2 vUv; out vec4 o;',
    'uniform vec2 uTexel; uniform vec2 uSize; uniform float uDt;',
    'vec2 worldOf(vec2 uv){ return vec2((uv.x - .5) * uSize.x, uv.y * uSize.y); }'
  ].join('\n');
  // the noise texture: rg = a divergence-free vector field (curl of value noise), b = 3-octave fbm, a = value noise
  var NOISE = 'vec2 nzCurl(sampler2D t, vec2 uv){ return (texture(t, uv).rg * 2. - 1.) * 1.5; }';
  var SPOTS = 'uniform vec4 uSpots[' + MAX_SPOTS + ']; uniform int uNSpots;';
  var PGHOST = 'float P(vec2 uv){ float s = 1.; if (uv.x < 0.) { uv.x = -uv.x; s = -s; } else if (uv.x > 1.) { uv.x = 2. - uv.x; s = -s; }' +
    ' if (uv.y > 1.) { uv.y = 2. - uv.y; s = -s; } else if (uv.y < 0.) uv.y = -uv.y; return s * texture(tP, uv).r; }';

  var FS = {
    curl: { tex: ['tVel'], src: [
      'uniform sampler2D tVel;',
      'void main(){ float h = uSize.x * uTexel.x;',
      '  float L = texture(tVel, vUv - vec2(uTexel.x, 0.)).y, R = texture(tVel, vUv + vec2(uTexel.x, 0.)).y;',
      '  float B = texture(tVel, vUv - vec2(0., uTexel.y)).x, T = texture(tVel, vUv + vec2(0., uTexel.y)).x;',
      '  o = vec4(((R - L) - (T - B)) / (2. * h), 0., 0., 1.); }'
    ] },
    // velocity: carried along itself (semi-Lagrangian), then pushed by buoyancy, swirl, turbulence, wind and the jets
    force: { tex: ['tVel', 'tScal', 'tCurl', 'tNoise'], src: [
      'uniform sampler2D tVel, tScal, tCurl, tNoise; uniform float uTime, uBuoy, uSmokeWeight, uVort, uTurb, uWind, uDamp, uJet; uniform vec2 uSeed;',
      SPOTS, NOISE,
      'void main(){',
      '  vec2 v0 = texture(tVel, vUv).xy; vec2 p = vUv - uDt * v0 / uSize; vec2 v = vec2(0.);',
      // (a third of a two-cell average is mixed in: velocity and pressure live on the same grid points, and without
      //  it a checkerboard ripple the pressure solve cannot see builds up and shows as teeth along the flames)
      '  if (!(p.x < 0. || p.x > 1. || p.y > 1.)) { p.y = max(p.y, .5 * uTexel.y);',
      '    v = mix(texture(tVel, p).xy, .5 * (texture(tVel, p + .5 * uTexel).xy + texture(tVel, p - .5 * uTexel).xy), .3) * .998; }',
      '  vec4 s = texture(tScal, vUv); vec2 w = worldOf(vUv); float h = uSize.x * uTexel.x;',
      '  vec2 f = vec2(0., uBuoy * s.r - uSmokeWeight * s.a);',
      '  float c = texture(tCurl, vUv).r;',
      '  float cL = abs(texture(tCurl, vUv - vec2(uTexel.x, 0.)).r), cR = abs(texture(tCurl, vUv + vec2(uTexel.x, 0.)).r);',
      '  float cB = abs(texture(tCurl, vUv - vec2(0., uTexel.y)).r), cT = abs(texture(tCurl, vUv + vec2(0., uTexel.y)).r);',
      '  vec2 gr = vec2(cR - cL, cT - cB); vec2 N = gr / (length(gr) + 1e-5);',
      '  f += uVort * h * vec2(N.y, -N.x) * c * smoothstep(.02, .25, s.r + s.a);',
      '  float hg = smoothstep(.05, .55, w.y);',
      // two octaves of rising turbulence; each is two copies of the field drifting apart, so it never repeats
      '  vec2 q = w * (3.1 / 16.) + uSeed, q2 = w * (7.3 / 16.) - uSeed;',
      '  vec2 t1 = (nzCurl(tNoise, q + vec2(.023, -.119) * uTime) + nzCurl(tNoise, q + vec2(.37 - .018 * uTime, .61 - .119 * uTime))) * .7071;',
      '  vec2 t2 = (nzCurl(tNoise, q2 + vec2(-.031, -.206) * uTime) + nzCurl(tNoise, q2 + vec2(.53 + .027 * uTime, .19 - .206 * uTime))) * .7071;',
      '  f += uTurb * hg * (.25 + s.r) * (t1 + .45 * t2);',
      '  f.x += uWind * smoothstep(0., 1., w.y) * (.4 + s.r);',
      '  for (int i = 0; i < ' + MAX_SPOTS + '; i++) { if (i >= uNSpots) break; vec4 sp = uSpots[i]; vec2 d = w - sp.xy;',
      '    float gs = exp(-(d.x * d.x) / (2. * sp.z * sp.z) - (d.y * d.y) / (1.2 * sp.z * sp.z)); f.y += uJet * sp.w * gs; }',
      '  v += f * uDt; v /= 1. + uDamp * uDt;',
      '  if (vUv.y < uTexel.y * 1.5) v.y = max(v.y, 0.);',
      '  o = vec4(v, 0., 1.); }'
    ] },
    divergence: { tex: ['tVel', 'tScal'], src: [
      'uniform sampler2D tVel, tScal; uniform float uExpand;',
      'void main(){ float h = uSize.x * uTexel.x; vec2 C = texture(tVel, vUv).xy;',
      '  vec2 L = texture(tVel, vUv - vec2(uTexel.x, 0.)).xy, R = texture(tVel, vUv + vec2(uTexel.x, 0.)).xy;',
      '  vec2 B = texture(tVel, vUv - vec2(0., uTexel.y)).xy, T = texture(tVel, vUv + vec2(0., uTexel.y)).xy;',
      '  if (vUv.y < uTexel.y) B.y = -C.y;',
      '  vec4 s = texture(tScal, vUv);',
      '  float burn = s.g * smoothstep(.15, .38, s.r);',
      '  o = vec4((R.x - L.x + T.y - B.y) / (2. * h) - uExpand * burn, 0., 0., 1.); }'
    ] },
    // pressure, multigrid. Open sides and top: p = 0 exactly on the face, so the value just outside is minus the
    // value just inside (the same place on every grid, or the grids disagree and the cycle diverges). Solid
    // ground: no gradient through it, the value below mirrors the value above.
    smooth: { tex: ['tP', 'tRhs'], src: [
      'uniform sampler2D tP, tRhs; uniform float uH, uOmega;',
      PGHOST,
      'void main(){ float c = texture(tP, vUv).r;',
      '  float j = (P(vUv - vec2(uTexel.x, 0.)) + P(vUv + vec2(uTexel.x, 0.)) + P(vUv - vec2(0., uTexel.y)) + P(vUv + vec2(0., uTexel.y)) - uH * uH * texture(tRhs, vUv).r) * .25;',
      '  o = vec4(mix(c, j, uOmega), 0., 0., 1.); }'
    ] },
    // what the fine grid still gets wrong, averaged down to the next coarser grid (uFT = the fine grid's texel)
    restrict: { tex: ['tP', 'tRhs'], src: [
      'uniform sampler2D tP, tRhs; uniform float uH; uniform vec2 uFT;',
      PGHOST,
      'float res(vec2 uv){ float c = texture(tP, uv).r;',
      '  float lap = (P(uv - vec2(uFT.x, 0.)) + P(uv + vec2(uFT.x, 0.)) + P(uv - vec2(0., uFT.y)) + P(uv + vec2(0., uFT.y)) - 4. * c) / (uH * uH);',
      '  return texture(tRhs, uv).r - lap; }',
      'void main(){ vec2 d = .5 * uFT;',
      '  o = vec4(.25 * (res(vUv + vec2(-d.x, -d.y)) + res(vUv + vec2(d.x, -d.y)) + res(vUv + vec2(-d.x, d.y)) + res(vUv + d)), 0., 0., 1.); }'
    ] },
    // add the coarse grid's correction (bilinear by hand: 32-bit float textures cannot be filtered on every phone;
    // beyond the edges the same boundary rules apply)
    prolong: { tex: ['tP', 'tE'], src: [
      'uniform sampler2D tP, tE;',
      'float E(ivec2 c, ivec2 mx){ float s = 1.; if (c.x < 0) { c.x = 0; s = -s; } else if (c.x > mx.x) { c.x = mx.x; s = -s; }',
      '  if (c.y > mx.y) { c.y = mx.y; s = -s; } else if (c.y < 0) c.y = 0; return s * texelFetch(tE, c, 0).r; }',
      'void main(){ ivec2 mx = textureSize(tE, 0) - 1; vec2 st = vUv * vec2(mx + 1) - .5; ivec2 c = ivec2(floor(st)); vec2 f = st - vec2(c);',
      '  float e = mix(mix(E(c, mx), E(c + ivec2(1, 0), mx), f.x), mix(E(c + ivec2(0, 1), mx), E(c + ivec2(1, 1), mx), f.x), f.y);',
      '  o = vec4(texture(tP, vUv).r + e, 0., 0., 1.); }'
    ] },
    project: { tex: ['tVel', 'tP'], src: [
      'uniform sampler2D tVel, tP;',
      PGHOST,
      'void main(){ float h = uSize.x * uTexel.x;',
      '  vec2 g = vec2(P(vUv + vec2(uTexel.x, 0.)) - P(vUv - vec2(uTexel.x, 0.)), P(vUv + vec2(0., uTexel.y)) - P(vUv - vec2(0., uTexel.y))) / (2. * h);',
      '  vec2 v = texture(tVel, vUv).xy - g; if (vUv.y < uTexel.y) v.y = max(v.y, 0.);',
      '  o = vec4(v, 0., 1.); }'
    ] },
    advect: { tex: ['tVel', 'tSrc'], src: [
      'uniform sampler2D tVel, tSrc; uniform float uDir;',
      'void main(){ vec2 v = texture(tVel, vUv).xy; vec2 p = vUv - uDir * uDt * v / uSize;',
      '  if (p.x < 0. || p.x > 1. || p.y > 1.) { o = vec4(0.); return; }',
      '  o = texture(tSrc, vec2(p.x, max(p.y, .5 * uTexel.y))); }'
    ] },
    // the last third of MacCormack advection (error correction + limiter), then sources and chemistry in one pass
    react: { tex: ['tVel', 'tPhi', 'tHat', 'tBar', 'tNoise'], src: [
      'uniform sampler2D tVel, tPhi, tHat, tBar, tNoise; uniform float uTime; uniform vec2 uSeed;',
      'uniform vec4 uCoal; uniform vec4 uChem; uniform vec4 uCool; uniform vec2 uFuel;',
      SPOTS,
      'void main(){ vec2 v = texture(tVel, vUv).xy; vec2 p = vUv - uDt * v / uSize; vec4 r = vec4(0.);',
      '  if (!(p.x < 0. || p.x > 1. || p.y > 1.)) {',
      '    r = texture(tHat, vUv) + .4 * (texture(tPhi, vUv) - texture(tBar, vUv));',   // (.5 is the full correction; a little less leaves no stair-steps on slanted fronts)
      '    ivec2 mx = textureSize(tPhi, 0) - 1; vec2 st = p / uTexel - .5; ivec2 c = ivec2(floor(st));',
      '    vec4 a = texelFetch(tPhi, clamp(c, ivec2(0), mx), 0), b = texelFetch(tPhi, clamp(c + ivec2(1, 0), ivec2(0), mx), 0);',
      '    vec4 d = texelFetch(tPhi, clamp(c + ivec2(0, 1), ivec2(0), mx), 0), e = texelFetch(tPhi, clamp(c + ivec2(1, 1), ivec2(0), mx), 0);',
      '    r = clamp(r, min(min(a, b), min(d, e)), max(max(a, b), max(d, e)));',
      '    r = max(r * vec4(.999, .996, .995, .993), vec4(0.)); }',
      '  float T = r.r, F = r.g, S = r.b, M = r.a; vec2 w = worldOf(vUv);',
      '  for (int i = 0; i < ' + MAX_SPOTS + '; i++) { if (i >= uNSpots) break; vec4 sp = uSpots[i]; vec2 d = w - sp.xy;',
      '    float gs = exp(-(d.x * d.x) / (2. * sp.z * sp.z) - (d.y * d.y) / (1.2 * sp.z * sp.z)) * sp.w;',
      '    F += uDt * uFuel.x * gs; T += (uFuel.y - T) * clamp(uDt * 9. * gs, 0., 1.) * step(T, uFuel.y); }',
      // the coal bed: a band of heat at the bottom, patchy and breathing
      '  float cx = (w.x - uCoal.x) / uCoal.y; float band = exp(-cx * cx * cx * cx) * exp(-pow(max(w.y - uCoal.w, 0.) / .035, 2.)) * step(uCoal.w - .02, w.y);',
      '  float patchy = smoothstep(.3, .8, texture(tNoise, vec2(w.x * (9. / 16.), uTime * (.25 / 16.)) + uSeed).a);',
      '  T += uDt * uCoal.z * band * (.25 + 1.2 * patchy);',
      '  F += uDt * uCoal.z * band * patchy * .35;',
      // mixing-limited burning: gas burns where it is hot enough (uChem: burn rate, heat per fuel, soot yield, oxidation)
      '  float ign = smoothstep(.15, .38, T); float burn = min(F, uDt * uChem.x * F * ign);',
      '  F -= burn; T += burn * uChem.y * max(0., 1.1 - T); S += burn * uChem.z;',
      '  float ox = min(S, uDt * uChem.w * S * smoothstep(.2, .7, T) * (1.15 - smoothstep(.0, .25, F))); S -= ox; M += ox * uCool.z;',
      // radiation (theta^4) and mixing with cool air; cold soot turns into smoke
      '  T -= uDt * (uCool.x * T * T * T * T + uCool.y * T);',
      '  float cold = uDt * 3. * S * (1. - smoothstep(.3, .6, T)); S -= cold; M += cold * .6;',
      '  o = max(vec4(T, F, S, M), vec4(0.)); }'
    ] },
    reduce: { tex: ['tScal', 'tBlackbody'], src: [
      'uniform sampler2D tScal; uniform float uGain;',
      CF.GLSL_BB,
      'void main(){ vec2 base = floor(vUv * 8.) / 8.; vec4 acc = vec4(0.);',
      '  for (int j = 0; j < 6; j++) for (int i = 0; i < 6; i++) {',
      '    vec2 uv = base + (vec2(float(i), float(j)) + .5) / 48.; vec4 s = texture(tScal, uv);',
      '    float L = dot(cfBlackbody(s.r), vec3(.2126, .7152, .0722)) * s.b * uGain;',
      '    acc += vec4(L, L * uv.y, L * s.r, L * uv.x); }',
      '  o = clamp(acc / 36. / 6., 0., 1.); }'
    ] }
  };

  function Gpu(renderer) {
    this.renderer = renderer;
    var gl = this.gl = renderer.getContext();
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    this.half = !!gl.getExtension('EXT_color_buffer_half_float') || this.float;
    this.vao = gl.createVertexArray(); this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.progs = {}; this.passes = 0;
    // can one- and two-channel half-float textures be drawn into here? (they can wherever four-channel ones can,
    // by the WebGL 2 extension's own table, but a wrong driver costs nothing to check for)
    this.ok = this.complete('rgba');
    this.slim = this.ok && this.complete('r') && this.complete('rg');
    this.float = this.float && this.complete('r32');   // without 32-bit float targets the pressure falls back to plain relaxation
    var noise = CF.noiseTexture();
    this.noise = this.dataTexture(noise.image.width, noise.image.height, noise.image.data, true);
    renderer.resetState();
  }
  Gpu.prototype.complete = function (kind) {
    var gl = this.gl, t = this.target(4, 4, kind, true), ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); this.free(t);
    return ok;
  };
  // kind: 'r' | 'rg' | 'rgba' (half float, linear filtering, clamped) or 'r32' (one 32-bit float channel, unfiltered:
  // the pressure, whose tiny differences half floats cannot hold). New textures start at zero.
  Gpu.prototype.target = function (w, h, kind, exact) {
    var gl = this.gl, k = kind === 'r32' ? (this.float || exact ? 'r32' : 'r') : kind;
    if (!exact && !this.slim && k !== 'r32') k = 'rgba';
    var internal = k === 'r32' ? gl.R32F : k === 'r' ? gl.R16F : k === 'rg' ? gl.RG16F : gl.RGBA16F, filter = k === 'r32' ? gl.NEAREST : gl.LINEAR;
    var tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex: tex, fbo: fbo, w: w, h: h, kind: k };
  };
  Gpu.prototype.free = function (t) { if (!t) return; this.gl.deleteFramebuffer(t.fbo); this.gl.deleteTexture(t.tex); };
  Gpu.prototype.dataTexture = function (w, h, bytes, repeat) {
    var gl = this.gl, tex = gl.createTexture(), wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  };
  Gpu.prototype.program = function (name) {
    if (this.progs[name]) return this.progs[name];
    var gl = this.gl, def = FS[name], sh = function (type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s;
    };
    var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, HEAD + '\n' + def.src.join('\n')), p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var why = gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p);
      throw new Error('Campfire: the "' + name + '" pass did not compile: ' + why);
    }
    gl.deleteShader(vs); gl.deleteShader(fs);
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i), nm = info.name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, info.name); }
    gl.useProgram(p);
    def.tex.forEach(function (t, k) { if (u[t]) gl.uniform1i(u[t], k); });
    return (this.progs[name] = { p: p, u: u });
  };
  // three.js keeps a mirror of the GL state: take the context over for a batch of passes, then hand it back
  Gpu.prototype.begin = function () {
    var gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true); gl.depthMask(false);
  };
  Gpu.prototype.end = function () {
    var gl = this.gl;
    gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.renderer.resetState();
  };
  // start a pass: program `name` drawing into `target`, for a field of w x h metres
  Gpu.prototype.use = function (name, target, W, H, dt) {
    var gl = this.gl, pr = this.progs[name] || this.program(name), u = pr.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(pr.p);
    gl.uniform2f(u.uTexel, 1 / target.w, 1 / target.h); gl.uniform2f(u.uSize, W, H); gl.uniform1f(u.uDt, dt);
    return u;
  };
  Gpu.prototype.bind = function (unit, tex) { var gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); };
  Gpu.prototype.draw = function () { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); this.passes++; };
  Gpu.prototype.clear = function (target) {
    var gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  };
  // a three.js texture that shows one of our GL textures (three binds it as it is: its version stays 0)
  Gpu.prototype.wrap = function (glTex) {
    var t = new THREE.Texture(); t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter;
    var props = this.renderer.properties.get(t); props.__webglTexture = glTex; props.__webglInit = true;
    return t;
  };
  // read a field back as floats (development and tests only: it waits for the GPU)
  Gpu.prototype.read = function (target) {
    var gl = this.gl, out = new Float32Array(target.w * target.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); this.renderer.resetState();
    return out;
  };
  CF.gpu = function (renderer) { return renderer._cfGpu || (renderer._cfGpu = new Gpu(renderer)); };

  // ------------------------------------------------------------------ one slice
  // o: nx, ny (multiples of 4), W, H (metres), seed, mg: {levels, pre, post, coarse}
  function FireSim(renderer, o) {
    var G = this.G = CF.gpu(renderer);
    this.nx = o.nx; this.ny = o.ny; this.W = o.W; this.H = o.H;
    this.seed = [CF.rng.next(), CF.rng.next()]; this.time = CF.rng.range(0, 40);
    this.vel = [G.target(o.nx, o.ny, 'rg'), G.target(o.nx, o.ny, 'rg')];
    this.sc = [G.target(o.nx, o.ny, 'rgba'), G.target(o.nx, o.ny, 'rgba')];
    this.hat = G.target(o.nx, o.ny, 'rgba'); this.bar = G.target(o.nx, o.ny, 'rgba');
    this.curl = G.target(o.nx, o.ny, 'r');
    this.mg = o.mg || { levels: 5, pre: 2, post: 2, coarse: 8 };
    this.levels = [];
    for (var l = 0; l < (G.float ? this.mg.levels : 1); l++) {
      var w = o.nx >> l, h = o.ny >> l;
      if (l > 0 && ((o.nx >> (l - 1)) % 2 || (o.ny >> (l - 1)) % 2)) break;   // odd sizes cannot be halved cleanly
      this.levels.push({ w: w, h: h, cell: o.W / w, p: [G.target(w, h, 'r32'), G.target(w, h, 'r32')], rhs: G.target(w, h, 'r32') });
    }
    this.spots = new Float32Array(MAX_SPOTS * 4); this.nSpots = 0;
    this.params = {
      buoy: 6.0, smokeWeight: 0.3, vort: 4, turb: 4.6, wind: 0, damp: 0.7, jet: 2.2,
      burnK: 5, heat: 4.5, sootY: 1.4, ox: 11, coolRad: 2.0, coolLin: 1.35, smokeY: 0.35,
      fuelRate: 4, preheat: 0.42, coal: [0, 0.22, 0, 0.03], expand: 1.5, omega: 0.8
    };
    this.tScal = [G.wrap(this.sc[0].tex), G.wrap(this.sc[1].tex)];
    this.tVel = [G.wrap(this.vel[0].tex), G.wrap(this.vel[1].tex)];
    this.flip = 0; this.vflip = 0;   // which of the two holds the current field
    renderer.resetState();
  }
  FireSim.prototype.scalars = function () { return this.tScal[this.flip]; };
  FireSim.prototype.velocity = function () { return this.tVel[this.vflip]; };
  FireSim.prototype.smooth = function (L, n) {
    var G = this.G, gl = G.gl;
    for (var i = 0; i < n; i++) {
      var u = G.use('smooth', L.p[1], this.W, this.H, 0);
      gl.uniform1f(u.uH, L.cell); gl.uniform1f(u.uOmega, this.params.omega);
      G.bind(0, L.p[0].tex); G.bind(1, L.rhs.tex); G.draw();
      var t = L.p[0]; L.p[0] = L.p[1]; L.p[1] = t;
    }
  };
  FireSim.prototype.vcycle = function (l) {
    var G = this.G, gl = G.gl, L = this.levels[l], last = l === this.levels.length - 1, mg = this.mg, u;
    if (l > 0) G.clear(L.p[0]);                      // the coarse grids solve for a correction: start from nothing
    if (last) { this.smooth(L, l === 0 ? 14 : mg.coarse); return; }   // one grid only (no 32-bit float targets): plain relaxation
    this.smooth(L, mg.pre);
    var C = this.levels[l + 1];
    u = G.use('restrict', C.rhs, this.W, this.H, 0);
    gl.uniform1f(u.uH, L.cell); gl.uniform2f(u.uFT, 1 / L.w, 1 / L.h);
    G.bind(0, L.p[0].tex); G.bind(1, L.rhs.tex); G.draw();
    this.vcycle(l + 1);
    G.use('prolong', L.p[1], this.W, this.H, 0);
    G.bind(0, L.p[0].tex); G.bind(1, C.p[0].tex); G.draw();
    var t = L.p[0]; L.p[0] = L.p[1]; L.p[1] = t;
    this.smooth(L, mg.post);
  };
  // one step of dt seconds. The caller brackets a batch of steps with G.begin() / G.end().
  FireSim.prototype.step = function (dt) {
    var G = this.G, gl = G.gl, P = this.params, W = this.W, H = this.H, u;
    this.time += dt;
    var v0 = this.vel[this.vflip], v1 = this.vel[1 - this.vflip], s0 = this.sc[this.flip], s1 = this.sc[1 - this.flip];
    // velocity
    G.use('curl', this.curl, W, H, dt); G.bind(0, v0.tex); G.draw();
    u = G.use('force', v1, W, H, dt);
    gl.uniform1f(u.uTime, this.time); gl.uniform2f(u.uSeed, this.seed[0], this.seed[1]);
    gl.uniform1f(u.uBuoy, P.buoy); gl.uniform1f(u.uSmokeWeight, P.smokeWeight); gl.uniform1f(u.uVort, P.vort); gl.uniform1f(u.uTurb, P.turb);
    gl.uniform1f(u.uWind, P.wind); gl.uniform1f(u.uDamp, P.damp); gl.uniform1f(u.uJet, P.jet);
    gl.uniform4fv(u.uSpots, this.spots); gl.uniform1i(u.uNSpots, this.nSpots);
    G.bind(0, v0.tex); G.bind(1, s0.tex); G.bind(2, this.curl.tex); G.bind(3, G.noise); G.draw();
    // pressure: divergence (with the expansion of burning gas), a multigrid V-cycle, then remove the gradient
    var L0 = this.levels[0];
    u = G.use('divergence', L0.rhs, W, H, dt); gl.uniform1f(u.uExpand, P.expand);
    G.bind(0, v1.tex); G.bind(1, s0.tex); G.draw();
    this.vcycle(0);
    G.use('project', v0, W, H, dt); G.bind(0, v1.tex); G.bind(1, L0.p[0].tex); G.draw();
    // (the projected velocity is back in v0: vflip stays)
    // scalars: forward, back, then correct + limit + burn
    u = G.use('advect', this.hat, W, H, dt); gl.uniform1f(u.uDir, 1); G.bind(0, v0.tex); G.bind(1, s0.tex); G.draw();
    u = G.use('advect', this.bar, W, H, dt); gl.uniform1f(u.uDir, -1); G.bind(0, v0.tex); G.bind(1, this.hat.tex); G.draw();
    u = G.use('react', s1, W, H, dt);
    gl.uniform1f(u.uTime, this.time); gl.uniform2f(u.uSeed, this.seed[0], this.seed[1]);
    gl.uniform4f(u.uCoal, P.coal[0], P.coal[1], P.coal[2], P.coal[3]);
    gl.uniform4f(u.uChem, P.burnK, P.heat, P.sootY, P.ox); gl.uniform4f(u.uCool, P.coolRad, P.coolLin, P.smokeY, 0);
    gl.uniform2f(u.uFuel, P.fuelRate, P.preheat);
    gl.uniform4fv(u.uSpots, this.spots); gl.uniform1i(u.uNSpots, this.nSpots);
    G.bind(0, v0.tex); G.bind(1, s0.tex); G.bind(2, this.hat.tex); G.bind(3, this.bar.tex); G.bind(4, G.noise); G.draw();
    this.flip = 1 - this.flip;
  };
  // how far from divergence-free the velocity is, before and after the pressure solve (tests: tools/dev)
  FireSim.prototype.probe = function () {
    var G = this.G, gl = G.gl, P = this.params, L0 = this.levels[0], v = this.vel[this.vflip], s = this.sc[this.flip];
    function rms(a) { var t = 0; for (var i = 0; i < a.length; i += 4) t += a[i] * a[i]; return Math.sqrt(t / (a.length / 4)); }
    G.begin();
    var u = G.use('divergence', L0.rhs, this.W, this.H, 1 / 60); gl.uniform1f(u.uExpand, P.expand);
    G.bind(0, v.tex); G.bind(1, s.tex); G.draw();
    var after = rms(G.read(L0.rhs));
    G.end();
    return { residual: after, scal: G.read(s), vel: G.read(v), nx: this.nx, ny: this.ny, W: this.W, H: this.H };
  };
  FireSim.prototype.dispose = function () {
    var G = this.G;
    [].concat(this.vel, this.sc, [this.hat, this.bar, this.curl]).forEach(function (t) { G.free(t); });
    this.levels.forEach(function (L) { G.free(L.p[0]); G.free(L.p[1]); G.free(L.rhs); });
    this.tScal.concat(this.tVel).forEach(function (t) { t.dispose(); });
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
    'uniform sampler2D tScal, tVel, tDepth, tNoise; uniform vec2 uRes, uTexel, uSize, uSeed;',
    'uniform float uSoftLum, uNear, uFar, uGain, uBlue, uSmokeK, uTime, uSoft, uAlpha, uLag, uDetail, uEdge, uRise, uFlow, uBodyK, uRimK;',
    'uniform vec3 uSmokeLit, uSmokeAmb;',
    CF.GLSL_BB,
    'float lin(float d){ float z = d * 2. - 1.; return 2. * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }',
    // cubic B-spline in four bilinear taps: smooth to the second derivative, so the grid never shows as facets or
    // as teeth along a flame's edge
    'vec4 cubic(sampler2D t, vec2 uv){',
    '#ifdef CF_CUBIC',
    '  vec2 st = uv / uTexel - .5; vec2 i = floor(st), f = st - i, f2 = f * f, f3 = f2 * f;',
    '  vec2 w0 = (1. - 3. * f + 3. * f2 - f3) / 6., w1 = (4. - 6. * f2 + 3. * f3) / 6., w3 = f3 / 6., w2 = 1. - w0 - w1 - w3;',
    '  vec2 g0 = w0 + w1, g1 = w2 + w3; vec2 h0 = (i - .5 + w1 / g0) * uTexel, h1 = (i + 1.5 + w3 / g1) * uTexel;',
    '  return g0.y * (g0.x * texture(t, h0) + g1.x * texture(t, vec2(h1.x, h0.y))) + g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)) + g1.x * texture(t, h1));',
    '#else',
    '  return texture(t, uv);',
    '#endif',
    '}',
    'void main(){',
    '  vec2 vel = cubic(tVel, vUv).xy;',
    '  vec4 s = cubic(tScal, vUv - vel * uLag / uSize);',     // the field at the moment of this frame
    '  float hy = smoothstep(.02, .22, vUv.y);',
    // fine detail: a noise pattern rising at the gas's usual speed, pulled a little further by the local flow (two
    // phases, each reset while it is invisible), so wrinkles lean and curl with the eddies without being smeared
    '  vec2 P = vUv * uSize - vec2(0., uTime * uRise); vec2 rel = (vel - vec2(0., uRise)) * uFlow;',
    '  float cyc = uTime * 3.1; float p0 = fract(cyc), p1 = fract(cyc + .5), w0 = 1. - abs(2. * p0 - 1.);',
    '  vec2 d0 = (P - rel * (p0 - .5)) * uDetail + uSeed, d1 = (P - rel * (p1 - .5)) * uDetail + uSeed;',
    '  vec2 up = vec2(0., uTime * uRise * .31 * uDetail);',   // the finer octave rises a little faster: the pattern never repeats itself
    '  float n0 = texture(tNoise, d0).b * .62 + texture(tNoise, d0 * 2.9 - up + .37).b * .38;',
    '  float n1 = texture(tNoise, d1).b * .62 + texture(tNoise, d1 * 2.9 - up + .37).b * .38;',
    '  float det = (n0 * w0 + n1 * (1. - w0)) - .5;',
    '  float S = s.b * (1. + det * uBodyK * hy);',
    '  float Tv = s.r * (1. + det * .12 * hy);',
    '  vec3 bb = cfBlackbody(Tv); float bl = dot(bb, vec3(.2126, .7152, .0722));',
    // soot glows as a smooth body; where it thins out it burns away quickly, so a flame has an edge and not a haze,
    // and the detail wrinkles that edge
    '  float body = 1. - exp(-S * 2.2);',
    '  float rim = smoothstep(uEdge * .2, uEdge * 1.5, s.b * (1. + det * uRimK * hy));',
    '  vec3 E = bb * pow(bl, uSoftLum - 1.) * body * rim * uGain * smoothstep(.5, .78, Tv);',
    '  float young = s.g * smoothstep(.16, .4, s.r) * (1. - smoothstep(.1, .6, s.b * 3.));',
    '  E += vec3(.18, .32, 1.) * young * uBlue;',
    '  float edge = smoothstep(0., .1, vUv.x) * smoothstep(1., .9, vUv.x) * smoothstep(1., .8, vUv.y) * smoothstep(0., .015, vUv.y);',
    '  float sceneZ = lin(texture(tDepth, gl_FragCoord.xy / uRes).r);',
    '  float soft = clamp((sceneZ - vViewZ) / uSoft, 0., 1.);',
    '  float a = 1. - exp(-(s.a * uSmokeK * (1. + .6 * det) + s.b * .35 * rim));',
    '  vec3 smoke = mix(uSmokeAmb, uSmokeLit, clamp(1.15 - vUv.y * 1.4, 0., 1.)) + cfBlackbody(s.r) * .02;',
    '  float k = edge * soft * uAlpha;',
    '  outColor = vec4((E + smoke * a) * k, a * k); }'
  ].join('\n');

  // ------------------------------------------------------------------ the whole fire: N slices + readback
  // o: blackbody, nx, ny, slices, W, H, y0, spread, mg, cubic
  function FireVolume(renderer, o) {
    this.renderer = renderer;
    var G = this.G = CF.gpu(renderer), gl = G.gl;
    this.ok = G.ok;
    this.bb = o.blackbody;
    this.bbGl = G.dataTexture(this.bb.image.width, 1, this.bb.image.data, false);
    this.W = o.W || 1.3; this.H = o.H || 2.2; this.y0 = o.y0 || -0.03; this.spread = o.spread || 1.2;
    this.group = new THREE.Group();
    this.slices = [];
    var n = o.slices || 3, depths = n === 1 ? [0] : n === 2 ? [-0.1, 0.11] : [-0.17, 0.0, 0.16];
    var scales = n === 1 ? [1.0] : [0.94, 1.0, 0.9], noise = CF.noiseTexture();
    for (var i = 0; i < n; i++) {
      var sim = new FireSim(renderer, { nx: o.nx, ny: o.ny, W: this.W * scales[i], H: this.H * scales[i], mg: o.mg });
      var mat = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: SLICE_VS, fragmentShader: SLICE_FS, defines: o.cubic === false ? {} : { CF_CUBIC: 1 },
        uniforms: {
          tScal: { value: null }, tVel: { value: null }, tDepth: { value: null }, tNoise: { value: noise }, tBlackbody: { value: this.bb },
          uRes: { value: new THREE.Vector2(1, 1) }, uTexel: { value: new THREE.Vector2(1 / o.nx, 1 / o.ny) },
          uSize: { value: new THREE.Vector2(sim.W, sim.H) }, uSeed: { value: new THREE.Vector2(CF.rng.next(), CF.rng.next()) },
          uNear: { value: 0.1 }, uFar: { value: 400 }, uGain: { value: 1 }, uLag: { value: 0 }, uDetail: { value: 0.3 }, uEdge: { value: 0.14 }, uRise: { value: 1.6 }, uFlow: { value: 0.05 }, uBodyK: { value: 1.6 }, uRimK: { value: 1.4 },
          uBlue: { value: 0.04 }, uSoftLum: { value: 0.86 }, uSmokeK: { value: 2.0 }, uTime: { value: 0 }, uSoft: { value: 0.12 },
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
    this.order = this.slices.slice();
    // the light the flames give: an 8 x 8 summary read back through a pixel buffer, a frame or two late, without a stall
    var t8 = gl.createTexture(), f8 = gl.createFramebuffer();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t8); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 8, 8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f8); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t8, 0);
    gl.bindTexture(gl.TEXTURE_2D, null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.reduce = { tex: t8, fbo: f8, w: 8, h: 8 };
    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, 256, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = null;
    this.readBuf = new Uint8Array(8 * 8 * 4);
    this.light = { power: 0, x: 0, y: 0.35, theta: 0.5, fresh: false };
    this.right = new THREE.Vector3(1, 0, 0); this.fwd = new THREE.Vector3(0, 0, 1);
    renderer.resetState();
  }
  // spots3d: [{x, y, z, r, s, k}] in world metres (fire centre at the origin); n = how many of them count
  FireVolume.prototype.setSources = function (spots3d, n) {
    var ns = this.slices.length, count = n === undefined ? spots3d.length : n, share = ns === 1 ? 0.62 : 1;   // one slice gets every spot: not all their fuel
    for (var si = 0; si < ns; si++) {
      var sl = this.slices[si], buf = sl.sim.spots, m = 0;
      for (var j = 0; j < count; j++) {
        var sp = spots3d[j];
        if (ns > 1 && sp.k !== undefined && (sp.k % ns) !== si && sp.s < 1.6) continue;
        var along = sp.x * this.right.x + sp.z * this.right.z, depth = sp.x * this.fwd.x + sp.z * this.fwd.z;
        var dd = depth - sl.depth, str = sp.s * share * Math.exp(-dd * dd / (2 * 0.2 * 0.2));
        if (str < 0.02) continue;
        var at = m;
        if (m >= MAX_SPOTS) {                       // full: the new one replaces the weakest, if it is stronger
          at = 0; for (var q = 1; q < MAX_SPOTS; q++) if (buf[q * 4 + 3] < buf[at * 4 + 3]) at = q;
          if (buf[at * 4 + 3] >= str) continue;
        } else m++;
        buf[at * 4] = along * this.spread / sl.scale; buf[at * 4 + 1] = (sp.y - this.y0) / sl.scale;
        buf[at * 4 + 2] = sp.r * (0.85 + 0.2 * this.spread); buf[at * 4 + 3] = str;
      }
      sl.sim.nSpots = m;
    }
  };
  FireVolume.prototype.setParams = function (fn) { for (var i = 0; i < this.slices.length; i++) fn(this.slices[i].sim.params, i); };
  FireVolume.prototype.orient = function (camera) {
    // slices face the camera around the vertical axis
    var dx = camera.position.x, dz = camera.position.z, len = Math.hypot(dx, dz) || 1;
    this.fwd.set(dx / len, 0, dz / len); this.right.set(this.fwd.z, 0, -this.fwd.x);
    var yaw = Math.atan2(this.fwd.x, this.fwd.z);
    for (var i = 0; i < this.slices.length; i++) {
      var sl = this.slices[i], W = this.W * sl.scale, H = this.H * sl.scale;
      sl.mesh.scale.set(W, H, 1);
      sl.mesh.rotation.set(0, yaw, 0);
      sl.mesh.position.set(this.fwd.x * sl.depth, this.y0 + H / 2, this.fwd.z * sl.depth);
    }
  };
  FireVolume.prototype.windAlong = function (wx, wz) { return wx * this.right.x + wz * this.right.z; };
  // `steps` simulation steps of dt each, then (if `read`) queue the light summary
  FireVolume.prototype.step = function (dt, steps, read) {
    var G = this.G, n = steps === undefined ? 1 : steps;
    G.begin();
    for (var k = 0; k < n; k++) for (var i = 0; i < this.slices.length; i++) this.slices[i].sim.step(dt);
    if (read) this.queueRead(1);
    G.end();
  };
  FireVolume.prototype.drawReduce = function (gain) {
    var G = this.G, gl = G.gl, mid = this.slices[this.slices.length >> 1].sim;
    var u = G.use('reduce', this.reduce, mid.W, mid.H, 0); gl.uniform1f(u.uGain, gain || 1);
    G.bind(0, mid.sc[mid.flip].tex); G.bind(1, this.bbGl); G.draw();
  };
  FireVolume.prototype.queueRead = function (gain) {   // inside begin()/end()
    var gl = this.G.gl;
    if (this.fence) return;                            // the last one is still on its way
    this.drawReduce(gain);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
  };
  FireVolume.prototype.digest = function () {
    var mid = this.slices[this.slices.length >> 1].sim, L = 0, ly = 0, lt = 0, lx = 0, b = this.readBuf, li = this.light;
    for (var i = 0; i < 64; i++) { L += b[i * 4]; ly += b[i * 4 + 1]; lt += b[i * 4 + 2]; lx += b[i * 4 + 3]; }
    li.power = L / 255 / 64 * 6;                       // mean luminance over the slice (x6 undoes the packing)
    if (L > 0) { li.y = this.y0 + ly / L * mid.H; li.x = (lx / L - 0.5) * mid.W; li.theta = lt / L; }
    li.fresh = true;
    return li;
  };
  // the newest light summary; .fresh is true when one arrived since the last call. sync = wait for it (tests, warp)
  FireVolume.prototype.readback = function (gain, sync) {
    var gl = this.G.gl, li = this.light;
    if (sync) {
      if (this.fence) { gl.deleteSync(this.fence); this.fence = null; }
      this.G.begin(); this.drawReduce(gain);
      gl.readPixels(0, 0, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, this.readBuf);
      this.G.end();
      return this.digest();
    }
    li.fresh = false;
    if (this.fence) {
      var st = gl.clientWaitSync(this.fence, 0, 0);
      if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
        gl.deleteSync(this.fence); this.fence = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.readBuf); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.digest();
      } else if (st === gl.WAIT_FAILED) { gl.deleteSync(this.fence); this.fence = null; }
    }
    return li;
  };
  // lag = seconds since the last simulation step (the slices are drawn that much further along the flow)
  FireVolume.prototype.prepareDraw = function (camera, depthTex, w, h, time, gain, lag) {
    this.orient(camera);
    var o = this.order, i, j;
    for (i = 1; i < o.length; i++) {                   // far first (fwd points to the camera)
      var x = o[i]; for (j = i - 1; j >= 0 && o[j].depth < x.depth; j--) o[j + 1] = o[j]; o[j + 1] = x;
    }
    for (i = 0; i < o.length; i++) {
      var sl = o[i], u = sl.mesh.material.uniforms;
      u.tScal.value = sl.sim.scalars(); u.tVel.value = sl.sim.velocity(); u.tDepth.value = depthTex; u.uRes.value.set(w, h);
      u.uNear.value = camera.near; u.uFar.value = camera.far; u.uTime.value = time; u.uGain.value = gain; u.uLag.value = lag || 0;
      sl.mesh.renderOrder = 10 + i;
    }
  };
  FireVolume.prototype.setLook = function (name, value) {
    for (var i = 0; i < this.slices.length; i++) { var u = this.slices[i].mesh.material.uniforms[name]; if (u) u.value = value; }
  };
  FireVolume.prototype.setSmokeLight = function (lr, lg, lb, amb) {
    for (var i = 0; i < this.slices.length; i++) {
      var u = this.slices[i].mesh.material.uniforms; u.uSmokeLit.value.setRGB(lr, lg, lb);
      if (amb) u.uSmokeAmb.value.setRGB(amb[0], amb[1], amb[2]);
    }
  };
  // passes issued per simulation step, all slices (for the notes and the tests)
  FireVolume.prototype.passesPerStep = function () {
    var G = this.G, before = G.passes; G.begin();
    for (var i = 0; i < this.slices.length; i++) this.slices[i].sim.step(1e-6);
    G.end();
    return G.passes - before;
  };
  FireVolume.prototype.dispose = function () {
    var gl = this.G.gl;
    this.slices.forEach(function (sl) { sl.sim.dispose(); sl.mesh.geometry.dispose(); sl.mesh.material.dispose(); });
    if (this.fence) gl.deleteSync(this.fence);
    gl.deleteBuffer(this.pbo); gl.deleteFramebuffer(this.reduce.fbo); gl.deleteTexture(this.reduce.tex); gl.deleteTexture(this.bbGl);
  };
  CF.FireVolume = FireVolume;
  CF.FIRE_MAX_SPOTS = MAX_SPOTS;
})();
