/* astro.js — sun, moon and solunar maths.
   Self-contained, no dependencies. Accuracy is well inside a minute for
   rise/set at NSW latitudes, which is all a fishing app needs. */
(function (global) {
  'use strict';

  var RAD = Math.PI / 180, DEG = 180 / Math.PI;
  var DAY_MS = 86400000;
  var J1970 = 2440588, J2000 = 2451545;

  function sin(d) { return Math.sin(d * RAD); }
  function cos(d) { return Math.cos(d * RAD); }
  function tan(d) { return Math.tan(d * RAD); }
  function rev(x) { return x - Math.floor(x / 360) * 360; }
  function rev180(x) { var r = rev(x); return r > 180 ? r - 360 : r; }

  function toJulian(date) { return date.valueOf() / DAY_MS - 0.5 + J1970; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * DAY_MS); }
  function daysSinceJ2000(date) { return toJulian(date) - J2000; }
  /* Schlyter's orbital elements are referred to 2000 Jan 0.0 = JD 2451543.5,
     which is 1.5 days before J2000.0. Mixing the two epochs shifts the sun by
     about 1.5 degrees, i.e. six minutes of time — so keep them separate. */
  function daysSchlyter(date) { return toJulian(date) - 2451543.5; }

  /* ---------- timezone helpers ---------------------------------------- */

  var _dtfCache = {};
  function dtf(tz) {
    if (!_dtfCache[tz]) {
      _dtfCache[tz] = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }
    return _dtfCache[tz];
  }

  /* Minutes that the zone is ahead of UTC at this instant. */
  function tzOffset(date, tz) {
    var p = dtf(tz).formatToParts(date), o = {};
    for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    var asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
    return Math.round((asUTC - (date.valueOf() - date.valueOf() % 1000)) / 60000);
  }

  /* Wall-clock fields in the zone. */
  function parts(date, tz) {
    var p = dtf(tz).formatToParts(date), o = {};
    for (var i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
    return {
      year: +o.year, month: +o.month, day: +o.day,
      hour: +o.hour % 24, minute: +o.minute, second: +o.second
    };
  }

  /* The UTC instant of local midnight starting the given local calendar day. */
  function localMidnight(y, m, d, tz) {
    var guess = Date.UTC(y, m - 1, d, 0, 0, 0);
    for (var i = 0; i < 3; i++) {
      var off = tzOffset(new Date(guess), tz);
      var next = Date.UTC(y, m - 1, d, 0, 0, 0) - off * 60000;
      if (next === guess) break;
      guess = next;
    }
    return new Date(guess);
  }

  /* Local midnight of the day containing `date`. */
  function startOfLocalDay(date, tz) {
    var p = parts(date, tz);
    return localMidnight(p.year, p.month, p.day, tz);
  }

  function addDaysLocal(date, n, tz) {
    var p = parts(date, tz);
    var base = new Date(Date.UTC(p.year, p.month - 1, p.day));
    base.setUTCDate(base.getUTCDate() + n);
    return localMidnight(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), tz);
  }

  /* ---------- sidereal time ------------------------------------------- */

  function gmst(date) {                     // degrees
    var d = daysSinceJ2000(date);
    return rev(280.46061837 + 360.98564736629 * d);
  }
  function lmst(date, lon) { return rev(gmst(date) + lon); }

  /* ---------- sun ------------------------------------------------------ */

  function sunEcliptic(date) {
    var d = daysSchlyter(date);
    var w = 282.9404 + 4.70935e-5 * d;        // longitude of perihelion
    var M = rev(356.0470 + 0.9856002585 * d); // mean anomaly
    var e = 0.016709 - 1.151e-9 * d;
    var E = M + e * DEG * sin(M) * (1 + e * cos(M));
    var xv = cos(E) - e, yv = Math.sqrt(1 - e * e) * sin(E);
    var v = rev(Math.atan2(yv, xv) * DEG);
    var r = Math.sqrt(xv * xv + yv * yv);
    return { lon: rev(v + w), r: r, M: M, w: w };
  }

  function obliquity(date) { return 23.4393 - 3.563e-7 * daysSchlyter(date); }

  function eclToEq(lon, lat, ecl) {
    var xs = cos(lon) * cos(lat), ys = sin(lon) * cos(lat), zs = sin(lat);
    var xe = xs, ye = ys * cos(ecl) - zs * sin(ecl), ze = ys * sin(ecl) + zs * cos(ecl);
    return { ra: rev(Math.atan2(ye, xe) * DEG), dec: Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * DEG };
  }

  function altitude(ra, dec, date, lat, lon) {
    var ha = rev180(lmst(date, lon) - ra);
    var h = Math.asin(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha)) * DEG;
    return h;
  }

  function azimuth(ra, dec, date, lat, lon) {
    var ha = rev180(lmst(date, lon) - ra);
    var y = -sin(ha) * cos(dec);
    var x = cos(lat) * sin(dec) - sin(lat) * cos(dec) * cos(ha);
    return rev(Math.atan2(y, x) * DEG);
  }

  function sunPosition(date, lat, lon) {
    var s = sunEcliptic(date), eq = eclToEq(s.lon, 0, obliquity(date));
    return {
      ra: eq.ra, dec: eq.dec,
      alt: altitude(eq.ra, eq.dec, date, lat, lon),
      az: azimuth(eq.ra, eq.dec, date, lat, lon),
      lon: s.lon
    };
  }

  /* ---------- moon ----------------------------------------------------- */

  function moonEcliptic(date) {
    var d = daysSchlyter(date);
    var N = rev(125.1228 - 0.0529538083 * d);   // ascending node
    var i = 5.1454;
    var w = rev(318.0634 + 0.1643573223 * d);   // arg. of perigee
    var a = 60.2666;                            // Earth radii
    var e = 0.054900;
    var M = rev(115.3654 + 13.0649929509 * d);  // mean anomaly

    var E = M + e * DEG * sin(M) * (1 + e * cos(M));
    for (var k = 0; k < 6; k++) {
      var dE = (E - e * DEG * sin(E) - M) / (1 - e * cos(E));
      E -= dE;
      if (Math.abs(dE) < 1e-8) break;
    }
    var x = a * (cos(E) - e), y = a * Math.sqrt(1 - e * e) * sin(E);
    var r = Math.sqrt(x * x + y * y);
    var v = rev(Math.atan2(y, x) * DEG);

    var xe = r * (cos(N) * cos(v + w) - sin(N) * sin(v + w) * cos(i));
    var ye = r * (sin(N) * cos(v + w) + cos(N) * sin(v + w) * cos(i));
    var ze = r * sin(v + w) * sin(i);

    var lon = rev(Math.atan2(ye, xe) * DEG);
    var lat = Math.atan2(ze, Math.sqrt(xe * xe + ye * ye)) * DEG;

    // perturbations
    var s = sunEcliptic(date);
    var Ls = rev(s.M + s.w);
    var Lm = rev(N + w + M);
    var D = rev(Lm - Ls);
    var F = rev(Lm - N);

    lon += -1.274 * sin(M - 2 * D)
         + 0.658 * sin(2 * D)
         - 0.186 * sin(s.M)
         - 0.059 * sin(2 * M - 2 * D)
         - 0.057 * sin(M - 2 * D + s.M)
         + 0.053 * sin(M + 2 * D)
         + 0.046 * sin(2 * D - s.M)
         + 0.041 * sin(M - s.M)
         - 0.035 * sin(D)
         - 0.031 * sin(M + s.M)
         - 0.015 * sin(2 * F - 2 * D)
         + 0.011 * sin(M - 4 * D);

    lat += -0.173 * sin(F - 2 * D)
         - 0.055 * sin(M - F - 2 * D)
         - 0.046 * sin(M + F - 2 * D)
         + 0.033 * sin(F + 2 * D)
         + 0.017 * sin(2 * M + F);

    r += -0.58 * cos(M - 2 * D) - 0.46 * cos(2 * D);

    return { lon: rev(lon), lat: lat, r: r, D: D, sunLon: s.lon };
  }

  /* Topocentric equatorial coordinates — the moon's parallax is ~1 degree,
     far too big to ignore for rise and set. */
  function moonPosition(date, lat, lon) {
    var m = moonEcliptic(date);
    var eq = eclToEq(m.lon, m.lat, obliquity(date));
    var mpar = Math.asin(1 / m.r) * DEG;
    var gclat = lat - 0.1924 * sin(2 * lat);
    var rho = 0.99833 + 0.00167 * cos(2 * lat);
    var ha = rev180(lmst(date, lon) - eq.ra);
    var g = Math.atan2(tan(gclat), cos(ha)) * DEG;
    var topRA = eq.ra - mpar * rho * cos(gclat) * sin(ha) / cos(eq.dec);
    var topDec = eq.dec - mpar * rho * sin(gclat) * sin(g - eq.dec) /
                 (Math.abs(sin(g)) < 1e-9 ? 1e-9 : sin(g));
    return {
      ra: rev(topRA), dec: topDec, distER: m.r,
      alt: altitude(rev(topRA), topDec, date, lat, lon),
      az: azimuth(rev(topRA), topDec, date, lat, lon),
      eclLon: m.lon, eclLat: m.lat, sunLon: m.sunLon
    };
  }

  var PHASES = [
    'New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'
  ];

  function moonIllumination(date) {
    var m = moonEcliptic(date);
    var elong = Math.acos(cos(m.lon - m.sunLon) * cos(m.lat)) * DEG;
    var phaseAngle = 180 - elong;
    var fraction = (1 + cos(phaseAngle)) / 2;
    /* 0 = new, 0.5 = full, measured forward through waxing */
    var phase = rev(m.lon - m.sunLon) / 360;
    var idx = Math.floor(phase * 8 + 0.5) % 8;
    return {
      fraction: fraction,
      phase: phase,
      age: phase * 29.530588853,
      waxing: phase < 0.5,
      name: PHASES[idx],
      index: idx
    };
  }

  /* ---------- rise / set / transit ------------------------------------- */

  function scan(date0, hours, stepMin, fn) {
    var out = [], n = Math.ceil(hours * 60 / stepMin);
    for (var i = 0; i <= n; i++) out.push(fn(new Date(date0.valueOf() + i * stepMin * 60000)));
    return out;
  }

  function bisect(t0, t1, f, target) {
    var a = t0, b = t1;
    for (var i = 0; i < 24; i++) {
      var mid = (a + b) / 2;
      if ((f(new Date(a)) - target) * (f(new Date(mid)) - target) <= 0) b = mid; else a = mid;
    }
    return new Date((a + b) / 2);
  }

  /* Generic rise/set finder over a local day. */
  function crossings(startUTC, hours, altFn, h0, stepMin) {
    stepMin = stepMin || 10;
    var res = { rise: null, set: null, alwaysUp: false, alwaysDown: false, maxAlt: -90, maxTime: null, minAlt: 90, minTime: null };
    var n = Math.ceil(hours * 60 / stepMin);
    var prevT = startUTC.valueOf(), prevA = altFn(new Date(prevT));
    if (prevA > res.maxAlt) { res.maxAlt = prevA; res.maxTime = new Date(prevT); }
    if (prevA < res.minAlt) { res.minAlt = prevA; res.minTime = new Date(prevT); }
    var any = prevA > h0, all = prevA > h0;
    for (var i = 1; i <= n; i++) {
      var t = startUTC.valueOf() + i * stepMin * 60000, a = altFn(new Date(t));
      if (a > res.maxAlt) { res.maxAlt = a; res.maxTime = new Date(t); }
      if (a < res.minAlt) { res.minAlt = a; res.minTime = new Date(t); }
      if (a > h0) any = true; else all = false;
      if (prevA <= h0 && a > h0 && !res.rise) res.rise = bisect(prevT, t, altFn, h0);
      if (prevA > h0 && a <= h0 && !res.set) res.set = bisect(prevT, t, altFn, h0);
      prevT = t; prevA = a;
    }
    res.alwaysUp = all;
    res.alwaysDown = !any;
    return res;
  }

  /* Refine a stationary point (transit) by golden-ish parabolic fit. */
  function refineExtreme(centre, altFn, maximise, windowMin) {
    windowMin = windowMin || 20;
    var a = centre.valueOf() - windowMin * 60000, b = centre.valueOf() + windowMin * 60000;
    for (var i = 0; i < 40; i++) {
      var m1 = a + (b - a) / 3, m2 = b - (b - a) / 3;
      var f1 = altFn(new Date(m1)), f2 = altFn(new Date(m2));
      if (maximise ? f1 < f2 : f1 > f2) a = m1; else b = m2;
    }
    return new Date((a + b) / 2);
  }

  function sunTimes(date, lat, lon, tz) {
    var start = startOfLocalDay(date, tz);
    var f = function (d) { return sunPosition(d, lat, lon).alt; };
    var main = crossings(start, 24, f, -0.833, 6);
    var civil = crossings(start, 24, f, -6, 6);
    return {
      dayStart: start,
      sunrise: main.rise, sunset: main.set,
      dawn: civil.rise, dusk: civil.set,
      solarNoon: main.maxTime ? refineExtreme(main.maxTime, f, true) : null,
      maxAlt: main.maxAlt,
      polar: main.alwaysUp ? 'up' : (main.alwaysDown ? 'down' : null)
    };
  }

  function moonTimes(date, lat, lon, tz) {
    var start = startOfLocalDay(date, tz);
    var f = function (d) { return moonPosition(d, lat, lon).alt; };
    var c = crossings(start, 24, f, -0.8, 6);
    /* Upper transit = altitude maximum; lower transit ("underfoot") = minimum.
       Both are real solunar triggers whether or not the moon is above the
       horizon at the time. */
    /* A maximum or minimum that sits on the edge of the 24 h window is not a
       transit at all — it is yesterday's or tomorrow's still tailing off. The
       moon transits every ~24 h 50 min, so roughly one day a month has no
       upper transit and one has no lower. Take the interior one as real and
       place the other 12 h 25 min away, where it may fall just outside the day
       (solunar() keeps whatever overlaps the day). */
    var edge = 20 * 60000, s0 = start.valueOf(), s1 = s0 + DAY_MS;
    function interior(t) { return t && t.valueOf() - s0 > edge && s1 - t.valueOf() > edge; }
    var transit = interior(c.maxTime) ? refineExtreme(c.maxTime, f, true) : null;
    var under = interior(c.minTime) ? refineExtreme(c.minTime, f, false) : null;
    var HALF = 12.42 * 3600000;
    function pair(from, maximise) {
      /* the partner transit nearest to this day */
      var g1 = from.valueOf() + HALF, g2 = from.valueOf() - HALF;
      var g = Math.abs(g1 - (s0 + DAY_MS / 2)) < Math.abs(g2 - (s0 + DAY_MS / 2)) ? g1 : g2;
      return refineExtreme(new Date(g), f, maximise, 60);
    }
    if (transit && !under) under = pair(transit, false);
    else if (under && !transit) transit = pair(under, true);
    return {
      dayStart: start,
      rise: c.rise, set: c.set,
      transit: transit, underfoot: under,
      maxAlt: c.maxAlt,
      alwaysUp: c.alwaysUp, alwaysDown: c.alwaysDown
    };
  }

  /* ---------- solunar --------------------------------------------------- */

  /* Majors run either side of the moon's upper and lower transit; minors
     either side of moonrise and moonset. Windows are the widely used ones:
     +/- 1 h for majors, +/- 45 min for minors. */
  function solunar(date, lat, lon, tz) {
    var mt = moonTimes(date, lat, lon, tz);
    var start = mt.dayStart.valueOf(), end = start + DAY_MS;
    var out = [];
    function push(kind, centre, halfMin, label) {
      if (!centre) return;
      var a = centre.valueOf() - halfMin * 60000, b = centre.valueOf() + halfMin * 60000;
      if (b < start || a > end) return;
      out.push({ kind: kind, label: label, centre: new Date(centre), start: new Date(a), end: new Date(b) });
    }
    push('major', mt.transit, 60, 'Moon overhead');
    push('major', mt.underfoot, 60, 'Moon underfoot');
    push('minor', mt.rise, 45, 'Moonrise');
    push('minor', mt.set, 45, 'Moonset');
    out.sort(function (a, b) { return a.start - b.start; });
    return { periods: out, moon: mt, illumination: moonIllumination(new Date(start + DAY_MS / 2)) };
  }

  /* Solunar intensity 0..1 at an instant — used by the bite score. */
  function solunarStrength(when, periods) {
    var t = when.valueOf(), best = 0;
    for (var i = 0; i < periods.length; i++) {
      var p = periods[i];
      if (t < p.start || t > p.end) continue;
      var half = (p.end - p.start) / 2;
      var d = Math.abs(t - p.centre) / half;                 // 0 at centre, 1 at edge
      var shape = 0.5 * (1 + Math.cos(Math.PI * d));         // smooth taper
      best = Math.max(best, (p.kind === 'major' ? 1 : 0.6) * shape);
    }
    return best;
  }

  global.Astro = {
    tzOffset: tzOffset, parts: parts, startOfLocalDay: startOfLocalDay,
    addDaysLocal: addDaysLocal, localMidnight: localMidnight,
    sunPosition: sunPosition, moonPosition: moonPosition,
    moonIllumination: moonIllumination,
    sunTimes: sunTimes, moonTimes: moonTimes,
    solunar: solunar, solunarStrength: solunarStrength,
    toJulian: toJulian, fromJulian: fromJulian
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Astro;
