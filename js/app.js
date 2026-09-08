/* app.js — screens, charts and glue. */
(function () {
  'use strict';

  var D = window.FishData, C = window.Core, A = window.Astro;
  var TZ = C.TZ, HOUR = 3600000, DAY = 86400000;

  var S = {
    settings: C.Store.settings(),
    spot: null, lat: null, lon: null, gpsFix: null,
    wx: null, marine: null, tide: null, bom: null, bomTides: null,
    live: null, liveRadar: null, obs: null, obsDelta: null, ens: null, spread: null, learned: null,
    bomRadarId: null, bomFrameIx: 0, bomPlaying: false, bomTimer: null, radarSource: 'bom',
    series: [], windows: [], detail: null,
    tideDay: 0, mapMode: 'radar', base: 'map',
    radar: null, frames: [], frameIx: 0, playing: false, timer: null,
    loading: false, lastError: null, stale: false
  };

  /* ================= formatting ====================================== */
  var fT = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  var fT24 = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  var fDay = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short' });
  var fDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: 'numeric', month: 'short' });
  var fFull = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });

  function t(x) { return x == null ? '—' : fT.format(new Date(x)).replace(' ', '').toLowerCase(); }
  function t24(x) { return x == null ? '—' : fT24.format(new Date(x)); }
  function dayName(x) { return fDay.format(new Date(x)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function n1(x) { return x == null ? '—' : (Math.round(x * 10) / 10).toFixed(1); }
  function n0(x) { return x == null ? '—' : String(Math.round(x)); }

  var WMO = {
    0: ['Clear', '☀️'], 1: ['Mostly clear', '🌤️'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'],
    51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
    56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'],
    61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'],
    71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'], 77: ['Snow grains', '❄️'],
    80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'],
    85: ['Snow showers', '🌨️'], 86: ['Snow showers', '🌨️'],
    95: ['Thunderstorm', '⛈️'], 96: ['Storm with hail', '⛈️'], 99: ['Storm with hail', '⛈️']
  };
  function wx(code) { return WMO[code] || ['—', '•']; }

  function toneColor(tone) {
    return { great: 'var(--great)', good: 'var(--good)', ok: 'var(--ok)', poor: 'var(--poor)', bad: 'var(--bad)' }[tone];
  }
  function scoreColor(n) { return toneColor(C.Score.verdict(n).tone); }

  function arrow(deg, size) {
    if (deg == null) return '';
    /* meteorological direction is where the wind comes FROM; point the arrow
       the way it is blowing. */
    return '<span class="arrow" style="transform:rotate(' + ((deg + 180) % 360) + 'deg);font-size:' + (size || 15) + 'px">↑</span>';
  }

  function el(id) { return document.getElementById(id); }

  function relDay(ms) {
    var a = A.startOfLocalDay(new Date(), TZ).valueOf();
    var d = Math.round((A.startOfLocalDay(new Date(ms), TZ).valueOf() - a) / DAY);
    if (d === 0) return 'Today'; if (d === 1) return 'Tomorrow';
    return dayName(ms);
  }

  /* ================= boot ============================================ */

  function applyTheme() {
    var th = S.settings.theme;
    if (th === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', th);
  }

  function init() {
    applyTheme();
    bindTabs(); bindSettings(); bindMaps(); bindFish();
    el('spotBtn').addEventListener('click', openSpotPicker);
    el('gpsBtn').addEventListener('click', function () { locate(true); });
    el('refreshBtn').addEventListener('click', function () { load(true); });
    el('fab').addEventListener('click', openCatchForm);
    el('addCatchBtn').addEventListener('click', openCatchForm);
    el('sheetBg').addEventListener('click', closeSheet);
    el('sheetClose').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    renderRuleLinks(); renderAbout();
    setSpot(S.settings.spot, true);
    load(false);
    if (S.settings.useGps) locate(false);
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
    setInterval(function () { if (S.wx) { computeScores(); renderNow(); } }, 5 * 60000);
  }

  function bindTabs() {
    var tabs = el('tabs');
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      Array.prototype.forEach.call(tabs.children, function (x) { x.classList.toggle('on', x === b); });
      ['now', 'forecast', 'tides', 'maps', 'fish', 'me'].forEach(function (v) {
        var node = el('v-' + v); if (node) node.classList.toggle('on', v === b.dataset.v);
      });
      el('fab').style.display = b.dataset.v === 'now' ? '' : 'none';
      window.scrollTo(0, 0);
      if (b.dataset.v === 'maps') initRadar();
      if (b.dataset.v === 'tides') renderTides();
    });
    /* the settings pane has no tab of its own — the gear opens it */
    el('spotBtn').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function showView(v) {
    var b = document.querySelector('#tabs button[data-v="' + v + '"]');
    if (b) b.click();
    else {
      ['now', 'forecast', 'tides', 'maps', 'fish', 'me'].forEach(function (x) {
        el('v-' + x).classList.toggle('on', x === v);
      });
      Array.prototype.forEach.call(el('tabs').children, function (x) { x.classList.remove('on'); });
      el('fab').style.display = 'none';
      window.scrollTo(0, 0);
    }
  }

  /* ================= location ======================================== */

  function haversine(a, b, c, d) {
    var R = 6371, p = Math.PI / 180;
    var x = Math.sin((c - a) * p / 2), y = Math.sin((d - b) * p / 2);
    var h = x * x + Math.cos(a * p) * Math.cos(c * p) * y * y;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function nearestSpot(lat, lon, kindFilter) {
    var best = null, bd = 1e9;
    D.SPOTS.forEach(function (s) {
      if (kindFilter && s.kinds.indexOf(kindFilter) < 0) return;
      var d = haversine(lat, lon, s.lat, s.lon);
      if (d < bd) { bd = d; best = s; }
    });
    return { spot: best, km: bd };
  }

  function setSpot(id, quiet) {
    var s = D.SPOTS[id] || D.SPOTS[0];
    S.spot = s; S.lat = s.lat; S.lon = s.lon; S.gpsFix = null;
    el('spotName').textContent = s.name;
    el('spotRegion').textContent = s.region;
    if (!quiet) { C.Store.saveSettings({ spot: s.id }); S.settings = C.Store.settings(); load(true); }
  }

  function locate(explicit) {
    if (!navigator.geolocation) { if (explicit) alertBanner('This browser will not share a location.'); return; }
    el('gpsBtn').classList.add('spin');
    navigator.geolocation.getCurrentPosition(function (pos) {
      el('gpsBtn').classList.remove('spin');
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var near = nearestSpot(lat, lon);
      S.gpsFix = { lat: lat, lon: lon, km: near.km };
      S.spot = near.spot; S.lat = lat; S.lon = lon;
      el('spotName').textContent = near.km < 3 ? near.spot.name : ('Near ' + near.spot.name);
      el('spotRegion').textContent = near.km < 3 ? near.spot.region
        : (near.km.toFixed(0) + ' km from ' + near.spot.name);
      load(true);
    }, function () {
      el('gpsBtn').classList.remove('spin');
      if (explicit) alertBanner('Could not get a location fix. Pick a spot from the list instead.');
      if (!S.wx) load(false);
    }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 });
  }

  function alertBanner(msg, kind) {
    var box = el('alerts');
    var div = document.createElement('div');
    div.className = 'banner ' + (kind || 'info');
    div.innerHTML = msg;
    box.appendChild(div);
    setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 9000);
  }

  /* ================= data load ======================================= */

  function load(force) {
    if (S.loading) { S.reload = true; return; }
    S.reload = false;
    S.loading = true;
    el('refreshBtn').classList.add('spin');
    var sp = S.spot;
    var sea = sp && sp.sea ? sp.sea : null;

    var jobs = [
      C.Api.weather(S.lat, S.lon, S.settings.model).then(function (r) { S.wx = r.data; S.stale = r.stale; S.fellBack = !!r.fellBack; S.wxAt = r.cachedAt; })
        .catch(function (e) { S.lastError = e; S.wx = S.wx || null; }),
      C.Api.local('bom.json').then(function (j) { S.bom = j; }).catch(function () {}),
      C.Api.local('tides.json').then(function (j) { S.bomTides = j; }).catch(function () {}),
      C.Api.live('obs.json').then(function (r) { S.live = r.data; }).catch(function () { S.live = null; }),
      C.Api.live('radar.json', 3).then(function (r) { S.liveRadar = r.data; }).catch(function () { S.liveRadar = null; }),
      C.Api.ensemble(S.lat, S.lon).then(function (r) { S.ens = r.data; }).catch(function () { S.ens = null; })
    ];
    if (sea) {
      jobs.push(C.Api.marine(sea.lat, sea.lon).then(function (r) { S.marine = r.data; S.marineKm = r.offshoreKm; }).catch(function () { S.marine = null; }));
      jobs.push(C.Api.seaLevel(sea.lat, sea.lon).then(function (r) { S.seaLevel = r.data; }).catch(function () { S.seaLevel = null; }));
    } else { S.marine = null; S.seaLevel = null; }

    Promise.all(jobs).then(function () {
      S.loading = false;
      if (S.reload) { S.reload = false; load(true); return; }
      el('refreshBtn').classList.remove('spin');
      buildTide();
      S.obs = C.Obs.nearest(S.live, S.lat, S.lon, 45);
      S.obsDelta = S.wx && S.obs ? C.Obs.apply(S.wx, S.obs, 6) : null;
      S.spread = C.Ensemble.spread(S.ens);
      if (!S.wx) {
        el('verdict').textContent = 'No forecast yet';
        el('verdictSub').textContent = 'Check your connection and hit refresh.';
        return;
      }
      computeScores();
      renderAll();
    });
  }

  function buildTide() {
    var sp = S.spot;
    S.tide = null;
    if (!sp || !sp.port) return;
    var port = D.PORTS[sp.port];
    var fromBom = C.Tides.fromBom(S.bomTides, sp.port, sp.hwOff, sp.lwOff);
    if (fromBom) { S.tide = fromBom; S.tide.portName = port.name; return; }
    if (S.seaLevel) {
      var m = C.Tides.fromModel(S.seaLevel, port.msl, sp.hwOff, sp.lwOff);
      if (m) { m.portName = port.name; S.tide = m; }
    }
  }

  function ctx() {
    var picks = S.settings.species.map(function (n) {
      return D.SPECIES.filter(function (s) { return s.n === n; })[0];
    }).filter(Boolean);
    S.learned = S.settings.learn ? C.Score.learn(C.Store.log()) : { ready: false, mult: {} };
    var weights = {}, expert = S.settings.weights || {};
    ['wind', 'pressure', 'light', 'solunar', 'tide', 'swell', 'cloud', 'sst'].forEach(function (k) {
      weights[k] = (expert[k] != null ? expert[k] : 1) * (S.learned.mult[k] != null ? S.learned.mult[k] : 1);
    });
    return {
      kinds: S.spot ? S.spot.kinds : ['e'],
      faces: S.spot && !S.gpsFix ? S.spot.faces : (S.spot && S.gpsFix && S.gpsFix.km < 4 ? S.spot.faces : null),
      access: S.settings.access,
      windLimit: S.settings.windLimit,
      swellLimit: S.settings.swellLimit,
      species: picks,
      weights: weights,
      spread: S.spread,
      lat: S.lat, lon: S.lon
    };
  }

  function computeScores() {
    var c = ctx();
    var now = new Date();
    var sun = A.sunTimes(now, S.lat, S.lon, TZ);
    var sol = A.solunar(now, S.lat, S.lon, TZ);
    var cc = { kinds: c.kinds, faces: c.faces, weights: c.weights, access: c.access, windLimit: c.windLimit,
               swellLimit: c.swellLimit, species: c.species, month: A.parts(now, TZ).month - 1 };
    S.detail = C.Score.at(Date.now(), S.wx, S.marine, S.tide, sun, sol.periods, cc);
    S.sun = sun; S.sol = sol;
    S.series = C.Score.series(S.wx, S.marine, S.tide, c, TZ);
    var top = S.series.reduce(function (m, p) { return Math.max(m, p.score); }, 0);
    S.windows = C.Score.windows(S.series, Math.max(48, top - 18), TZ);
  }

  function renderAll() {
    renderNow(); renderForecast(); renderTides(); renderFish(); renderSettings(); renderBomLinks(); renderStatus();
  }

  /* ================= NOW ============================================= */

  function dialSvg(score) {
    var r = 52, cc = 62, circ = 2 * Math.PI * r;
    var pct = Math.max(0, Math.min(100, score)) / 100;
    return '<svg viewBox="0 0 124 124" aria-hidden="true">' +
      '<circle cx="' + cc + '" cy="' + cc + '" r="' + r + '" fill="none" stroke="var(--card2)" stroke-width="11"/>' +
      '<circle cx="' + cc + '" cy="' + cc + '" r="' + r + '" fill="none" stroke="' + scoreColor(score) + '" stroke-width="11" stroke-linecap="round" ' +
      'stroke-dasharray="' + (circ * pct).toFixed(1) + ' ' + circ.toFixed(1) + '"/></svg>' +
      '<div class="num"><b>' + score + '</b><i>bite score</i></div>';
  }

  function renderNow() {
    if (!S.detail) return;
    var d = S.detail, v = C.Score.verdict(d.score);
    el('dial').innerHTML = dialSvg(d.score);
    el('verdict').textContent = v.label;
    el('verdict').style.color = toneColor(v.tone);

    var sp = S.settings.species[0];
    var who = S.settings.name ? S.settings.name : null;
    var bits = [];
    bits.push(S.spot ? S.spot.name : '');
    if (sp) bits.push('chasing ' + sp.toLowerCase());
    bits.push(S.settings.access === 'boat' ? 'in the boat' : 'land based');
    el('verdictSub').textContent = (who ? who + ' — ' : '') + bits.join(' · ');

    var r = C.Score.reasons(d);
    el('reasonChips').innerHTML =
      r.good.slice(0, 2).map(function (x) { return '<span class="chip pos">' + esc(x) + '</span>'; }).join('') +
      r.bad.slice(0, 2).map(function (x) { return '<span class="chip neg">' + esc(x) + '</span>'; }).join('');

    el('factors').innerHTML = d.parts.filter(function (p) { return p.w > 0; }).map(function (p) {
      var pct = Math.round(p.f * 100);
      return '<div class="factor"><span>' + esc(p.label) + '</span>' +
        '<span class="bar"><i style="width:' + pct + '%;background:' + scoreColor(pct) + '"></i></span>' +
        '<span class="val">' + pct + '</span></div>';
    }).join('');

    var foot = [];
    if (sp && d.seasonMult < 1) foot.push(sp + ' is ' + (d.seasonMult < 0.6 ? 'well out of its main run' : 'a bit off its peak') + ' this month.');
    if (S.stale) foot.push('Showing the last forecast that downloaded.');
    foot.push('Model: ' + (S.fellBack ? 'best available (BOM model unavailable)'
      : S.settings.model === 'bom_access_global' ? 'BOM ACCESS-G' : 'best available'));
    el('scoreFoot').textContent = foot.join(' ');

    /* hazard + warning banners */
    var box = el('alerts'); box.innerHTML = '';
    if (d.hazard) {
      box.innerHTML += '<div class="banner warn"><b>Big swell running</b>' +
        'Around ' + n1(d.wave) + ' m. Rock and beach ledges get dangerous fast — stay well back, wear a lifejacket and never fish alone.</div>';
    }
    if (d.wind != null && d.wind > S.settings.windLimit) {
      box.innerHTML += '<div class="banner warn"><b>Over your wind limit</b>' +
        n0(d.wind) + ' kt now, gusting ' + n0(d.gust) + ' kt — you set ' + S.settings.windLimit + ' kt.</div>';
    }
    if (S.bom && S.bom.warnings && S.bom.warnings.length) {
      S.bom.warnings.slice(0, 3).forEach(function (w) {
        box.innerHTML += '<div class="banner warn"><b>' + esc(w.title) + '</b>' + esc(w.text || 'Current BOM marine warning.') + '</div>';
      });
    }
    var closed = closedSpeciesNote();
    if (closed) box.innerHTML += '<div class="banner info"><b>Closed season</b>' + closed + '</div>';

    /* the grid */
    var cells = [];
    function cell(k, v, x) { cells.push('<div class="cell"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="x">' + (x || '&nbsp;') + '</div></div>'); }
    cell('Wind', n0(d.wind) + ' <small>kt</small> ' + arrow(d.dir, 17),
      C.degToCompass(d.dir) + ' · gusts ' + n0(d.gust) + ' kt');
    var HN = S.wx.hourly, nowMs = Date.now();
    var code = C.sampleNearest(HN.time, HN.weather_code, nowMs);
    cell('Air', n0(C.sampleSeries(HN.time, HN.temperature_2m, nowMs)) + '°',
      wx(code)[1] + ' ' + wx(code)[0]);
    var tr = d.pressureTrend;
    cell('Barometer', n0(d.pressure) + ' <small>hPa</small>',
      tr == null ? '&nbsp;' : (tr > 0.3 ? '▲ rising' : tr < -0.3 ? '▼ falling' : '– steady') + ' ' + n1(Math.abs(tr)) + ' /3h');
    if (d.wave != null) cell('Swell', n1(d.wave) + ' <small>m</small>',
      (d.period ? n0(d.period) + ' s ' : '') + C.degToCompass(C.sampleSeries(S.marine.hourly.time, S.marine.hourly.swell_wave_direction, Date.now())));
    if (d.sst != null) cell('Water', n1(d.sst) + '°', seaTempNote(d.sst));
    else if (S.spot && S.spot.sea) cell('Water', '<small>no reading</small>', 'sea temp not modelled here');
    cell('Cloud &amp; rain', n0(d.cloud) + '<small>%</small>',
      d.rain > 0 ? n1(d.rain) + ' mm falling' : (d.rain24 > 0.5 ? n1(d.rain24) + ' mm last 24 h' : 'Dry'));
    if (cells.length % 3 === 1) {
      cell('Humidity', n0(C.sampleSeries(HN.time, HN.relative_humidity_2m, nowMs)) + '<small>%</small>',
        'Rain 24 h ' + n1(d.rain24) + ' mm');
      cell('Feels like', n0(C.sampleSeries(HN.time, HN.apparent_temperature, nowMs)) + '°',
        d.wind > 18 ? 'Wind chill biting' : '&nbsp;');
    } else if (cells.length % 3 === 2) {
      cell('Rain 24 h', n1(d.rain24) + ' <small>mm</small>', d.rain24 > 20 ? 'Fresh in the system' : '&nbsp;');
    }
    el('nowGrid').innerHTML = cells.join('');

    renderStation(); renderTideNow(); renderSunMoon(); renderWindows(); renderBomText();
  }

  function renderStation() {
    var card = el('stationCard'), o = S.obs;
    if (!o) { card.style.display = 'none'; return; }
    card.style.display = '';
    var d = S.obsDelta;
    function delta(v, unit, dp) {
      if (v == null || Math.abs(v) < (dp ? 0.15 : 0.5)) return '<span class="muted">matches model</span>';
      var sign = v > 0 ? '+' : '−';
      return '<span style="color:' + (Math.abs(v) > (unit === 'kt' ? 5 : 2) ? 'var(--poor)' : 'var(--ink2)') + '">' +
        sign + (dp ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v))) + ' ' + unit + ' vs model</span>';
    }
    el('stationBody').innerHTML =
      '<div class="row"><div><div style="font-weight:680;font-size:16px">' + esc(o.name) + '</div>' +
      '<div class="muted">' + o.km + ' km away · read ' + (o.ageMin != null ? o.ageMin + ' min ago' : 'recently') + '</div></div>' +
      '<div class="chip">BOM station</div></div>' +
      '<div class="grid" style="margin-top:10px">' +
      '<div class="cell"><div class="k">Wind</div><div class="v">' + n0(o.windKt) + ' <small>kt</small> ' + arrow(o.windDir, 16) + '</div>' +
      '<div class="x">' + (o.windDirText || C.degToCompass(o.windDir)) + (o.gustKt != null ? ' · gusts ' + n0(o.gustKt) : '') + '<br>' + (d ? delta(d.wind, 'kt') : '') + '</div></div>' +
      '<div class="cell"><div class="k">Pressure</div><div class="v">' + n1(o.pressure) + '</div><div class="x">hPa<br>' + (d ? delta(d.pressure, 'hPa', true) : '') + '</div></div>' +
      '<div class="cell"><div class="k">Air</div><div class="v">' + n1(o.temp) + '°</div><div class="x">' +
      (o.rain != null ? o.rain + ' mm since 9am' : '&nbsp;') + '<br>' + (d ? delta(d.temp, '°', true) : '') + '</div></div>' +
      '</div>' +
      (d && (Math.abs(d.wind) >= 3 || Math.abs(d.pressure) >= 1.5) ?
        '<div class="muted" style="margin-top:8px">The next six hours of the forecast have been nudged toward what the station is reading. The model gets the rest.</div>' : '');
  }

  function seaTempNote(sst) {
    if (sst < 16) return 'Cold — salmon & trout water';
    if (sst < 19) return 'Cool — snapper & bream';
    if (sst < 22) return 'Mild — kings starting';
    if (sst < 25) return 'Warm — pelagics about';
    return 'Hot — mackerel & marlin water';
  }

  function closedSpeciesNote() {
    var out = [];
    S.settings.species.forEach(function (n) {
      var s = D.SPECIES.filter(function (x) { return x.n === n; })[0];
      if (s && s.closed) out.push('<b style="display:inline">' + esc(s.n) + '</b> — ' + esc(s.closed));
    });
    return out.length ? out.join('<br>') : null;
  }

  function renderTideNow() {
    var box = el('tideNow');
    if (!S.tide) {
      el('tideNowCard').style.display = S.spot && S.spot.kinds.indexOf('f') >= 0 && S.spot.kinds.length === 1 ? 'none' : '';
      box.innerHTML = '<div class="muted">No tide data for this spot.</div>';
      return;
    }
    el('tideNowCard').style.display = '';
    var st = C.Tides.state(S.tide, Date.now());
    if (!st) { box.innerHTML = '<div class="muted">Tide data does not cover right now.</div>'; return; }
    var mins = st.minsToNext, hrs = Math.floor(mins / 60);
    var when = (hrs ? hrs + ' h ' : '') + (mins % 60) + ' min';
    box.innerHTML =
      '<div class="row"><div>' +
      '<div style="font-size:20px;font-weight:680">' + (st.rising ? 'Running in' : 'Running out') +
      ' · ' + n1(st.height) + ' m</div>' +
      '<div class="muted">' + (st.next.type === 'high' ? 'High' : 'Low') + ' ' + n1(st.next.h) + ' m in ' + when + ' (' + t(st.next.t) + ')</div>' +
      '</div><div style="text-align:right"><div style="font-size:26px">' + (st.rising ? '⬆' : '⬇') + '</div>' +
      '<div class="muted">' + n1(Math.abs(st.rate)) + ' m/h</div></div></div>' +
      '<div style="margin-top:10px">' + tideSpark() + '</div>' +
      (S.spot.damped ? '<div class="muted" style="margin-top:8px">' + esc(S.spot.note || 'Tide heights inside this system are much smaller than at the entrance.') + '</div>' : '');
  }

  function tideSpark() {
    var w = 320, h = 54, now = Date.now();
    var t0 = now - 6 * HOUR, t1 = now + 12 * HOUR;
    var pts = [], min = 99, max = -99;
    for (var t = t0; t <= t1; t += 15 * 60000) {
      var v = C.Tides.heightAt(S.tide, t);
      if (v == null) continue;
      pts.push([t, v]); if (v < min) min = v; if (v > max) max = v;
    }
    if (pts.length < 3) return '';
    var rng = Math.max(0.2, max - min);
    var path = pts.map(function (p, i) {
      var x = (p[0] - t0) / (t1 - t0) * w, y = h - 6 - (p[1] - min) / rng * (h - 14);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    var nx = (now - t0) / (t1 - t0) * w;
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="height:54px">' +
      '<path d="' + path + ' L' + w + ' ' + h + ' L0 ' + h + 'Z" fill="color-mix(in srgb,var(--accent) 16%,transparent)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
      '<line x1="' + nx + '" y1="0" x2="' + nx + '" y2="' + h + '" stroke="var(--accent2)" stroke-width="1.5" stroke-dasharray="3 3"/>' +
      '</svg>';
  }

  function renderSunMoon() {
    var sun = S.sun, sol = S.sol, il = sol.illumination;
    var glyph = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][il.index];
    var next = sol.periods.filter(function (p) { return p.end.valueOf() > Date.now(); });
    var rows = next.slice(0, 2).map(function (p) {
      return '<div class="row" style="margin-top:6px"><span>' + (p.kind === 'major' ? '<b>Major</b>' : 'Minor') + ' · ' + esc(p.label) + '</span>' +
        '<span class="muted">' + t(p.start) + ' – ' + t(p.end) + '</span></div>';
    }).join('');
    el('sunMoon').innerHTML =
      '<div class="grid two">' +
      '<div class="cell"><div class="k">Sunrise</div><div class="v">' + t(sun.sunrise) + '</div><div class="x">first light ' + t(sun.dawn) + '</div></div>' +
      '<div class="cell"><div class="k">Sunset</div><div class="v">' + t(sun.sunset) + '</div><div class="x">dark by ' + t(sun.dusk) + '</div></div>' +
      '<div class="cell"><div class="k">Moon</div><div class="v">' + glyph + ' ' + Math.round(il.fraction * 100) + '<small>%</small></div><div class="x">' + esc(il.name) + '</div></div>' +
      '<div class="cell"><div class="k">Moonrise</div><div class="v">' + t(sol.moon.rise) + '</div><div class="x">set ' + t(sol.moon.set) + '</div></div>' +
      '</div>' + rows;
  }

  function renderWindows() {
    var box = el('windows');
    if (!S.windows.length) { box.innerHTML = '<div class="empty">Nothing stands out in the next week. Best of a bad lot is still the dawn change.</div>'; return; }
    box.innerHTML = S.windows.slice(0, 5).map(function (w) {
      var conf = C.Ensemble.label(w.sd);
      return '<div class="win"><div><div class="w1">' + relDay(w.start) + ' ' + t(w.start) + ' – ' + t(w.end) + '</div>' +
        '<div class="w2">' + fDate.format(new Date(w.start)) + ' · ' + Math.round((w.end - w.start) / HOUR) + ' hour window' +
        (conf ? ' · <span style="color:' + toneColor(conf.tone) + '">' + conf.text.toLowerCase() + '</span>' : '') + '</div></div>' +
        '<div class="pill" style="background:' + scoreColor(w.peak) + '">' + w.peak + '</div></div>';
    }).join('') + (S.spread ? '<div class="muted">Confidence comes from how tightly the ' + S.spread.members + ' members of BOM\u2019s ensemble agree on the wind.</div>' : '');
  }

  function renderBomText() {
    var card = el('bomCard');
    if (!S.bom || !S.bom.coastal || !S.spot || !S.spot.district) { card.style.display = 'none'; return; }
    var f = S.bom.coastal[S.spot.district];
    if (!f) { card.style.display = 'none'; return; }
    card.style.display = '';
    el('bomText').innerHTML = (f.periods || []).slice(0, 3).map(function (p) {
      return '<div style="margin-bottom:8px"><b>' + esc(p.label) + '</b><br>' + esc(p.text) + '</div>';
    }).join('') || esc(f.text || '');
    el('bomMeta').innerHTML = 'BOM ' + esc(D.DISTRICTS[S.spot.district] || '') + ' · issued ' + esc(f.issued || S.bom.updated || '') +
      '<br>Based on Bureau of Meteorology information that has subsequently been modified. The Bureau does not necessarily support or endorse, or have any connection with, this app.';
  }

  /* ================= FORECAST ======================================== */

  function renderForecast() {
    renderTempChart(); renderScoreChart(); renderHourStrip(); renderDayList(); renderMarine();
  }

  function renderTempChart() {
    var H = S.wx.hourly, T = H.time, V = H.temperature_2m, F = H.apparent_temperature;
    if (!T || !V) { el('tempChart').innerHTML = ''; return; }
    var w = 700, h = 210, padL = 30, padB = 26, now = Date.now();
    var pts = [], fpts = [], min = 99, max = -99;
    for (var i = 0; i < T.length; i++) {
      var ts = T[i] * 1000; if (ts < now - 3 * HOUR || V[i] == null) continue;
      pts.push([ts, V[i]]); min = Math.min(min, V[i]); max = Math.max(max, V[i]);
      if (F && F[i] != null) fpts.push([ts, F[i]]);
    }
    if (pts.length < 3) { el('tempChart').innerHTML = ''; return; }
    var lo = Math.floor(min / 2) * 2 - 2, hi = Math.ceil(max / 2) * 2 + 2;
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    var X = function (x) { return padL + (x - t0) / (t1 - t0) * (w - padL - 8); };
    var Y = function (v) { return 12 + (hi - v) / (hi - lo) * (h - padB - 20); };
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
    var fpath = fpts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
    var grid = '', labels = '';
    for (var v = lo; v <= hi; v += (hi - lo > 16 ? 4 : 2)) {
      grid += '<line x1="' + padL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (w - 8) + '" y2="' + Y(v).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="2 4"/>' +
        '<text x="2" y="' + (Y(v) + 4).toFixed(1) + '" font-size="10" fill="var(--ink3)">' + v + '°</text>';
    }
    var Dy = S.wx.daily, d0 = A.startOfLocalDay(new Date(t0), TZ).valueOf();
    for (var k = 0; k < 8; k++) {
      var ds = d0 + k * DAY;
      if (ds > t0 && ds < t1) grid += '<line x1="' + X(ds).toFixed(1) + '" y1="10" x2="' + X(ds).toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--line)"/>';
      if (ds + DAY > t0 && ds < t1) {
        var mid = X(Math.max(t0, ds) + Math.min(DAY, Math.min(t1, ds + DAY) - Math.max(t0, ds)) / 2);
        var di = -1; for (var q = 0; q < Dy.time.length; q++) if (Dy.time[q] * 1000 === ds) di = q;
        labels += '<text x="' + mid.toFixed(1) + '" y="' + (h - 8) + '" font-size="10.5" fill="var(--ink3)" text-anchor="middle">' + dayName(ds) + '</text>';
        if (di >= 0) {
          labels += '<text x="' + mid.toFixed(1) + '" y="' + (Y(Dy.temperature_2m_max[di]) - 8).toFixed(1) + '" font-size="11" font-weight="700" fill="var(--accent2)" text-anchor="middle">' + n0(Dy.temperature_2m_max[di]) + '°</text>';
          labels += '<text x="' + mid.toFixed(1) + '" y="' + (Y(Dy.temperature_2m_min[di]) + 15).toFixed(1) + '" font-size="11" font-weight="700" fill="var(--accent)" text-anchor="middle">' + n0(Dy.temperature_2m_min[di]) + '°</text>';
        }
      }
    }
    var nx = X(Math.max(t0, Math.min(t1, now)));
    el('tempChart').innerHTML = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:210px">' + grid +
      '<path d="' + path + ' L' + X(t1).toFixed(1) + ' ' + (h - padB) + ' L' + X(t0).toFixed(1) + ' ' + (h - padB) + 'Z" fill="color-mix(in srgb,var(--accent2) 12%,transparent)"/>' +
      (fpath ? '<path d="' + fpath + '" fill="none" stroke="var(--ink3)" stroke-width="1.4" stroke-dasharray="4 3"/>' : '') +
      '<path d="' + path + '" fill="none" stroke="var(--accent2)" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<line x1="' + nx.toFixed(1) + '" y1="10" x2="' + nx.toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3"/>' +
      labels + '</svg>';
    var obs = S.obs && S.obs.temp != null ? ' · station reading ' + n1(S.obs.temp) + '° now' : '';
    el('tempFoot').textContent = 'Air temperature at ' + (S.gpsFix ? 'your location' : S.spot.name) + ', hourly for seven days. Dashed line is feels-like.' + obs;
  }

  function renderScoreChart() {
    var w = 700, h = 200, pad = 26;
    var pts = S.series;
    if (!pts.length) { el('scoreChart').innerHTML = ''; return; }
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var X = function (t) { return pad + (t - t0) / (t1 - t0) * (w - pad - 8); };
    var Y = function (s) { return h - 26 - s / 100 * (h - 46); };
    var maxWind = Math.max(12, pts.reduce(function (m, p) { return Math.max(m, p.wind || 0); }, 0));

    var nights = '', days = '', ticks = '';
    var d0 = A.startOfLocalDay(new Date(t0), TZ).valueOf();
    for (var i = 0; i < 8; i++) {
      var ds = d0 + i * DAY;
      var st = A.sunTimes(new Date(ds + 12 * HOUR), S.lat, S.lon, TZ);
      var sr = st.sunrise ? st.sunrise.valueOf() : ds + 6 * HOUR;
      var ss = st.sunset ? st.sunset.valueOf() : ds + 18 * HOUR;
      if (ss > t0 && ds < t1) {
        var a = Math.max(t0, ss), b = Math.min(t1, ds + DAY + (sr - ds));
        if (b > a) nights += '<rect x="' + X(a).toFixed(1) + '" y="14" width="' + (X(b) - X(a)).toFixed(1) + '" height="' + (h - 40) + '" fill="color-mix(in srgb,var(--ink) 9%,transparent)"/>';
      }
      if (ds > t0 && ds < t1) {
        ticks += '<line x1="' + X(ds).toFixed(1) + '" y1="14" x2="' + X(ds).toFixed(1) + '" y2="' + (h - 26) + '" stroke="var(--line)" stroke-width="1"/>' +
          '<text x="' + (X(ds) + 4).toFixed(1) + '" y="' + (h - 10) + '" font-size="11" fill="var(--ink3)">' + dayName(ds) + '</text>';
      }
    }
    var bars = pts.map(function (p) {
      var x = X(p.t), bh = (p.wind || 0) / maxWind * 34;
      return '<rect x="' + (x - 1.4).toFixed(1) + '" y="' + (h - 26 - bh).toFixed(1) + '" width="2.8" height="' + bh.toFixed(1) + '" fill="var(--ink3)" opacity=".35"/>';
    }).join('');
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.score).toFixed(1); }).join(' ');
    var area = path + ' L' + X(t1).toFixed(1) + ' ' + (h - 26) + ' L' + X(t0).toFixed(1) + ' ' + (h - 26) + 'Z';
    var nowX = X(Math.max(t0, Math.min(t1, Date.now())));

    el('scoreChart').innerHTML = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:200px">' +
      nights + ticks + bars +
      '<path d="' + area + '" fill="color-mix(in srgb,var(--accent) 14%,transparent)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round"/>' +
      S.windows.slice(0, 4).map(function (win) {
        return '<rect x="' + X(win.start).toFixed(1) + '" y="14" width="' + Math.max(2, X(win.end) - X(win.start)).toFixed(1) + '" height="' + (h - 40) + '" fill="color-mix(in srgb,var(--great) 13%,transparent)"/>';
      }).join('') +
      '<line x1="' + nowX.toFixed(1) + '" y1="14" x2="' + nowX.toFixed(1) + '" y2="' + (h - 26) + '" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="4 3"/>' +
      '<text x="2" y="' + (Y(100) + 4) + '" font-size="10" fill="var(--ink3)">100</text>' +
      '<text x="2" y="' + (Y(50) + 4) + '" font-size="10" fill="var(--ink3)">50</text>' +
      '</svg>';
  }

  function renderHourStrip() {
    var H = S.wx.hourly, out = [], now = Date.now();
    var sunByDay = {};
    for (var i = 0; i < H.time.length; i++) {
      var ts = H.time[i] * 1000;
      if (ts < now - HOUR || ts > now + 48 * HOUR) continue;
      var p = A.parts(new Date(ts), TZ), k = p.year + '-' + p.month + '-' + p.day;
      if (!sunByDay[k]) sunByDay[k] = A.sunTimes(new Date(ts), S.lat, S.lon, TZ);
      var st = sunByDay[k];
      var night = !(st.sunrise && st.sunset && ts >= st.sunrise.valueOf() && ts <= st.sunset.valueOf());
      var sc = null;
      for (var j = 0; j < S.series.length; j++) if (Math.abs(S.series[j].t - ts) < 30 * 60000) { sc = S.series[j].score; break; }
      var code = H.weather_code ? H.weather_code[i] : null;
      out.push('<div class="hour' + (night ? ' night' : '') + '">' +
        '<div class="t">' + (Math.abs(ts - now) < 40 * 60000 ? 'Now' : t(ts)) + '</div>' +
        '<div class="ic">' + wx(code)[1] + '</div>' +
        '<div class="tm">' + (H.temperature_2m[i] != null ? n0(H.temperature_2m[i]) + '°' : '·') + '</div>' +
        '<div class="wd">' + (H.wind_speed_10m[i] != null ? arrow(H.wind_direction_10m[i], 12) + ' ' + n0(H.wind_speed_10m[i]) : '·') + '</div>' +
        (sc != null ? '<div class="dot" style="background:' + scoreColor(sc) + '" title="' + sc + '"></div>' : '<div class="dot"></div>') +
        '</div>');
    }
    el('hourStrip').innerHTML = out.join('');
  }

  function renderDayList() {
    var Dy = S.wx.daily, out = [];
    for (var i = 0; i < Dy.time.length; i++) {
      var ts = Dy.time[i] * 1000;
      if (ts < A.startOfLocalDay(new Date(), TZ).valueOf()) continue;
      var dayWins = S.windows.filter(function (w) {
        return A.startOfLocalDay(new Date(w.start), TZ).valueOf() === A.startOfLocalDay(new Date(ts), TZ).valueOf();
      });
      var best = S.series.filter(function (p) {
        return p.t >= ts && p.t < ts + DAY;
      }).reduce(function (m, p) { return Math.max(m, p.score); }, 0);
      var swell = null;
      if (S.marine && S.marine.daily && S.marine.daily.wave_height_max) {
        for (var k = 0; k < S.marine.daily.time.length; k++) if (S.marine.daily.time[k] * 1000 === ts) swell = S.marine.daily.wave_height_max[k];
      }
      var sdDay = null, sdN = 0, sdSum = 0;
      S.series.forEach(function (p) { if (p.t >= ts && p.t < ts + DAY && p.sd != null) { sdSum += p.sd; sdN++; } });
      if (sdN) sdDay = C.Ensemble.label(sdSum / sdN);
      out.push('<div class="day"><div><div class="dn">' + relDay(ts) + '</div><div class="dd">' + fDate.format(new Date(ts)) +
        (sdDay ? '<br><span style="color:' + toneColor(sdDay.tone) + '">' + sdDay.text.split(' ')[0] + ' conf.</span>' : '') + '</div></div>' +
        '<div class="di">' + wx(Dy.weather_code[i])[1] + '</div>' +
        '<div><div class="dt">' + n0(Dy.temperature_2m_min[i]) + '° – ' + n0(Dy.temperature_2m_max[i]) + '°' +
        (Dy.precipitation_sum[i] > 0.2 ? ' · ' + n1(Dy.precipitation_sum[i]) + ' mm' : '') + '</div>' +
        '<div class="dw">' + arrow(Dy.wind_direction_10m_dominant[i], 12) + ' ' + n0(Dy.wind_speed_10m_max[i]) + ' kt max' +
        (swell != null ? ' · swell ' + n1(swell) + ' m' : '') +
        (dayWins.length ? ' · best ' + t(dayWins[0].start) : '') + '</div></div>' +
        '<div class="pill" style="background:' + scoreColor(best) + '">' + best + '</div></div>');
    }
    el('dayList').innerHTML = out.join('');
  }

  function renderMarine() {
    var card = el('marineCard');
    if (!S.marine || !S.marine.hourly || !S.marine.hourly.time || !S.marine.hourly.wave_height) {
      card.style.display = 'none'; return;
    }
    card.style.display = '';
    var Hh = S.marine.hourly, now = Date.now();
    function s(k) { return C.sampleSeries(Hh.time, Hh[k], now); }
    var cells = [];
    if (s('swell_wave_height') != null) cells.push(['Swell', n1(s('swell_wave_height')) + ' <small>m</small>', n0(s('swell_wave_period')) + ' s ' + C.degToCompass(s('swell_wave_direction'))]);
    if (s('wave_height') != null) cells.push(['Total sea', n1(s('wave_height')) + ' <small>m</small>', n0(s('wave_period')) + ' s ' + C.degToCompass(s('wave_direction'))]);
    if (s('wind_wave_height') != null) cells.push(['Wind wave', n1(s('wind_wave_height')) + ' <small>m</small>', 'chop on top']);
    if (s('sea_surface_temperature') != null) cells.push(['Sea temp', n1(s('sea_surface_temperature')) + '°', seaTempNote(s('sea_surface_temperature'))]);
    else cells.push(['Sea temp', '<small>no reading</small>', 'not modelled at this point']);
    if (!cells.length) { card.style.display = 'none'; return; }
    el('marineNote').textContent = 'Open-water point about ' + (S.marineKm ? (22 + S.marineKm) : 22) + ' km off ' + (S.spot ? S.spot.name : 'the spot') + '. Inside a bay or estuary the swell will be smaller than this.';
    el('marineGrid').className = 'grid two';
    el('marineGrid').innerHTML = cells.map(function (c) {
      return '<div class="cell"><div class="k">' + c[0] + '</div><div class="v">' + c[1] + '</div><div class="x">' + c[2] + '</div></div>';
    }).join('');

    /* 7-day swell height line */
    var w = 700, h = 120, pad = 24;
    var T = Hh.time || [], V = Hh.wave_height || [];
    var pts = [];
    for (var i = 0; i < T.length; i++) if (V[i] != null) pts.push([T[i] * 1000, V[i]]);
    if (pts.length < 3) { el('swellChart').innerHTML = ''; return; }
    var t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    var mx = Math.max(1.5, pts.reduce(function (m, p) { return Math.max(m, p[1]); }, 0));
    var X = function (x) { return pad + (x - t0) / (t1 - t0) * (w - pad - 8); };
    var Y = function (v) { return h - 22 - v / mx * (h - 40); };
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
    var lim = S.settings.swellLimit;
    var ticks = '';
    var d0 = A.startOfLocalDay(new Date(t0), TZ).valueOf();
    for (var k = 0; k < 8; k++) {
      var ds = d0 + k * DAY;
      if (ds > t0 && ds < t1) ticks += '<line x1="' + X(ds).toFixed(1) + '" y1="10" x2="' + X(ds).toFixed(1) + '" y2="' + (h - 22) + '" stroke="var(--line)"/>' +
        '<text x="' + (X(ds) + 3).toFixed(1) + '" y="' + (h - 7) + '" font-size="10" fill="var(--ink3)">' + dayName(ds) + '</text>';
    }
    el('swellChart').innerHTML = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:120px">' + ticks +
      '<line x1="' + pad + '" y1="' + Y(lim).toFixed(1) + '" x2="' + (w - 8) + '" y2="' + Y(lim).toFixed(1) + '" stroke="var(--bad)" stroke-dasharray="4 3" stroke-width="1.2"/>' +
      '<text x="' + (w - 10) + '" y="' + (Y(lim) - 4).toFixed(1) + '" font-size="10" fill="var(--bad)" text-anchor="end">your limit ' + n1(lim) + ' m</text>' +
      '<path d="' + path + ' L' + X(t1).toFixed(1) + ' ' + (h - 22) + ' L' + X(t0).toFixed(1) + ' ' + (h - 22) + 'Z" fill="color-mix(in srgb,var(--accent) 13%,transparent)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
      '<text x="2" y="' + (Y(mx) + 9) + '" font-size="10" fill="var(--ink3)">' + n1(mx) + 'm</text></svg>';
  }

  /* ================= TIDES =========================================== */

  function renderTides() {
    if (!S.wx) return;
    var chips = [];
    for (var i = 0; i < 7; i++) {
      var ds = A.addDaysLocal(new Date(), i, TZ).valueOf();
      chips.push('<button class="chip' + (i === S.tideDay ? ' sel' : '') + '" data-d="' + i + '" style="flex:none">' +
        (i === 0 ? 'Today' : dayName(ds) + ' ' + A.parts(new Date(ds), TZ).day) + '</button>');
    }
    var td = el('tideDays');
    td.innerHTML = chips.join('');
    td.onclick = function (e) {
      var b = e.target.closest('button[data-d]'); if (!b) return;
      S.tideDay = +b.dataset.d; renderTides();
    };

    var dayStart = A.addDaysLocal(new Date(), S.tideDay, TZ);
    el('tideTitle').textContent = fFull.format(dayStart);
    var sun = A.sunTimes(dayStart, S.lat, S.lon, TZ);
    var sol = A.solunar(dayStart, S.lat, S.lon, TZ);

    el('tideChart').innerHTML = tideDayChart(dayStart, sun, sol);

    if (S.tide) {
      var ex = C.Tides.extremesForDay(S.tide, dayStart.valueOf());
      el('tideTable').innerHTML = ex.length ? ex.map(function (e) {
        return '<tr><td class="ty">' + (e.type === 'high' ? 'High' : 'Low') + '</td>' +
          '<td class="tm">' + t(e.t) + '</td><td class="hh">' + n1(e.h) + ' m</td></tr>';
      }).join('') : '<tr><td class="muted">No tide data for this day.</td></tr>';
      var port = S.tide.portName || '';
      var off = S.spot && (S.spot.hwOff || S.spot.lwOff) ? ', shifted ' + S.spot.hwOff + ' min for ' + S.spot.name : '';
      el('tideSource').innerHTML = S.tide.source === 'bom'
        ? 'Official Bureau of Meteorology predictions for ' + esc(port) + esc(off) + '.<br>Based on Bureau of Meteorology information that has subsequently been modified. The Bureau does not necessarily support or endorse, or have any connection with, this app. Do not use for navigation.'
        : 'Estimated from a global tide model, referenced to ' + esc(port) + esc(off) + '. Times are usually within about 20 minutes; heights are approximate. ' +
          '<a href="https://www.bom.gov.au/australia/tides/" target="_blank" rel="noopener">Check BOM tide tables</a> before anything that depends on depth.' +
          (S.spot && S.spot.damped ? '<br>' + esc(S.spot.note) : '');
    } else {
      el('tideTable').innerHTML = '<tr><td class="muted">Freshwater spot — no tides.</td></tr>';
      el('tideSource').textContent = '';
    }

    el('solunarList').innerHTML = sol.periods.map(function (p) {
      var strength = p.kind === 'major' ? 3 : 2;
      var moonBoost = sol.illumination.fraction > 0.9 || sol.illumination.fraction < 0.1 ? 1 : 0;
      var stars = '●'.repeat(Math.min(4, strength + moonBoost)) + '○'.repeat(Math.max(0, 4 - strength - moonBoost));
      return '<div class="row" style="padding:9px 0;border-bottom:1px solid var(--line)">' +
        '<div><div style="font-weight:640">' + (p.kind === 'major' ? 'Major' : 'Minor') + ' — ' + esc(p.label) + '</div>' +
        '<div class="muted">' + t(p.start) + ' – ' + t(p.end) + '</div></div>' +
        '<div style="color:var(--accent2);letter-spacing:2px">' + stars + '</div></div>';
    }).join('') + '<div class="muted" style="margin-top:10px">Majors run either side of the moon directly overhead or directly underfoot; minors either side of moonrise and moonset. They matter most when they land on a tide change or on first or last light.</div>';
  }

  function tideDayChart(dayStart, sun, sol) {
    var w = 700, h = 190, padL = 30, padB = 24;
    var t0 = dayStart.valueOf(), t1 = t0 + DAY;
    var X = function (x) { return padL + (x - t0) / DAY * (w - padL - 10); };
    var bands = '';
    if (sun.sunrise) bands += '<rect x="' + X(t0) + '" y="8" width="' + (X(sun.sunrise) - X(t0)) + '" height="' + (h - padB - 8) + '" fill="color-mix(in srgb,var(--ink) 10%,transparent)"/>';
    if (sun.sunset) bands += '<rect x="' + X(sun.sunset) + '" y="8" width="' + (X(t1) - X(sun.sunset)) + '" height="' + (h - padB - 8) + '" fill="color-mix(in srgb,var(--ink) 10%,transparent)"/>';
    sol.periods.forEach(function (p) {
      var a = Math.max(t0, p.start.valueOf()), b = Math.min(t1, p.end.valueOf());
      if (b <= a) return;
      bands += '<rect x="' + X(a).toFixed(1) + '" y="8" width="' + (X(b) - X(a)).toFixed(1) + '" height="' + (h - padB - 8) + '" fill="color-mix(in srgb,var(--accent2) ' + (p.kind === 'major' ? 22 : 12) + '%,transparent)"/>';
    });
    var hours = '';
    for (var hh = 0; hh <= 24; hh += 6) {
      var x = X(t0 + hh * HOUR);
      hours += '<line x1="' + x.toFixed(1) + '" y1="8" x2="' + x.toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--line)"/>' +
        '<text x="' + x.toFixed(1) + '" y="' + (h - 8) + '" font-size="10.5" fill="var(--ink3)" text-anchor="middle">' + (hh === 24 ? '12am' : (hh % 12 === 0 ? 12 : hh % 12) + (hh < 12 ? 'am' : 'pm')) + '</text>';
    }
    if (!S.tide) {
      return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:190px">' + bands + hours +
        '<text x="' + (w / 2) + '" y="' + (h / 2) + '" font-size="13" fill="var(--ink3)" text-anchor="middle">No tide at this spot</text></svg>';
    }
    var pts = [], min = 99, max = -99;
    for (var tt = t0; tt <= t1; tt += 10 * 60000) {
      var v = C.Tides.heightAt(S.tide, tt);
      if (v == null) continue;
      pts.push([tt, v]); min = Math.min(min, v); max = Math.max(max, v);
    }
    if (pts.length < 3) {
      return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:190px">' + bands + hours +
        '<text x="' + (w / 2) + '" y="' + (h / 2) + '" font-size="13" fill="var(--ink3)" text-anchor="middle">Tide data does not reach this day</text></svg>';
    }
    var lo = Math.floor(min * 10) / 10 - 0.1, hi = Math.ceil(max * 10) / 10 + 0.1;
    var Y = function (v) { return 14 + (hi - v) / (hi - lo) * (h - padB - 22); };
    var path = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
    var labels = C.Tides.extremesForDay(S.tide, t0).map(function (e) {
      var x = X(e.t), y = Y(e.h);
      var anchor = x < 60 ? 'start' : x > w - 60 ? 'end' : 'middle';
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.2" fill="var(--accent)"/>' +
        '<text x="' + x.toFixed(1) + '" y="' + (e.type === 'high' ? y - 9 : y + 15).toFixed(1) + '" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="' + anchor + '">' +
        t(e.t) + ' · ' + n1(e.h) + 'm</text>';
    }).join('');
    var nowLine = '';
    if (Date.now() >= t0 && Date.now() <= t1) {
      var nx = X(Date.now());
      nowLine = '<line x1="' + nx.toFixed(1) + '" y1="8" x2="' + nx.toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--accent2)" stroke-width="1.8" stroke-dasharray="4 3"/>';
    }
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:190px">' + bands + hours +
      '<path d="' + path + ' L' + X(pts[pts.length - 1][0]).toFixed(1) + ' ' + (h - padB) + ' L' + X(pts[0][0]).toFixed(1) + ' ' + (h - padB) + 'Z" fill="color-mix(in srgb,var(--accent) 15%,transparent)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2.4"/>' + labels + nowLine +
      '<text x="2" y="' + (Y(hi) + 4).toFixed(1) + '" font-size="10" fill="var(--ink3)">' + n1(hi) + 'm</text>' +
      '<text x="2" y="' + (Y(lo) + 4).toFixed(1) + '" font-size="10" fill="var(--ink3)">' + n1(lo) + 'm</text></svg>';
  }

  /* ================= MAPS ============================================ */

  function bindMaps() {
    el('mapSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-m]'); if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
      S.mapMode = b.dataset.m;
      el('radarPane').style.display = S.mapMode === 'radar' ? '' : 'none';
      el('windPane').style.display = S.mapMode === 'wind' ? '' : 'none';
      el('wavePane').style.display = S.mapMode === 'waves' ? '' : 'none';
      if (S.mapMode === 'wind') setWindy('windyFrame', 'wind');
      if (S.mapMode === 'waves') setWindy('waveFrame', 'waves');
      if (S.mapMode === 'radar' && S.map) S.map.render();
    });
    el('baseSeg').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-b]'); if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
      S.base = b.dataset.b;
      buildMapLayers();
    });
    el('radarSrc').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-rs]'); if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
      S.radarSource = b.dataset.rs; showRadarSource();
    });
    el('bomPlay').addEventListener('click', function () { S.bomPlaying ? bomStop() : bomPlay(); });
    el('bomScrub').addEventListener('input', function () { bomStop(); S.bomFrameIx = +this.value; bomShow(); });
    el('bomRadarPick').addEventListener('change', function () { S.bomRadarId = this.value; bomBuild(); });
    el('playBtn').addEventListener('click', togglePlay);
    el('scrub').addEventListener('input', function () {
      stopPlay(); S.frameIx = +this.value; showFrame();
    });
    el('radarLegend').innerHTML = ['#8ad2ff', '#3fa9f5', '#1e6ed6', '#2fbf4f', '#f5d020', '#f08a1e', '#e0362c', '#a02090']
      .map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('');
  }

  function setWindy(id, overlay) {
    var f = el(id);
    var lat = S.lat.toFixed(3), lon = S.lon.toFixed(3);
    var u = 'https://embed.windy.com/embed2.html?lat=' + lat + '&lon=' + lon +
      '&detailLat=' + lat + '&detailLon=' + lon + '&zoom=8&level=surface&overlay=' + overlay +
      '&menu=&message=&marker=true&calendar=now&pressure=&type=map&location=coordinates&detail=' +
      '&metricWind=kt&metricTemp=%C2%B0C&radarRange=-1';
    if (f.getAttribute('data-src') !== u) { f.setAttribute('data-src', u); f.src = u; }
  }

  function showRadarSource() {
    var haveBom = !!(S.liveRadar && S.liveRadar.radars && Object.keys(S.liveRadar.radars).length);
    if (!haveBom && S.radarSource === 'bom') S.radarSource = 'rv';
    el('bomPane').style.display = S.radarSource === 'bom' ? '' : 'none';
    el('rvPane').style.display = S.radarSource === 'rv' ? '' : 'none';
    Array.prototype.forEach.call(el('radarSrc').children, function (x) { x.classList.toggle('on', x.dataset.rs === S.radarSource); });
    el('radarSrc').children[0].disabled = !haveBom;
    el('radarSrc').children[0].style.opacity = haveBom ? '' : '.4';
    if (S.radarSource === 'bom') bomBuild();
    else { if (S.map) S.map.render(); }
  }

  function bomBuild() {
    var R = S.liveRadar; if (!R || !R.radars) return;
    var ids = Object.keys(R.radars);
    if (!S.bomRadarId || !R.radars[S.bomRadarId]) {
      /* nearest radar to where he is */
      var best = null, bd = 1e9;
      ids.forEach(function (id) {
        var m = D.RADARS[id]; if (!m) return;
        var d = C.haversine(S.lat, S.lon, m.lat, m.lon);
        if (d < bd) { bd = d; best = id; }
      });
      S.bomRadarId = best || ids[0];
    }
    el('bomRadarPick').innerHTML = ids.map(function (id) {
      var m = D.RADARS[id];
      return '<option value="' + id + '"' + (id === S.bomRadarId ? ' selected' : '') + '>' + esc(m ? m.name : id) + ' 128 km</option>';
    }).join('');
    var r = R.radars[S.bomRadarId], base = C.Api.liveBase();
    var stage = el('bomStage');
    var layers = ['background', 'topography', 'locations', 'range'].map(function (l) {
      return r.layers && r.layers[l] ? '<img class="bl" src="' + base + r.layers[l] + '" alt="">' : '';
    }).join('');
    var frames = (r.frames || []).map(function (f, i) {
      return '<img class="bf" data-i="' + i + '" src="' + base + f.file + '" alt="" style="opacity:0">';
    }).join('');
    /* he is here: BOM 128 km images are 512 px across 256 km, north up */
    var dot = '';
    var m = D.RADARS[S.bomRadarId];
    if (m) {
      var dy = (S.lat - m.lat) * 111.2, dx = (S.lon - m.lon) * 111.2 * Math.cos(m.lat * Math.PI / 180);
      var px = 50 + dx / 256 * 100, py = 50 - dy / 256 * 100;
      if (px > 2 && px < 98 && py > 2 && py < 98) dot = '<div class="bdot" style="left:' + px.toFixed(1) + '%;top:' + py.toFixed(1) + '%"></div>';
    }
    stage.innerHTML = layers + frames + dot +
      (r.layers && r.layers.legend ? '<img class="blegend" src="' + base + r.layers.legend + '" alt="">' : '');
    el('bomScrub').max = String(Math.max(0, (r.frames || []).length - 1));
    S.bomFrameIx = Math.max(0, (r.frames || []).length - 1);
    el('bomMeta').textContent = 'Bureau of Meteorology ' + (m ? m.name : S.bomRadarId) + ' radar · frames every ' +
      (r.stepMin || 6) + ' min · pulled ' + (R.fetched ? Math.round((Date.now() - R.fetched * 1000) / 60000) + ' min ago' : 'recently') +
      '. Refreshes every 10 minutes.';
    bomShow(); bomPlay();
  }

  function bomShow() {
    var r = S.liveRadar && S.liveRadar.radars[S.bomRadarId]; if (!r) return;
    var imgs = el('bomStage').querySelectorAll('.bf');
    Array.prototype.forEach.call(imgs, function (im, i) { im.style.opacity = i === S.bomFrameIx ? 1 : 0; });
    el('bomScrub').value = String(S.bomFrameIx);
    var f = r.frames[S.bomFrameIx];
    el('bomTime').textContent = f ? t(f.time * 1000) : '—';
  }
  function bomPlay() {
    S.bomPlaying = true; clearInterval(S.bomTimer);
    el('bomPlay').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/></svg>';
    S.bomTimer = setInterval(function () {
      var r = S.liveRadar && S.liveRadar.radars[S.bomRadarId]; if (!r || !r.frames.length) return;
      S.bomFrameIx = (S.bomFrameIx + 1) % r.frames.length; bomShow();
    }, S.bomFrameIx === (S.liveRadar.radars[S.bomRadarId].frames.length - 1) ? 1400 : 700);
  }
  function bomStop() {
    S.bomPlaying = false; clearInterval(S.bomTimer);
    el('bomPlay').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/></svg>';
  }

  function initRadar() {
    showRadarSource();
    if (!S.map) {
      S.map = new MiniMap(el('map'), { lat: S.lat, lon: S.lon, zoom: 8, minZoom: 4, maxZoom: 12 });
      buildMapLayers();
    }
    S.map.setMarkers([{ lat: S.lat, lon: S.lon, cls: S.gpsFix ? 'me' : '' }]);
    if (S.mapSpot !== (S.spot ? S.spot.id : -1) || !S.mapCentred) {
      S.map.setView(S.lat, S.lon, S.map.z);
      S.mapSpot = S.spot ? S.spot.id : -1;
      S.mapCentred = true;
    }
    if (!S.frames.length) loadRadar();
  }

  function buildMapLayers() {
    if (!S.map) return;
    S.map.clearLayers();
    var bm = MiniMap.Basemaps[S.base];
    S.map.addLayer({ url: bm.url, maxNativeZoom: bm.maxNativeZoom, opacity: 1 });
    el('mapAttr').textContent = bm.attribution + (S.frames.length ? ' · Radar © RainViewer' : '');
    S.radarLayers = [];
    S.frames.forEach(function (fr, i) {
      var L = S.map.addLayer({
        url: function (z, x, y) { return S.radarHost + fr.path + '/256/' + z + '/' + x + '/' + y + '/4/1_1.png'; },
        maxNativeZoom: 7, opacity: 0, visible: true
      });
      S.radarLayers.push(L);
    });
    showFrame();
  }

  function loadRadar() {
    C.Api.radarIndex().then(function (j) {
      S.radarHost = j.host;
      var past = (j.radar && j.radar.past) || [];
      var now = (j.radar && j.radar.nowcast) || [];
      S.frames = past.slice(-8).concat(now.slice(0, 2));
      S.pastCount = Math.min(8, past.length);
      S.frameIx = Math.max(0, S.pastCount - 1);
      el('scrub').max = String(Math.max(0, S.frames.length - 1));
      el('scrub').value = String(S.frameIx);
      buildMapLayers();
      startPlay();
    }).catch(function () {
      el('mapTime').textContent = 'offline';
    });
  }

  function showFrame() {
    if (!S.radarLayers || !S.frames.length) return;
    S.radarLayers.forEach(function (L, i) {
      L.node.style.opacity = i === S.frameIx ? 0.72 : 0;
    });
    var fr = S.frames[S.frameIx];
    el('scrub').value = String(S.frameIx);
    var future = S.frameIx >= S.pastCount;
    el('mapTime').innerHTML = t(fr.time * 1000) + (future ? '<br><span class="muted" style="font-size:10px">forecast</span>' : '');
  }

  function startPlay() {
    S.playing = true;
    el('playBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/></svg>';
    clearInterval(S.timer);
    S.timer = setInterval(function () {
      S.frameIx = (S.frameIx + 1) % S.frames.length;
      showFrame();
    }, 620);
  }
  function stopPlay() {
    S.playing = false; clearInterval(S.timer);
    el('playBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/></svg>';
  }
  function togglePlay() { S.playing ? stopPlay() : startPlay(); }

  function renderBomLinks() {
    var sp = S.spot; if (!sp) return;
    var r = D.RADARS[sp.radar];
    var out = [];
    if (r) {
      out.push(['128 km radar loop — ' + r.name, 'https://www.bom.gov.au/products/' + r.base + '3.loop.shtml', 'BOM']);
      out.push(['256 km radar loop — ' + r.name, 'https://www.bom.gov.au/products/' + r.base + '2.loop.shtml', 'BOM']);
    }
    if (sp.district) out.push(['Coastal waters forecast — ' + D.DISTRICTS[sp.district], 'https://www.bom.gov.au/nsw/forecasts/coastalwaters.shtml', 'BOM']);
    out.push(['NSW marine wind warnings', 'https://www.bom.gov.au/nsw/warnings/', 'BOM']);
    out.push(['NSW tide tables', 'https://www.bom.gov.au/australia/tides/', 'BOM']);
    out.push(['MetEye detailed forecast', 'https://www.bom.gov.au/australia/meteye/', 'BOM']);
    el('bomLinks').innerHTML = out.map(function (l) {
      return '<a href="' + l[1] + '" target="_blank" rel="noopener">' + esc(l[0]) + '<span>' + l[2] + ' ↗</span></a>';
    }).join('');
  }

  /* ================= FISH ============================================ */

  var fishFilter = 'now', fishQuery = '';

  function bindFish() {
    var filters = [['now', 'On now'], ['all', 'Everything'], ['e', 'Estuary'], ['b', 'Beach'], ['r', 'Rock'], ['o', 'Offshore'], ['f', 'Freshwater']];
    el('fishFilters').innerHTML = filters.map(function (f) {
      return '<button class="chip' + (f[0] === fishFilter ? ' sel' : '') + '" data-f="' + f[0] + '">' + f[1] + '</button>';
    }).join('');
    el('fishFilters').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-f]'); if (!b) return;
      fishFilter = b.dataset.f;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('sel', x === b); });
      renderFish();
    });
    el('fishSearch').addEventListener('input', function () { fishQuery = this.value.toLowerCase(); renderFish(); });
  }

  function renderFish() {
    var m = A.parts(new Date(), TZ).month - 1;
    var list = D.SPECIES.filter(function (s) {
      if (fishQuery) {
        var hay = (s.n + ' ' + s.aka + ' ' + s.baits.join(' ') + ' ' + s.lures.join(' ') + ' ' + s.where).toLowerCase();
        if (hay.indexOf(fishQuery) < 0) return false;
      }
      if (fishFilter === 'all') return true;
      if (fishFilter === 'now') return s.season[m] === 2;
      return s.cat === fishFilter;
    });
    if (fishFilter === 'now') list.sort(function (a, b) { return a.n.localeCompare(b.n); });

    var legend = '<div class="row" style="margin-bottom:8px"><span class="muted">' +
      (fishFilter === 'now' ? 'Running now in NSW' : list.length + ' species') +
      '</span><span class="monthkey">' + ['J','F','M','A','M','J','J','A','S','O','N','D'].map(function (mm, ix) {
        return '<i' + (ix === m ? ' class="on"' : '') + '>' + mm + '</i>';
      }).join('') + '</span></div>';
    el('fishList').innerHTML = list.length ? legend + list.map(function (s, i) {
      var heat = s.season.map(function (v, ix) {
        return '<i class="l' + v + (ix === m ? ' now' : '') + '"></i>';
      }).join('');
      var legal = s.protected ? 'No-take' : (s.min ? s.min + ' cm min' : 'no size limit');
      return '<button class="spc" data-s="' + esc(s.n) + '">' +
        '<div><div class="nm">' + esc(s.n) + (s.closed ? ' <span class="chip neg" style="padding:2px 7px">closed</span>' : '') + '</div>' +
        '<div class="mt">' + esc(legal) + ' · ' + esc(String(s.bag).split('(')[0].trim()) + '</div></div>' +
        '<div class="heat">' + heat + '</div></button>';
    }).join('') : '<div class="empty">Nothing matches. Try “Everything”.</div>';

    el('fishList').onclick = function (e) {
      var b = e.target.closest('button[data-s]'); if (!b) return;
      openSpecies(b.dataset.s);
    };
  }

  function openSpecies(name) {
    var s = D.SPECIES.filter(function (x) { return x.n === name; })[0];
    if (!s) return;
    var m = A.parts(new Date(), TZ).month - 1;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var heat = '<div style="display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin:10px 0">' +
      s.season.map(function (v, i) {
        return '<div style="text-align:center"><div class="l' + v + (i === m ? ' now' : '') + '" style="height:26px;border-radius:5px;background:' +
          (v === 2 ? 'var(--accent)' : v === 1 ? 'color-mix(in srgb,var(--accent) 35%,transparent)' : 'var(--card2)') +
          (i === m ? ';outline:2px solid var(--accent2);outline-offset:1px' : '') + '"></div>' +
          '<div style="font-size:9px;color:var(--ink3);margin-top:3px">' + months[i][0] + '</div></div>';
      }).join('') + '</div>';

    var body = '<h3>' + esc(s.n) + '</h3><div class="sub">' + esc(s.aka) + '</div>' +
      (s.closed ? '<div class="banner warn"><b>Closed season</b>' + esc(s.closed) + '</div>' : '') +
      (s.protected ? '<div class="banner warn"><b>No-take species</b>Release it, unharmed, straight away.</div>' : '') +
      heat +
      '<p style="font-size:14.5px;line-height:1.5;margin:12px 0">' + esc(s.run) + '</p>' +
      '<dl class="kv">' +
      '<dt>Legal size</dt><dd>' + (s.min ? s.min + ' cm minimum' : 'No size limit') + (s.max ? ', ' + s.max + ' cm maximum' : '') + '</dd>' +
      '<dt>Bag limit</dt><dd>' + esc(String(s.bag)) + '</dd>' +
      '<dt>Best tide</dt><dd>' + esc(s.tide) + '</dd>' +
      '<dt>Best time</dt><dd>' + esc(s.time) + '</dd>' +
      '<dt>Water temp</dt><dd>' + s.temp[0] + '–' + s.temp[1] + ' °C' + sstVerdict(s) + '</dd>' +
      (s.baits.length ? '<dt>Baits</dt><dd>' + esc(s.baits.join(', ')) + '</dd>' : '') +
      (s.lures.length ? '<dt>Lures</dt><dd>' + esc(s.lures.join(', ')) + '</dd>' : '') +
      '<dt>Where</dt><dd>' + esc(s.where) + '</dd>' +
      '</dl>' +
      '<button class="btn" id="pickSpecies">Chase ' + esc(s.n.toLowerCase()) + ' — score my conditions</button>' +
      '<div class="footnote" style="margin-top:12px">Limits checked against NSW DPIRD, ' + D.RULES.asAt + '. Rules change — check the official tables before you keep a fish.</div>';
    openSheet(body);
    var btn = el('pickSpecies');
    if (btn) btn.addEventListener('click', function () {
      var arr = S.settings.species.filter(function (x) { return x !== s.n; });
      arr.unshift(s.n);
      S.settings = C.Store.saveSettings({ species: arr.slice(0, 4) });
      closeSheet(); computeScores(); renderAll(); showView('now');
    });
  }

  function sstVerdict(s) {
    if (!S.detail || S.detail.sst == null) return '';
    var v = S.detail.sst;
    if (v >= s.temp[0] && v <= s.temp[1]) return ' — water is ' + n1(v) + ' °C, right in range';
    return ' — water is ' + n1(v) + ' °C, ' + (v < s.temp[0] ? 'too cold' : 'too warm');
  }

  function renderRuleLinks() {
    var R = D.RULES;
    el('ruleLinks').innerHTML = [
      ['Buy or check your fishing licence', R.fee.url, '$' + R.fee.d3 + ' 3-day · $' + R.fee.y1 + ' a year'],
      ['Saltwater bag &amp; size limits', R.links.rules, 'NSW DPIRD'],
      ['Freshwater bag &amp; size limits', R.links.freshRules, 'NSW DPIRD'],
      ['Closures &amp; marine park zoning map', R.links.map, 'FishSmart'],
      ['Rock fishing lifejacket law', R.lifejacket.url, '$' + R.lifejacket.penalty + ' fine in declared areas']
    ].map(function (l) {
      return '<a href="' + l[1] + '" target="_blank" rel="noopener">' + l[0] + '<span>' + l[2] + ' ↗</span></a>';
    }).join('');
  }

  /* ================= SETTINGS & LOG ================================== */

  function bindSettings() {
    el('setName').addEventListener('change', function () {
      S.settings = C.Store.saveSettings({ name: this.value.trim() }); renderNow();
    });
    seg('accessSeg', 'a', function (v) { S.settings = C.Store.saveSettings({ access: v }); computeScores(); renderAll(); });
    seg('gpsSeg', 'g', function (v) {
      S.settings = C.Store.saveSettings({ useGps: v === '1' });
      if (v === '1') locate(true);
    });
    seg('modelSeg', 'md', function (v) { S.settings = C.Store.saveSettings({ model: v }); load(true); });
    seg('themeSeg', 't', function (v) { S.settings = C.Store.saveSettings({ theme: v }); applyTheme(); });
    seg('learnSeg', 'l', function (v) { S.settings = C.Store.saveSettings({ learn: v === '1' }); computeScores(); renderAll(); });
    el('resetWeights').addEventListener('click', function () {
      S.settings = C.Store.saveSettings({ weights: {} }); computeScores(); renderAll();
    });
    el('windLim').addEventListener('input', function () {
      el('windLimVal').textContent = this.value;
      S.settings = C.Store.saveSettings({ windLimit: +this.value });
    });
    el('windLim').addEventListener('change', function () { computeScores(); renderAll(); });
    el('swellLim').addEventListener('input', function () {
      el('swellLimVal').textContent = (+this.value).toFixed(1);
      S.settings = C.Store.saveSettings({ swellLimit: +this.value });
    });
    el('swellLim').addEventListener('change', function () { computeScores(); renderAll(); });
  }

  function seg(id, key, fn) {
    var node = el(id);
    node.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-' + key + ']'); if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
      fn(b.dataset[key]);
    });
  }
  function setSeg(id, key, val) {
    Array.prototype.forEach.call(el(id).children, function (x) { x.classList.toggle('on', x.dataset[key] === String(val)); });
  }

  function renderSettings() {
    el('setName').value = S.settings.name;
    setSeg('accessSeg', 'a', S.settings.access);
    setSeg('gpsSeg', 'g', S.settings.useGps ? '1' : '0');
    setSeg('modelSeg', 'md', S.settings.model);
    setSeg('themeSeg', 't', S.settings.theme);
    el('windLim').value = S.settings.windLimit; el('windLimVal').textContent = S.settings.windLimit;
    el('swellLim').value = S.settings.swellLimit; el('swellLimVal').textContent = (+S.settings.swellLimit).toFixed(1);

    renderWeights();
    el('speciesPick').innerHTML = D.SPECIES.map(function (s) {
      var on = S.settings.species.indexOf(s.n) >= 0;
      return '<button class="chip' + (on ? ' sel' : '') + '" data-sp="' + esc(s.n) + '">' + esc(s.n) + '</button>';
    }).join('');
    el('speciesPick').onclick = function (e) {
      var b = e.target.closest('button[data-sp]'); if (!b) return;
      var n = b.dataset.sp, arr = S.settings.species.slice();
      var i = arr.indexOf(n);
      if (i >= 0) arr.splice(i, 1); else arr.unshift(n);
      S.settings = C.Store.saveSettings({ species: arr.slice(0, 4) });
      renderSettings(); computeScores(); renderNow();
    };
    renderLog();
  }

  var FACTOR_NAMES = { wind: 'Wind', pressure: 'Barometer', light: 'Dawn & dusk', solunar: 'Moon timing',
    tide: 'Tide', swell: 'Swell', cloud: 'Cloud & rain', sst: 'Water temp' };

  function renderWeights() {
    var W = S.settings.weights || {}, L = S.learned || { ready: false, mult: {} };
    el('weightList').innerHTML = Object.keys(FACTOR_NAMES).map(function (k) {
      var v = W[k] != null ? W[k] : 1;
      var learned = L.mult[k] != null && Math.abs(L.mult[k] - 1) > 0.02 ? ' <span class="muted">· log says ×' + L.mult[k].toFixed(2) + '</span>' : '';
      return '<div class="field" style="margin-bottom:8px"><label>' + FACTOR_NAMES[k] + ' — <b id="wv_' + k + '">×' + v.toFixed(2) + '</b>' + learned + '</label>' +
        '<input type="range" data-w="' + k + '" min="0.5" max="1.5" step="0.05" value="' + v + '"></div>';
    }).join('');
    el('weightList').oninput = function (e) {
      var r = e.target.closest('input[data-w]'); if (!r) return;
      el('wv_' + r.dataset.w).textContent = '×' + (+r.value).toFixed(2);
      var w = S.settings.weights || {}; w[r.dataset.w] = +r.value;
      S.settings = C.Store.saveSettings({ weights: w });
    };
    el('weightList').onchange = function () { computeScores(); renderAll(); };
    el('learnNote').innerHTML = L.ready
      ? 'Learned from ' + L.n + ' logged catches' + (L.notes.length ? ': ' + esc(L.notes.join(', ')) + '.' : '. Nothing stands out yet.')
      : 'Log ' + Math.max(0, 6 - (L.n || 0)) + ' more catches and the app starts weighting what actually produces for you.';
    setSeg('learnSeg', 'l', S.settings.learn ? '1' : '0');
  }

  function renderLog() {
    var l = C.Store.log();
    el('logList').innerHTML = l.length ? l.slice(0, 12).map(function (e) {
      return '<div class="logitem"><div><div>' + esc(e.species) + (e.length ? ' · ' + e.length + ' cm' : '') + '</div>' +
        '<div class="lm">' + esc(e.spot) + ' · ' + fDate.format(new Date(e.t)) + ' ' + t(e.t) +
        (e.tide ? ' · ' + esc(e.tide) : '') + (e.wind != null ? ' · ' + n0(e.wind) + ' kt' : '') + '</div></div>' +
        '<button class="chip" data-del="' + e.id + '">✕</button></div>';
    }).join('') : '<div class="empty">No catches logged yet. Every one you log records the tide, wind, moon and barometer with it.</div>';
    el('logList').onclick = function (e) {
      var b = e.target.closest('button[data-del]'); if (!b) return;
      C.Store.removeCatch(b.dataset.del); renderLog();
    };
    el('logInsight').innerHTML = logInsight(l);
  }

  function logInsight(l) {
    if (l.length < 4) return '';
    var runIn = 0, runOut = 0, lowWind = 0, inMoon = 0, lowLight = 0;
    l.forEach(function (e) {
      if (e.tide === 'Running in') runIn++;
      if (e.tide === 'Running out') runOut++;
      if (e.wind != null && e.wind < 12) lowWind++;
      if (e.moonPeriod) inMoon++;
      if (e.lowLight) lowLight++;
    });
    var bits = [];
    if (runIn || runOut) bits.push((runIn >= runOut ? runIn + ' on a run-in tide' : runOut + ' on a run-out tide'));
    if (lowWind) bits.push(lowWind + ' with wind under 12 kt');
    if (inMoon) bits.push(inMoon + ' inside a moon period');
    if (lowLight) bits.push(lowLight + ' at first or last light');
    return '<div class="banner info" style="margin-top:12px"><b>Your ' + l.length + ' logged catches</b>' + bits.join(' · ') + '</div>';
  }

  function openCatchForm() {
    var opts = D.SPECIES.map(function (s) { return '<option>' + esc(s.n) + '</option>'; }).join('');
    var st = S.tide ? C.Tides.state(S.tide, Date.now()) : null;
    openSheet('<h3>Log a catch</h3><div class="sub">Conditions are saved with it automatically.</div>' +
      '<div class="field"><label>Species</label><select id="cSpecies">' + opts + '</select></div>' +
      '<div class="field"><label>Length (cm) — optional</label><input type="number" id="cLen" inputmode="numeric" placeholder="e.g. 42"></div>' +
      '<div class="field"><label>Notes — optional</label><input type="text" id="cNote" placeholder="Bait, spot, what it took"></div>' +
      '<div class="muted" style="margin-bottom:12px">Recording: ' + esc(S.spot ? S.spot.name : '') +
      (st ? ' · ' + (st.rising ? 'running in' : 'running out') : '') +
      (S.detail && S.detail.wind != null ? ' · ' + n0(S.detail.wind) + ' kt ' + C.degToCompass(S.detail.dir) : '') +
      (S.detail && S.detail.pressure != null ? ' · ' + n0(S.detail.pressure) + ' hPa' : '') + '</div>' +
      '<button class="btn" id="cSave">Save catch</button>');
    if (S.settings.species[0]) el('cSpecies').value = S.settings.species[0];
    el('cSave').addEventListener('click', function () {
      var moonNow = S.sol ? A.solunarStrength(new Date(), S.sol.periods) > 0.2 : false;
      var lowLight = false;
      if (S.sun && S.sun.sunrise && S.sun.sunset) {
        var m = Math.min(Math.abs(Date.now() - S.sun.sunrise.valueOf()), Math.abs(Date.now() - S.sun.sunset.valueOf())) / 60000;
        lowLight = m < 90;
      }
      C.Store.addCatch({
        id: String(Date.now()), t: Date.now(),
        species: el('cSpecies').value,
        length: el('cLen').value ? +el('cLen').value : null,
        note: el('cNote').value,
        spot: S.spot ? S.spot.name : '',
        tide: st ? (st.rising ? 'Running in' : 'Running out') : null,
        tideHeight: st ? Math.round(st.height * 100) / 100 : null,
        wind: S.detail ? Math.round(S.detail.wind) : null,
        windDir: S.detail ? Math.round(S.detail.dir) : null,
        pressure: S.detail ? Math.round(S.detail.pressure) : null,
        sst: S.detail && S.detail.sst != null ? Math.round(S.detail.sst * 10) / 10 : null,
        moon: S.sol ? Math.round(S.sol.illumination.fraction * 100) : null,
        moonPeriod: moonNow, lowLight: lowLight,
        score: S.detail ? S.detail.score : null,
        parts: S.detail ? S.detail.parts.map(function (p) { return { key: p.key, f: Math.round(p.f * 100) / 100 }; }) : null
      });
      closeSheet(); renderLog();
      alertBanner('Catch logged.', 'info');
    });
  }

  function dataStatus() {
    var rows = [];
    function row(name, ok, text) { rows.push({ name: name, ok: ok, text: text }); }
    if (S.wx) {
      var cov = Math.round(C.coverage(S.wx.hourly.time, S.wx.hourly.temperature_2m, 168) * 100);
      row('Forecast', cov > 80 ? 'ok' : 'warn', (S.fellBack ? 'Multi-model blend — BOM ACCESS-G was not returning data' : (S.settings.model === 'bom_access_global' ? 'BOM ACCESS-G' : 'Multi-model blend')) +
        ' · ' + cov + '% of the next 7 days filled' + (S.stale ? ' · showing an older download' : ''));
    } else row('Forecast', 'bad', 'Nothing downloaded' + (S.lastError ? ' — ' + esc(String(S.lastError.message || S.lastError)) : ''));
    if (S.spot && S.spot.sea) {
      if (S.marine && S.marine.hourly && S.marine.hourly.wave_height) {
        var mc = Math.round(C.coverage(S.marine.hourly.time, S.marine.hourly.wave_height, 168) * 100);
        var sc = Math.round(C.coverage(S.marine.hourly.time, S.marine.hourly.sea_surface_temperature, 48) * 100);
        row('Sea state', mc > 60 ? 'ok' : 'warn', 'Swell ' + mc + '% filled' + (S.marineKm ? ' · had to step ' + S.marineKm + ' km further offshore to find open water' : ''));
        row('Water temp', sc > 60 ? 'ok' : 'warn', sc > 60 ? 'Sea surface temperature available' : 'Not modelled at this point — the cell shows no reading');
      } else { row('Sea state', 'bad', 'No wave data came back for this coast'); }
    } else row('Sea state', 'ok', 'Not applicable — inland or sheltered water');
    if (S.tide) row('Tides', S.tide.source === 'bom' ? 'ok' : 'warn', S.tide.source === 'bom' ? 'Official BOM predictions for ' + S.tide.portName : 'Model estimate — the two-hourly BOM job has not written tides yet');
    else if (S.spot && S.spot.port) row('Tides', 'bad', 'No tide data');
    row('BOM text', S.bom && S.bom.coastal && Object.keys(S.bom.coastal).length ? 'ok' : 'warn',
      S.bom && S.bom.coastal && Object.keys(S.bom.coastal).length ? 'Coastal waters forecast issued ' + esc(S.bom.updated || '') : 'Not fetched yet — run “Update BOM data” in GitHub Actions');
    if (S.obs) row('Station', S.obs.ageMin != null && S.obs.ageMin < 90 ? 'ok' : 'warn', esc(S.obs.name) + ' · ' + S.obs.km + ' km · ' + (S.obs.ageMin != null ? S.obs.ageMin + ' min old' : 'age unknown'));
    else row('Station', 'warn', S.live ? 'No BOM station within 45 km yet — the feed maps more stations every 10 min' : 'Live feed not reachable');
    var nR = S.liveRadar && S.liveRadar.radars ? Object.keys(S.liveRadar.radars).length : 0;
    row('BOM radar', nR ? 'ok' : 'warn', nR ? nR + ' radars · pulled ' + Math.round((Date.now() - S.liveRadar.fetched * 1000) / 60000) + ' min ago' : 'No frames yet — run “Live BOM feed” in GitHub Actions');
    row('Confidence', S.spread ? 'ok' : 'warn', S.spread ? S.spread.members + '-member ensemble' : 'Ensemble not available — windows show no confidence tag');
    return rows;
  }

  function renderStatus() {
    var rows = dataStatus();
    var dot = { ok: 'var(--great)', warn: 'var(--ok)', bad: 'var(--bad)' };
    el('dataStatus').innerHTML = rows.map(function (r) {
      return '<div class="row" style="padding:8px 0;border-bottom:1px solid var(--line);align-items:flex-start">' +
        '<div style="display:flex;gap:8px;align-items:flex-start"><span style="width:9px;height:9px;border-radius:50%;background:' + dot[r.ok] + ';margin-top:6px;flex:none"></span>' +
        '<div><div style="font-weight:640;font-size:14px">' + r.name + '</div><div class="muted">' + r.text + '</div></div></div></div>';
    }).join('') + '<div class="muted" style="margin-top:8px">Pulled ' + (S.wxAt ? t(S.wxAt) : '—') + '. Tap the refresh button up top to fetch again.</div>';
    var bad = rows.filter(function (r) { return r.ok !== 'ok'; });
    el('statusHint').style.display = bad.length ? '' : 'none';
    el('statusHint').textContent = bad.length ? bad.length + ' data feed' + (bad.length > 1 ? 's' : '') + ' degraded — see Data status in settings' : '';
  }

  function renderAbout() {
    var R = D.RULES;
    el('about').innerHTML =
      '<p><b>Where the numbers come from.</b> Forecast from the Bureau of Meteorology ACCESS-G model (or a multi-model blend if you switch it), served through Open-Meteo. Swell, sea state and water temperature from Open-Meteo Marine. Rain radar from RainViewer, which ingests BOM radar. Wind and swell maps by Windy. Tides are official BOM predictions when the repository has them, otherwise a global tide model estimate. Sun, moon and feeding times are calculated on your phone.</p>' +
      '<p><b>Bureau of Meteorology.</b> This product is based on Bureau of Meteorology information that has subsequently been modified. The Bureau does not necessarily support or endorse, or have any connection with, the product.</p>' +
      '<p><b>Fishing rules</b> checked against NSW DPIRD, ' + esc(R.asAt) + '. They change — the official tables win. Report illegal fishing on 1800 043 536.</p>' +
      '<p><b>Not for navigation.</b> Tide heights and swell figures are guidance, not depth or safety data. Rock fishing kills people in NSW every year: wear a lifejacket, watch the sea for ten minutes before you climb down, and never fish alone.</p>' +
      '<p><b>Dawson&rsquo;s Fish Finder Pro.</b> Everything you enter stays on this phone.</p>';
  }

  /* ================= sheet & spot picker ============================= */

  function openSheet(html) {
    el('sheetBody').innerHTML = html;
    el('sheet').classList.add('on'); el('sheetBg').classList.add('on');
    el('sheet').scrollTop = 0;
  }
  function closeSheet() { el('sheet').classList.remove('on'); el('sheetBg').classList.remove('on'); }

  function openSpotPicker() {
    var groups = {}, order = [];
    D.SPOTS.forEach(function (s) {
      if (!groups[s.region]) { groups[s.region] = []; order.push(s.region); }
      groups[s.region].push(s);
    });
    var html = '<h3>Pick a spot</h3><div class="sub">Or tap the target icon up top to use your location.</div>' +
      '<div class="field"><input type="text" id="spotSearch" placeholder="Search spots" autocomplete="off"></div>' +
      '<div id="spotResults">' + order.map(function (r) {
        return '<div class="groupname">' + esc(r) + '</div><div class="spotlist">' + groups[r].map(function (s) {
          return '<button data-id="' + s.id + '"' + (S.spot && s.id === S.spot.id ? ' class="on"' : '') + '>' + esc(s.name) +
            '<div class="r">' + s.kinds.map(function (k) { return D.KIND_NAME[k]; }).join(' · ') + '</div></button>';
        }).join('') + '</div>';
      }).join('') + '</div>' +
      '<div class="footnote" style="margin-top:16px">Settings, catch log and licence links live under the gear below.</div>' +
      '<button class="btn ghost" id="toSettings" style="margin-top:10px">Settings &amp; catch log</button>';
    openSheet(html);
    el('spotResults').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      C.Store.saveSettings({ useGps: false });
      S.settings = C.Store.settings();
      setSpot(+b.dataset.id); closeSheet();
    });
    el('toSettings').addEventListener('click', function () { closeSheet(); showView('me'); });
    el('spotSearch').addEventListener('input', function () {
      var q = this.value.toLowerCase();
      Array.prototype.forEach.call(el('spotResults').querySelectorAll('.spotlist button'), function (b) {
        b.style.display = b.textContent.toLowerCase().indexOf(q) >= 0 ? '' : 'none';
      });
      Array.prototype.forEach.call(el('spotResults').querySelectorAll('.groupname'), function (g) {
        var list = g.nextElementSibling;
        var any = Array.prototype.some.call(list.children, function (b) { return b.style.display !== 'none'; });
        g.style.display = any ? '' : 'none'; list.style.display = any ? '' : 'none';
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
