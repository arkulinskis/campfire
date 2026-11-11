/* Campfire engine, part 5: sound, made live (no recordings).
   Fire, after Andy Farnell's "Designing Sound" (MIT Press 2010) fire model: crackling + hissing + lapping.
   - Crackles: a bank of synthesised micro-transients (filtered noise bursts with secondary clicks), played by a
     self-exciting (Hawkes) random process: every crackle briefly raises the chance of another, so they come in
     natural clusters. The base rate follows how much wood is burning, and each species crackles differently.
     Big pops also throw sparks (the engine listens). Each sound is panned to the log it came from.
   - Hiss: high band noise, slowly wandering; extra steam hiss while a wet branch dries.
   - Lapping / roar: low noise whose level follows the simulated flames' own flicker (read back from the GPU).
   - Sap whistles: faint tonal squeals from boiling resin.
   Night: crickets chirping at the rate Dolbear's law gives for the night's temperature, wind gusts (the same
   gusts bend the flames and the trees), and each place's own company. Forest: a brook somewhere behind you
   (bubbles, each a tiny sine: Minnaert), great horned owls, sometimes two answering each other. Snow: lake ice
   singing, wolves, a boreal owl's run of toots, frost cracking in the trees, the hush of falling snow when it
   snows. Desert: coyotes echoing off the canyon walls, a poorwill, the coffee pot simmering by the stones when
   the fire is hot, and thunder rolling in long after the lightning. Things at a place have a bearing: turn
   around and they move across your ears. Reverb from a synthesised impulse response per place.
   Events are scheduled ahead of time, so the fire keeps crackling in a background tab. */
