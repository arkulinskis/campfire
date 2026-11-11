/* Campfire engine, part 1: shared pieces.
   - CF.rng: a xoshiro128** generator seeded from the browser's crypto source (a new seed every visit, so no two
     fires are ever the same), plus helpers (uniform, gaussian, Ornstein-Uhlenbeck processes, Poisson waits).
   - CF.noise3: 3D value noise for the CPU side (sparks, wind).
   - CF.GLSL: noise, cellular (Voronoi) and bump helpers shared by every shader.
   - CF.blackbody: the colour of glowing matter from Planck's law integrated against the CIE 1931 observer
     (Wyman, Sloan & Shirley 2013 fit), as a small lookup texture: rgb = chromaticity, a = log luminance.
   - Geometry helpers (merge, jitter) and canvas textures.
   Needs three.js r158 (window.THREE). */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE;

  // ---------------------------------------------------------------- randomness
  function seed32() {
    var a = new Uint32Array(4);
    try { window.crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < 4; i++) a[i] = (Math.random() * 4294967296) >>> 0; }
    if (!(a[0] | a[1] | a[2] | a[3])) a[0] = 1;
    return a;
  }
  function Rng(s) {
    var st = s || seed32();
    this.s = new Uint32Array(st);
  }
  Rng.prototype.u32 = function () {
    var s = this.s, r = Math.imul(rotl(Math.imul(s[1], 5), 7), 9), t = s[1] << 9;
    s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]; s[2] ^= t; s[3] = rotl(s[3], 11);
    return r >>> 0;
  };
  function rotl(x, k) { return (x << k) | (x >>> (32 - k)); }
  Rng.prototype.next = function () { return this.u32() / 4294967296; };
  Rng.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
  Rng.prototype.int = function (a, b) { return a + Math.floor(this.next() * (b - a + 1)); };
  Rng.prototype.pick = function (arr) { return arr[Math.floor(this.next() * arr.length)]; };
  Rng.prototype.chance = function (p) { return this.next() < p; };
  Rng.prototype.gauss = function () {
    var u = 1 - this.next(), v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * v);
  };
  Rng.prototype.expo = function (mean) { return -Math.log(1 - this.next()) * mean; };   // Poisson waiting time
  Rng.prototype.logUniform = function (a, b) { return a * Math.pow(b / a, this.next()); };
  CF.Rng = Rng;
  CF.rng = new Rng();                                 // the session's own entropy
  CF.fixedRng = function (n) { return new Rng(new Uint32Array([n * 2654435761 >>> 0, 0x9e3779b9, n + 7, 0x85ebca6b])); };

  // Ornstein-Uhlenbeck: a value that wanders around a mean and always drifts back (flicker, wind, flame spots).
  function OU(mean, sigma, theta, rng) {
    this.mean = mean; this.sigma = sigma; this.theta = theta; this.x = mean; this.rng = rng || CF.rng;
  }
  OU.prototype.step = function (dt) {
    this.x += this.theta * (this.mean - this.x) * dt + this.sigma * Math.sqrt(dt) * this.rng.gauss();
    return this.x;
  };
  CF.OU = OU;

  CF.clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  CF.lerp = function (a, b, t) { return a + (b - a) * t; };
  CF.smooth = function (a, b, x) { var t = CF.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  CF.damp = function (cur, target, rate, dt) { return target + (cur - target) * Math.exp(-rate * dt); };

  // ---------------------------------------------------------------- CPU noise
  var P = new Uint8Array(512);
  (function () {
    var r = CF.fixedRng(11), p = [];
    for (var i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) { var j = Math.floor(r.next() * (i + 1)), t = p[i]; p[i] = p[j]; p[j] = t; }
    for (i = 0; i < 512; i++) P[i] = p[i & 255];
  })();
  function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  function h3(x, y, z) { return P[P[P[x & 255] + (y & 255)] + (z & 255)] / 255; }
  CF.noise3 = function (x, y, z) {
    var X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), fx = x - X, fy = y - Y, fz = z - Z;
    var u = fade(fx), v = fade(fy), w = fade(fz);
    var a = CF.lerp(CF.lerp(h3(X, Y, Z), h3(X + 1, Y, Z), u), CF.lerp(h3(X, Y + 1, Z), h3(X + 1, Y + 1, Z), u), v);
    var b = CF.lerp(CF.lerp(h3(X, Y, Z + 1), h3(X + 1, Y, Z + 1), u), CF.lerp(h3(X, Y + 1, Z + 1), h3(X + 1, Y + 1, Z + 1), u), v);
    return CF.lerp(a, b, w) * 2 - 1;
  };
  // divergence-free 3D turbulence (curl of three offset noise fields), for sparks and smoke
  CF.curl3 = function (x, y, z, out) {
    var e = 0.1, n = CF.noise3;
    var a = function (x, y, z) { return n(x, y, z); };
    var b = function (x, y, z) { return n(x + 31.4, y + 17.1, z - 9.2); };
    var c = function (x, y, z) { return n(x - 21.7, y + 5.3, z + 41.9); };
    out.x = ((c(x, y + e, z) - c(x, y - e, z)) - (b(x, y, z + e) - b(x, y, z - e))) / (2 * e);
    out.y = ((a(x, y, z + e) - a(x, y, z - e)) - (c(x + e, y, z) - c(x - e, y, z))) / (2 * e);
    out.z = ((b(x + e, y, z) - b(x - e, y, z)) - (a(x, y + e, z) - a(x, y - e, z))) / (2 * e);
    return out;
  };

  // ---------------------------------------------------------------- GLSL helpers
  CF.GLSL = [
    'float cfHash(vec3 p){ p = fract(p * vec3(.1031, .1030, .0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }',
    'vec3 cfHash3(vec3 p){ p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6))); return fract(sin(p) * 43758.5453123); }',
    'float cfNoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3. - 2. * f);',
    '  return mix(mix(mix(cfHash(i), cfHash(i + vec3(1,0,0)), f.x), mix(cfHash(i + vec3(0,1,0)), cfHash(i + vec3(1,1,0)), f.x), f.y),',
    '             mix(mix(cfHash(i + vec3(0,0,1)), cfHash(i + vec3(1,0,1)), f.x), mix(cfHash(i + vec3(0,1,1)), cfHash(i + vec3(1,1,1)), f.x), f.y), f.z); }',
    '#ifndef CF_OCT', '#define CF_OCT 5', '#endif',
    'float cfFbm(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < CF_OCT; i++) { s += a * cfNoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= .5; } return s; }',
    'float cfFbm3(vec3 p){ float a = .5, s = 0.; for (int i = 0; i < 3; i++) { s += a * cfNoise(p); p = p * 2.07 + vec3(4.1, 1.3, 7.7); a *= .5; } return s; }',
    // cellular: x = distance to nearest cell point, y = second nearest (y - x small = a crack)
    '#ifdef CF_OCT',   // the lightest tier: cell points keep to the middle of their cells, so only the 8 nearest cells can matter
    'vec2 cfCells(vec3 p){ vec3 i = floor(p - .5), f = p - i; float d1 = 8., d2 = 8.;',
    '  for (int z = 0; z <= 1; z++) for (int y = 0; y <= 1; y++) for (int x = 0; x <= 1; x++) {',
    '    vec3 g = vec3(float(x), float(y), float(z)); vec3 o = .25 + .5 * cfHash3(i + g); vec3 r = g + o - f; float d = dot(r, r);',
    '    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }',
    '  return vec2(sqrt(d1), sqrt(d2)); }',
    '#else',
    'vec2 cfCells(vec3 p){ vec3 i = floor(p), f = fract(p); float d1 = 8., d2 = 8.;',
    '  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {',
    '    vec3 g = vec3(float(x), float(y), float(z)); vec3 o = cfHash3(i + g); vec3 r = g + o - f; float d = dot(r, r);',
    '    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }',
    '  return vec2(sqrt(d1), sqrt(d2)); }',
    '#endif',
    // Mikkelsen bump mapping from any height function (no textures needed)
    'vec3 cfBump(vec3 pos, vec3 n, float h, float k){ vec3 dpx = dFdx(pos), dpy = dFdy(pos); float dhx = dFdx(h) * k, dhy = dFdy(h) * k;',
    '  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1); vec3 g = sign(det) * (dhx * r1 + dhy * r2);',
    '  return normalize(abs(det) * n - g); }'
  ].join('\n');

  // ---------------------------------------------------------------- blackbody
  // The flame field stores temperature as theta (0 = air, 1 = 1400 K); kelvin = 300 + theta * 1100.
  CF.KELVIN = function (theta) { return 300 + theta * 1100; };
  function g(l, m, s1, s2) { var t = (l - m) / (l < m ? s1 : s2); return Math.exp(-0.5 * t * t); }
  function cie(l) {
    return [1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
            0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
            1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8)];
  }
  function planckXYZ(T) {
    var X = 0, Y = 0, Z = 0, h = 6.626e-34, c = 2.998e8, k = 1.381e-23;
    for (var l = 380; l <= 780; l += 5) {
      var lm = l * 1e-9, B = (2 * h * c * c) / (Math.pow(lm, 5) * (Math.exp(h * c / (lm * k * T)) - 1)), w = cie(l);
      X += B * w[0]; Y += B * w[1]; Z += B * w[2];
    }
    return [X, Y, Z];
  }
  CF.blackbodyRGB = function (T) {  // linear sRGB, luminance = 1
    var xyz = planckXYZ(T), X = xyz[0] / xyz[1], Y = 1, Z = xyz[2] / xyz[1];
    var r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    r = Math.max(r, 0); gg = Math.max(gg, 0); b = Math.max(b, 0);
    var lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    return [r / lum, gg / lum, b / lum];
  };
  CF.LOGLUM_MIN = -22; CF.LOGLUM_SPAN = 26;
  CF.blackbodyTexture = function () {
    var N = 256, data = new Uint8Array(N * 4), Yref = planckXYZ(1300)[1];
    for (var i = 0; i < N; i++) {
      var theta = i / (N - 1) * 1.4, T = CF.KELVIN(theta), rgb = CF.blackbodyRGB(Math.max(T, 500));
      var mx = Math.max(rgb[0], rgb[1], rgb[2]);
      var L = Math.log(Math.max(planckXYZ(T)[1] / Yref, 1e-12));
      data[i * 4] = Math.round(255 * rgb[0] / mx); data[i * 4 + 1] = Math.round(255 * rgb[1] / mx);
      data[i * 4 + 2] = Math.round(255 * rgb[2] / mx);
      data[i * 4 + 3] = Math.round(255 * CF.clamp((L - CF.LOGLUM_MIN) / CF.LOGLUM_SPAN, 0, 1));
    }
    var tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  };
  // GLSL: radiance of glowing soot at temperature theta (relative to 1300 K = luminance 1)
  CF.GLSL_BB = [
    'uniform sampler2D tBlackbody;',
    'vec3 cfBlackbody(float theta){ vec4 b = texture(tBlackbody, vec2(clamp(theta / 1.4, 0., 1.) * (255. / 256.) + .5 / 256., .5));',
    '  float lum = exp(b.a * ' + CF.LOGLUM_SPAN.toFixed(1) + ' + (' + CF.LOGLUM_MIN.toFixed(1) + '));',
    '  vec3 c = b.rgb; return c * lum / max(dot(c, vec3(.2126, .7152, .0722)), 1e-4); }'
  ].join('\n');

  // ---------------------------------------------------------------- geometry
  CF.merge = function (geoms) {  // non-indexed merge of BufferGeometries with position + normal (+ uv)
    var pos = [], nor = [], uv = [], col = [];
    geoms.forEach(function (g0) {
      var g = g0.index ? g0.toNonIndexed() : g0;
      var p = g.attributes.position.array, n = g.attributes.normal ? g.attributes.normal.array : null;
      var u = g.attributes.uv ? g.attributes.uv.array : null, c = g.attributes.color ? g.attributes.color.array : null;
      for (var i = 0; i < p.length; i++) pos.push(p[i]);
      for (i = 0; i < p.length; i++) nor.push(n ? n[i] : 0);
      for (i = 0; i < p.length / 3 * 2; i++) uv.push(u ? u[i] : 0);
      for (i = 0; i < p.length; i++) col.push(c ? c[i] : 1);
    });
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return out;
  };
  CF.tint = function (geo, r, g, b) {  // give a geometry a vertex colour (used by merged props)
    var n = geo.attributes.position.count, c = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  };
  // push every vertex along its position direction by noise (rocks, lumps)
  CF.lumpy = function (geo, amount, freq, seed) {
    var p = geo.attributes.position, v = new THREE.Vector3();
    for (var i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      var n = CF.noise3(v.x * freq + seed, v.y * freq - seed * 0.7, v.z * freq + seed * 1.3) +
              0.5 * CF.noise3(v.x * freq * 2.3 - seed, v.y * freq * 2.3, v.z * freq * 2.3 + seed);
      v.multiplyScalar(1 + amount * n);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    return CF.smoothNormals(geo);
  };
  // smooth normals for non-indexed geometry (three's polyhedra): average the normals of coincident vertices
  CF.smoothNormals = function (geo) {
    geo.computeVertexNormals();
    if (geo.index) return geo;
    var p = geo.attributes.position, n = geo.attributes.normal, acc = {}, k, i;
    for (i = 0; i < p.count; i++) {
      k = Math.round(p.getX(i) * 1e4) + ',' + Math.round(p.getY(i) * 1e4) + ',' + Math.round(p.getZ(i) * 1e4);
      var a = acc[k] || (acc[k] = [0, 0, 0]); a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
    }
    for (i = 0; i < p.count; i++) {
      k = Math.round(p.getX(i) * 1e4) + ',' + Math.round(p.getY(i) * 1e4) + ',' + Math.round(p.getZ(i) * 1e4);
      var b = acc[k], l = Math.hypot(b[0], b[1], b[2]) || 1; n.setXYZ(i, b[0] / l, b[1] / l, b[2] / l);
    }
    n.needsUpdate = true; return geo;
  };

  // soft round puff with ragged noise edges (smoke sprites, breath), drawn once on a canvas
  CF.puffTexture = function (seed) {
    var S = 128, cv = document.createElement('canvas'); cv.width = cv.height = S;
    var cx = cv.getContext('2d'), img = cx.createImageData(S, S), r = seed || 3;
    for (var y = 0; y < S; y++) for (var x = 0; x < S; x++) {
      var dx = x / S * 2 - 1, dy = y / S * 2 - 1, d = Math.sqrt(dx * dx + dy * dy);
      var n = 0.6 * CF.noise3(x * 0.05 + r, y * 0.05, r) + 0.3 * CF.noise3(x * 0.12, y * 0.12 + r, 2 * r) + 0.15 * CF.noise3(x * 0.3, y * 0.3, r);
      var a = CF.clamp(1 - d * (1.05 - 0.35 * n), 0, 1); a = a * a * (3 - 2 * a);
      var k = (y * S + x) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.round(255 * a);
    }
    cx.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(cv); t.needsUpdate = true;
    return t;
  };

  // One small tiling texture replaces the noise the flame shaders used to compute per pixel (dozens of hashes each):
  // rg = a divergence-free vector field (the curl of value noise, +-1.5 packed into 0..1), b = three octaves of
  // value noise (contrast stretched around 0.5), a = one octave. 16 lattice cells across the tile; it repeats.
  CF.noiseTexture = function () {
    if (CF._noiseTex) return CF._noiseTex;
    var N = 256, C = 16, data = new Uint8Array(N * N * 4), psi = new Float32Array(N * N), i, x, y;
    function lattice(cells, seed) { var r = CF.fixedRng(seed), a = new Float32Array(cells * cells); for (var k = 0; k < a.length; k++) a[k] = r.next(); return a; }
    function value(lat, cells, gx, gy) {
      var X = Math.floor(gx), Y = Math.floor(gy), fx = gx - X, fy = gy - Y, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
      var x0 = ((X % cells) + cells) % cells, x1 = (x0 + 1) % cells, y0 = ((Y % cells) + cells) % cells, y1 = (y0 + 1) % cells;
      return CF.lerp(CF.lerp(lat[y0 * cells + x0], lat[y0 * cells + x1], u), CF.lerp(lat[y1 * cells + x0], lat[y1 * cells + x1], u), v);
    }
    var pL = lattice(C, 71), aL = lattice(C, 72), f1 = lattice(C, 73), f2 = lattice(C * 2, 74), f3 = lattice(C * 4, 75);
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) psi[y * N + x] = value(pL, C, (x + 0.5) / N * C, (y + 0.5) / N * C);
    var dq = 2 * C / N;   // lattice units between the two texels of a central difference
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      i = (y * N + x) * 4;
      var gx = (x + 0.5) / N * C, gy = (y + 0.5) / N * C;
      var ddx = (psi[y * N + (x + 1) % N] - psi[y * N + (x + N - 1) % N]) / dq, ddy = (psi[((y + 1) % N) * N + x] - psi[((y + N - 1) % N) * N + x]) / dq;
      var fbm = value(f1, C, gx, gy) * 0.5 + value(f2, C * 2, gx * 2, gy * 2) * 0.3 + value(f3, C * 4, gx * 4, gy * 4) * 0.2;
      data[i] = Math.round(255 * CF.clamp(0.5 + 0.5 * ddy / 1.5, 0, 1));
      data[i + 1] = Math.round(255 * CF.clamp(0.5 - 0.5 * ddx / 1.5, 0, 1));
      data[i + 2] = Math.round(255 * CF.clamp(0.5 + (fbm - 0.5) * 1.7, 0, 1));
      data[i + 3] = Math.round(255 * value(aL, C, gx, gy));
    }
    var t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    return (CF._noiseTex = t);
  };

  CF.fullscreenTriangle = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    return g;
  };
  CF.VERT_FS = 'in vec3 position; out vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }';
})();
