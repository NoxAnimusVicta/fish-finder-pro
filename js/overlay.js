/* overlay.js — our own wind and swell map layers.
   Pulls a lattice of forecast points from Open-Meteo for the area on
   screen, then draws a colour field, arrows and drifting particles on a
   canvas over the base map, with a slider through the next three days.
   Everything is drawn here; nothing is embedded from anyone else. */
(function (global) {
  'use strict';

  var HOUR = 3600000, TZ = 'Australia/Sydney';
  var OM = 'https://api.open-meteo.com/v1/forecast';
  var OMM = 'https://marine-api.open-meteo.com/v1/marine';
  var DAYS = 3;

  /* ---------- colour ramps ---------- */
  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function ramp(stops) {
    var pts = stops.map(function (s) { return [s[0], hex(s[1])]; });
    return function (v) {
      if (v == null || isNaN(v)) return null;
      if (v <= pts[0][0]) return pts[0][1];
      for (var i = 1; i < pts.length; i++) {
        if (v <= pts[i][0]) {
          var a = pts[i - 1], b = pts[i], t = (v - a[0]) / (b[0] - a[0]);
          return [a[1][0] + (b[1][0] - a[1][0]) * t, a[1][1] + (b[1][1] - a[1][1]) * t, a[1][2] + (b[1][2] - a[1][2]) * t];
        }
      }
      return pts[pts.length - 1][1];
    };
  }
  /* same four Seabreeze bands the charts use, blended between */
  var WIND_RAMP = ramp([[0, '#dbeaf5'], [4, '#9fdcb0'], [8, '#35d43a'], [12, '#b8e02a'], [16, '#ffe11a'], [21, '#ffb31a'], [26, '#ff8a1f'], [31, '#ff2f2f'], [40, '#b3001b'], [50, '#6a0dad']]);
  var WAVE_RAMP = ramp([[0, '#e4f1fb'], [0.5, '#b9d9f6'], [1, '#7fb8ff'], [1.5, '#4f96f2'], [2, '#2f7ff5'], [2.5, '#1a5fd6'], [3, '#0b4bd6'], [4, '#3d2fb8'], [5, '#6a1fa0'], [6, '#8a0f6b']]);
  function periodColor(s) { if (s == null) return '#888'; if (s < 8) return '#7fb8ff'; if (s < 12) return '#2f7ff5'; return '#0b4bd6'; }
  function windColor(kt) { if (kt == null) return '#888'; if (kt < 10) return '#35d43a'; if (kt < 20) return '#ffe11a'; if (kt < 30) return '#ff8a1f'; return '#ff2f2f'; }
  function rgb(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + a + ')'; }

  /* ---------- grid spec ---------- */
  /* Cover the view plus a margin, at a spacing near the models' own
     resolution but never more than ~80 points, so one request does it. */
  function gridSpec(map) {
    var b = map.bounds();
    var w = b.east - b.west, h = b.north - b.south;
    var sp = 0.125;
    while ((Math.ceil((w * 1.5) / sp) + 1) * (Math.ceil((h * 1.5) / sp) + 1) > 100) sp *= 2;
    var lon0 = Math.floor((b.west - w * 0.25) / sp) * sp, lat0 = Math.floor((b.south - h * 0.25) / sp) * sp;
    var nx = Math.ceil((b.east + w * 0.25 - lon0) / sp) + 1, ny = Math.ceil((b.north + h * 0.25 - lat0) / sp) + 1;
    return { lat0: lat0, lon0: lon0, sp: sp, nx: nx, ny: ny, key: [sp, lat0.toFixed(3), lon0.toFixed(3), nx, ny].join('|') };
  }
  function specCovers(spec, map) {
    if (!spec) return false;
    var b = map.bounds();
    return b.west >= spec.lon0 && b.east <= spec.lon0 + (spec.nx - 1) * spec.sp &&
           b.south >= spec.lat0 && b.north <= spec.lat0 + (spec.ny - 1) * spec.sp &&
           /* zoomed in far enough that a coarser grid would look blocky */
           spec.sp <= gridSpec(map).sp * 2.01;
  }

  function withTimeout(url, ms) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 20000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }).catch(function (e) { clearTimeout(t); throw e; });
  }

  /* One fetch for the whole lattice; Open-Meteo takes comma lists and
     answers with one object per point in the same order. */
  function fetchGrid(kind, spec) {
    var lats = [], lons = [];
    for (var i = 0; i < spec.ny; i++) for (var j = 0; j < spec.nx; j++) {
      lats.push((spec.lat0 + i * spec.sp).toFixed(4)); lons.push((spec.lon0 + j * spec.sp).toFixed(4));
    }
    var url = kind === 'wind'
      ? OM + '?latitude=' + lats.join(',') + '&longitude=' + lons.join(',') + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m' +
        '&wind_speed_unit=kn&timeformat=unixtime&timezone=' + encodeURIComponent(TZ) + '&forecast_days=' + DAYS
      : OMM + '?latitude=' + lats.join(',') + '&longitude=' + lons.join(',') + '&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,wind_wave_height' +
        '&timeformat=unixtime&timezone=' + encodeURIComponent(TZ) + '&forecast_days=' + DAYS;
    return withTimeout(url, 25000).then(function (j) {
      var pts = Array.isArray(j) ? j : [j];
      if (pts.length !== spec.nx * spec.ny) throw new Error('grid size mismatch');
      var time = pts[0].hourly.time, T = time.length, n = spec.nx * spec.ny;
      var f = {};
      var names = kind === 'wind' ? ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m']
        : ['wave_height', 'wave_direction', 'wave_period', 'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', 'wind_wave_height'];
      names.forEach(function (nm) {
        var arr = new Float32Array(T * n);
        for (var p = 0; p < n; p++) {
          var src = pts[p].hourly && pts[p].hourly[nm];
          for (var t = 0; t < T; t++) { var v = src ? src[t] : null; arr[t * n + p] = v == null ? NaN : v; }
        }
        f[nm] = kind === 'wind' ? arr : dilate(arr, spec, T, nm.indexOf('direction') >= 0);
      });
      return { kind: kind, spec: spec, time: time, T: T, n: n, f: f, fetched: Date.now() };
    });
  }

  /* The wave model has no value on land, and its cells are 10–30 km wide,
     so without help the colour would stop short of the beach. Fill each
     empty cell that touches a sea cell with the mean of its sea neighbours
     (directions as vectors), one ring only, so the wash reaches the shore
     without painting the whole hinterland. */
  function dilate(arr, spec, T, isDir) {
    var n = spec.nx * spec.ny, out = new Float32Array(arr);
    for (var t = 0; t < T; t++) {
      var base = t * n;
      for (var i = 0; i < spec.ny; i++) for (var j = 0; j < spec.nx; j++) {
        var k = base + i * spec.nx + j;
        if (!isNaN(arr[k])) continue;
        var s = 0, u = 0, v = 0, c = 0;
        for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
          var ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= spec.ny || jj >= spec.nx) continue;
          var q = arr[base + ii * spec.nx + jj]; if (isNaN(q)) continue;
          if (isDir) { var r = q * Math.PI / 180; u += Math.sin(r); v += Math.cos(r); } else s += q;
          c++;
        }
        if (!c) continue;
        out[k] = isDir ? (Math.atan2(u, v) * 180 / Math.PI + 360) % 360 : s / c;
      }
    }
    return out;
  }

  /* ---------- sampling ---------- */
  /* bilinear on a scalar field; NaN cells (land, for waves) drop out of the
     weights so the sea edge does not fade to nothing */
  function sampleScalar(g, arr, t, lat, lon) {
    var s = g.spec, fx = (lon - s.lon0) / s.sp, fy = (lat - s.lat0) / s.sp;
    if (fx < 0 || fy < 0 || fx > s.nx - 1 || fy > s.ny - 1) return NaN;
    var x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(s.nx - 1, x0 + 1), y1 = Math.min(s.ny - 1, y0 + 1);
    var tx = fx - x0, ty = fy - y0, base = t * g.n;
    var v00 = arr[base + y0 * s.nx + x0], v10 = arr[base + y0 * s.nx + x1], v01 = arr[base + y1 * s.nx + x0], v11 = arr[base + y1 * s.nx + x1];
    var w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty, sum = 0, ws = 0;
    if (!isNaN(v00)) { sum += v00 * w00; ws += w00; }
    if (!isNaN(v10)) { sum += v10 * w10; ws += w10; }
    if (!isNaN(v01)) { sum += v01 * w01; ws += w01; }
    if (!isNaN(v11)) { sum += v11 * w11; ws += w11; }
    return ws > 0.3 ? sum / ws : NaN;
  }
  /* a direction has to be blended as a vector, or 350° and 10° average to south */
  function sampleDir(g, dirArr, t, lat, lon) {
    var s = g.spec, fx = (lon - s.lon0) / s.sp, fy = (lat - s.lat0) / s.sp;
    if (fx < 0 || fy < 0 || fx > s.nx - 1 || fy > s.ny - 1) return NaN;
    var x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(s.nx - 1, x0 + 1), y1 = Math.min(s.ny - 1, y0 + 1);
    var tx = fx - x0, ty = fy - y0, base = t * g.n;
    var ids = [base + y0 * s.nx + x0, base + y0 * s.nx + x1, base + y1 * s.nx + x0, base + y1 * s.nx + x1];
    var w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty], u = 0, v = 0, ws = 0;
    for (var k = 0; k < 4; k++) {
      var d = dirArr[ids[k]]; if (isNaN(d)) continue;
      var r = d * Math.PI / 180; u += Math.sin(r) * w[k]; v += Math.cos(r) * w[k]; ws += w[k];
    }
    if (ws < 0.3) return NaN;
    return (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
  }

  /* ---------- coastline clip ---------- */
  /* data/coast.json: rings of milli-degree deltas (see scripts/build_coast.py) */
  function decodeCoast(doc) {
    if (!doc || !doc.rings) return null;
    var sc = doc.scale || 1000, out = [];
    doc.rings.forEach(function (flat) {
      var pts = [], x = 0, y = 0, minLon = 999, maxLon = -999, minLat = 999, maxLat = -999;
      for (var i = 0; i < flat.length; i += 2) {
        x += flat[i]; y += flat[i + 1];
        var lon = x / sc, lat = y / sc;
        pts.push(lon, lat);
        if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon; if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
      }
      out.push({ pts: pts, minLon: minLon, maxLon: maxLon, minLat: minLat, maxLat: maxLat });
    });
    return out;
  }
  /* the whole canvas minus every land ring in view — even-odd, so the sea
     is what remains */
  function clipPath(ctx, map, coast, sz) {
    var b = map.bounds();
    ctx.beginPath();
    ctx.rect(-4, -4, sz.w + 8, sz.h + 8);
    for (var r = 0; r < coast.length; r++) {
      var ring = coast[r];
      if (ring.maxLon < b.west || ring.minLon > b.east || ring.maxLat < b.south || ring.minLat > b.north) continue;
      var p = ring.pts;
      for (var i = 0; i < p.length; i += 2) {
        var q = map.project(p[i + 1], p[i]);
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
    }
    ctx.clip('evenodd');
  }

  /* ---------- the overlay ---------- */
  function Overlay(map, opts) {
    this.map = map; this.kind = opts.kind;           // 'wind' | 'swell'
    this.mode = opts.mode || (this.kind === 'wind' ? 'wind' : 'waves');   // swell: waves | swell1 | wwaves
    this.unit = opts.unit || 'kn';
    this.fmtTime = opts.fmtTime || function (ms) { return new Date(ms).toLocaleTimeString(); };
    this.fmtDay = opts.fmtDay || function (ms) { return new Date(ms).toDateString(); };
    this.onstatus = opts.onstatus || function () {};
    this.ontime = opts.ontime || function () {};
    this.reduced = false;
    try { this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    this.grid = null; this.t = 0; this.loading = false; this.playing = false;
    this.coast = opts.coast || null;             // land rings; the swell layer stops at the shore
    this.field = map.addCanvas('mm-field');
    this.parts = map.addCanvas('mm-particles');
    this.particles = [];
    var self = this;
    var prevMove = map.onmove;
    map.onmove = function (c, z) {
      if (prevMove) prevMove(c, z);
      self.redraw(); self.resetParticles();
      clearTimeout(self._fetchT);
      self._fetchT = setTimeout(function () { self.ensureGrid(); }, 500);
    };
    this._visible = function () { return true; };
    this.ensureGrid();
  }

  Overlay.prototype.setVisible = function (fn) { this._visible = fn; };
  Overlay.prototype.setCoast = function (rings) { this.coast = rings; this.redraw(); this.resetParticles(); };
  Overlay.prototype.clips = function () { return !!(this.coast && this.kind === 'swell'); };

  Overlay.prototype.ensureGrid = function () {
    var self = this, map = this.map;
    if (this.grid && specCovers(this.grid.spec, map) && Date.now() - this.grid.fetched < 90 * 60000) return Promise.resolve(this.grid);
    var spec = gridSpec(map);
    if (this.loading && this.loadingKey === spec.key) return this.loadingP;
    this.loading = true; this.loadingKey = spec.key;
    this.onstatus('loading');
    this.loadingP = fetchGrid(this.kind, spec).then(function (g) {
      self.loading = false;
      self.grid = g;
      /* keep the slider on the same instant when the grid refreshes */
      if (self.t >= g.T) self.t = g.T - 1;
      if (!self._tSet) self.t = self.indexNow();
      self._tSet = true;
      self.onstatus('ready');
      self.ontime(self.t, g.time[self.t] * 1000, g.T);
      self.redraw(); self.resetParticles(); self.animate();
      return g;
    }).catch(function (e) {
      self.loading = false;
      self.onstatus(self.grid ? 'stale' : 'error', e);
      throw e;
    });
    return this.loadingP;
  };

  Overlay.prototype.indexNow = function () {
    var g = this.grid; if (!g) return 0;
    var now = Date.now() / 1000;
    for (var i = 0; i < g.T; i++) if (g.time[i] >= now - 1800) return i;
    return g.T - 1;
  };

  Overlay.prototype.setTime = function (i) {
    var g = this.grid; if (!g) return;
    this.t = Math.max(0, Math.min(g.T - 1, i | 0)); this._tSet = true;
    this.ontime(this.t, g.time[this.t] * 1000, g.T);
    this.redraw();
  };
  Overlay.prototype.setMode = function (m) { this.mode = m; this.redraw(); this.resetParticles(); };
  Overlay.prototype.setUnit = function (u) { this.unit = u; };

  Overlay.prototype.play = function () {
    var self = this; if (this.playing || !this.grid) return;
    this.playing = true;
    this._playT = setInterval(function () {
      if (!self._visible()) return;
      var n = self.t + 1; if (n >= self.grid.T) n = 0;
      self.setTime(n);
    }, 700);
  };
  Overlay.prototype.stop = function () { this.playing = false; clearInterval(this._playT); };

  /* which arrays feed the picture in the current mode */
  Overlay.prototype.fields = function () {
    var f = this.grid.f;
    if (this.kind === 'wind') return { mag: f.wind_speed_10m, dir: f.wind_direction_10m, extra: f.wind_gusts_10m };
    if (this.mode === 'swell1') return { mag: f.swell_wave_height, dir: f.swell_wave_direction, extra: f.swell_wave_period };
    if (this.mode === 'wwaves') return { mag: f.wind_wave_height, dir: f.wave_direction, extra: f.wave_period };
    return { mag: f.wave_height, dir: f.wave_direction, extra: f.wave_period };
  };

  /* value under a point, for the tap readout */
  Overlay.prototype.valueAt = function (lat, lon) {
    var g = this.grid; if (!g) return null;
    var F = this.fields(), t = this.t;
    var mag = sampleScalar(g, F.mag, t, lat, lon);
    if (isNaN(mag)) return null;
    return { mag: mag, dir: sampleDir(g, F.dir, t, lat, lon), extra: sampleScalar(g, F.extra, t, lat, lon), time: g.time[t] * 1000 };
  };

  Overlay.prototype._size = function () {
    var s = this.map.size(), dpr = Math.min(2, window.devicePixelRatio || 1), resized = false;
    [this.field, this.parts].forEach(function (c) {
      if (c.width !== Math.round(s.w * dpr) || c.height !== Math.round(s.h * dpr)) {
        c.width = Math.round(s.w * dpr); c.height = Math.round(s.h * dpr);
        c.style.width = s.w + 'px'; c.style.height = s.h + 'px'; resized = true;
      }
    });
    if (resized) this._partsClipped = false;
    return { w: s.w, h: s.h, dpr: dpr, resized: resized };
  };

  Overlay.prototype.redraw = function () {
    var g = this.grid, sz = this._size(), ctx = this.field.getContext('2d');
    ctx.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);
    ctx.clearRect(0, 0, sz.w, sz.h);
    if (!g) return;
    ctx.save();
    if (this.clips()) clipPath(ctx, this.map, this.coast, sz);
    this._paint(ctx, sz);
    ctx.restore();
  };

  Overlay.prototype._paint = function (ctx, sz) {
    var g = this.grid, F = this.fields(), t = this.t, map = this.map, self = this;
    /* colour field: sampled every 4 px into a small image, then scaled up
       with smoothing so it reads as a continuous wash */
    var cell = 4, cw = Math.ceil(sz.w / cell), ch = Math.ceil(sz.h / cell);
    var off = this._off || (this._off = document.createElement('canvas'));
    off.width = cw; off.height = ch;
    var octx = off.getContext('2d'), img = octx.createImageData(cw, ch), d = img.data;
    var rampFn = this.kind === 'wind' ? WIND_RAMP : WAVE_RAMP, alpha = this.kind === 'wind' ? 130 : 150;
    /* longitude is linear across the screen in Mercator; latitude is not,
       so it is worked out once per row */
    var b = map.bounds(), lonPer = (b.east - b.west) / sz.w;
    for (var y = 0; y < ch; y++) {
      var lat = map.unproject(0, y * cell + cell / 2).lat;
      for (var x = 0; x < cw; x++) {
        var lon = b.west + (x * cell + cell / 2) * lonPer;
        var v = sampleScalar(g, F.mag, t, lat, lon), i = (y * cw + x) * 4;
        if (isNaN(v)) { d[i + 3] = 0; continue; }
        var c = rampFn(v); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = alpha;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, cw, ch, 0, 0, cw * cell, ch * cell);
    /* arrows on a screen lattice, pointing where the wind or swell is going */
    var step = 46, size = 13;
    for (var ay = step / 2; ay < sz.h; ay += step) {
      for (var ax = step / 2; ax < sz.w; ax += step) {
        var p = map.unproject(ax, ay);
        var mag = sampleScalar(g, F.mag, t, p.lat, p.lon); if (isNaN(mag)) continue;
        var dir = sampleDir(g, F.dir, t, p.lat, p.lon); if (isNaN(dir)) continue;
        var col = self.kind === 'wind' ? windColor(mag) : periodColor(sampleScalar(g, F.extra, t, p.lat, p.lon));
        var sc = self.kind === 'wind' ? Math.min(1.25, 0.75 + mag / 30) : Math.min(1.3, 0.7 + mag / 3);
        ctx.save(); ctx.translate(ax, ay); ctx.rotate((dir + 180) * Math.PI / 180); ctx.scale(size / 18 * sc, size / 18 * sc);
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(7, 0); ctx.lineTo(3, 0); ctx.lineTo(3, 9); ctx.lineTo(-3, 9); ctx.lineTo(-3, 0); ctx.lineTo(-7, 0); ctx.closePath();
        ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1.2 / (size / 18 * sc); ctx.fill(); ctx.stroke();
        ctx.restore();
      }
    }
  };

  /* ---------- particles ---------- */
  Overlay.prototype.resetParticles = function () {
    var sz = this._size(), n = this.reduced ? 0 : Math.round(sz.w * sz.h / 700);
    this.particles = [];
    for (var i = 0; i < n; i++) this.particles.push({ x: Math.random() * sz.w, y: Math.random() * sz.h, age: Math.random() * 80 | 0 });
    var ctx = this.parts.getContext('2d');
    if (this._partsClipped) { ctx.restore(); this._partsClipped = false; }
    ctx.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0); ctx.clearRect(0, 0, sz.w, sz.h);
    if (this.clips()) { ctx.save(); clipPath(ctx, this.map, this.coast, sz); this._partsClipped = true; }
  };

  Overlay.prototype.animate = function () {
    var self = this;
    if (this._raf) return;
    var last = 0;
    function frame(now) {
      self._raf = requestAnimationFrame(frame);
      if (!self.grid || self.reduced || !self._visible() || document.hidden) return;
      if (now - last < 33) return;      // ~30 fps is plenty on a phone
      last = now;
      self.step();
    }
    this._raf = requestAnimationFrame(frame);
  };
  Overlay.prototype.destroy = function () { cancelAnimationFrame(this._raf); this._raf = null; this.stop(); };

  Overlay.prototype.step = function () {
    var g = this.grid, sz = this._size(), ctx = this.parts.getContext('2d'), map = this.map, F = this.fields(), t = this.t;
    ctx.setTransform(sz.dpr, 0, 0, sz.dpr, 0, 0);
    /* fade what is there so the trails taper */
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.90)'; ctx.fillRect(0, 0, sz.w, sz.h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    var wind = this.kind === 'wind';
    ctx.strokeStyle = wind ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    for (var i = 0; i < this.particles.length; i++) {
      var p = this.particles[i];
      var ll = map.unproject(p.x, p.y);
      var mag = sampleScalar(g, F.mag, t, ll.lat, ll.lon), dir = sampleDir(g, F.dir, t, ll.lat, ll.lon);
      if (isNaN(mag) || isNaN(dir) || p.age > 90) {
        p.x = Math.random() * sz.w; p.y = Math.random() * sz.h; p.age = 0; continue;
      }
      /* wind speed in knots, swell by period: both scaled to a walk that
         reads as motion without turning into snow */
      var speed = wind ? 0.06 + mag * 0.11 : 0.4 + (sampleScalar(g, F.extra, t, ll.lat, ll.lon) || 8) * 0.12;
      var r = (dir + 180) * Math.PI / 180;
      var nx = p.x + Math.sin(r) * speed, ny = p.y - Math.cos(r) * speed;
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny; p.age++;
      if (p.x < 0 || p.y < 0 || p.x > sz.w || p.y > sz.h) { p.x = Math.random() * sz.w; p.y = Math.random() * sz.h; p.age = 0; }
    }
    ctx.stroke();
  };

  /* legend swatches for the html under the map */
  Overlay.legend = function (kind, unit) {
    var stops = kind === 'wind' ? [0, 5, 10, 15, 20, 25, 30, 40] : [0, 0.5, 1, 1.5, 2, 3, 4, 5];
    var fn = kind === 'wind' ? WIND_RAMP : WAVE_RAMP;
    var grad = stops.map(function (v, i) { return rgb(fn(v), 1) + ' ' + Math.round(100 * i / (stops.length - 1)) + '%'; }).join(',');
    var labels = kind === 'wind'
      ? stops.map(function (v) { return unit === 'kmh' ? Math.round(v * 1.852) : v; })
      : stops.map(function (v) { return v; });
    return '<div class="ovbar" style="background:linear-gradient(90deg,' + grad + ')"></div><div class="ovticks">' +
      labels.map(function (l) { return '<span>' + l + '</span>'; }).join('') + '</div>' +
      '<div class="muted" style="font-size:11px">' + (kind === 'wind' ? (unit === 'kmh' ? 'km/h' : 'knots') + ' at 10 m · arrows point where the wind is going · particles drift with it' : 'metres · arrows point where the swell is heading, coloured by period (light &lt;8 s, mid 8–11 s, dark 12 s+)') + '</div>';
  };

  global.WxOverlay = { Overlay: Overlay, legend: Overlay.legend, decodeCoast: decodeCoast, gridSpec: gridSpec, fetchGrid: fetchGrid, sampleScalar: sampleScalar, sampleDir: sampleDir, WIND_RAMP: WIND_RAMP, WAVE_RAMP: WAVE_RAMP };
})(typeof window !== 'undefined' ? window : globalThis);