(function () {
  'use strict';
  var CF = window.CF = window.CF || {};

  function Audio() { this.ctx = null; this.on = false; this.place = 'forest'; this.vol = { fire: 0.9, night: 0.7, master: 0.9 }; }
  CF.Audio = Audio;

  Audio.prototype.start = function () {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    var c = this.ctx = new AC({ latencyHint: 'playback' }), self = this;
    this.sr = c.sampleRate;
    this.master = c.createGain(); this.master.gain.value = 0;
    var comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(c.destination);
    this.fire = c.createGain(); this.fire.gain.value = this.vol.fire; this.fire.connect(this.master);
    this.night = c.createGain(); this.night.gain.value = this.vol.night; this.night.connect(this.master);
    this.verb = c.createConvolver(); this.verbOut = c.createGain(); this.verbOut.gain.value = 0.9;
    this.verb.connect(this.verbOut); this.verbOut.connect(this.master);
    this.echo = c.createDelay(3); this.echoFb = c.createGain(); this.echoLp = c.createBiquadFilter(); this.echoLp.frequency.value = 1800;
    this.echoIn = c.createGain(); this.echoIn.gain.value = 0;
    this.echoIn.connect(this.echo); this.echo.connect(this.echoLp); this.echoLp.connect(this.echoFb); this.echoFb.connect(this.echo); this.echoLp.connect(this.night);
    this.white = this.noiseBuf('white', 6); this.pink = this.noiseBuf('pink', 6); this.brown = this.noiseBuf('brown', 6);
    this.bank = []; for (var i = 0; i < 48; i++) this.bank.push(this.crackleBuf(i));
    this.pops = []; for (i = 0; i < 12; i++) this.pops.push(this.popBuf(i));
    // continuous fire layers
    this.roar = this.loop(this.brown, [['lowpass', 260, 0.7], ['peaking', 90, 1.2, 6]], this.fire, 0);
    this.lap = this.loop(this.pink, [['bandpass', 520, 0.6]], this.fire, 0);
    this.hiss = this.loop(this.white, [['highpass', 2600, 0.6], ['lowpass', 9000, 0.7]], this.fire, 0);
    this.steam = this.loop(this.white, [['bandpass', 5200, 2.5]], this.fire, 0);
    // night layers
    this.wind = this.loop(this.pink, [['bandpass', 420, 0.9]], this.night, 0);
    this.windHi = this.loop(this.white, [['highpass', 2400, 0.5], ['lowpass', 7000, 0.5]], this.night, 0);
    this.windF = this.wind.filters[0];
    this.hush = this.loop(this.white, [['highpass', 6500, 0.5], ['lowpass', 12000, 0.5]], this.night, 0);   // snow falling
    this.hawkes = 0; this.nextBase = 0; this.lastT = c.currentTime; this.sched = {};
    this.crickets = [];
    this.setPlace(this.place);
    this.master.gain.setTargetAtTime(this.vol.master, c.currentTime + 0.05, 1.2);
    this.timer = setInterval(function () { try { self.tick(); } catch (e) { /* keep going */ } }, 40);
    this.on = true;
  };
  Audio.prototype.stop = function () { if (this.timer) clearInterval(this.timer); if (this.ctx) this.ctx.close(); this.ctx = null; this.on = false; };
  Audio.prototype.suspend = function (yes) { if (!this.ctx) return; if (yes) this.ctx.suspend(); else this.ctx.resume(); };
  Audio.prototype.setVolume = function (which, v) {
    this.vol[which] = v; if (!this.ctx) return;
    var node = which === 'fire' ? this.fire : which === 'night' ? this.night : this.master;
    node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.15);
  };

  // ---------------------------------------------------------------- buffers
  Audio.prototype.noiseBuf = function (kind, sec) {
    var n = Math.floor(this.sr * sec), b = this.ctx.createBuffer(2, n, this.sr), R = CF.rng;
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch), b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
      for (var i = 0; i < n; i++) {
        var w = R.next() * 2 - 1;
        if (kind === 'white') d[i] = w * 0.5;
        else if (kind === 'pink') { // Paul Kellet's filter
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.09; b6 = w * 0.115926;
        } else { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }
      }
      // crossfade the loop point
      var f = Math.floor(this.sr * 0.05);
      for (i = 0; i < f; i++) { var t = i / f; d[i] = d[i] * t + d[n - f + i] * (1 - t); }
    }
    return b;
  };
  function biquad(type, f, q, sr) {   // RBJ cookbook, returns a stateful filter function
    var w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), b0, b1, b2, a0, a1, a2;
    if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; } else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; } else { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
    a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
    var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return function (x) { var y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
  }
  Audio.prototype.crackleBuf = function (k) {
    var R = CF.rng, sr = this.sr, dur = R.range(0.012, 0.05), n = Math.floor(sr * dur), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    var f = R.logUniform(900, 7000), bp = biquad('bp', f, R.range(0.8, 4), sr), hp = biquad('hp', 400, 0.7, sr);
    var tau = R.range(0.0012, 0.006) * sr, clicks = [[0, 1]];
    for (var c = 0, nc = R.int(0, 3); c < nc; c++) clicks.push([Math.floor(R.range(0.002, dur * 0.7) * sr), R.range(0.2, 0.7)]);
    for (var i = 0; i < n; i++) {
      var e = 0;
      for (c = 0; c < clicks.length; c++) if (i >= clicks[c][0]) e += clicks[c][1] * Math.exp(-(i - clicks[c][0]) / tau);
      d[i] = hp(bp((R.next() * 2 - 1) * e)) * 2.2;
    }
    return b;
  };
  Audio.prototype.popBuf = function (k) {
    var R = CF.rng, sr = this.sr, dur = R.range(0.06, 0.14), n = Math.floor(sr * dur), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    var bp = biquad('bp', R.logUniform(500, 2200), 0.9, sr), lp = biquad('lp', 180, 0.8, sr), tau = R.range(0.004, 0.012) * sr, th = R.range(70, 140);
    for (var i = 0; i < n; i++) {
      var e = Math.exp(-i / tau), x = (R.next() * 2 - 1);
      d[i] = bp(x * e) * 2.8 + lp(x * Math.exp(-i / (tau * 2))) * 1.4 + Math.sin(i / sr * 6.283 * th) * Math.exp(-i / (sr * 0.018)) * 0.35;
    }
    return b;
  };
  Audio.prototype.loop = function (buf, filters, dest, gain) {
    var c = this.ctx, s = c.createBufferSource(); s.buffer = buf; s.loop = true;
    s.playbackRate.value = CF.rng.range(0.97, 1.03);
    var node = s, fs = [];
    filters.forEach(function (f) {
      var bq = c.createBiquadFilter(); bq.type = f[0]; bq.frequency.value = f[1]; bq.Q.value = f[2]; if (f[3]) bq.gain.value = f[3];
      node.connect(bq); node = bq; fs.push(bq);
    });
    var g = c.createGain(); g.gain.value = gain; node.connect(g); g.connect(dest);
    s.start(c.currentTime, CF.rng.range(0, buf.duration));
    return { src: s, gain: g, filters: fs };
  };

  // ---------------------------------------------------------------- place
  Audio.prototype.impulse = function (sec, decay, taps) {
    var n = Math.floor(this.sr * sec), b = this.ctx.createBuffer(2, n, this.sr), R = CF.rng;
    for (var ch = 0; ch < 2; ch++) {
      var d = b.getChannelData(ch), lp = biquad('lp', 5200, 0.6, this.sr);
      for (var i = 0; i < n; i++) { var t = i / this.sr; d[i] = lp((R.next() * 2 - 1) * Math.pow(1 - t / sec, decay) * Math.exp(-t * 2.2)) * 0.6; }
      (taps || []).forEach(function (tp) { var k = Math.floor(tp[0] * b.sampleRate); for (var j = 0; j < 600 && k + j < n; j++) d[k + j] += (R.next() * 2 - 1) * tp[1] * Math.exp(-j / 120); });
    }
    return b;
  };
  Audio.prototype.setPlace = function (place) {
    this.place = place;
    if (!this.ctx) return;
    var c = this.ctx, now = c.currentTime, self = this;
    this.verb.buffer = place === 'forest' ? this.impulse(1.6, 2.4) : place === 'snow' ? this.impulse(2.8, 1.6) : this.impulse(3.4, 1.4, [[0.42, 0.25], [0.95, 0.18], [1.6, 0.1]]);
    this.echo.delayTime.value = place === 'desert' ? 1.05 : 0.6; this.echoFb.gain.value = place === 'desert' ? 0.38 : 0;
    this.echoIn.gain.value = place === 'desert' ? 0.5 : 0;
    this.crickets.forEach(function (k) { try { k.osc.stop(); } catch (e) {} });
    this.crickets = [];
    this.drop(this.brook); this.drop(this.pot); this.brook = this.pot = null;
    var token = this.placeToken = (this.placeToken || 0) + 1;
    if (place === 'forest') {   // a brook, off behind the tent
      this.waterBuf(9, 85, 700, 4200, 0.05, function (buf) {
        if (self.placeToken === token) self.brook = self.place3(buf, [['highpass', 500, 0.5], ['lowpass', 3600, 0.5]], self.night, 3.9, 0.5);
      });
    } else if (place === 'desert') {   // the coffee pot by the stones (cf-world.js puts it there)
      this.waterBuf(6, 16, 260, 900, 0.02, function (buf) {
        if (self.placeToken === token) self.pot = self.place3(buf, [['lowpass', 1500, 0.6]], self.fire, 1.18, 0.05);
      });
    }
    this.windF.Q.value = place === 'desert' ? 2.2 : 0.9;   // the canyon gives the wind a note
    var tempC = place === 'forest' ? 15 + CF.rng.range(-2, 3) : place === 'desert' ? 19 + CF.rng.range(-2, 3) : null;
    if (tempC !== null) {
      var n = place === 'forest' ? 5 : 4;
      for (var i = 0; i < n; i++) {
        var o = c.createOscillator(); o.type = 'sine'; o.frequency.value = (place === 'desert' ? 3900 : 4300) + CF.rng.range(-350, 450);
        var g = c.createGain(); g.gain.value = 0; var pan = c.createStereoPanner(); pan.pan.value = CF.rng.range(-0.95, 0.95);
        var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = CF.rng.range(5000, 9000);
        o.connect(g); g.connect(lp); lp.connect(pan); pan.connect(this.night);
        o.start();
        // Dolbear's law (1897): chirps per minute = 4 * T(F) - 160 = 7.2 * T(C) - 32; each cricket a little off
        var perMin = Math.max(30, 7.2 * (tempC + CF.rng.range(-1.5, 1.5)) - 32);
        this.crickets.push({ osc: o, gain: g, period: 60 / perMin, next: now + CF.rng.range(0.2, 3), amp: CF.rng.logUniform(0.012, 0.045), pulses: CF.rng.int(2, 4), rest: 0 });
      }
    }
    var A = place === 'forest' ? { owl: 75, snap: 110 } : place === 'snow' ? { ice: 38, wolf: 160, toot: 170, frost: 80 } : { coyote: 140, snap: 160, poorwill: 110 };
    this.sched = {};
    Object.keys(A).forEach(function (k) { self.sched[k] = { mean: A[k], next: now + CF.rng.expo(A[k] * 0.4) + 6 }; });
  };

  // ---------------------------------------------------------------- live update (engine calls this every frame)
  // s = {power, flicker, crackle, wet, gust, wind, burning: [{az, rate, pop, sap}], yaw, dist}
  Audio.prototype.update = function (s) {
    if (!this.ctx) return;
    this.state = s;
    var now = this.ctx.currentTime, k = 0.08;
    var p = Math.min(1.6, s.power), near = 3.2 / Math.max(1.5, s.dist || 3.2);
    this.roar.gain.gain.setTargetAtTime((0.05 + 0.5 * p * (0.6 + 0.8 * s.flicker)) * near, now, k);
    this.roar.filters[0].frequency.setTargetAtTime(180 + 260 * p + 300 * s.flicker, now, 0.1);
    this.lap.gain.gain.setTargetAtTime(0.02 * p * (0.3 + 1.6 * s.flicker) * near, now, 0.06);
    this.hiss.gain.gain.setTargetAtTime((0.006 + 0.03 * p) * (0.7 + 0.6 * s.hissMod) * near, now, 0.3);
    this.steam.gain.gain.setTargetAtTime(0.05 * s.wet * near, now, 0.4);
    var gust = s.gust;
    this.wind.gain.gain.setTargetAtTime(0.03 + 0.18 * gust, now, 0.4);
    this.windF.frequency.setTargetAtTime(this.place === 'desert' ? 190 + 260 * gust : 300 + 500 * gust, now, 0.6);
    this.hush.gain.gain.setTargetAtTime(this.place === 'snow' ? 0.014 * (s.snow || 0) : 0, now, 2);
    if (this.brook) { this.brook.gain.gain.setTargetAtTime(0.06 * (1 - 0.3 * Math.min(1, gust)), now, 1.5); this.brook.pan.pan.setTargetAtTime(this.panFor(this.brook.az) * 0.85, now, 0.15); }
    if (this.pot) { this.pot.gain.gain.setTargetAtTime(0.05 * CF.clamp(((s.heat || 0) - 0.45) * 1.6, 0, 1) * near, now, 3); this.pot.pan.pan.setTargetAtTime(this.panFor(this.pot.az) * 0.5, now, 0.15); }
    this.windHi.gain.gain.setTargetAtTime((this.place === 'forest' ? 0.012 : 0.006) + (this.place === 'forest' ? 0.05 : 0.02) * gust * gust, now, 0.5);
  };
  Audio.prototype.panFor = function (az) { var y = this.state ? this.state.yaw : 0; return Math.max(-1, Math.min(1, Math.sin(az - y))); };

  Audio.prototype.tick = function () {
    var c = this.ctx; if (!c || !this.state) return;
    var now = c.currentTime, ahead = document.hidden ? 1.6 : 0.15, until = now + ahead, s = this.state, R = CF.rng;
    if (this.horizon === undefined || this.horizon < now) this.horizon = now;
    // crackles: thinning of a Hawkes process (base rate from the logs + self-excitation)
    var t = this.horizon;
    while (t < until) {
      var base = 0.2; for (var i = 0; i < s.burning.length; i++) base += s.burning[i].rate;
      var lam = base + this.hawkes, wait = R.expo(1 / Math.max(lam, 0.05));
      this.hawkes *= Math.exp(-wait / 0.07);
      t += wait;
      if (t >= until) { t = until; break; }
      if (R.next() * lam > base + this.hawkes) continue;
      // which log, how big
      var log = this.pickLog(s.burning), big = R.next() < (log ? log.pop : 0.02) * 0.25;
      this.hawkes += big ? 9 : 4.5 * R.next();
      this.crackle(t, log ? this.panFor(log.az) : R.range(-0.4, 0.4), big, log);
    }
    this.horizon = t;
    // sap whistles
    s.burning.forEach(function (lg) { if (lg.sap > 0 && R.next() < lg.sap * 0.0012 * (ahead / 0.04)) this.whistle(now + R.range(0, ahead), this.panFor(lg.az)); }, this);
    // crickets
    this.crickets.forEach(function (k) {
      while (k.next < until) {
        var g = k.gain.gain, tt = Math.max(k.next, now);
        if (k.rest > 0) { k.rest--; k.next += k.period; continue; }
        for (var p = 0; p < k.pulses; p++) {
          var t0 = tt + p * 0.032; g.setValueAtTime(0, t0); g.linearRampToValueAtTime(k.amp, t0 + 0.004); g.setValueAtTime(k.amp, t0 + 0.014); g.linearRampToValueAtTime(0, t0 + 0.02);
        }
        k.next += k.period * R.range(0.95, 1.05);
        if (R.next() < 0.02) k.rest = R.int(4, 30);   // a cricket goes quiet for a while
      }
    }, this);
    // animals and the land
    Object.keys(this.sched).forEach(function (kind) {
      var sc = this.sched[kind];
      if (sc.next < until) { this[kind](Math.max(sc.next, now), R.range(-1, 1)); sc.next = Math.max(sc.next, now) + 8 + R.expo(sc.mean); }
    }, this);
  };
  Audio.prototype.pickLog = function (list) {
    var tot = 0, i; for (i = 0; i < list.length; i++) tot += list[i].rate;
    var x = CF.rng.next() * tot; for (i = 0; i < list.length; i++) { x -= list[i].rate; if (x <= 0) return list[i]; }
    return list[list.length - 1] || null;
  };

  // ---------------------------------------------------------------- one-shots
  Audio.prototype.out = function (t, pan, gain, dest, verb) {
    var c = this.ctx, g = c.createGain(), p = c.createStereoPanner();
    g.gain.value = gain; p.pan.value = pan; g.connect(p); p.connect(dest || this.fire);
    if (verb) { var v = c.createGain(); v.gain.value = verb; p.connect(v); v.connect(this.verb); }
    return g;
  };
  Audio.prototype.crackle = function (t, pan, big, log) {
    var c = this.ctx, R = CF.rng, s = c.createBufferSource();
    s.buffer = big ? R.pick(this.pops) : R.pick(this.bank);
    s.playbackRate.value = R.range(0.7, 1.35) * (log && log.pitch || 1);
    var near = 3.2 / Math.max(1.5, (this.state && this.state.dist) || 3.2);
    var amp = (big ? R.range(0.35, 0.7) : R.logUniform(0.03, 0.4)) * near;
    s.connect(this.out(t, pan * 0.6, amp, this.fire, big ? 0.25 : 0.1));
    s.start(t);
    if (big && this.onPop) {
      var self = this, delay = Math.max(0, (t - c.currentTime) * 1000);
      setTimeout(function () { self.onPop(log); }, delay);
    }
  };
  Audio.prototype.whistle = function (t, pan) {
    var c = this.ctx, R = CF.rng, o = c.createOscillator(), lfo = c.createOscillator(), lg = c.createGain(), dur = R.range(0.4, 1.8), f = R.range(2400, 6200);
    o.frequency.value = f; lfo.frequency.value = R.range(5, 14); lg.gain.value = f * 0.012; lfo.connect(lg); lg.connect(o.frequency);
    o.frequency.setValueAtTime(f, t); o.frequency.linearRampToValueAtTime(f * R.range(0.85, 1.1), t + dur);
    var g = this.out(t, pan * 0.5, 0, this.fire, 0.05); o.connect(g);
    var a = R.range(0.004, 0.012);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.08); g.gain.setValueAtTime(a * 0.8, t + dur * 0.7); g.gain.linearRampToValueAtTime(0, t + dur);
    o.start(t); lfo.start(t); o.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
  };
  Audio.prototype.noiseHit = function (t, dur, type, f, q, gain, pan, sweepTo, dest, verb) {
    var c = this.ctx, s = c.createBufferSource(); s.buffer = this.white; var bq = c.createBiquadFilter();
    bq.type = type; bq.frequency.setValueAtTime(f, t); bq.Q.value = q; if (sweepTo) bq.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    var g = this.out(t, pan, 0, dest, verb); s.connect(bq); bq.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + Math.min(0.01, dur * 0.2)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.start(t, CF.rng.range(0, 5)); s.stop(t + dur + 0.05);
    return g;
  };
  Audio.prototype.match = function () {
    if (!this.ctx) return; var t = this.ctx.currentTime + 0.02, R = CF.rng;
    for (var i = 0; i < 9; i++) this.noiseHit(t + i * 0.014 + R.range(0, 0.006), 0.02, 'bandpass', R.range(2500, 5000), 1.2, 0.25, 0.1);
    this.noiseHit(t + 0.13, 0.7, 'bandpass', 700, 0.8, 0.28, 0.1, 2600, null, 0.2);
    this.noiseHit(t + 0.14, 1.6, 'highpass', 3000, 0.7, 0.05, 0.1);
  };
  Audio.prototype.logDrop = function (pan) {
    if (!this.ctx) return; var t = this.ctx.currentTime + 0.01, c = this.ctx, R = CF.rng;
    this.noiseHit(t, 0.18, 'lowpass', 380, 0.8, 0.9, pan, null, null, 0.2);
    [170, 410, 930].forEach(function (f) {
      var o = c.createOscillator(); o.frequency.value = f * R.range(0.9, 1.1);
      var g = this.out(t, pan, 0, this.fire, 0.15); o.connect(g);
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.12 * 200 / f, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + R.range(0.12, 0.28));
      o.start(t); o.stop(t + 0.35);
    }, this);
    for (var i = 0; i < 10; i++) this.crackle(t + 0.05 + R.expo(0.12), pan, i < 2, null);
    this.hawkes += 20;
  };
  Audio.prototype.stir = function () {
    if (!this.ctx) return; var t = this.ctx.currentTime + 0.01, R = CF.rng;
    for (var i = 0; i < 6; i++) this.noiseHit(t + i * 0.07 + R.range(0, 0.04), 0.12, 'bandpass', R.range(1100, 2600), 2, 0.12, 0);
    for (i = 0; i < 16; i++) this.crackle(t + 0.1 + R.expo(0.15), R.range(-0.3, 0.3), i < 3, null);
    this.hawkes += 30;
  };
  Audio.prototype.collapse = function (pan) {
    if (!this.ctx) return; var t = this.ctx.currentTime + 0.01, R = CF.rng;
    this.noiseHit(t, 0.4, 'lowpass', 260, 0.7, 0.8, pan, null, null, 0.3);
    for (var i = 0; i < 14; i++) this.crackle(t + R.expo(0.18), pan, i < 2, null);
    this.hawkes += 25;
  };
  // ---- water, made of bubbles. A brook's babble (and a pot's simmer) is the ringing of air bubbles: each one a short
  // sine whose pitch follows its size (Minnaert 1933: about 3.26 / radius in metres, in Hz) and rises as it nears the
  // surface (van den Doel, "Physically based models for liquid sounds", 2005). Thousands of them, written into a
  // buffer that loops without a seam (bubbles that run off the end wrap round to the start).
  // It is built a few dozen bubbles at a time between frames (a phone would stall for half a second otherwise)
  // and handed to `done` when ready.
  Audio.prototype.waterBuf = function (sec, perSec, fLo, fHi, bed, done) {
    var R = CF.rng, sr = this.sr, n = Math.floor(sr * sec), b = this.ctx.createBuffer(2, n, sr), ctx = this.ctx, self = this;
    var total = Math.round(sec * perSec) * 2, made = 0;
    function some() {
      if (self.ctx !== ctx) return;                 // the sound was stopped meanwhile
      var until = Math.min(total, made + 40), i;
      for (; made < until; made++) {
        var d = b.getChannelData(made & 1);
        var f0 = R.logUniform(fLo, fHi), tau = R.range(5, 16) / f0 * sr, len = Math.min(n, Math.floor(tau * 6)), rise = R.range(0.05, 0.6) / len;
        var amp = Math.pow(R.next(), 2.2) * Math.sqrt(fLo / f0), at = R.int(0, n - 1), ph = 0, w = 6.2832 * f0 / sr, att = Math.max(8, 0.0008 * sr);
        for (i = 0; i < len; i++) { ph += w * (1 + rise * i); d[(at + i) % n] += Math.sin(ph) * amp * Math.exp(-i / tau) * Math.min(1, i / att); }
      }
      if (made < total) { setTimeout(some, 12); return; }
      for (var ch = 0; ch < 2; ch++) {
        var c = b.getChannelData(ch), peak = 0;
        if (bed) {   // the wash underneath: band-limited noise
          var bp = biquad('bp', 900, 0.5, sr), bp2 = biquad('bp', 2400, 0.7, sr);
          for (i = 0; i < n; i++) { var x = R.next() * 2 - 1; c[i] += (bp(x) * 0.6 + bp2(x) * 0.3) * bed; }
          var f = Math.floor(sr * 0.08); for (i = 0; i < f; i++) { var t = i / f; c[i] = c[i] * t + c[n - f + i] * (1 - t); }
        }
        for (i = 0; i < n; i++) { var a = Math.abs(c[i]); if (a > peak) peak = a; }
        var g = 0.5 / (peak || 1); for (i = 0; i < n; i++) c[i] *= g;
      }
      done(b);
    }
    setTimeout(some, 30);
  };
  // a looping sound that sits at a fixed bearing around the camp (the brook over there, the pot by the stones):
  // its pan follows the way you turn
  Audio.prototype.place3 = function (buf, filters, dest, az, verb) {
    var c = this.ctx, l = this.loop(buf, filters, dest, 0), pan = c.createStereoPanner();
    l.gain.disconnect(); l.gain.connect(pan); pan.connect(dest);
    if (verb) { var v = c.createGain(); v.gain.value = verb; pan.connect(v); v.connect(this.verb); }
    l.pan = pan; l.az = az;
    return l;
  };
  Audio.prototype.drop = function (l) { if (!l) return; try { l.src.stop(); } catch (e) {} try { l.gain.disconnect(); if (l.pan) l.pan.disconnect(); } catch (e2) {} };

  // far thunder, long after the flash: a low roll that swells two or three times and dies away
  Audio.prototype.thunder = function (delay, strength, pan) {
    if (!this.ctx) return;
    var c = this.ctx, R = CF.rng, t = c.currentTime + delay, dur = R.range(5, 9), s = c.createBufferSource(); s.buffer = this.brown; s.loop = true;
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.setValueAtTime(150, t); lp.frequency.exponentialRampToValueAtTime(55, t + dur);
    var g = this.out(t, (pan || 0) * 0.5, 0, this.night, 0.7), top = 0.13 * Math.min(1, strength);
    s.connect(lp); lp.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(top, t + R.range(0.3, 0.7));
    for (var k = 1, n = R.int(2, 4); k <= n; k++) g.gain.linearRampToValueAtTime(top * R.range(0.25, 0.9) * (1 - k / (n + 1)), t + dur * k / (n + 1));
    g.gain.linearRampToValueAtTime(0, t + dur);
    s.start(t, R.range(0, 5)); s.stop(t + dur + 0.1);
  };
  // common poorwill (desert): a soft whistled "poor-will", over and over, from somewhere on the canyon floor
  Audio.prototype.poorwill = function (t, pan) {
    var c = this.ctx, R = CF.rng, n = R.int(5, 13), f = R.range(1150, 1350), gap = R.range(1.25, 1.6), amp = R.range(0.012, 0.028);
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; var g = this.out(t, pan, 1, this.night, 0.8); lp.connect(g);
    if (this.echoIn) lp.connect(this.echoIn);
    for (var k = 0; k < n; k++) {
      var s = t + k * gap + R.range(-0.03, 0.03), o = c.createOscillator(), e = c.createGain(), a = amp * (0.6 + 0.4 * Math.sin(Math.PI * (k + 0.5) / n));
      o.frequency.setValueAtTime(f, s); o.frequency.setValueAtTime(f, s + 0.13); o.frequency.linearRampToValueAtTime(f * 0.97, s + 0.19);
      o.frequency.linearRampToValueAtTime(f * 1.34, s + 0.36); o.frequency.linearRampToValueAtTime(f * 1.5, s + 0.4);
      e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(a, s + 0.02); e.gain.setValueAtTime(a, s + 0.11); e.gain.linearRampToValueAtTime(a * 0.15, s + 0.17);
      e.gain.linearRampToValueAtTime(a * 1.1, s + 0.24); e.gain.setValueAtTime(a * 1.1, s + 0.34); e.gain.linearRampToValueAtTime(0, s + 0.42);
      o.connect(e); e.connect(lp); o.start(s); o.stop(s + 0.45);
    }
  };
  // boreal owl (snow): a quick run of soft toots that swells and stops
  Audio.prototype.toot = function (t, pan) {
    var c = this.ctx, R = CF.rng, n = R.int(8, 15), f = R.range(680, 800), amp = R.range(0.012, 0.026), step = R.range(0.115, 0.14);
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; var g = this.out(t, pan, 1, this.night, 1.0); lp.connect(g);
    for (var k = 0; k < n; k++) {
      var s = t + k * step, o = c.createOscillator(), e = c.createGain(), a = amp * (0.35 + 0.65 * Math.min(1, (k + 1) / (n * 0.7)));
      o.frequency.setValueAtTime(f * 0.97, s); o.frequency.linearRampToValueAtTime(f, s + 0.03);
      e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(a, s + 0.015); e.gain.setValueAtTime(a, s + 0.05); e.gain.linearRampToValueAtTime(0, s + 0.085);
      o.connect(e); e.connect(lp); o.start(s); o.stop(s + 0.1);
    }
  };
  // frost crack (snow): sap freezing in a trunk somewhere in the trees, a dry knock with the lake's echo behind it
  Audio.prototype.frost = function (t, pan) {
    var c = this.ctx, R = CF.rng, n = R.chance(0.3) ? 2 : 1;
    for (var k = 0; k < n; k++) {
      var s = c.createBufferSource(), tt = t + k * R.range(0.18, 0.5); s.buffer = R.pick(this.pops); s.playbackRate.value = R.range(0.45, 0.7);
      var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2000; s.connect(lp);
      lp.connect(this.out(tt, pan, R.range(0.05, 0.11), this.night, 1.4)); s.start(tt);
    }
  };
  // ---- animals and the land (t = when, pan = where)
  Audio.prototype.owl = function (t, pan, answer) {   // great horned owl: hoo, h-hoo, hoo, hoo
    var c = this.ctx, R = CF.rng, f0 = answer ? R.range(335, 390) : R.range(270, 330), pattern = [[0, 0.32], [0.55, 0.14], [0.72, 0.42], [1.42, 0.38], [2.05, 0.42]];
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; var g = this.out(t, pan, R.range(0.04, 0.08), this.night, 0.9); lp.connect(g);
    pattern.forEach(function (p) {
      var o = c.createOscillator(), e = c.createGain(), s = t + p[0], d = p[1];
      o.frequency.setValueAtTime(f0 * 0.96, s); o.frequency.linearRampToValueAtTime(f0, s + d * 0.3); o.frequency.linearRampToValueAtTime(f0 * 0.9, s + d);
      e.gain.setValueAtTime(0, s); e.gain.linearRampToValueAtTime(1, s + 0.06); e.gain.setValueAtTime(0.85, s + d - 0.08); e.gain.linearRampToValueAtTime(0, s + d);
      o.connect(e); e.connect(lp); o.start(s); o.stop(s + d + 0.05);
    });
    if (!answer && R.chance(0.45)) this.owl(t + R.range(3.5, 7), pan > 0 ? R.range(-1, -0.2) : R.range(0.2, 1), true);   // its mate answers from the other side, a little higher
  };
  Audio.prototype.snap = function (t, pan) {
    var s = this.ctx.createBufferSource(); s.buffer = CF.rng.pick(this.bank); s.playbackRate.value = 0.55;
    var lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; s.connect(lp);
    lp.connect(this.out(t, pan, 0.12, this.night, 1.2)); s.start(t);
  };
  Audio.prototype.ice = function (t, pan) {   // lake ice singing: dispersive chirps, sometimes a deep boom
    var c = this.ctx, R = CF.rng, n = R.int(1, 3);
    for (var i = 0; i < n; i++) {
      var s = t + i * R.range(0.15, 0.5), o = c.createOscillator(), d = R.range(0.35, 1.1), g = this.out(s, pan, 0, this.night, 1.0);
      o.frequency.setValueAtTime(R.range(1600, 3200), s); o.frequency.exponentialRampToValueAtTime(R.range(140, 320), s + d);
      o.connect(g); g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(R.range(0.01, 0.025), s + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, s + d);
      o.start(s); o.stop(s + d + 0.05);
    }
    if (R.chance(0.45)) {
      var b = c.createOscillator(), bg = this.out(t, pan, 0, this.night, 0.8); b.frequency.setValueAtTime(52, t); b.frequency.exponentialRampToValueAtTime(34, t + 1.8);
      b.connect(bg); bg.gain.setValueAtTime(0, t); bg.gain.linearRampToValueAtTime(0.09, t + 0.02); bg.gain.exponentialRampToValueAtTime(0.0001, t + 2);
      b.start(t); b.stop(t + 2.1);
      this.noiseHit(t, 0.6, 'lowpass', 220, 0.7, 0.12, pan, null, this.night, 0.6);
    }
  };
  Audio.prototype.howl = function (t, pan, base, dur) {
    var c = this.ctx, R = CF.rng, o = c.createOscillator(), vib = c.createOscillator(), vg = c.createGain();
    o.type = 'sawtooth'; vib.frequency.value = R.range(4.5, 6); vg.gain.value = base * 0.015; vib.connect(vg); vg.connect(o.frequency);
    o.frequency.setValueAtTime(base * 0.8, t); o.frequency.linearRampToValueAtTime(base * 1.25, t + dur * 0.25); o.frequency.setValueAtTime(base * 1.25, t + dur * 0.6); o.frequency.linearRampToValueAtTime(base * 0.85, t + dur);
    var f1 = c.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = base * 1.6; f1.Q.value = 3;
    var f2 = c.createBiquadFilter(); f2.type = 'lowpass'; f2.frequency.value = 1600;
    var g = this.out(t, pan, 0, this.night, 1.0); o.connect(f1); f1.connect(f2); f2.connect(g);
    if (this.echoIn && this.place === 'desert') g.connect(this.echoIn);   // the echo hears the call as shaped, not the raw tone
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(R.range(0.05, 0.09), t + dur * 0.2); g.gain.setValueAtTime(0.06, t + dur * 0.75); g.gain.linearRampToValueAtTime(0, t + dur);
    o.start(t); vib.start(t); o.stop(t + dur + 0.1); vib.stop(t + dur + 0.1);
  };
  Audio.prototype.wolf = function (t, pan) {
    var R = CF.rng, n = R.int(1, 3);
    for (var i = 0; i < n; i++) this.howl(t + i * R.range(0.8, 2.2), Math.max(-1, Math.min(1, pan + R.range(-0.2, 0.2))), R.range(330, 470), R.range(2.8, 4.5));
  };
  Audio.prototype.coyote = function (t, pan) {
    var c = this.ctx, R = CF.rng, n = R.int(6, 14), tt = t;
    for (var i = 0; i < n; i++) {   // yips
      var o = c.createOscillator(), d = R.range(0.06, 0.16), g = this.out(tt, pan + R.range(-0.15, 0.15), 0, this.night, 1.1);
      o.type = 'triangle'; o.frequency.setValueAtTime(R.range(550, 800), tt); o.frequency.exponentialRampToValueAtTime(R.range(900, 1400), tt + d);
      var lp = c.createBiquadFilter(); lp.frequency.value = 2200; o.connect(lp); lp.connect(g); if (this.echoIn) g.connect(this.echoIn);
      g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(R.range(0.02, 0.05), tt + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, tt + d);
      o.start(tt); o.stop(tt + d + 0.05); tt += d + R.range(0.03, 0.18);
    }
    this.howl(tt, pan, R.range(650, 900), R.range(1.4, 2.4));
    if (R.chance(0.6)) this.howl(tt + 0.4, -pan * 0.5, R.range(700, 1000), R.range(1.2, 2));
  };
})();
