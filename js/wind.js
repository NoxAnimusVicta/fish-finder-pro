/* wind.js — Seabreeze-style wind, wave and live-station charts.
   Pure rendering: takes plain arrays, draws SVG, wires a scrub tooltip.
   Everything is in knots internally; the caller says which unit to lead with. */
(function (global) {
  'use strict';

  var HOUR = 3600000;

  /* ---------- palette: same four bands Seabreeze readers already know ---------- */
  function windColor(kt) {
    if (kt == null) return 'var(--ink3)';
    if (kt < 10) return '#35d43a';
    if (kt < 20) return '#ffe11a';
    if (kt < 30) return '#ff8a1f';
    return '#ff2f2f';
  }
  function periodColor(s) {
    if (s == null) return 'var(--ink3)';
    if (s < 8) return '#7fb8ff';
    if (s < 12) return '#2f7ff5';
    return '#0b4bd6';
  }
  function kmh(kt) { return kt == null ? null : kt * 1.852; }
  function ftIn(m) {
    if (m == null) return '—';
    var inches = m / 0.0254, ft = Math.floor(inches / 12), inch = Math.round(inches - ft * 12);
    if (inch === 12) { ft++; inch = 0; }
    return ft + "'" + inch + '"';
  }
  function compass(d) {
    if (d == null) return '—';
    var pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round(((d % 360) / 22.5)) % 16];
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  /* Chunky arrow pointing up (north); rotate by (from-direction + 180) so it
     points where the wind is going, the way Seabreeze draws it. */
  function arrow(x, y, deg, size, fill, opacity, stroke) {
    var s = size / 18;
    return '<path d="M0,-9 L7,0 L3,0 L3,9 L-3,9 L-3,0 L-7,0 Z" transform="translate(' + x.toFixed(1) + ' ' + y.toFixed(1) +
      ') rotate(' + ((deg == null ? 0 : deg + 180) % 360).toFixed(0) + ') scale(' + s.toFixed(2) + ')" fill="' + fill +
      '" stroke="' + (stroke || 'rgba(0,0,0,.45)') + '" stroke-width="1.2" vector-effect="non-scaling-stroke"' + (opacity != null ? ' opacity="' + opacity + '"' : '') + '/>';
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function sample(T, V, ms) {
    if (!T || !V || !T.length) return null;
    var t = ms / 1000;
    if (t <= T[0]) return V[0];
    var n = T.length; if (t >= T[n - 1]) return V[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
    var a = V[lo], b = V[hi];
    if (a == null || b == null) return a == null ? b : a;
    return lerp(a, b, (t - T[lo]) / (T[hi] - T[lo]));
  }
  function niceMax(v, step, floor) { return Math.max(floor, Math.ceil((v || 0) / step) * step); }

  /* ---------- scrub tooltip shared by every chart ---------- */
  function bindScrub(wrap, svg, opts) {
    /* opts: {x0, x1 (svg units), t0, t1 (ms), width (svg units), onTip(ms) -> html|null} */
    var tip = wrap.querySelector('.wtip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'wtip'; wrap.appendChild(tip); }
    var line = wrap.querySelector('.wline');
    if (!line) { line = document.createElement('div'); line.className = 'wline'; wrap.appendChild(line); }
    var active = false;
    function show(clientX) {
      var r = svg.getBoundingClientRect();
      var fx = (clientX - r.left) / r.width * opts.width;
      var f = (fx - opts.x0) / (opts.x1 - opts.x0);
      if (f < 0) f = 0; if (f > 1) f = 1;
      var ms = opts.t0 + f * (opts.t1 - opts.t0);
      var html = opts.onTip(ms);
      if (!html) { hide(); return; }
      tip.innerHTML = html; tip.style.display = '';
      var px = (opts.x0 + f * (opts.x1 - opts.x0)) / opts.width * r.width;
      line.style.display = ''; line.style.left = px + 'px';
      var tw = tip.offsetWidth, left = px - tw / 2;
      if (left < 4) left = 4; if (left + tw > r.width - 4) left = r.width - tw - 4;
      tip.style.left = left + 'px';
      active = true;
    }
    function hide() { tip.style.display = 'none'; line.style.display = 'none'; active = false; }
    svg.addEventListener('pointerdown', function (e) { show(e.clientX); try { svg.setPointerCapture(e.pointerId); } catch (x) {} });
    svg.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse' || e.buttons || active) show(e.clientX); });
    svg.addEventListener('pointerup', function () { setTimeout(hide, 2500); });
    svg.addEventListener('pointercancel', hide);
    svg.addEventListener('mouseleave', function () { if (!('ontouchstart' in window)) hide(); });
    hide();
    return { show: show, hide: hide };
  }

  /* ================= 1. wind & wave forecast ================= */
  /* d: { time[] (unix s), wind[] kt, gust[] kt, dir[] deg, wave[] m|null, wavePeriod[]|null, waveDir[]|null,
          code[] wmo, rainPct[]|null (same index as time), rainMm[],
          daily: {time[], code[], tmin[], tmax[]}, sun: fn(ms)->{sunrise,sunset} }
     o: { hours, now, unit 'kn'|'kmh', fmtTime(ms), fmtDay(ms), fmtDate(ms), icon(code, night), desc(code), stepHours } */
  function windWave(wrap, d, o) {
    var W = 340, H = 236, padL = 30, padR = 30, top = 52, bottom = 34;
    var t0 = Math.floor(o.now / HOUR) * HOUR - HOUR, t1 = t0 + o.hours * HOUR;
    var x0 = padL, x1 = W - padR;
    var X = function (ms) { return x0 + (ms - t0) / (t1 - t0) * (x1 - x0); };
    var maxKt = 0, maxWave = 0, i;
    for (i = 0; i < d.time.length; i++) {
      var ts = d.time[i] * 1000; if (ts < t0 || ts > t1) continue;
      if (d.wind[i] != null) maxKt = Math.max(maxKt, d.wind[i]);
      if (d.gust && d.gust[i] != null && o.hours <= 48) maxKt = Math.max(maxKt, d.gust[i]);
      if (d.wave && d.wave[i] != null) maxWave = Math.max(maxWave, d.wave[i]);
    }
    var ktMax = niceMax(maxKt + 3, 5, 25), wvMax = niceMax(maxWave + 0.5, 1, 3);
    var Yk = function (kt) { return H - bottom - kt / ktMax * (H - bottom - top); };
    var Yw = function (m) { return H - bottom - m / wvMax * (H - bottom - top); };
    var g = '';
    /* night shading */
    for (var day = t0 - 12 * HOUR; day < t1 + 12 * HOUR; day += 24 * HOUR) {
      var sn = o.sun(day);
      if (!sn || !sn.sunset || !sn.sunrise) continue;
      var a = sn.sunset.valueOf(), b = sn.sunrise.valueOf() + 24 * HOUR; // this dusk to next dawn (approx)
      var nx = o.sun(day + 24 * HOUR); if (nx && nx.sunrise) b = nx.sunrise.valueOf();
      var xa = Math.max(x0, X(a)), xb = Math.min(x1, X(b));
      if (xb > xa) g += '<rect x="' + xa.toFixed(1) + '" y="' + top + '" width="' + (xb - xa).toFixed(1) + '" height="' + (H - bottom - top) + '" fill="var(--t-ink-5)"/>';
    }
    /* grid + axes */
    for (var k = 0; k <= ktMax; k += 5) {
      g += '<line x1="' + x0 + '" y1="' + Yk(k).toFixed(1) + '" x2="' + x1 + '" y2="' + Yk(k).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"/>';
      if (k % 10 === 0) g += '<text x="' + (W - 2) + '" y="' + (Yk(k) + 3.5).toFixed(1) + '" font-size="9.5" fill="var(--ink3)" text-anchor="end">' + (o.unit === 'kmh' ? Math.round(kmh(k)) : k) + '</text>';
    }
    for (var m = 0; m <= wvMax; m += 1) g += '<text x="2" y="' + (Yw(m) + 3.5).toFixed(1) + '" font-size="9.5" fill="var(--accent)">' + m + '</text>';
    g += '<text x="2" y="' + (top - 6) + '" font-size="8.5" fill="var(--accent)">m</text>';
    g += '<text x="' + (W - 2) + '" y="' + (top - 6) + '" font-size="8.5" fill="var(--ink3)" text-anchor="end">' + (o.unit === 'kmh' ? 'km/h' : 'kt') + '</text>';
    /* wave area */
    if (d.wave) {
      var path = '', started = false;
      for (i = 0; i < d.time.length; i++) {
        var tm = d.time[i] * 1000; if (tm < t0 - HOUR || tm > t1 + HOUR || d.wave[i] == null) continue;
        var xx = Math.min(x1, Math.max(x0, X(tm)));
        path += (started ? 'L' : 'M') + xx.toFixed(1) + ' ' + Yw(d.wave[i]).toFixed(1) + ' '; started = true;
      }
      if (started) g += '<path d="' + path + 'L' + x1 + ' ' + (H - bottom) + ' L' + x0 + ' ' + (H - bottom) + ' Z" fill="var(--t-accent-30)"/>' +
        '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="1.6"/>';
    }
    /* day bands: label, icon, temps */
    var dayStart = o.dayStart(t0);
    for (var ds = dayStart; ds < t1; ds += 24 * HOUR) {
      var de = Math.min(t1, ds + 24 * HOUR), dsx = Math.max(x0, X(ds)), dex = Math.min(x1, X(de));
      if (dex - dsx < 24) continue;
      var mid = (dsx + dex) / 2;
      if (X(ds) > x0) g += '<line x1="' + X(ds).toFixed(1) + '" y1="' + (top - 4) + '" x2="' + X(ds).toFixed(1) + '" y2="' + (H - bottom + 4) + '" stroke="var(--line)"/>';
      var di = -1; for (var q = 0; q < d.daily.time.length; q++) if (Math.abs(d.daily.time[q] * 1000 - ds) < HOUR * 2) di = q;
      var wide = dex - dsx > 60;
      g += '<text x="' + mid.toFixed(1) + '" y="' + (H - 6) + '" font-size="11" font-weight="700" fill="var(--ink)" text-anchor="middle">' + esc(o.fmtDay(ds + 12 * HOUR)) + '</text>';
      if (di >= 0) {
        g += '<text x="' + mid.toFixed(1) + '" y="16" font-size="16" text-anchor="middle">' + o.icon(d.daily.code[di], false) + '</text>';
        g += '<text x="' + mid.toFixed(1) + '" y="34" font-size="' + (wide ? 11 : 9.5) + '" fill="var(--ink2)" text-anchor="middle">' +
          Math.round(d.daily.tmin[di]) + '–' + Math.round(d.daily.tmax[di]) + '°</text>';
      }
      /* hour ticks */
      var dw = dex - dsx, tickEvery = dw > 200 ? 3 : (dw > 110 ? 6 : 12);
      for (var hh = tickEvery; hh < 24; hh += tickEvery) {
        var tt = ds + hh * HOUR; if (tt < t0 || tt > t1) continue;
        g += '<text x="' + X(tt).toFixed(1) + '" y="' + (H - bottom + 12) + '" font-size="8.5" fill="var(--ink3)" text-anchor="middle">' + esc(o.fmtTime(tt).replace(':00', '')) + '</text>';
      }
    }
    /* arrows */
    var step = o.stepHours * HOUR, size = o.hours <= 48 ? 15 : (o.hours <= 96 ? 13 : 11);
    var arrows = '', gusts = '';
    for (var at = Math.ceil(t0 / step) * step; at <= t1; at += step) {
      var kt = sample(d.time, d.wind, at), dir = sample(d.time, d.dir, at), gu = d.gust ? sample(d.time, d.gust, at) : null;
      if (kt == null) continue;
      if (gu != null && o.hours <= 48) gusts += arrow(X(at), Yk(Math.min(gu, ktMax)), dir, size - 2, 'var(--t-ink-12)', 1, 'rgba(0,0,0,0)');
      arrows += arrow(X(at), Yk(Math.min(kt, ktMax)), dir, size, windColor(kt));
    }
    g += gusts + arrows;
    /* now line */
    if (o.now >= t0 && o.now <= t1) g += '<line x1="' + X(o.now).toFixed(1) + '" y1="' + (top - 4) + '" x2="' + X(o.now).toFixed(1) + '" y2="' + (H - bottom) + '" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="4 3"/>';
    wrap.innerHTML = '<svg class="chart wchart" viewBox="0 0 ' + W + ' ' + H + '" style="height:' + H + 'px">' + g + '</svg>';
    var svg = wrap.querySelector('svg');
    bindScrub(wrap, svg, { x0: x0, x1: x1, t0: t0, t1: t1, width: W, onTip: function (ms) {
      var kt = sample(d.time, d.wind, ms), gu = d.gust ? sample(d.time, d.gust, ms) : null, dir = sample(d.time, d.dir, ms);
      if (kt == null) return null;
      var code = null, ci = 0, best = 1e18;
      for (var j = 0; j < d.time.length; j++) { var dd = Math.abs(d.time[j] * 1000 - ms); if (dd < best) { best = dd; ci = j; } }
      code = d.code ? d.code[ci] : null;
      var sn = o.sun(ms), night = !!(sn && sn.sunrise && sn.sunset && (ms < sn.sunrise.valueOf() || ms > sn.sunset.valueOf()));
      var rain = d.rainPct ? d.rainPct[ci] : null, mm = d.rainMm ? d.rainMm[ci] : null;
      var wv = d.wave ? sample(d.time, d.wave, ms) : null, per = d.wavePeriod ? sample(d.time, d.wavePeriod, ms) : null, wd = d.waveDir ? sample(d.time, d.waveDir, ms) : null;
      var rainLine = rain != null ? '<span class="' + (rain >= 50 ? 'bad' : rain >= 25 ? 'ok' : 'good') + '">' + rain + '% chance of rain</span>' :
        (mm != null && mm > 0.1 ? '<span class="ok">' + (Math.round(mm * 10) / 10) + ' mm</span>' : '<span class="good">Dry</span>');
      return '<div class="h">' + esc(o.fmtDay(ms)) + ' ' + esc(o.fmtTime(ms)) + '</div>' +
        '<div class="c">' + o.icon(code, night) + ' ' + esc(o.desc(code)) + ' · ' + rainLine + '</div>' +
        '<div class="g"><div><div class="k">Wind</div><b>' + Math.round(kt) + ' kt</b><br>' + Math.round(kmh(kt)) + ' km/h<br>' + compass(dir) +
        (gu != null ? '<br><span class="m">gusts ' + Math.round(gu) + ' kt</span>' : '') + '</div>' +
        (wv != null ? '<div><div class="k">Waves</div><b>' + (Math.round(wv * 10) / 10).toFixed(1) + ' m</b><br>' + ftIn(wv) + (per != null ? '<br>' + Math.round(per) + ' s ' + compass(wd) : '') + '</div>' : '') +
        '</div>';
    } });
  }

  /* ================= 2. wave / swell forecast ================= */
  /* d: {time[], wave[] total m, swell[] m, swellPeriod[] s, swellDir[] deg, windWave[] m, period[] s (total)} */
  function waveChart(wrap, d, o) {
    var W = 340, H = 190, padL = 30, padR = 30, top = 22, bottom = 34;
    var t0 = Math.floor(o.now / HOUR) * HOUR - HOUR, t1 = t0 + o.hours * HOUR;
    var x0 = padL, x1 = W - padR;
    var X = function (ms) { return x0 + (ms - t0) / (t1 - t0) * (x1 - x0); };
    var maxWave = 0, maxPer = 0, i;
    for (i = 0; i < d.time.length; i++) {
      var ts = d.time[i] * 1000; if (ts < t0 || ts > t1) continue;
      if (d.wave[i] != null) maxWave = Math.max(maxWave, d.wave[i]);
      if (d.swellPeriod && d.swellPeriod[i] != null) maxPer = Math.max(maxPer, d.swellPeriod[i]);
    }
    var wvMax = niceMax(maxWave + 0.5, 1, 3), perMax = niceMax(maxPer + 2, 4, 16);
    var Yw = function (m) { return H - bottom - m / wvMax * (H - bottom - top); };
    var Yp = function (s) { return H - bottom - s / perMax * (H - bottom - top); };
    var g = '';
    for (var m = 0; m <= wvMax; m += 1) {
      g += '<line x1="' + x0 + '" y1="' + Yw(m).toFixed(1) + '" x2="' + x1 + '" y2="' + Yw(m).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"/>' +
        '<text x="2" y="' + (Yw(m) + 3.5).toFixed(1) + '" font-size="9.5" fill="var(--accent)">' + m + '</text>';
    }
    for (var p = 0; p <= perMax; p += 4) g += '<text x="' + (W - 2) + '" y="' + (Yp(p) + 3.5).toFixed(1) + '" font-size="9.5" fill="#2f7ff5" text-anchor="end">' + p + '</text>';
    g += '<text x="2" y="' + (top - 8) + '" font-size="8.5" fill="var(--accent)">m</text><text x="' + (W - 2) + '" y="' + (top - 8) + '" font-size="8.5" fill="#2f7ff5" text-anchor="end">period s</text>';
    var path = '', spath = '', started = false, sstarted = false;
    for (i = 0; i < d.time.length; i++) {
      var tm = d.time[i] * 1000; if (tm < t0 - HOUR || tm > t1 + HOUR) continue;
      var xx = Math.min(x1, Math.max(x0, X(tm)));
      if (d.wave[i] != null) { path += (started ? 'L' : 'M') + xx.toFixed(1) + ' ' + Yw(d.wave[i]).toFixed(1) + ' '; started = true; }
      if (d.swell && d.swell[i] != null) { spath += (sstarted ? 'L' : 'M') + xx.toFixed(1) + ' ' + Yw(d.swell[i]).toFixed(1) + ' '; sstarted = true; }
    }
    if (started) g += '<path d="' + path + 'L' + x1 + ' ' + (H - bottom) + ' L' + x0 + ' ' + (H - bottom) + ' Z" fill="var(--t-accent-30)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="1.6"/>';
    if (sstarted) g += '<path d="' + spath + '" fill="none" stroke="var(--accent)" stroke-width="1.2" stroke-dasharray="3 3" opacity=".8"/>';
    if (o.limit != null && o.limit <= wvMax) g += '<line x1="' + x0 + '" y1="' + Yw(o.limit).toFixed(1) + '" x2="' + x1 + '" y2="' + Yw(o.limit).toFixed(1) + '" stroke="#ff2f2f" stroke-width="1.2" stroke-dasharray="4 3"/>' +
      '<text x="' + (x1 - 2) + '" y="' + (Yw(o.limit) - 3).toFixed(1) + '" font-size="8.5" fill="#ff2f2f" text-anchor="end">your limit ' + o.limit.toFixed(1) + ' m</text>';
    var dayStart = o.dayStart(t0);
    for (var ds = dayStart; ds < t1; ds += 24 * HOUR) {
      var de = Math.min(t1, ds + 24 * HOUR), dsx = Math.max(x0, X(ds)), dex = Math.min(x1, X(de));
      if (dex - dsx < 24) continue;
      if (X(ds) > x0) g += '<line x1="' + X(ds).toFixed(1) + '" y1="' + top + '" x2="' + X(ds).toFixed(1) + '" y2="' + (H - bottom + 4) + '" stroke="var(--line)"/>';
      g += '<text x="' + ((dsx + dex) / 2).toFixed(1) + '" y="' + (H - 6) + '" font-size="11" font-weight="700" fill="var(--ink)" text-anchor="middle">' + esc(o.fmtDay(ds + 12 * HOUR)) + '</text>';
      var tickEvery = dex - dsx > 110 ? 6 : 12;
      for (var hh = tickEvery; hh < 24; hh += tickEvery) {
        var tt = ds + hh * HOUR; if (tt < t0 || tt > t1 || dex - dsx < 60) continue;
        g += '<text x="' + X(tt).toFixed(1) + '" y="' + (H - bottom + 12) + '" font-size="8.5" fill="var(--ink3)" text-anchor="middle">' + esc(o.fmtTime(tt).replace(':00', '')) + '</text>';
      }
    }
    var step = o.stepHours * HOUR, size = o.hours <= 48 ? 14 : 11, arrows = '';
    for (var at = Math.ceil(t0 / step) * step; at <= t1; at += step) {
      var per = d.swellPeriod ? sample(d.time, d.swellPeriod, at) : null, dir = d.swellDir ? sample(d.time, d.swellDir, at) : null;
      if (per == null) continue;
      arrows += arrow(X(at), Yp(Math.min(per, perMax)), dir, size, periodColor(per));
    }
    g += arrows;
    if (o.now >= t0 && o.now <= t1) g += '<line x1="' + X(o.now).toFixed(1) + '" y1="' + top + '" x2="' + X(o.now).toFixed(1) + '" y2="' + (H - bottom) + '" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="4 3"/>';
    wrap.innerHTML = '<svg class="chart wchart" viewBox="0 0 ' + W + ' ' + H + '" style="height:' + H + 'px">' + g + '</svg>';
    bindScrub(wrap, wrap.querySelector('svg'), { x0: x0, x1: x1, t0: t0, t1: t1, width: W, onTip: function (ms) {
      var wv = sample(d.time, d.wave, ms); if (wv == null) return null;
      var sw = d.swell ? sample(d.time, d.swell, ms) : null, per = d.swellPeriod ? sample(d.time, d.swellPeriod, ms) : null;
      var dir = d.swellDir ? sample(d.time, d.swellDir, ms) : null, ww = d.windWave ? sample(d.time, d.windWave, ms) : null;
      return '<div class="h">' + esc(o.fmtDay(ms)) + ' ' + esc(o.fmtTime(ms)) + '</div>' +
        '<div class="g"><div><div class="k">Total sea</div><b>' + wv.toFixed(1) + ' m</b><br>' + ftIn(wv) + '</div>' +
        '<div><div class="k">Swell</div><b>' + (sw != null ? sw.toFixed(1) + ' m' : '—') + '</b><br>' + (per != null ? Math.round(per) + ' s ' + compass(dir) : '') +
        (ww != null ? '<br><span class="m">wind chop ' + ww.toFixed(1) + ' m</span>' : '') + '</div></div>' +
        (per != null ? '<div class="c">' + (per >= 12 ? 'Long-period groundswell — power and push' : per >= 8 ? 'Mid-period swell' : 'Short-period wind swell — messy') + '</div>' : '');
    } });
  }

  /* ================= 3. live station wind report ================= */
  /* rows: [[unix s, kt, gustKt, dir, temp, press], ...] sorted; o: {now, hours, unit, fmtTime, fmtDay, compact} */
  function liveWind(wrap, rows, o) {
    var W = 340, H = o.compact ? 110 : 178, padL = 30, padR = 30, top = 14, bottom = o.compact ? 20 : 26;
    var t1 = o.now, t0 = t1 - o.hours * HOUR;
    var x0 = padL, x1 = W - padR;
    var X = function (ms) { return x0 + (ms - t0) / (t1 - t0) * (x1 - x0); };
    var pts = rows.filter(function (r) { return r[0] * 1000 >= t0 - 15 * 60000 && r[1] != null; });
    if (pts.length < 2) { wrap.innerHTML = '<div class="muted">No recent readings from this station.</div>'; return; }
    var maxKt = 0;
    pts.forEach(function (r) { maxKt = Math.max(maxKt, r[1] || 0, r[2] || 0); });
    var ktMax = niceMax(maxKt + 3, 5, 20);
    var Y = function (kt) { return H - bottom - kt / ktMax * (H - bottom - top); };
    var g = '';
    for (var k = 0; k <= ktMax; k += 5) {
      g += '<line x1="' + x0 + '" y1="' + Y(k).toFixed(1) + '" x2="' + x1 + '" y2="' + Y(k).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 3"/>';
      if (k % 10 === 0 || ktMax <= 20) {
        g += '<text x="' + (W - 2) + '" y="' + (Y(k) + 3.5).toFixed(1) + '" font-size="9.5" fill="var(--ink3)" text-anchor="end">' + k + '</text>';
        g += '<text x="2" y="' + (Y(k) + 3.5).toFixed(1) + '" font-size="9.5" fill="var(--ink3)">' + Math.round(kmh(k)) + '</text>';
      }
    }
    g += '<text x="2" y="' + (top - 4) + '" font-size="8.5" fill="var(--ink3)">km/h</text><text x="' + (W - 2) + '" y="' + (top - 4) + '" font-size="8.5" fill="var(--ink3)" text-anchor="end">kt</text>';
    /* hour ticks */
    for (var ht = Math.ceil(t0 / HOUR) * HOUR; ht <= t1; ht += HOUR) {
      var hrs = Math.round((t1 - ht) / HOUR), every = o.hours > 8 ? 2 : 1;
      if (hrs % every) continue;
      g += '<text x="' + X(ht).toFixed(1) + '" y="' + (H - bottom + 12) + '" font-size="8.5" fill="var(--ink3)" text-anchor="middle">' + esc(o.fmtTime(ht).replace(':00', '')) + '</text>';
    }
    /* thin line through the averages so gaps read as gaps */
    var line = '', started = false, prevT = null;
    pts.forEach(function (r) {
      var ms = r[0] * 1000, xx = X(ms);
      if (prevT != null && ms - prevT > 70 * 60000) started = false;
      line += (started ? 'L' : 'M') + xx.toFixed(1) + ' ' + Y(Math.min(r[1], ktMax)).toFixed(1) + ' '; started = true; prevT = ms;
    });
    g += '<path d="' + line + '" fill="none" stroke="var(--t-ink-12)" stroke-width="1"/>';
    /* thin arrows down to size when there are many readings (10-minute stations) */
    var n = pts.length, size = n > 60 ? 9 : n > 36 ? 11 : 13;
    var gusts = '', avgs = '';
    pts.forEach(function (r) {
      var ms = r[0] * 1000, xx = X(ms);
      if (r[2] != null) gusts += arrow(xx, Y(Math.min(r[2], ktMax)), r[3], size - 1, 'var(--t-ink-12)', 1, 'rgba(0,0,0,0)');
      avgs += arrow(xx, Y(Math.min(r[1], ktMax)), r[3], size, windColor(r[1]));
    });
    g += gusts + avgs;
    g += '<line x1="' + X(t1).toFixed(1) + '" y1="' + top + '" x2="' + X(t1).toFixed(1) + '" y2="' + (H - bottom) + '" stroke="#e0362c" stroke-width="1.2"/>';
    wrap.innerHTML = '<svg class="chart wchart" viewBox="0 0 ' + W + ' ' + H + '" style="height:' + H + 'px">' + g + '</svg>';
    bindScrub(wrap, wrap.querySelector('svg'), { x0: x0, x1: x1, t0: t0, t1: t1, width: W, onTip: function (ms) {
      var best = null, bd = 1e18;
      pts.forEach(function (r) { var dd = Math.abs(r[0] * 1000 - ms); if (dd < bd) { bd = dd; best = r; } });
      if (!best || bd > 45 * 60000) return null;
      var tm = best[0] * 1000;
      return '<div class="h">' + esc(o.fmtDay(tm)) + ' ' + esc(o.fmtTime(tm)) + '</div>' +
        '<div class="g"><div><div class="k">Average</div><b>' + Math.round(best[1]) + ' kt</b><br>' + Math.round(kmh(best[1])) + ' km/h<br>' + compass(best[3]) + '</div>' +
        '<div><div class="k">Gust</div><b>' + (best[2] != null ? Math.round(best[2]) + ' kt' : '—') + '</b><br>' + (best[2] != null ? Math.round(kmh(best[2])) + ' km/h' : '') + '<br>' + compass(best[3]) + '</div></div>' +
        ((best[4] != null || best[5] != null) ? '<div class="c">' + (best[4] != null ? best[4] + '°' : '') + (best[5] != null ? ' · ' + best[5] + ' hPa' : '') + '</div>' : '');
    } });
  }

  global.WindCharts = { windWave: windWave, waveChart: waveChart, liveWind: liveWind, windColor: windColor, ftIn: ftIn, bindScrub: bindScrub };
})(typeof window !== 'undefined' ? window : globalThis);
