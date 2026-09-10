/* core.js — storage, network, tides and the bite score. */
(function (global) {
  'use strict';

  var TZ = 'Australia/Sydney';
  var HOUR = 3600000;

  /* ==================== storage ======================================== */

  var Store = {
    _get: function (k, d) {
      try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
      catch (e) { return d; }
    },
    _set: function (k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
    },
    settings: function () {
      var s = Store._get('nf.settings', null) || {};
      return {
        name: s.name || '',
        spot: (s.spot == null ? 58 : s.spot),      // Huskisson by default
        useGps: s.useGps !== false,
        species: s.species || [],
        access: s.access || 'land',                // land | boat
        windLimit: s.windLimit || 20,              // knots
        swellLimit: s.swellLimit || 2.0,           // metres
        model: s.model || 'bom_access_global',
        theme: s.theme || 'auto',
        unitsWind: s.unitsWind || 'kn',
        textSize: s.textSize || 'normal',
        kind: s.kind || '',                        // '' = all of the spot's kinds, else e|b|r|o|f
        weights: s.weights || {},                  // expert multipliers per factor
        learn: s.learn !== false                   // let the catch log tune weights
      };
    },
    saveSettings: function (patch) {
      var s = Store.settings();
      for (var k in patch) s[k] = patch[k];
      Store._set('nf.settings', s);
      return s;
    },
    log: function () { return Store._get('nf.log', []); },
    addCatch: function (entry) {
      var l = Store.log(); l.unshift(entry);
      if (l.length > 400) l = l.slice(0, 400);
      Store._set('nf.log', l); return l;
    },
    removeCatch: function (id) {
      var l = Store.log().filter(function (e) { return e.id !== id; });
      Store._set('nf.log', l); return l;
    },
    cacheGet: function (key) {
      var c = Store._get('nf.cache.' + key, null);
      return c && c.t && c.v ? c : null;
    },
    cacheSet: function (key, value) { Store._set('nf.cache.' + key, { t: Date.now(), v: value }); },
    /* favourites, recents and per-spot notes */
    favs: function () { return Store._get('nf.favs', []); },
    toggleFav: function (id) {
      var f = Store.favs(), i = f.indexOf(id);
      if (i >= 0) f.splice(i, 1); else f.push(id);
      Store._set('nf.favs', f); return f;
    },
    recent: function () { return Store._get('nf.recent', []); },
    pushRecent: function (id) {
      var r = Store.recent().filter(function (x) { return x !== id; });
      r.unshift(id); r = r.slice(0, 5);
      Store._set('nf.recent', r); return r;
    },
    note: function (id) { return Store._get('nf.note.' + id, ''); },
    setNote: function (id, text) {
      if (text) Store._set('nf.note.' + id, text);
      else { try { localStorage.removeItem('nf.note.' + id); } catch (e) {} }
    },
    /* places he added himself by searching (ids from 1000 up) */
    customs: function () { return Store._get('nf.custom', []); },
    addCustom: function (spot) {
      var c = Store.customs();
      spot.id = 1000 + c.reduce(function (m, x) { return Math.max(m, x.id - 1000 + 1); }, 0);
      c.push(spot); Store._set('nf.custom', c); return spot;
    },
    removeCustom: function (id) {
      Store._set('nf.custom', Store.customs().filter(function (x) { return x.id !== id; }));
    },
    wipe: function () {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('nf.') === 0) keys.push(k); }
        keys.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
    }
  };

  /* ==================== network ======================================== */

  function withTimeout(url, ms, revalidate) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 15000);
    var opts = {};
    if (ctrl) opts.signal = ctrl.signal;
    /* GitHub serves the data files with max-age=600; without this the browser
       happily hands back a ten-minute-old copy without asking. */
    if (revalidate) opts.cache = 'no-cache';
    return fetch(url, opts)
      .then(function (r) {
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) { clearTimeout(t); throw e; });
  }

  /* Serve cache immediately when fresh; otherwise fetch, falling back to
     whatever stale copy we have so the app still shows something offline. */
  function cachedJson(key, url, ttlMin, revalidate) {
    var c = Store.cacheGet(key);
    var fresh = c && (Date.now() - c.t) < ttlMin * 60000;
    if (fresh) return Promise.resolve({ data: c.v, cachedAt: c.t, stale: false });
    return withTimeout(url, 15000, revalidate).then(function (j) {
      Store.cacheSet(key, j);
      return { data: j, cachedAt: Date.now(), stale: false };
    }).catch(function (err) {
      if (c) return { data: c.v, cachedAt: c.t, stale: true, error: err };
      throw err;
    });
  }

  var OM = 'https://api.open-meteo.com/v1/forecast';
  var OMM = 'https://marine-api.open-meteo.com/v1/marine';

  /* Kept to variables every Open-Meteo model exposes, so switching the model
     can never 400 the whole app. */
  var HOURLY_BASE = ['temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
    'precipitation', 'weather_code', 'pressure_msl', 'cloud_cover',
    'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'];
  var DAILY_BASE = ['weather_code', 'temperature_2m_max', 'temperature_2m_min',
    'precipitation_sum', 'wind_speed_10m_max', 'wind_gusts_10m_max',
    'wind_direction_10m_dominant'];

  function round4(x) { return Math.round(x * 1e4) / 1e4; }

  /* Fraction of non-null values in the next `hours` of an hourly series. */
  function coverage(times, values, hours) {
    if (!times || !values) return 0;
    var now = Date.now() / 1000, n = 0, ok = 0;
    for (var i = 0; i < times.length; i++) {
      if (times[i] < now - 3600 || times[i] > now + hours * 3600) continue;
      n++; if (values[i] != null) ok++;
    }
    return n ? ok / n : 0;
  }
  function usableWeather(j) {
    if (!j || !j.hourly || !j.hourly.time) return false;
    return coverage(j.hourly.time, j.hourly.temperature_2m, 48) > 0.8 &&
           coverage(j.hourly.time, j.hourly.wind_speed_10m, 48) > 0.8;
  }
  function usableMarine(j) {
    if (!j || !j.hourly || !j.hourly.time) return false;
    return coverage(j.hourly.time, j.hourly.wave_height, 48) > 0.6;
  }

  var Api = {
    weather: function (lat, lon, model) {
      var hourly = HOURLY_BASE.slice();
      var daily = DAILY_BASE.slice();
      if (!model || model === 'best_match') {
        hourly.push('precipitation_probability');
        hourly.push('uv_index');
        daily.push('precipitation_probability_max');
      }
      var base = OM + '?latitude=' + round4(lat) + '&longitude=' + round4(lon) +
        '&hourly=' + hourly.join(',') + '&daily=' + daily.join(',') +
        '&timezone=' + encodeURIComponent(TZ) + '&timeformat=unixtime' +
        '&wind_speed_unit=kn&forecast_days=7&past_days=1';
      var u = base + (model && model !== 'best_match' ? '&models=' + model : '');
      var key = 'wx.' + round4(lat) + ',' + round4(lon) + '.' + (model || 'bm');
      function fallback() {
        return cachedJson(key + '.fallback', base, 30).then(function (r) { r.fellBack = true; return r; });
      }
      return cachedJson(key, u, 30).then(function (r) {
        /* A single model can come back 200 with nulls when its feed is stale
           (ACCESS-G has done this on Open-Meteo before). Treat that like an
           error and use the multi-model blend instead. */
        if (u !== base && !usableWeather(r.data)) return fallback();
        return r;
      }).catch(function (err) {
        if (u === base) throw err;
        return fallback();
      });
    },

    marine: function (lat, lon, step) {
      /* The wave grid is coarse near the coast, so a point inside a bay can
         come back as land (all nulls). Try the spot's sea point, then keep
         stepping east until the model answers. */
      step = step || 0;
      var lon2 = lon + step * 0.2;
      var u = OMM + '?latitude=' + round4(lat) + '&longitude=' + round4(lon2) +
        '&hourly=wave_height,wave_direction,wave_period,wind_wave_height,' +
        'swell_wave_height,swell_wave_direction,swell_wave_period,sea_surface_temperature' +
        '&daily=wave_height_max,wave_direction_dominant,wave_period_max' +
        '&timezone=' + encodeURIComponent(TZ) + '&timeformat=unixtime' +
        '&forecast_days=7&cell_selection=sea';
      return cachedJson('mar.' + round4(lat) + ',' + round4(lon2), u, 60).then(function (r) {
        if (usableMarine(r.data) || step >= 3) { r.offshoreKm = Math.round(step * 0.2 * 111 * Math.cos(lat * Math.PI / 180)); return r; }
        return Api.marine(lat, lon, step + 1);
      }).catch(function (err) {
        if (step >= 3) throw err;
        return Api.marine(lat, lon, step + 1);
      });
    },

    /* Model tide, used only when official BOM predictions are not in the repo. */
    seaLevel: function (lat, lon) {
      var base = OMM + '?latitude=' + round4(lat) + '&longitude=' + round4(lon) +
        '&hourly=sea_level_height_msl&timezone=' + encodeURIComponent(TZ) +
        '&timeformat=unixtime&forecast_days=7&past_days=1&cell_selection=sea';
      var key = 'sl.' + round4(lat) + ',' + round4(lon);
      function usable(j) {
        var a = j && j.hourly && j.hourly.sea_level_height_msl;
        if (!a) return false;
        for (var i = 0; i < a.length; i++) if (a[i] !== null && a[i] !== undefined) return true;
        return false;
      }
      return cachedJson(key, base, 180).then(function (res) {
        if (usable(res.data)) return res;
        /* A 200 with an all-null array is a documented failure mode, so pin
           the currents model explicitly and try once more. */
        return cachedJson(key + '.mf', base + '&models=meteofrance_currents', 180);
      });
    },

    /* Written into the repo by the GitHub Action. Absent on a fresh install. */
    local: function (file) {
      return withTimeout('./data/' + file + '?v=' + Math.floor(Date.now() / 600000), 8000, true)
        .then(function (j) { Store.cacheSet('local.' + file, j); return j; })
        .catch(function () {
          var c = Store.cacheGet('local.' + file);
          return c ? c.v : null;
        });
    },

    radarIndex: function () {
      return withTimeout('https://api.rainviewer.com/public/weather-maps.json', 12000);
    },

    /* Files the 10-minute GitHub Action force-pushes to the `live` branch:
       BOM station observations and radar frames. Served raw from GitHub,
       which sends open CORS headers. Falls back to ./live/ for local tests. */
    liveBase: function () {
      try {
        var h = location.hostname, parts = location.pathname.split('/').filter(Boolean);
        if (/\.github\.io$/.test(h) && parts.length) {
          return 'https://raw.githubusercontent.com/' + h.split('.')[0] + '/' + parts[0] + '/live/';
        }
      } catch (e) {}
      return './live/';
    },
    live: function (name, ttlMin) {
      var url = Api.liveBase() + name + '?t=' + Math.floor(Date.now() / 300000);
      return cachedJson('live.' + name, url, ttlMin || 4, true);
    },

    /* BOM's own ensemble (ACCESS-GE) for spread, i.e. how sure the model is. */
    ensemble: function (lat, lon) {
      var base = 'https://ensemble-api.open-meteo.com/v1/ensemble?latitude=' + round4(lat) +
        '&longitude=' + round4(lon) + '&hourly=wind_speed_10m,wind_gusts_10m' +
        '&timezone=' + encodeURIComponent(TZ) + '&timeformat=unixtime&wind_speed_unit=kn&forecast_days=7';
      var key = 'ens.' + round4(lat) + ',' + round4(lon);
      return cachedJson(key, base + '&models=bom_access_global_ensemble', 120).catch(function () {
        return cachedJson(key + '.ec', base + '&models=ecmwf_ifs025', 120);
      });
    }
  };

  /* ==================== observations ==================================== */

  var Obs = {
    /* Nearest BOM weather station with a recent reading. */
    nearest: function (live, lat, lon, maxKm) {
      if (!live || !live.stations) return null;
      var best = null, bd = maxKm || 40;
      for (var i = 0; i < live.stations.length; i++) {
        var st = live.stations[i];
        if (st.lat == null || st.lon == null) continue;
        var d = haversine(lat, lon, st.lat, st.lon);
        if (d < bd && (st.windKt != null || st.pressure != null)) { bd = d; best = st; }
      }
      if (!best) return null;
      var out = {}; for (var k in best) out[k] = best[k];
      out.km = Math.round(bd);
      out.ageMin = live.fetched ? Math.round((Date.now() - live.fetched * 1000) / 60000) : null;
      if (best.time) out.ageMin = Math.round((Date.now() - best.time * 1000) / 60000);
      return out;
    },

    /* Nudge the next few hours of the model toward what the station is
       actually reading. The correction decays to nothing over `hours` so a
       stale reading cannot poison tomorrow. Returns the delta applied. */
    apply: function (wx, obs, hours) {
      if (!wx || !wx.hourly || !obs || obs.ageMin == null || obs.ageMin > 90) return null;
      hours = hours || 6;
      var H = wx.hourly, T = H.time, now = Date.now();
      var mw = sampleSeries(T, H.wind_speed_10m, now), mg = sampleSeries(T, H.wind_gusts_10m, now);
      var mp = sampleSeries(T, H.pressure_msl, now), mt = sampleSeries(T, H.temperature_2m, now);
      var d = {
        wind: (obs.windKt != null && mw != null) ? obs.windKt - mw : 0,
        gust: (obs.gustKt != null && mg != null) ? obs.gustKt - mg : 0,
        pressure: (obs.pressure != null && mp != null) ? obs.pressure - mp : 0,
        temp: (obs.temp != null && mt != null) ? obs.temp - mt : 0
      };
      /* Clamp so a station in a wind tunnel cannot drag the forecast to silly places. */
      d.wind = clamp(d.wind, -12, 12); d.gust = clamp(d.gust, -15, 15);
      d.pressure = clamp(d.pressure, -6, 6); d.temp = clamp(d.temp, -6, 6);
      if (!wx._raw) {
        wx._raw = { wind_speed_10m: H.wind_speed_10m.slice(), wind_gusts_10m: H.wind_gusts_10m.slice(),
                    pressure_msl: H.pressure_msl.slice(), temperature_2m: H.temperature_2m.slice() };
      }
      for (var i = 0; i < T.length; i++) {
        var dtH = (T[i] * 1000 - now) / HOUR;
        if (dtH < -1 || dtH > hours) continue;
        var w = dtH <= 0 ? 1 : 1 - dtH / hours;
        H.wind_speed_10m[i] = Math.max(0, wx._raw.wind_speed_10m[i] + d.wind * w);
        H.wind_gusts_10m[i] = Math.max(0, wx._raw.wind_gusts_10m[i] + d.gust * w);
        H.pressure_msl[i] = wx._raw.pressure_msl[i] + d.pressure * Math.max(w, 0.5);
        H.temperature_2m[i] = wx._raw.temperature_2m[i] + d.temp * w;
      }
      d.modelWind = mw; d.modelPressure = mp; d.modelTemp = mt;
      return d;
    }
  };

  function haversine(a, b, c, d) {
    var R = 6371, p = Math.PI / 180;
    var x = Math.sin((c - a) * p / 2), y = Math.sin((d - b) * p / 2);
    var h = x * x + Math.cos(a * p) * Math.cos(c * p) * y * y;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* ==================== ensemble spread ================================= */

  var Ensemble = {
    /* Per-hour standard deviation of wind across members, in knots. */
    spread: function (ens) {
      if (!ens || !ens.hourly || !ens.hourly.time) return null;
      var H = ens.hourly, keys = Object.keys(H).filter(function (k) { return /^wind_speed_10m/.test(k); });
      if (keys.length < 3) return null;
      var T = H.time, out = [];
      for (var i = 0; i < T.length; i++) {
        var n = 0, sum = 0, sq = 0;
        for (var k = 0; k < keys.length; k++) {
          var v = H[keys[k]][i]; if (v == null) continue;
          n++; sum += v; sq += v * v;
        }
        out.push(n > 2 ? Math.sqrt(Math.max(0, sq / n - (sum / n) * (sum / n))) : null);
      }
      return { time: T, sd: out, members: keys.length };
    },
    at: function (sp, whenMs) { return sp ? sampleSeries(sp.time, sp.sd, whenMs) : null; },
    label: function (sd) {
      if (sd == null) return null;
      if (sd < 2.5) return { text: 'High confidence', tone: 'great' };
      if (sd < 5) return { text: 'Fair confidence', tone: 'ok' };
      return { text: 'Low confidence', tone: 'bad' };
    }
  };

  /* ==================== helpers ======================================== */

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }

  /* Sample an hourly series (unix seconds) at an arbitrary instant. */
  function sampleSeries(times, values, whenMs) {
    if (!times || !values) return null;
    var t = whenMs / 1000;
    if (t <= times[0]) return values[0];
    var n = times.length;
    if (t >= times[n - 1]) return values[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    var a = values[lo], b = values[hi];
    if (a == null || b == null) return a == null ? b : a;
    return lerp(a, b, (t - times[lo]) / (times[hi] - times[lo]));
  }

  function sampleNearest(times, values, whenMs) {
    if (!times || !values || !times.length) return null;
    var t = whenMs / 1000, lo = 0, hi = times.length - 1;
    if (t <= times[0]) return values[0];
    if (t >= times[hi]) return values[hi];
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    return (t - times[lo]) <= (times[hi] - t) ? values[lo] : values[hi];
  }

  function degToCompass(d) {
    if (d == null) return '—';
    var pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return pts[Math.round(((d % 360) / 22.5)) % 16];
  }

  /* ==================== tides =========================================== */

  var Tides = {
    /* From official BOM extremes written into data/tides.json. */
    fromBom: function (bom, portKey, hwOff, lwOff) {
      if (!bom || !bom.ports || !bom.ports[portKey]) return null;
      var p = bom.ports[portKey];
      var ext = (p.tides || []).map(function (t) {
        var off = (t.type === 'high' ? hwOff : lwOff) * 60000;
        return { t: t.time * 1000 + off, h: t.height, type: t.type };
      }).sort(function (a, b) { return a.t - b.t; });
      if (ext.length < 2) return null;
      return { extremes: ext, source: 'bom', portName: p.name, updated: bom.updated, datum: 'chart datum' };
    },

    /* From the Open-Meteo sea level series (metres above mean sea level). */
    fromModel: function (sl, mslOffset, hwOff, lwOff) {
      if (!sl || !sl.hourly) return null;
      var T = sl.hourly.time, V = sl.hourly.sea_level_height_msl;
      if (!T || !V) return null;
      var pts = [];
      for (var i = 0; i < T.length; i++) if (V[i] != null) pts.push([T[i] * 1000, V[i]]);
      if (pts.length < 6) return null;

      /* Resample to 5 minutes with a Catmull-Rom spline so the peak of a
         semidiurnal tide is not clipped by hourly sampling. */
      var step = 5 * 60000, out = [];
      for (var k = 1; k < pts.length - 2; k++) {
        var p0 = pts[k - 1], p1 = pts[k], p2 = pts[k + 1], p3 = pts[k + 2];
        var span = p2[0] - p1[0], n = Math.max(1, Math.round(span / step));
        for (var s = 0; s < n; s++) {
          var t = s / n, t2 = t * t, t3 = t2 * t;
          var v = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
          out.push([p1[0] + span * t, v]);
        }
      }
      var ext = [];
      for (var j = 1; j < out.length - 1; j++) {
        var a = out[j - 1][1], b = out[j][1], c = out[j + 1][1];
        if (b > a && b >= c) ext.push({ t: out[j][0] + hwOff * 60000, h: b + mslOffset, type: 'high' });
        else if (b < a && b <= c) ext.push({ t: out[j][0] + lwOff * 60000, h: b + mslOffset, type: 'low' });
      }
      /* Drop extremes closer together than 3 h — spline wobble, not a tide. */
      var clean = [];
      for (var m = 0; m < ext.length; m++) {
        if (clean.length && ext[m].t - clean[clean.length - 1].t < 3 * HOUR) {
          var last = clean[clean.length - 1];
          if (ext[m].type === last.type) {
            if ((last.type === 'high' && ext[m].h > last.h) || (last.type === 'low' && ext[m].h < last.h)) clean[clean.length - 1] = ext[m];
            continue;
          }
        }
        clean.push(ext[m]);
      }
      if (clean.length < 2) return null;
      return { extremes: clean, source: 'model', datum: 'approx. chart datum' };
    },

    /* Height at an instant, interpolating between extremes with the standard
       cosine curve (the continuous form of the rule of twelfths). */
    heightAt: function (tide, whenMs) {
      var e = tide.extremes, i;
      if (!e.length) return null;
      if (whenMs <= e[0].t || whenMs >= e[e.length - 1].t) return null;
      for (i = 0; i < e.length - 1; i++) if (whenMs >= e[i].t && whenMs <= e[i + 1].t) break;
      var a = e[i], b = e[i + 1];
      var f = (whenMs - a.t) / (b.t - a.t);
      return (a.h + b.h) / 2 + (a.h - b.h) / 2 * Math.cos(Math.PI * f);
    },

    /* Rate of change in metres per hour. */
    rateAt: function (tide, whenMs) {
      var h1 = Tides.heightAt(tide, whenMs - 15 * 60000);
      var h2 = Tides.heightAt(tide, whenMs + 15 * 60000);
      if (h1 == null || h2 == null) return null;
      return (h2 - h1) * 2;
    },

    state: function (tide, whenMs) {
      var e = tide.extremes, i;
      for (i = 0; i < e.length - 1; i++) if (whenMs >= e[i].t && whenMs <= e[i + 1].t) break;
      if (i >= e.length - 1) return null;
      var a = e[i], b = e[i + 1];
      var rising = b.type === 'high';
      var range = Math.abs(b.h - a.h);
      var toNext = b.t - whenMs, sinceLast = whenMs - a.t;
      return {
        rising: rising, prev: a, next: b, range: range,
        minsToNext: Math.round(toNext / 60000),
        minsSinceLast: Math.round(sinceLast / 60000),
        fraction: sinceLast / (b.t - a.t),
        height: Tides.heightAt(tide, whenMs),
        rate: Tides.rateAt(tide, whenMs)
      };
    },

    maxRate: function (tide) {
      var m = 0;
      for (var i = 0; i < tide.extremes.length - 1; i++) {
        var a = tide.extremes[i], b = tide.extremes[i + 1];
        var span = (b.t - a.t) / HOUR;
        if (span <= 0) continue;
        m = Math.max(m, Math.abs(b.h - a.h) / span * (Math.PI / 2));
      }
      return m || 1;
    },

    extremesForDay: function (tide, dayStartMs) {
      return tide.extremes.filter(function (e) {
        return e.t >= dayStartMs && e.t < dayStartMs + 86400000;
      });
    }
  };

  /* ==================== bite score ====================================== */

  /* How much of the wind is blowing straight at this spot. Uses the bearing
     the spot faces, so a westerly at Callala Bay (faces SE) is offshore and
     flattens the bay, while the same westerly at Currarong (faces NE) is
     side-shore. Rivers and lakes return 0. */
  function exposure(dir, faces) {
    if (dir == null || faces == null) return { on: 0, off: 0 };
    var diff = Math.abs(((dir - faces) % 360 + 540) % 360 - 180);   // 0 = dead onshore
    var c = Math.cos(diff * Math.PI / 180);
    return { on: Math.max(0, c), off: Math.max(0, -c) };
  }

  function windFactor(kt, gust, dir, limit, kinds, faces) {
    if (kt == null) return 0.5;
    var f;
    if (kt <= 8) f = 1;
    else f = clamp(1 - (kt - 8) / Math.max(4, (limit - 8) * 1.35), 0, 1);
    if (gust != null && kt > 0 && gust > kt * 1.6 && kt > 10) f *= 0.9;
    var ex = exposure(dir, faces);
    var strength = clamp((kt - 5) / 12, 0, 1.4);
    f += 0.12 * ex.off - 0.14 * ex.on * strength;
    return clamp(f, 0, 1);
  }

  function pressureFactor(p, d3, d24) {
    if (p == null) return 0.5;
    var f;
    if (d3 == null) f = 0.6;
    else if (d3 <= -3) f = 0.5;                    // storm dropping out
    else if (d3 <= -0.6) f = 1.0;                  // the classic pre-frontal feed
    else if (d3 < 0.5) f = 0.75;                   // steady
    else if (d3 < 2) f = 0.4;                      // rising behind a front
    else f = 0.3;
    if (p >= 1013 && p <= 1025) f = Math.min(1, f + 0.08);
    if (p < 1000) f *= 0.9;
    if (d24 != null && d24 < -10) f = Math.min(f, 0.6);   // a real blow coming, not a normal front
    return clamp(f, 0, 1);
  }

  function lightFactor(whenMs, sunrise, sunset, nightBiter) {
    if (!sunrise || !sunset) return 0.5;
    var mins = function (a) { return Math.abs(whenMs - a) / 60000; };
    var dr = mins(sunrise), ds = mins(sunset);
    var edge = Math.min(dr, ds);
    var isNight = whenMs < sunrise - 30 * 60000 || whenMs > sunset + 30 * 60000;
    var floor = isNight ? (nightBiter ? 0.75 : 0.3) : 0.42;
    if (edge <= 90) return clamp(1 - (edge / 90) * 0.35, 0.65, 1);
    /* taper from the 0.65 at 90 min out to the day/night floor by 3 h, rather
       than dropping off a cliff */
    if (edge <= 180) return floor + (0.65 - floor) * (1 - (edge - 90) / 90);
    return floor;
  }

  function tideFactor(tide, whenMs, maxRate, pref) {
    if (!tide) return { f: 0.5, note: null };
    var st = Tides.state(tide, whenMs);
    if (!st || st.rate == null) return { f: 0.5, note: null };
    var move = clamp(Math.abs(st.rate) / (maxRate || 1), 0, 1);
    var f = 0.25 + 0.6 * move;
    var near = Math.min(st.minsToNext, st.minsSinceLast);
    if (near <= 120) f += 0.15 * (1 - near / 120);
    if (pref === 'run-in' && st.rising) f += 0.12;
    if (pref === 'run-out' && !st.rising) f += 0.12;
    if (pref === 'high slack' && st.next.type === 'high' && st.minsToNext < 60) f += 0.15;
    if (pref === 'low slack' && st.next.type === 'low' && st.minsToNext < 60) f += 0.15;
    return { f: clamp(f, 0, 1), state: st };
  }

  function swellFactor(h, period, kinds, limit) {
    if (h == null) return { f: 0.6, hazard: false };
    var beachRock = kinds.indexOf('b') >= 0 || kinds.indexOf('r') >= 0;
    var offshore = kinds.indexOf('o') >= 0;
    var f, hazard = false;
    if (beachRock) {
      if (h < 0.4) f = 0.55;
      else if (h <= 1.8) f = 1;
      else if (h <= 2.5) f = 0.6;
      else { f = 0.15; hazard = true; }
      if (period != null && period > 11 && h > 1.5) { f *= 0.8; hazard = h > 2; }
    } else if (offshore) {
      if (h <= 1.2) f = 1;
      else if (h <= limit) f = clamp(1 - (h - 1.2) / Math.max(0.5, limit - 1.2) * 0.6, 0.35, 1);
      else { f = 0.15; hazard = true; }
    } else {
      f = h > 3 ? 0.7 : 0.9;                       // estuary barely cares
    }
    return { f: clamp(f, 0, 1), hazard: hazard };
  }

  function tempFactor(sst, range) {
    if (sst == null || !range) return 0.6;
    if (sst >= range[0] && sst <= range[1]) return 1;
    var d = sst < range[0] ? range[0] - sst : sst - range[1];
    return clamp(1 - d / 4, 0.1, 1);
  }

  function rainFactor(mmNow, mm24, kinds, likesFresh) {
    var f = 0.75;
    if (mmNow == null) return f;
    if (mmNow > 0 && mmNow <= 1.2) f = 0.9;        // drizzle often helps
    else if (mmNow > 4) f = 0.4;
    if (mm24 != null && mm24 > 25 && kinds.indexOf('e') >= 0) f = likesFresh ? Math.min(1, f + 0.3) : f * 0.6;
    return clamp(f, 0, 1);
  }

  var NIGHT_BITERS = ['Mulloway', 'Teraglin', 'Mud crab', 'Blue swimmer crab', 'Estuary perch', 'School shark', 'Eastern rock lobster', 'Flounder'];
  var FRESH_LOVERS = ['Mulloway', 'Mud crab', 'Australian bass', 'Estuary perch'];

  var Score = {
    /* ctx: {kinds, access, windLimit, swellLimit, species:[speciesObjs], month} */
    at: function (whenMs, wx, marine, tide, sun, solunarPeriods, ctx) {
      var H = wx.hourly, T = H.time;
      var kt = sampleSeries(T, H.wind_speed_10m, whenMs);
      var gust = sampleSeries(T, H.wind_gusts_10m, whenMs);
      var dir = sampleSeries(T, H.wind_direction_10m, whenMs);
      var pres = sampleSeries(T, H.pressure_msl, whenMs);
      var pres3 = sampleSeries(T, H.pressure_msl, whenMs - 3 * HOUR);
      var pres24 = sampleSeries(T, H.pressure_msl, whenMs - 24 * HOUR);
      var cloud = sampleSeries(T, H.cloud_cover, whenMs);
      var rainNow = sampleSeries(T, H.precipitation, whenMs);

      var mm24 = 0, mm72 = 0, i;
      for (i = 0; i < T.length; i++) {
        var ts = T[i] * 1000, mm = (H.precipitation && H.precipitation[i]) || 0;
        if (ts > whenMs - 24 * HOUR && ts <= whenMs) mm24 += mm;
        if (ts > whenMs - 72 * HOUR && ts <= whenMs) mm72 += mm;
      }

      var sp = ctx.species && ctx.species.length ? ctx.species[0] : null;
      var nightBiter = sp ? NIGHT_BITERS.indexOf(sp.n) >= 0 : false;
      var likesFresh = sp ? FRESH_LOVERS.indexOf(sp.n) >= 0 : false;
      var tidePref = sp ? (/run-in/i.test(sp.tide) ? 'run-in' : /run-out/i.test(sp.tide) ? 'run-out' :
        /high slack/i.test(sp.tide) ? 'high slack' : /low slack/i.test(sp.tide) ? 'low slack' : null) : null;

      var swellH = marine ? sampleSeries(marine.hourly.time, marine.hourly.swell_wave_height, whenMs) : null;
      var waveH = marine ? sampleSeries(marine.hourly.time, marine.hourly.wave_height, whenMs) : null;
      var period = marine ? sampleSeries(marine.hourly.time, marine.hourly.swell_wave_period, whenMs) : null;
      var sst = marine ? sampleSeries(marine.hourly.time, marine.hourly.sea_surface_temperature, whenMs) : null;

      var maxRate = tide ? Tides.maxRate(tide) : 1;
      var tf = tideFactor(tide, whenMs, maxRate, tidePref);
      var sw = swellFactor(waveH != null ? waveH : swellH, period, ctx.kinds, ctx.swellLimit);

      var parts = [], W = ctx.weights || {};
      function add(key, label, f, w) {
        var m = W[key] != null ? W[key] : 1;
        parts.push({ key: key, label: label, f: f, w: w * m, base: w, mult: m });
      }

      var boat = ctx.access === 'boat';
      var coastal = ctx.kinds.indexOf('o') >= 0 || ctx.kinds.indexOf('b') >= 0 || ctx.kinds.indexOf('r') >= 0;

      add('wind', 'Wind', windFactor(kt, gust, dir, ctx.windLimit, ctx.kinds, ctx.faces), boat ? 24 : 17);
      add('pressure', 'Barometer', pressureFactor(pres, pres != null && pres3 != null ? pres - pres3 : null,
        pres != null && pres24 != null ? pres - pres24 : null), 12);
      add('light', 'Light', lightFactor(whenMs, sun.sunrise && sun.sunrise.valueOf(), sun.sunset && sun.sunset.valueOf(), nightBiter), 16);
      add('solunar', 'Moon timing', global.Astro.solunarStrength(new Date(whenMs), solunarPeriods) * 0.85 + 0.15, 13);
      if (tide) add('tide', 'Tide', tf.f, ctx.kinds.indexOf('e') >= 0 ? 20 : (coastal ? 13 : 0));
      if (coastal) add('swell', 'Swell', sw.f, ctx.kinds.indexOf('b') >= 0 || ctx.kinds.indexOf('r') >= 0 ? 18 : 13);
      add('cloud', 'Cloud & rain', clamp((cloud != null ? (0.55 + 0.45 * Math.min(cloud, 85) / 85) : 0.7) *
        rainFactor(rainNow, mm72 > 40 ? mm72 : mm24, ctx.kinds, likesFresh), 0, 1), 8);
      if (sp && sst != null) add('sst', 'Water temp', tempFactor(sst, sp.temp), 12);

      var num = 0, den = 0;
      for (i = 0; i < parts.length; i++) { num += parts[i].f * parts[i].w; den += parts[i].w; }
      var base = den ? num / den : 0.5;

      var seasonMult = 1;
      if (sp) {
        var v = sp.season[ctx.month];
        seasonMult = v === 2 ? 1 : v === 1 ? 0.86 : 0.5;
      }

      var isNight = !!(sun.sunrise && sun.sunset && (whenMs < sun.sunrise.valueOf() - 1800000 || whenMs > sun.sunset.valueOf() + 1800000));
      return {
        score: Math.round(clamp(base * seasonMult, 0, 1) * 100),
        parts: parts, seasonMult: seasonMult, isNight: isNight,
        wind: kt, gust: gust, dir: dir, pressure: pres,
        pressureTrend: (pres != null && pres3 != null) ? pres - pres3 : null,
        cloud: cloud, rain: rainNow, rain24: mm24, rain72: mm72,
        swell: swellH, wave: waveH, period: period, sst: sst,
        tideState: tf.state || null, hazard: sw.hazard
      };
    },

    /* Hourly scores across the forecast, plus the standout windows. */
    series: function (wx, marine, tide, ctx, tz) {
      var out = [], now = Date.now();
      var T = wx.hourly.time;
      var start = now - 2 * HOUR;
      var end = T[T.length - 1] * 1000;
      var sunCache = {}, solCache = {}, bSum = {}, bN = {};
      for (var t = Math.ceil(start / HOUR) * HOUR; t <= end; t += HOUR) {
        var d = new Date(t);
        var dayKey = global.Astro.parts(d, tz);
        var k = dayKey.year + '-' + dayKey.month + '-' + dayKey.day;
        if (!sunCache[k]) {
          sunCache[k] = global.Astro.sunTimes(d, ctx.lat, ctx.lon, tz);
          solCache[k] = global.Astro.solunar(d, ctx.lat, ctx.lon, tz).periods;
        }
        var c = { kinds: ctx.kinds, access: ctx.access, windLimit: ctx.windLimit, swellLimit: ctx.swellLimit,
                  species: ctx.species, month: dayKey.month - 1, faces: ctx.faces, weights: ctx.weights };
        var s = Score.at(t, wx, marine, tide, sunCache[k], solCache[k], c);
        out.push({ t: t, score: s.score, wind: s.wind, dir: s.dir, hazard: s.hazard,
                   sd: Ensemble.at(ctx.spread, t) });
        for (var q = 0; q < s.parts.length; q++) { var pk = s.parts[q].key; bSum[pk] = (bSum[pk] || 0) + s.parts[q].f; bN[pk] = (bN[pk] || 0) + 1; }
      }
      /* what each factor typically reads at this spot this week — the catch
         log compares against this, not against a fixed number */
      out.baseline = {};
      for (var bk in bSum) out.baseline[bk] = bSum[bk] / bN[bk];
      return out;
    },

    /* Windows are built around peaks rather than by thresholding a run, so a
       flat good day yields one sensible session instead of a 16-hour block. */
    windows: function (series, minScore, tz) {
      var pts = series.filter(function (p) { return p.t > Date.now() - HOUR; });
      if (pts.length < 3) return [];
      var sm = pts.map(function (p, i) {
        var a = pts[Math.max(0, i - 1)].score, c = pts[Math.min(pts.length - 1, i + 1)].score;
        return { t: p.t, s: (a + 2 * p.score + c) / 4, raw: p.score };
      });
      var cand = [];
      for (var i = 0; i < sm.length; i++) {
        var prev = i > 0 ? sm[i - 1].s : -1, next = i < sm.length - 1 ? sm[i + 1].s : -1;
        if (sm[i].s < minScore || !(sm[i].s >= prev && sm[i].s > next)) continue;
        var floor = Math.max(minScore - 4, sm[i].s - 9);
        var a = i, b = i;
        while (a > 0 && sm[a - 1].s >= floor && (sm[i].t - sm[a - 1].t) <= 2.5 * HOUR) a--;
        while (b < sm.length - 1 && sm[b + 1].s >= floor && (sm[b + 1].t - sm[i].t) <= 2.5 * HOUR) b++;
        var peak = 0, sum = 0, sdSum = 0, sdN = 0;
        for (var k = a; k <= b; k++) {
          peak = Math.max(peak, sm[k].raw); sum += sm[k].raw;
          if (pts[k].sd != null) { sdSum += pts[k].sd; sdN++; }
        }
        cand.push({ start: sm[a].t, end: sm[b].t + HOUR, peak: peak, avg: Math.round(sum / (b - a + 1)),
                    sd: sdN ? sdSum / sdN : null });
      }
      cand.sort(function (x, y) { return y.peak - x.peak || y.avg - x.avg || x.start - y.start; });

      var kept = [], perDay = {};
      for (var j = 0; j < cand.length && kept.length < 6; j++) {
        var w = cand[j], clash = false;
        for (var m = 0; m < kept.length; m++) {
          if (w.start < kept[m].end && w.end > kept[m].start) { clash = true; break; }
        }
        if (clash) continue;
        var key = tz ? (function () { var p = global.Astro.parts(new Date(w.start), tz); return p.year + '-' + p.month + '-' + p.day; })()
          : Math.floor(w.start / 86400000);
        perDay[key] = (perDay[key] || 0) + 1;
        if (perDay[key] > 2) continue;
        kept.push(w);
      }
      return kept.sort(function (x, y) { return y.peak - x.peak || x.start - y.start; });
    },

    /* What the log says about him. For each factor, compare its value at the
       moment of each catch with its typical value, and nudge the weight. Needs
       a handful of catches before it says anything, and never moves a weight
       by more than about a third. */
    learn: function (log) {
      var all = (log || []).filter(function (e) { return e.parts && e.parts.length; });
      var catches = all.filter(function (e) { return !e.blank; });
      var blanks = all.filter(function (e) { return e.blank; });
      if (catches.length < 6) return { ready: false, n: catches.length, blanks: blanks.length, mult: {} };
      /* Mean factor value at the moment of each catch, against a reference:
         the same factor on his blank sessions when there are enough of them,
         otherwise the week-typical value recorded with the catch. Entries
         from before baselines were recorded fall back to 0.6. */
      var cs = {}, cn = {}, rs = {}, rn = {};
      catches.forEach(function (e) {
        e.parts.forEach(function (p) {
          cs[p.key] = (cs[p.key] || 0) + p.f; cn[p.key] = (cn[p.key] || 0) + 1;
          var b = p.b != null ? p.b : 0.6;
          rs[p.key] = (rs[p.key] || 0) + b; rn[p.key] = (rn[p.key] || 0) + 1;
        });
      });
      var bs = {}, bn = {};
      blanks.forEach(function (e) { e.parts.forEach(function (p) { bs[p.key] = (bs[p.key] || 0) + p.f; bn[p.key] = (bn[p.key] || 0) + 1; }); });
      var mult = {}, notes = [];
      for (var k in cs) {
        if (cn[k] < 4) continue;
        var mean = cs[k] / cn[k];
        var ref = (bn[k] >= 4) ? bs[k] / bn[k] : rs[k] / rn[k];
        var lift = mean - ref;                 // >0: he catches when this factor reads better than usual
        var conf = Math.min(1, cn[k] / 15);    // ease in — six catches move a weight a little, fifteen fully
        var m = clamp(1 + lift * 2.2 * conf, 0.7, 1.35);
        mult[k] = Math.round(m * 100) / 100;
        if (m > 1.12) notes.push(k + ' up');
        if (m < 0.9) notes.push(k + ' down');
      }
      return { ready: true, n: catches.length, blanks: blanks.length, mult: mult, notes: notes, usingBlanks: blanks.length >= 4 };
    },

    verdict: function (n) {
      if (n >= 80) return { label: 'Drop everything', tone: 'great' };
      if (n >= 66) return { label: 'Well worth going', tone: 'good' };
      if (n >= 50) return { label: 'Worth a shot', tone: 'ok' };
      if (n >= 35) return { label: 'Tough but fishable', tone: 'poor' };
      return { label: 'Give it a miss', tone: 'bad' };
    },

    /* Plain-English reasons, best and worst first. */
    reasons: function (detail) {
      var p = detail.parts.slice().sort(function (a, b) { return b.f - a.f; });
      var good = p.filter(function (x) { return x.f >= 0.72 && x.w > 0; }).slice(0, 3);
      var bad = p.filter(function (x) { return x.f <= 0.45 && x.w > 0; }).reverse().slice(0, 3);
      var phrase = {
        wind: function (f) { return f >= 0.72 ? 'Light wind' : 'Too much wind'; },
        pressure: function (f) { return f >= 0.72 ? (detail.pressureTrend != null && detail.pressureTrend < -0.5 ? 'Barometer falling — fish feed ahead of a change' : 'Steady barometer') : 'Barometer working against you'; },
        light: function (f) { return f >= 0.72 ? 'Prime low light' : (detail.isNight ? 'Dark — most species quieter' : 'Middle of the day'); },
        solunar: function (f) { return f >= 0.72 ? 'Inside a moon feeding period' : 'Between moon periods'; },
        tide: function (f) { return f >= 0.72 ? 'Good run of tide' : 'Tide barely moving'; },
        swell: function (f) { return f >= 0.72 ? 'Comfortable swell' : 'Swell too big'; },
        cloud: function (f) { return f >= 0.72 ? 'Soft overcast light' : 'Rain against you'; },
        sst: function (f) { return f >= 0.72 ? 'Water temp suits them' : 'Water temp is off'; }
      };
      return {
        good: good.map(function (x) { return phrase[x.key] ? phrase[x.key](x.f) : x.label; }),
        bad: bad.map(function (x) { return phrase[x.key] ? phrase[x.key](x.f) : x.label; })
      };
    }
  };

  global.Core = {
    TZ: TZ, Store: Store, Api: Api, Tides: Tides, Score: Score, Obs: Obs, Ensemble: Ensemble,
    haversine: haversine, coverage: coverage,
    sampleSeries: sampleSeries, sampleNearest: sampleNearest,
    degToCompass: degToCompass, clamp: clamp, exposure: exposure
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Core;
