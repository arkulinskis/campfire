/* Campfire engine, part 4: the places.
   Three campsites built from code (no image files): "forest" (boreal midnight: spruce, tent, stump and axe),
   "snow" (lakeshore, first snow: birches, frozen lake, overturned canoe, full moon, maybe an aurora) and
   "desert" (canyon: sandstone walls, boulders, a dead juniper, quarter moon, the Milky Way at its best).
   Every surface is a MeshStandardMaterial patched with procedural shaders (albedo, roughness, bump, glow), so
   the fire's light, shadows and the sky's reflections work on everything. Layouts are fixed per place (it is
   *your* spot); the fire and its logs are random every visit. */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};
  var THREE = window.THREE;

  // ------------------------------------------------------------------ material patching
  // spec: {uniforms, decl (GLSL top), albedo (sets col, h), rough (sets rough), bump (k), emissive (adds to glow vec3), attr}
  CF.patch = function (mat, spec) {
    mat.userData.cf = spec;
    mat.customProgramCacheKey = function () { return spec.key || spec.albedo || 'cf'; };
    mat.onBeforeCompile = function (sh) {
      Object.keys(spec.uniforms || {}).forEach(function (k) { sh.uniforms[k] = spec.uniforms[k]; });
      var attr = spec.attr ? 'attribute float ' + spec.attr + '; varying float vAttr;\n' : '';
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + attr + 'varying vec3 vWP; varying vec3 vOP; varying vec3 vON;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vec4 cfW = vec4(transformed, 1.);\n#ifdef USE_INSTANCING\n cfW = instanceMatrix * cfW;\n#endif\n vWP = (modelMatrix * cfW).xyz; vOP = transformed; vON = objectNormal;' + (spec.attr ? ' vAttr = ' + spec.attr + ';' : ''));
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vOP; varying vec3 vON;' + (spec.attr ? ' varying float vAttr;' : '') + '\n' + CF.GLSL + '\n' + (spec.decl || '') + '\nfloat cfH = 0.; vec3 cfGlow = vec3(0.); float cfRough = -1.;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n{ vec3 col = diffuseColor.rgb; float h = 0.; float rough = -1.; vec3 glow = vec3(0.);\n' + (spec.albedo || '') + '\n diffuseColor.rgb = col; cfH = h; cfRough = rough; cfGlow = glow; }')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n if (cfRough >= 0.) roughnessFactor = cfRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (spec.bump ? ' normal = cfBump(-vViewPosition, normal, cfH, ' + spec.bump.toFixed(4) + ');' : ''))
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += cfGlow;');
    };
    return mat;
  };
  function std(o) { return new THREE.MeshStandardMaterial(Object.assign({ roughness: 0.92, metalness: 0 }, o || {})); }

  // shared uniforms every world material can read (engine updates them)
  CF.U = {
    uTime: { value: 0 }, uEmber: { value: new THREE.Color(0, 0, 0) }, uFirePos: { value: new THREE.Vector3(0, 0.3, 0) },
    uWet: { value: 0 }
  };

  // ------------------------------------------------------------------ sky
  var SKY_VS = 'varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.); gl_Position = p.xyww; }';
  var SKY_FS = [
    'varying vec3 vDir;',
    'uniform vec3 uZenith, uHorizon, uGround, uMoonDir, uMwAxis; uniform float uStars, uMilky, uTime, uMoon, uPhase, uAurora, uGlow;',
    'uniform vec4 uShootA, uShootB;',
    CF.GLSL,
    'vec3 starCol(float t){ return mix(vec3(1., .72, .45), mix(vec3(1., .96, .9), vec3(.75, .85, 1.), smoothstep(.5, 1., t)), smoothstep(0., .5, t)); }',
    'float starLayer(vec3 d, float scale, float thresh, out vec3 col){',
    '  vec3 p = d * scale; vec3 c = floor(p); vec3 o = cfHash3(c); float hv = cfHash(c + 17.3);',
    '  col = starCol(cfHash(c + 3.1)); if (hv < thresh) return 0.;',
    '  vec3 r = (c + .25 + .5 * o) - p; float dd = dot(r, r);',
    '  float m = pow((hv - thresh) / (1. - thresh), 3.);',
    '  return exp(-dd * 30.) * m; }',
    'void main(){',
    '  vec3 d = normalize(vDir); float h = d.y;',
    '  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0., 1.), .5));',
    '  float mwb = dot(d, uMwAxis); float band = exp(-mwb * mwb / .045);',
    '  float dust = cfFbm(d * 7.5 + 3.); float clouds = cfFbm(d * 3.2 + 11.);',
    '  float core = smoothstep(.3, 1., dot(d, normalize(vec3(.62, .25, -.74))));',
    '  float mw = band * (.35 + .9 * clouds) * (1. - .85 * smoothstep(.45, .7, dust) * exp(-mwb * mwb / .006));',
    '  col += uMilky * mw * mix(vec3(.55, .6, .75), vec3(.95, .82, .62), core * .7) * (.6 + 1.4 * core) * .03;',
    '  vec3 sc; float s = 0.;',
    '  s += starLayer(d, 520., .93 - band * .05, sc) * 1.0; vec3 acc = sc * s;',
    '  float s2 = starLayer(d, 190., .985, sc) * 7.; acc += sc * s2;',
    '  float s3 = starLayer(d, 70., .993, sc) * 30.; acc += sc * s3;',
    '  float tw = .65 + .35 * cfNoise(vec3(d.xz * 300., uTime * 3.)); float ext = smoothstep(-.02, .25, h);',
    '  col += acc * uStars * tw * ext * .1;',
    // moon: disc with phase + maria, and a halo in the air
    '  float md = dot(d, uMoonDir); float mr = .9998;',
    '  if (uMoon > 0.) {',
    '    float ang = acos(clamp(md, -1., 1.)); col += uMoon * vec3(.55, .62, .78) * (exp(-ang * 9.) * .03 + exp(-ang * 45.) * .05) * uGlow;',
    '    if (ang < .012) { vec3 t1 = normalize(cross(uMoonDir, vec3(0., 1., 0.))), t2 = cross(t1, uMoonDir);',
    '      vec2 q = vec2(dot(d - uMoonDir, t1), dot(d - uMoonDir, t2)) / .012; float z = sqrt(max(0., 1. - dot(q, q)));',
    '      vec3 n = vec3(q, z); float lit = smoothstep(-.05, .1, dot(n, normalize(vec3(cos(uPhase), 0., sin(uPhase)))));',
    '      float maria = .75 + .25 * smoothstep(.4, .65, cfFbm(vec3(q * 3., 2.)));',
    '      col = mix(col, vec3(1., .98, .92) * 2.2 * uMoon * maria * (.03 + lit), smoothstep(1., .92, length(q))); } }',
    // aurora curtains (snow place, some nights)
    '  if (uAurora > 0. && h > 0.) { float az = atan(d.x, -d.z);',
    '    float w = cfFbm(vec3(az * 2.2, uTime * .03, 1.)) ; float curtain = smoothstep(.0, .05, h - .06 - w * .08) * (1. - smoothstep(.12, .55, h - w * .15));',
    '    float rays = .5 + .5 * cfNoise(vec3(az * 40., h * 2. - uTime * .4, uTime * .1));',
    '    float lane = smoothstep(.35, .6, cfFbm(vec3(az * 1.3 + uTime * .006, 4., uTime * .02))) * smoothstep(-.6, .4, -d.z);',
    '    vec3 ac = mix(vec3(.15, 1., .45), vec3(.8, .25, .9), smoothstep(.15, .45, h));',
    '    col += ac * curtain * rays * lane * uAurora * .05; }',
    // shooting star: a short streak along a great circle
    '  if (uShootB.w > 0.) { vec3 a = uShootA.xyz, b = uShootB.xyz; vec3 n = normalize(cross(a, b)); float off = abs(dot(d, n));',
    '    float t = atan(dot(d, cross(n, a)), dot(d, a)) / max(acos(dot(a, b)), 1e-3); float head = uShootA.w;',
    '    float tail = smoothstep(head - .35, head, t) * step(t, head) * step(0., t);',
    '    col += vec3(.9, .95, 1.) * exp(-off * off * 4e6) * tail * uShootB.w * 1.6; }',
    '  col = mix(uGround, col, smoothstep(-.06, .01, h));',
    '  gl_FragColor = vec4(col, 1.); }'
  ].join('\n');

  function makeSky(o) {
    var mat = new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uZenith: { value: new THREE.Color().fromArray(o.zenith) }, uHorizon: { value: new THREE.Color().fromArray(o.horizon) },
        uGround: { value: new THREE.Color().fromArray(o.ground) }, uMoonDir: { value: new THREE.Vector3().fromArray(o.moonDir || [0, 1, 0]).normalize() },
        uMwAxis: { value: new THREE.Vector3().fromArray(o.mwAxis || [0.35, 0.45, 0.82]).normalize() },
        uStars: { value: o.stars }, uMilky: { value: o.milky }, uTime: CF.U.uTime, uMoon: { value: o.moon || 0 }, uPhase: { value: o.phase || 0 },
        uAurora: { value: 0 }, uGlow: { value: 1 }, uShootA: { value: new THREE.Vector4(0, 0, -1, 0) }, uShootB: { value: new THREE.Vector4(0, 0, -1, 0) }
      }
    });
    var m = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mat);
    m.frustumCulled = false; m.renderOrder = -10;
    return m;
  }

  // ------------------------------------------------------------------ ground (polar grid: fine near the fire)
  function groundGeo(height) {
    var rings = [0], r = 0.04;
    while (r < 140) { rings.push(r); r *= 1.075; r += 0.02; }
    var A = 120, pos = [], idx = [];
    for (var i = 0; i < rings.length; i++) for (var j = 0; j < A; j++) {
      var a = j / A * Math.PI * 2 + (i % 2) * Math.PI / A, x = Math.cos(a) * rings[i], z = Math.sin(a) * rings[i];
      pos.push(x, height(x, z), z);
    }
    for (i = 0; i < rings.length - 1; i++) for (j = 0; j < A; j++) {
      var a0 = i * A + j, a1 = i * A + (j + 1) % A, b0 = (i + 1) * A + j, b1 = (i + 1) * A + (j + 1) % A;
      idx.push(a0, a1, b0, a1, b1, b0);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
    return g;
  }

  var GROUND = {
    forest: [
      'float r = length(vWP.xz); float n1 = cfFbm(vec3(vWP.xz * 1.1, 0.)); float n2 = cfNoise(vec3(vWP.xz * 11., 1.));',
      'float ndl = smoothstep(.38, .72, cfFbm3(vec3(vWP.xz * 3.4, 4.)));',
      'float twig = smoothstep(.93, .99, cfNoise(vec3(vWP.x * 30. + vWP.z * 4., vWP.z * 3., 9.)));',
      'float lit = cfNoise(vec3(vWP.xz * 70., 3.)) * .6 + cfNoise(vec3(vWP.xz * 160., 6.)) * .4;',
      'col = mix(vec3(.05, .036, .027), vec3(.14, .075, .04), ndl * .75 + lit * .25);',
      'col = mix(col, vec3(.035, .055, .02), smoothstep(.55, .72, n1) * smoothstep(3., 5., r));',
      'col = mix(col, vec3(.2, .14, .09), twig * .7);',
      'float trod = (1. - smoothstep(1.2, 2.6, r)) * .55; col = mix(col, vec3(.06, .045, .035), trod);',
      'float pit = 1. - smoothstep(.42, .72, r + (n2 - .5) * .14);',
      'vec3 ash = mix(vec3(.014, .012, .011), vec3(.13, .125, .12), smoothstep(.35, .85, cfNoise(vec3(vWP.xz * 16., 2.))));',
      'col = mix(col, ash, pit) * (.8 + .4 * n2);',
      'h = n2 * .3 + ndl * .3 + twig + lit * .5; rough = .95;',
      'glow = uEmber * exp(-r * r / .05) * smoothstep(.45, .8, cfNoise(vec3(vWP.xz * 18., uTime * .3)));'
    ].join('\n'),
    snow: [
      'float r = length(vWP.xz); float n1 = cfFbm(vec3(vWP.xz * .9, 0.)); float n2 = cfNoise(vec3(vWP.xz * 13., 1.));',
      'float lake = smoothstep(-.02, -.09, vWP.y);',
      'float melt = 1. - smoothstep(.85, 1.35, r + (n1 - .5) * .35);',
      'vec3 snow = vec3(.7, .74, .8) * (.92 + .08 * n1);',
      'vec3 mud = vec3(.025, .02, .016) * (.7 + .6 * n2);',
      'col = mix(snow, mud, melt);',
      'float pit = 1. - smoothstep(.42, .7, r + (n2 - .5) * .14);',
      'col = mix(col, mix(vec3(.015), vec3(.12, .115, .11), smoothstep(.4, .8, cfNoise(vec3(vWP.xz * 16., 2.)))), pit);',
      'float patches = smoothstep(.45, .62, cfFbm(vec3(vWP.xz * .35, 7.)));',
      'vec3 ice = vec3(.012, .018, .024) + vec3(.02, .03, .04) * cfNoise(vec3(vWP.xz * 2., 3.));',
      'col = mix(col, mix(ice, snow * .9, patches), lake);',
      'rough = mix(mix(.7, .5, melt), mix(.07, .7, patches), lake);',
      'float sp = cfHash(floor(vWP * 70.)); if (sp > .992 && melt < .1 && lake < .5) rough = .05;',
      'h = n1 * 1.2 + n2 * .25 * melt + (cfFbm3(vec3(vWP.xz * 6., 5.)) * .3) * (1. - lake);',
      'glow = uEmber * exp(-r * r / .05) * smoothstep(.45, .8, cfNoise(vec3(vWP.xz * 18., uTime * .3)));'
    ].join('\n'),
    desert: [
      'float r = length(vWP.xz); float n1 = cfFbm(vec3(vWP.xz * .6, 0.)); float n2 = cfNoise(vec3(vWP.xz * 12., 1.));',
      'float rip = sin(dot(vWP.xz, vec2(.82, .57)) * 11. + n1 * 9.) * .5 + .5;',
      'col = vec3(.40, .26, .16) * (.82 + .3 * n1) * (.93 + .1 * rip);',
      'vec2 pc = cfCells(vec3(vWP.xz * 6., 3.)); float peb = 1. - smoothstep(.12, .2, pc.x); peb *= step(.7, cfHash(floor(vec3(vWP.xz * 6., 3.))));',
      'col = mix(col, vec3(.13, .08, .055), peb * .8);',
      'float trod = (1. - smoothstep(1.2, 2.6, r)) * .35; col = mix(col, col * .7, trod);',
      'float pit = 1. - smoothstep(.42, .72, r + (n2 - .5) * .14);',
      'col = mix(col, mix(vec3(.015), vec3(.13, .12, .11), smoothstep(.35, .85, cfNoise(vec3(vWP.xz * 16., 2.)))), pit);',
      'h = rip * .6 * (1. - pit) + peb * .8 + n2 * .2; rough = .97;',
      'glow = uEmber * exp(-r * r / .05) * smoothstep(.45, .8, cfNoise(vec3(vWP.xz * 18., uTime * .3)));'
    ].join('\n')
  };

  // ------------------------------------------------------------------ stones, rocks
  var ROCK = [
    'float n = cfFbm(vOP * 7. + vec3(cfHash(floor(vWP * .5)) * 20.)); float rr = length(vWP.xz);',
    'vec2 rc = cfCells(vOP * 9.); float grain = cfNoise(vOP * 55.); float pits = smoothstep(.06, .0, rc.y - rc.x);',
    'col = uRock * (.4 + .55 * n) * (.75 + .35 * grain) * (1. - pits * .18);',
    'float soot = (1. - smoothstep(.5, .85, rr)) * smoothstep(-.4, .6, -dot(normalize(vON.xz + 1e-4), normalize(vWP.xz + 1e-4)) + .3) * smoothstep(.0, .25, vWP.y + .1);',
    'col = mix(col, vec3(.012), clamp(soot * 1.3, 0., .92));',
    'col = mix(col, uMoss, smoothstep(.62, .75, cfNoise(vOP * 5.)) * smoothstep(.3, .8, vON.y) * uMossK);',
    'col = mix(col, vec3(.85, .88, .94), smoothstep(.35, .7, vON.y) * uSnowK * step(.85, rr));',
    'h = n + grain * .5 - pits * .15; rough = .88 - grain * .1;'
  ].join('\n');
  function rockMat(rock, moss, mossK, snowK) {
    return CF.patch(std(), { key: 'rock', albedo: ROCK, bump: 0.012,
      uniforms: { uRock: { value: new THREE.Color().fromArray(rock) }, uMoss: { value: new THREE.Color().fromArray(moss) },
                  uMossK: { value: mossK }, uSnowK: { value: snowK } }, decl: 'uniform vec3 uRock, uMoss; uniform float uMossK, uSnowK;' });
  }
  function rock(size, seed, flat) {
    var g = new THREE.IcosahedronGeometry(1, 4);
    CF.lumpy(g, 0.28, 1.3, seed);
    g.scale(size * (1 + (seed % 3) * 0.1), size * (flat || 0.7), size * 0.9);
    return g;
  }
  CF.rockGeo = rock; CF.rockMat = rockMat;   // cf-people.js seats people on rocks in the desert

  // ------------------------------------------------------------------ wood: logs, branches, trees
  // a log along X, radius r, length L; split = a half log with a flat face; aEnd marks caps (1) and the split face (2)
  CF.makeLogGeo = function (L, r, split, seed) {
    var seg = 18, rows = 10, pos = [], ends = [], idx = [], rng = CF.fixedRng(seed | 0);
    var bend = rng.range(-0.04, 0.04), knot = rng.range(0, 1);
    function rad(a, t) {
      var n = CF.noise3(Math.cos(a) * 1.6 + seed, Math.sin(a) * 1.6, t * 2.2) * 0.12 + CF.noise3(a * 3 + seed, t * 9, 1) * 0.05;
      return r * (1 + n) * (1 - 0.08 * Math.abs(t - 0.5));
    }
    var a0 = split ? 0 : 0, a1 = split ? Math.PI : Math.PI * 2, ring = split ? seg + 1 : seg;
    for (var i = 0; i <= rows; i++) {
      var t = i / rows, x = (t - 0.5) * L, yb = Math.sin(t * Math.PI) * bend * L;
      for (var j = 0; j < ring; j++) {
        var a = a0 + (a1 - a0) * j / (split ? seg : seg), rr = rad(a, t);
        pos.push(x, Math.sin(a) * rr + yb, Math.cos(a) * rr); ends.push(0);
      }
    }
    for (i = 0; i < rows; i++) for (j = 0; j < (split ? seg : seg); j++) {
      var p0 = i * ring + j, p1 = i * ring + (j + 1) % ring, q0 = p0 + ring, q1 = p1 + ring;
      idx.push(p0, p1, q0, p1, q1, q0);
    }
    var base = pos.length / 3;
    if (split) {   // the flat split face (y ~ 0 plane), lighter wood
      for (i = 0; i <= rows; i++) {
        t = i / rows; x = (t - 0.5) * L; yb = Math.sin(t * Math.PI) * bend * L;
        var rr0 = rad(0, t), rr1 = rad(Math.PI, t);
        pos.push(x, yb, rr0 * 0.98, x, yb, -rr1 * 0.98); ends.push(2, 2);
      }
      for (i = 0; i < rows; i++) { var k = base + i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
    }
    // end caps
    [0, rows].forEach(function (row, side) {
      var c = pos.length / 3, x0 = (row / rows - 0.5) * L, yb0 = Math.sin(row / rows * Math.PI) * bend * L;
      pos.push(x0, yb0 + (split ? r * 0.3 : 0), 0); ends.push(1);
      for (var j2 = 0; j2 < ring; j2++) {
        var a = a0 + (a1 - a0) * j2 / seg, rr = rad(a, row / rows) * 0.97;
        pos.push(x0, Math.sin(a) * rr + yb0, Math.cos(a) * rr); ends.push(1);
      }
      for (j2 = 0; j2 < (split ? seg : ring); j2++) {
        var n1 = c + 1 + j2, n2 = c + 1 + (j2 + 1) % ring;
        if (side === 0) idx.push(c, n1, n2); else idx.push(c, n2, n1);
      }
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.Float32BufferAttribute(ends, 1));
    g.setIndex(idx); g.computeVertexNormals();
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
    g.userData = { knot: knot };
    return g;
  };

  var LOG = [
    'float along = vOP.x; float ang = atan(vOP.z, vOP.y); float rr = length(vOP.yz);',
    'float ridge = cfFbm(vec3(along * 2.5, ang * 2.2, uSeed)); float fine = cfNoise(vec3(along * 4., ang * 16., uSeed + 3.));',
    'vec3 bark = uBark * (.55 + .7 * ridge) * (.75 + .4 * fine);',
    'if (uBirch > .5) { float mark = smoothstep(.62, .7, cfNoise(vec3(along * 1.2, ang * 9., uSeed)) + .25 * cfNoise(vec3(along * 30., ang, 1.)));',
    '  bark = mix(vec3(.62, .6, .55), vec3(.04), mark); }',
    'float rings = fract(rr * 55. + cfNoise(vOP * 9.) * 1.6); vec3 wood = uWood * (.8 + .25 * smoothstep(.4, .6, rings));',
    'vec3 base = vAttr > .5 ? wood : bark;',
    'vec3 cq = vOP * vec3(32., 48., 48.) + uSeed; vec2 cell = cfCells(cq);',
    'float fw = clamp(length(fwidth(cq)) * .5, .0, 1.); float crack = (1. - smoothstep(.0, .05 + fw, cell.y - cell.x)) * (1. - smoothstep(.25, .8, fw));',
    'float expo = (1. - smoothstep(.0, .42, vWP.y)) * (1. - smoothstep(.12, .62, length(vWP.xz))) + cfFbm3(vOP * 5. + uSeed) * .5 - .15;',
    'float charM = smoothstep(.0, .25, uChar * 1.3 + expo * .9 - .45);',
    'vec3 charC = mix(vec3(.012, .011, .01), vec3(.16, .155, .15), smoothstep(.55, .9, cfNoise(vOP * 22.)) * (1. - uHeat) * .8);',
    'col = mix(base, charC, charM);',
    'col *= 1. - uWetK * .35;',
    'h = vAttr > .5 ? rings * .3 : ridge * 1.2 + fine * .4; h = mix(h, (1. - crack) * .5 + cell.x * .15, charM);',
    'rough = mix(.92 - uWetK * .4, .8, charM);',
    'float pulse = .55 + .45 * cfNoise(vec3(vOP.x * 6., uTime * .9, uSeed + vOP.z * 6.));',
    'float hot = uHeat * charM * clamp(expo + .55, 0., 1.);',
    'float under = smoothstep(.3, -.6, vON.y) * .6 + .4;',
    'glow = vec3(1., .14, .015) * (crack * .3 + smoothstep(.45, .95, 1. - cell.x) * .025 + fw * .06) * hot * hot * under * pulse * uGlowK;'
  ].join('\n');
  CF.makeLogMat = function (sp, seed) {
    var u = {
      uBark: { value: new THREE.Color().fromArray(sp.bark) }, uWood: { value: new THREE.Color().fromArray(sp.wood) },
      uChar: { value: 0 }, uHeat: { value: 0 }, uSeed: { value: seed }, uWetK: { value: sp.wet ? 1 : 0 },
      uBirch: { value: sp.birch ? 1 : 0 }, uGlowK: { value: 1 }, uTime: CF.U.uTime
    };
    var m = CF.patch(std(), { key: 'log', albedo: LOG, bump: 0.004, attr: 'aEnd', uniforms: u,
      decl: 'uniform vec3 uBark, uWood; uniform float uChar, uHeat, uSeed, uWetK, uBirch, uGlowK, uTime;' });
    m.userData.u = u;
    return m;
  };

  // coals: lumpy chunks in a low heap, breathing glow
  var COAL = [
    'vec3 cq = vWP * 26.; vec2 cell = cfCells(cq); float fw = clamp(length(fwidth(cq)) * .5, 0., 1.); float crack = (1. - smoothstep(.0, .08 + fw, cell.y - cell.x)) * (1. - smoothstep(.3, .9, fw));',
    'float r = length(vWP.xz); float heap = 1. - smoothstep(.0, .36, r);',
    'float br = cfNoise(vec3(vWP.xz * 7., uTime * .35)) * .6 + cfNoise(vec3(vWP.xz * 19., uTime * .8)) * .4;',
    'float ash = smoothstep(.6, .9, cfNoise(vWP * 30.)) * (1. - uCoalHeat * .8);',
    'col = mix(vec3(.012, .011, .01), vec3(.16, .155, .15), ash * .7);',
    'h = cell.x + crack;',
    'rough = .85;',
    'float g = uCoalHeat * heap * (smoothstep(.2, .7, br) * (.55 + crack * 1.8) + .12) * (1. - ash * .85);',
    'glow = uCoalCol * g;'
  ].join('\n');

  function branch(geoms, p0, dir, len, rad, depth, rng, opt) {
    var seg = 7, g = new THREE.CylinderGeometry(rad * 0.62, rad, len, seg, 1, true);
    g.translate(0, len / 2, 0);
    var q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    g.applyQuaternion(q); g.translate(p0.x, p0.y, p0.z);
    geoms.push(CF.tint(g, opt.c[0], opt.c[1], opt.c[2]));
    if (depth <= 0 || rad < opt.minR) return;
    var n = rng.int(opt.kids[0], opt.kids[1]);
    for (var i = 0; i < n; i++) {
      var t = rng.range(0.45, 0.95), at = p0.clone().addScaledVector(dir.clone().normalize(), len * t);
      var side = new THREE.Vector3(rng.gauss(), rng.range(-0.2, 0.6) + opt.up, rng.gauss()).normalize();
      var nd = dir.clone().normalize().lerp(side, opt.spread).normalize();
      branch(geoms, at, nd, len * rng.range(0.45, 0.7), rad * rng.range(0.45, 0.65), depth - 1, rng, opt);
    }
    var end = p0.clone().addScaledVector(dir.clone().normalize(), len);
    var cont = dir.clone().normalize().add(new THREE.Vector3(rng.gauss() * 0.25, 0.05, rng.gauss() * 0.25)).normalize();
    branch(geoms, end, cont, len * 0.7, rad * 0.62, depth - 1, rng, opt);
  }

  function spruceGeo(seed, height) {
    var rng = CF.fixedRng(seed), geoms = [], H = height, tiers = Math.round(H * 1.6);
    var trunk = new THREE.CylinderGeometry(0.05, 0.16, H, 7, 1, true); trunk.translate(0, H / 2, 0);
    geoms.push(CF.tint(trunk, 0.09, 0.06, 0.045));
    for (var i = 0; i < tiers; i++) {
      var t = i / tiers, y = 0.9 + t * (H - 1.1), rad = (1 - t) * (0.25 * H) * rng.range(0.85, 1.12) + 0.12, hh = (H / tiers) * 1.9;
      var c = new THREE.ConeGeometry(rad, hh, 11, 3, true);
      var p = c.attributes.position;
      for (var k = 0; k < p.count; k++) {
        var x = p.getX(k), yy = p.getY(k), z = p.getZ(k), a = Math.atan2(z, x), d = Math.hypot(x, z);
        var jag = 1 + 0.32 * CF.noise3(Math.cos(a) * 2 + seed, Math.sin(a) * 2, i * 0.7) + 0.18 * Math.sin(a * 7 + i);
        p.setXYZ(k, Math.cos(a) * d * jag, yy - d * 0.25, Math.sin(a) * d * jag);
      }
      c.computeVertexNormals();
      c.translate(rng.gauss() * 0.04, y, rng.gauss() * 0.04);
      var shade = rng.range(0.8, 1.15);
      geoms.push(CF.tint(c, 0.035 * shade, 0.055 * shade, 0.035 * shade));
    }
    return CF.merge(geoms);
  }
  var NEEDLES = [
    'float n = cfNoise(vOP * vec3(14., 6., 14.)) * .6 + cfNoise(vOP * 40.) * .4;',
    'col = vColor * (.6 + .8 * n);',
    'col = mix(col, vec3(.8, .84, .9), uSnowCap * smoothstep(.2, .55, vON.y + n * .3 - .2) * step(.2, vOP.y));',
    'h = n; rough = .9;'
  ].join('\n');
  function needleMat(snowCap) {
    return CF.patch(std({ vertexColors: true, side: THREE.DoubleSide }), { key: 'needle' + snowCap, albedo: NEEDLES, bump: 0.02,
      uniforms: { uSnowCap: { value: snowCap } }, decl: 'uniform float uSnowCap;' });
  }
  var BARK = [
    'float n = cfNoise(vOP * vec3(30., 3., 30.)) * .6 + cfNoise(vOP * 9.) * .4;',
    'col = vColor * (.7 + .5 * n);',
    'if (uBirch > .5 && vColor.r > .3) { float m = smoothstep(.66, .74, cfNoise(vec3(atan(vOP.z, vOP.x) * 2., vOP.y * 9., vOP.x * 3.)) + .2 * cfNoise(vOP * 40.)); col = mix(col, vec3(.03), m); }',
    'col = mix(col, vec3(.8, .84, .9), uSnowCap * smoothstep(.55, .9, vON.y + n * .2));',
    'h = n; rough = .9;'
  ].join('\n');
  function barkMat(birch, snowCap) {
    return CF.patch(std({ vertexColors: true }), { key: 'bark' + birch + snowCap, albedo: BARK, bump: 0.01,
      uniforms: { uBirch: { value: birch }, uSnowCap: { value: snowCap } }, decl: 'uniform float uBirch, uSnowCap;' });
  }
  function birchGeo(seed, H) {
    var rng = CF.fixedRng(seed), geoms = [];
    var lean = new THREE.Vector3(rng.gauss() * 0.08, 1, rng.gauss() * 0.08).normalize();
    branch(geoms, new THREE.Vector3(0, -0.1, 0), lean, H * 0.55, 0.14, 4, rng,
           { kids: [2, 4], spread: 0.55, up: 0.6, minR: 0.012, c: [0.72, 0.7, 0.66] });
    return CF.merge(geoms);
  }
  function snagGeo(seed) {   // dead juniper: twisted, low, wide
    var rng = CF.fixedRng(seed), geoms = [];
    branch(geoms, new THREE.Vector3(0, -0.1, 0), new THREE.Vector3(0.3, 1, 0.1).normalize(), 1.3, 0.13, 4, rng,
           { kids: [2, 3], spread: 0.75, up: 0.15, minR: 0.012, c: [0.2, 0.17, 0.14] });
    return CF.merge(geoms);
  }

  // ------------------------------------------------------------------ props
  function tentGeo() {
    var g = [], W = 1.15, L = 2.3, H = 1.3;
    function panel(sign) {   // a sloped canvas panel with sag
      var p = new THREE.PlaneGeometry(L, Math.hypot(W, H), 16, 8), pa = p.attributes.position;
      for (var i = 0; i < pa.count; i++) {
        var x = pa.getX(i), y = pa.getY(i), u = (y / Math.hypot(W, H)) + 0.5, sag = Math.sin(u * Math.PI) * Math.sin((x / L + 0.5) * Math.PI) * 0.06;
        pa.setXYZ(i, x, H * u, sign * W * (1 - u) - sign * sag * 0.3);
        pa.setY(i, H * u - sag);
      }
      p.computeVertexNormals(); return CF.tint(p, 0.5, 0.39, 0.24);
    }
    g.push(panel(1), panel(-1));
    var back = new THREE.BufferGeometry();
    back.setAttribute('position', new THREE.Float32BufferAttribute([-L / 2, 0, -W, -L / 2, 0, W, -L / 2, H, 0], 3));
    back.computeVertexNormals(); g.push(CF.tint(back, 0.46, 0.36, 0.22));
    // front: two flaps tied back + dark opening
    var dark = new THREE.BufferGeometry();
    dark.setAttribute('position', new THREE.Float32BufferAttribute([L / 2 - 0.25, 0, -W * 0.92, L / 2 - 0.25, H * 0.95, 0, L / 2 - 0.25, 0, W * 0.92], 3));
    dark.computeVertexNormals(); g.push(CF.tint(dark, 0.02, 0.016, 0.012));
    [-1, 1].forEach(function (s) {
      var f = new THREE.BufferGeometry();
      f.setAttribute('position', new THREE.Float32BufferAttribute([L / 2, 0, s * W, L / 2, H, 0, L / 2 + 0.05, 0.2, s * W * 0.35], 3));
      f.computeVertexNormals(); g.push(CF.tint(f, 0.52, 0.41, 0.26));
    });
    var pole = new THREE.CylinderGeometry(0.015, 0.015, H + 0.12, 5); pole.translate(L / 2 + 0.02, (H + 0.12) / 2, 0); g.push(CF.tint(pole, 0.15, 0.1, 0.07));
    var ridge = new THREE.CylinderGeometry(0.01, 0.01, L + 0.1, 4); ridge.rotateZ(Math.PI / 2); ridge.translate(0, H + 0.01, 0); g.push(CF.tint(ridge, 0.2, 0.17, 0.12));
    [[L / 2 + 0.9, 0], [-L / 2 - 0.9, 0]].forEach(function (pt) {  // guy ropes
      var a = new THREE.Vector3(pt[0] > 0 ? L / 2 : -L / 2, H, 0), b = new THREE.Vector3(pt[0], 0, pt[1]), d = b.clone().sub(a);
      var c = new THREE.CylinderGeometry(0.004, 0.004, d.length(), 3); c.translate(0, d.length() / 2, 0);
      c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize())); c.translate(a.x, a.y, a.z);
      g.push(CF.tint(c, 0.5, 0.45, 0.35));
    });
    return CF.merge(g);
  }
  var CANVAS = [
    'float weave = sin(vOP.x * 260.) * sin(vOP.y * 260. + vOP.z * 260.) * .5 + .5;',
    'float dirt = cfFbm(vOP * 2.5); col = vColor * (.85 + .25 * dirt) * (1. - .25 * smoothstep(.1, -.05, vOP.y - .25) * dirt);',
    'col = mix(col, vec3(.82, .86, .92), uSnowCap * smoothstep(.45, .8, vON.y));',
    'h = weave * .3 + dirt; rough = .9;'
  ].join('\n');
  function canvasMat(snowCap) {
    return CF.patch(std({ vertexColors: true, side: THREE.DoubleSide }), { key: 'canvas' + snowCap, albedo: CANVAS, bump: 0.004,
      uniforms: { uSnowCap: { value: snowCap } }, decl: 'uniform float uSnowCap;' });
  }
  function canoeGeo() {   // overturned cedar-strip canoe
    var g = new THREE.SphereGeometry(1, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2), p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var taper = 1 - Math.pow(Math.abs(x), 2.2) * 0.9;
      p.setXYZ(i, x * 2.4, y * 0.36 * (0.75 + 0.25 * taper), z * 0.45 * taper);
    }
    g.computeVertexNormals();
    return CF.tint(g, 0.06, 0.13, 0.08);
  }
  function stumpAxeGeo() {
    var g = [];
    var s = new THREE.CylinderGeometry(0.26, 0.3, 0.42, 16); s.translate(0, 0.21, 0); g.push(CF.tint(s, 0.22, 0.15, 0.09));
    var top = new THREE.CircleGeometry(0.255, 16); top.rotateX(-Math.PI / 2); top.translate(0, 0.421, 0); g.push(CF.tint(top, 0.42, 0.3, 0.18));
    var dir = new THREE.Vector3(-0.8, 0.6, 0.1).normalize(), L = 0.68;
    var h = new THREE.CylinderGeometry(0.014, 0.018, L, 7); h.translate(0, L / 2, 0);
    h.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)); h.translate(0.04, 0.44, 0); g.push(CF.tint(h, 0.34, 0.22, 0.12));
    var head = new THREE.BoxGeometry(0.15, 0.09, 0.022); head.translate(0.05, 0.43, 0); g.push(CF.tint(head, 0.09, 0.09, 0.1));
    return CF.merge(g);
  }
  function bedrollGeo() {
    var g = [];
    var r = new THREE.CylinderGeometry(0.17, 0.17, 0.85, 18); r.rotateZ(Math.PI / 2); r.translate(0, 0.17, 0); g.push(CF.tint(r, 0.42, 0.08, 0.06));
    [-0.25, 0.25].forEach(function (x) { var b = new THREE.TorusGeometry(0.172, 0.012, 4, 18); b.rotateY(Math.PI / 2); b.translate(x, 0.17, 0); g.push(CF.tint(b, 0.12, 0.08, 0.05)); });
    return CF.merge(g);
  }
  function potGeo() {
    var pts = [[0, 0], [0.075, 0], [0.085, 0.02], [0.07, 0.16], [0.045, 0.2], [0.05, 0.215], [0.0, 0.215]].map(function (q) { return new THREE.Vector2(q[0], q[1]); });
    var g = new THREE.LatheGeometry(pts, 20);
    var spout = new THREE.CylinderGeometry(0.008, 0.016, 0.1, 6); spout.rotateZ(-0.9); spout.translate(0.1, 0.12, 0);
    return CF.merge([CF.tint(g, 0.035, 0.033, 0.032), CF.tint(spout, 0.035, 0.033, 0.032)]);
  }
  function cliffGeo(seed, r0, r1, H) {   // a canyon wall ring segment, strata and overhangs
    var A = 140, V = 40, pos = [], idx = [];
    for (var i = 0; i <= V; i++) for (var j = 0; j <= A; j++) {
      var a = j / A * Math.PI * 1.55 - Math.PI * 0.95, v = i / V, y = v * H;
      var rr = r0 + (r1 - r0) * (0.5 + 0.5 * CF.noise3(Math.cos(a) * 2 + seed, Math.sin(a) * 2, 0));
      rr += CF.noise3(a * 6, v * 5, seed) * 3 + Math.sin(v * 14 + CF.noise3(a * 4, 0, seed) * 3) * 0.7 - v * 4;
      var top = H * (0.75 + 0.35 * CF.noise3(a * 3.3, seed, 1));
      y = Math.min(y, top);
      pos.push(Math.cos(a) * rr, y - 0.5, Math.sin(a) * rr);
    }
    for (i = 0; i < V; i++) for (j = 0; j < A; j++) { var a0 = i * (A + 1) + j; idx.push(a0, a0 + 1, a0 + A + 1, a0 + 1, a0 + A + 2, a0 + A + 1); }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3 * 2), 2));
    return g;
  }
  var CLIFF = [
    'float strata = cfNoise(vec3(vWP.y * 1.6 + cfNoise(vWP * .08) * 3., 0., 1.));',
    'col = mix(vec3(.30, .12, .06), vec3(.42, .24, .13), strata) * (.75 + .4 * cfFbm(vWP * .25));',
    'col = mix(col, vec3(.1, .07, .06), smoothstep(.6, .8, cfNoise(vec3(vWP.x * .5, vWP.y * .05, vWP.z * .5))) * .6);',
    'h = strata + cfFbm(vWP * .7); rough = .95;'
  ].join('\n');

  // ------------------------------------------------------------------ places
  CF.PLACES = {
    forest: {
      name: 'Boreal midnight', sky: { zenith: [0.0035, 0.005, 0.011], horizon: [0.014, 0.018, 0.028], ground: [0.002, 0.002, 0.002], stars: 1.0, milky: 1.0, moon: 0, mwAxis: [0.4, 0.3, 0.86] },
      fog: [0.0035, 0.0045, 0.0075], fogDensity: 0.045, moon: { color: [0.55, 0.62, 0.85], intensity: 0.012, dir: [-0.4, 0.8, -0.3] }, hemi: [0.012, 0.004],
      motes: 'fireflies', exposure: 1.0, smokeAmb: [0.004, 0.005, 0.008],
      woods: ['pine', 'birch', 'maple'],
      height: function (x, z) { var r = Math.hypot(x, z); return CF.smooth(4, 14, r) * (CF.noise3(x * 0.08, z * 0.08, 1) * 0.9 + 0.3); }
    },
    snow: {
      name: 'Lakeshore, first snow', sky: { zenith: [0.006, 0.01, 0.022], horizon: [0.024, 0.032, 0.05], ground: [0.004, 0.005, 0.007], stars: 0.75, milky: 0.45, moon: 1, phase: 1.4, moonDir: [0.55, 0.3, -0.78], mwAxis: [0.3, 0.55, 0.78] },
      fog: [0.009, 0.012, 0.02], fogDensity: 0.022, moon: { color: [0.62, 0.72, 0.95], intensity: 0.07, dir: [0.55, 0.3, -0.78] }, hemi: [0.02, 0.012],
      motes: 'snow', exposure: 0.42, smokeAmb: [0.01, 0.012, 0.02], aurora: 0.45,
      woods: ['birch', 'spruce', 'ash'],
      height: function (x, z) {
        var shore = -7 - CF.noise3(x * 0.07, 0, 3) * 3 - Math.abs(x) * 0.05;
        if (z < shore) return -0.12;
        var r = Math.hypot(x, z); return CF.smooth(0, 1.5, z - shore) * (CF.smooth(4, 12, r) * (CF.noise3(x * 0.1, z * 0.1, 2) * 0.6 + 0.3) + 0.02) - 0.1 * (1 - CF.smooth(0, 1.5, z - shore));
      }
    },
    desert: {
      name: 'Desert canyon', sky: { zenith: [0.0026, 0.003, 0.0072], horizon: [0.016, 0.014, 0.018], ground: [0.003, 0.002, 0.002], stars: 1.35, milky: 1.6, moon: 0.6, phase: 0.2, moonDir: [-0.82, 0.13, -0.56], mwAxis: [0.25, 0.25, 0.94] },
      fog: [0.004, 0.0038, 0.0045], fogDensity: 0.011, moon: { color: [0.75, 0.7, 0.62], intensity: 0.02, dir: [-0.82, 0.22, -0.56] }, hemi: [0.01, 0.006],
      motes: 'none', exposure: 0.8, smokeAmb: [0.005, 0.005, 0.006],
      woods: ['mesquite', 'juniper', 'pinon'],
      height: function (x, z) { var r = Math.hypot(x, z); return CF.smooth(5, 25, r) * (CF.noise3(x * 0.04, z * 0.04, 5) * 1.6 + 0.4) + CF.smooth(20, 40, r) * 1.5; }
    }
  };

  CF.buildWorld = function (place, renderer, quality) {
    var P = CF.PLACES[place] || CF.PLACES.forest, scene = new THREE.Scene(), W = { scene: scene, place: place, def: P, casters: [] };
    var sky = makeSky(P.sky); scene.add(sky); W.sky = sky;
    W.fog = new THREE.FogExp2(new THREE.Color().fromArray(P.fog), P.fogDensity); scene.fog = W.fog;
    // environment reflections from the sky
    try {
      var pm = new THREE.PMREMGenerator(renderer), es = new THREE.Scene(), s2 = makeSky(P.sky);
      s2.material.uniforms.uStars.value *= 0.5; es.add(s2);
      W.env = pm.fromScene(es, 0.02, 0.1, 1000).texture; pm.dispose();
      scene.environment = W.env;
    } catch (e) { W.env = null; }
    // lights: moon/starlight + sky
    var moon = new THREE.DirectionalLight(new THREE.Color().fromArray(P.moon.color), P.moon.intensity * 10);
    moon.position.fromArray(P.moon.dir).multiplyScalar(40); scene.add(moon); W.moon = moon;
    var hemi = new THREE.HemisphereLight(new THREE.Color(0.5, 0.6, 1.0), new THREE.Color(0.3, 0.25, 0.2), P.hemi[0] * 10); scene.add(hemi); W.hemi = hemi;
    // ground
    var gmat = CF.patch(std(), { key: 'ground-' + place, albedo: GROUND[place], bump: 0.01, uniforms: { uEmber: CF.U.uEmber, uTime: CF.U.uTime }, decl: 'uniform vec3 uEmber; uniform float uTime;' });
    if (W.env) gmat.envMapIntensity = place === 'snow' ? 1.0 : 0.4;
    var ground = new THREE.Mesh(groundGeo(P.height), gmat); ground.receiveShadow = true; scene.add(ground); W.ground = ground;
    W.height = P.height;
    // stone ring
    var stoneM = rockMat(place === 'desert' ? [0.2, 0.13, 0.09] : [0.13, 0.13, 0.125], [0.03, 0.05, 0.02], place === 'forest' ? 0.8 : 0, place === 'snow' ? 1 : 0);
    var ringR = CF.fixedRng(place.length * 7);
    var nst = 14;
    for (var i = 0; i < nst; i++) {
      var a = i / nst * Math.PI * 2 + ringR.gauss() * 0.05, rr = 0.66 + ringR.gauss() * 0.03, sz = ringR.range(0.09, 0.14);
      var st = new THREE.Mesh(rock(sz, i * 3 + 1, 0.75), stoneM);
      st.position.set(Math.cos(a) * rr, sz * 0.35, Math.sin(a) * rr); st.rotation.y = ringR.range(0, 6.28);
      st.castShadow = st.receiveShadow = true; scene.add(st); W.casters.push(st);
    }
    // coals
    var coalU = { uCoalHeat: { value: 0 }, uCoalCol: { value: new THREE.Color(1, 0.3, 0.05) }, uTime: CF.U.uTime };
    var coalM = CF.patch(std(), { key: 'coal', albedo: COAL, bump: 0.01, uniforms: coalU, decl: 'uniform float uCoalHeat; uniform vec3 uCoalCol; uniform float uTime;' });
    var coalG = new THREE.IcosahedronGeometry(1, 1); CF.lumpy(coalG, 0.35, 1.7, 3);
    var NC = quality === 'low' ? 60 : 110, coals = new THREE.InstancedMesh(coalG, coalM, NC), mtx = new THREE.Matrix4(), cr = CF.fixedRng(5);
    W.coalBase = [];
    for (i = 0; i < NC; i++) {
      var ca = cr.range(0, 6.28), cd = Math.sqrt(cr.next()) * 0.36, cs = cr.range(0.018, 0.045);
      var cy = (1 - cd / 0.4) * 0.05 + cs * 0.4;
      W.coalBase.push([Math.cos(ca) * cd, cy, Math.sin(ca) * cd, cs, cr.range(0, 6.28)]);
      mtx.compose(new THREE.Vector3(Math.cos(ca) * cd, cy, Math.sin(ca) * cd), new THREE.Quaternion().setFromEuler(new THREE.Euler(cr.range(0, 3), cr.range(0, 3), 0)), new THREE.Vector3(cs, cs * 0.7, cs));
      coals.setMatrixAt(i, mtx);
    }
    coals.receiveShadow = true; scene.add(coals); W.coals = coals; W.coalU = coalU;
    // place-specific scenery
    var trees = [], tr = CF.fixedRng(place.length * 31 + 2);
    function okSpot(x, z) {
      if (Math.hypot(x, z) < 5.5) return false;
      if (Math.hypot(x - 0, z - 4.2) < 4 && z > 0) return false;           // keep the view from the seat open
      return true;
    }
    if (place === 'forest') {
      var nm = needleMat(0), bm = barkMat(0, 0);
      var variants = [0, 1, 2, 3].map(function (k) { return spruceGeo(100 + k, 9 + k * 1.6); });
      for (i = 0; i < 95; i++) {
        var ta = tr.range(0, 6.28), td = 6 + Math.pow(tr.next(), 0.7) * 34, tx = Math.cos(ta) * td, tz = Math.sin(ta) * td;
        if (!okSpot(tx, tz)) continue;
        var t = new THREE.Mesh(variants[i % 4], nm);
        t.position.set(tx, P.height(tx, tz) - 0.1, tz); t.rotation.y = tr.range(0, 6.28); var sc = tr.range(0.75, 1.3); t.scale.set(sc, sc * tr.range(0.9, 1.15), sc);
        scene.add(t); trees.push(t); if (td < 11) { t.castShadow = true; W.casters.push(t); }
      }
      var tent = new THREE.Mesh(tentGeo(), canvasMat(0)); tent.position.set(-3.3, 0, -2.0); tent.rotation.y = -0.55;
      tent.castShadow = tent.receiveShadow = true; scene.add(tent); W.casters.push(tent);
      var stump = new THREE.Mesh(stumpAxeGeo(), barkMat(0, 0)); stump.position.set(2.3, 0, -1.4); stump.rotation.y = 2.2; stump.castShadow = true; scene.add(stump); W.casters.push(stump);
      var b1 = new THREE.Mesh(rock(0.6, 41, 0.6), rockMat([0.12, 0.12, 0.12], [0.03, 0.05, 0.02], 1, 0)); b1.position.set(4.2, 0.1, 1.2); b1.castShadow = true; scene.add(b1);
      W.wood = { x: 2.1, z: 1.8 };
    } else if (place === 'snow') {
      var bmat = barkMat(1, 1), nmat = needleMat(1);
      var bv = [0, 1, 2].map(function (k) { return birchGeo(300 + k, 7 + k); });
      var sv = [0, 1].map(function (k) { return spruceGeo(200 + k, 8 + k * 2); });
      for (i = 0; i < 80; i++) {
        ta = tr.range(-0.1, 3.3); td = 6 + Math.pow(tr.next(), 0.7) * 30; tx = Math.cos(ta) * td; tz = Math.sin(ta) * td * 0.9 + 1;
        if (!okSpot(tx, tz) || P.height(tx, tz) < -0.05) continue;
        var isB = tr.chance(0.6);
        t = new THREE.Mesh(isB ? bv[i % 3] : sv[i % 2], isB ? bmat : nmat);
        t.position.set(tx, P.height(tx, tz) - 0.1, tz); t.rotation.y = tr.range(0, 6.28); sc = tr.range(0.8, 1.25); t.scale.set(sc, sc, sc);
        scene.add(t); trees.push(t); if (td < 11) { t.castShadow = true; W.casters.push(t); }
      }
      var canoe = new THREE.Mesh(canoeGeo(), canvasMat(1)); canoe.position.set(-4.2, 0.0, -1.0); canoe.rotation.y = 0.25; canoe.scale.setScalar(0.85); canoe.castShadow = canoe.receiveShadow = true; scene.add(canoe); W.casters.push(canoe);
      // the far shore: a dark treeline across the ice
      var farG = [0, 1, 2].map(function (k) { return spruceGeo(400 + k, 10 + k * 2); });
      for (i = 0; i < 70; i++) {
        var fx = tr.range(-110, 110), fz = -48 - tr.range(0, 18) - Math.abs(fx) * 0.1;
        var ft = new THREE.Mesh(farG[i % 3], nmat); ft.position.set(fx, -0.2, fz); var fs = tr.range(1.0, 1.7); ft.scale.set(fs, fs * tr.range(0.9, 1.3), fs); scene.add(ft);
      }
      var bs = new THREE.Mesh(rock(0.5, 51, 0.55), rockMat([0.11, 0.11, 0.12], [0, 0, 0], 0, 1)); bs.position.set(3.6, 0.05, -2.2); bs.castShadow = true; scene.add(bs);
      W.wood = { x: 2.2, z: 1.6 };
    } else {
      var cliffM = CF.patch(std(), { key: 'cliff', albedo: CLIFF, bump: 0.05 });
      var c1 = new THREE.Mesh(cliffGeo(3, 85, 125, 26), cliffM); scene.add(c1);
      var rmat = rockMat([0.26, 0.13, 0.07], [0, 0, 0], 0, 0);
      [[5.5, -3.5, 1.3], [-6.5, -4, 1.8], [7.5, 2.5, 0.9], [-4.6, 3.8, 0.7], [14, -12, 2.6], [-15, -9, 3.2], [3.2, -2.4, 0.35], [24, -30, 6], [-30, -26, 8]].forEach(function (b, k) {
        var m = new THREE.Mesh(rock(b[2], 60 + k, 0.62), rmat); m.position.set(b[0], b[2] * 0.25, b[1]); m.rotation.y = k;
        m.castShadow = m.receiveShadow = true; scene.add(m); if (Math.hypot(b[0], b[1]) < 9) W.casters.push(m);
      });
      var snag = new THREE.Mesh(snagGeo(9), barkMat(0, 0)); snag.position.set(-3.2, 0, -2.6); snag.scale.setScalar(1.3); snag.castShadow = true; scene.add(snag); W.casters.push(snag);
      var shrubM = needleMat(0);
      for (i = 0; i < 40; i++) {
        ta = tr.range(0, 6.28); td = 4 + tr.next() * 30; tx = Math.cos(ta) * td; tz = Math.sin(ta) * td;
        if (!okSpot(tx, tz)) continue;
        var sg = new THREE.IcosahedronGeometry(1, 2); CF.lumpy(sg, 0.4, 2, i); CF.tint(sg, 0.07, 0.07, 0.045);
        var sh = new THREE.Mesh(sg, shrubM); var ss = tr.range(0.2, 0.5); sh.scale.set(ss * 1.3, ss * 0.7, ss * 1.2); sh.position.set(tx, P.height(tx, tz) + ss * 0.2, tz); scene.add(sh);
      }
      var roll = new THREE.Mesh(bedrollGeo(), canvasMat(0)); roll.position.set(-2.9, 0, -1.9);   // clear of the seats people sit on (cf-people.js)
      roll.rotation.y = 0.9; roll.castShadow = true; scene.add(roll); W.casters.push(roll);
      var pot = new THREE.Mesh(potGeo(), std({ vertexColors: true, roughness: 0.55, metalness: 0.6 })); pot.position.set(0.68, 0.11, 0.28); pot.rotation.y = 2; pot.castShadow = true; scene.add(pot); W.casters.push(pot);
      W.wood = { x: 2.0, z: 1.7 };
    }
    // a seat log across the fire, and the woodpile you take logs from
    var seatSp = { bark: place === 'snow' ? [0.6, 0.58, 0.54] : [0.12, 0.08, 0.05], wood: [0.5, 0.36, 0.22], birch: place === 'snow' };
    var seat = new THREE.Mesh(CF.makeLogGeo(1.8, 0.17, false, 77), CF.makeLogMat(seatSp, 7));
    seat.position.set(0.3, 0.15, -2.4); seat.rotation.y = 0.15; seat.castShadow = seat.receiveShadow = true; scene.add(seat); W.casters.push(seat);
    W.trees = trees;
    W.motesKind = P.motes;
    W.dispose = function () {
      scene.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); }); });
      if (W.env) W.env.dispose();
    };
    return W;
  };
})();
