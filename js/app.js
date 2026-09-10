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
  /* wind is stored in knots everywhere; only the display converts */
  function ago(min) { if (min == null) return 'recently'; if (min < 1) return 'just now'; if (min < 90) return min + ' min ago'; if (min < 48 * 60) return (Math.round(min / 6) / 10) + ' h ago'; return Math.round(min / 1440) + ' d ago'; }
  function wv(kt) { return kt == null ? '—' : String(Math.round(S.settings.unitsWind === 'kmh' ? kt * 1.852 : kt)); }
  function wu() { return S.settings.unitsWind === 'kmh' ? 'km/h' : 'kt'; }

  /* night-aware weather glyph */
  function wxIcon(code, isNight) {
    var w = WMO[code] || ['—', '•'];
    if (!isNight) return w[1];
    if (code === 0) return '🌙';
    if (code === 1 || code === 2) return '☁️';
    return w[1];
  }

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
    document.documentElement.classList.toggle('big', S.settings.textSize === 'large');
  }

  function init() {
    applyTheme();
    bindTabs(); bindSettings(); bindMaps(); bindFish();
    el('spotBtn').addEventListener('click', openSpotPicker);
    el('gpsBtn').addEventListener('click', function () { locate(true); });
    el('gearBtn').addEventListener('click', function () { showView('me'); });
    window.addEventListener('online', function () { load(true); });
    bindSheetSwipe();
    if (!C.Store._get('nf.onboarded', false)) setTimeout(openWelcome, 600);
    el('refreshBtn').addEventListener('click', function () { load(true); });
    el('fab').addEventListener('click', function () { openCatchForm(); });
    el('addCatchBtn').addEventListener('click', function () { openCatchForm(); });
    el('sheetBg').addEventListener('click', closeSheet);
    el('sheetClose').addEventListener('click', closeSheet);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
    el('shareBtn').addEventListener('click', shareConditions);
    el('noteBtn').addEventListener('click', function () {
      var c = el('noteCard'); c.style.display = '';
      c.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { el('spotNote').focus(); }, 350);
    });
    el('spotNote').addEventListener('input', function () {
      var id = S.spot ? S.spot.id : null; if (id == null) return;
      clearTimeout(S.noteTimer);
      var v = this.value;
      S.noteTimer = setTimeout(function () { C.Store.setNote(id, v.trim()); el('noteMeta').textContent = v.trim() ? 'Saved on this phone.' : ''; }, 400);
    });
    el('installDone').addEventListener('click', function () { C.Store._set('nf.installHintDone', true); el('installCard').style.display = 'none'; });
    el('blankBtn').addEventListener('click', function () { openCatchForm(null, true); });
    el('shareLogBtn').addEventListener('click', shareLog);
    el('wipeBtn').addEventListener('click', wipeApp);
    el('backupBtn').addEventListener('click', backup);
    el('restoreBtn').addEventListener('click', restore);
    window.DFFP = { S: S, planDay: planDay, bestBets: function () { return S.bets; }, recompute: function () { computeScores(); renderAll(); } };
    bindPullToRefresh();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden || !S.wx) return;
      if (S.wxAt && Date.now() - S.wxAt > 20 * 60000) load(true);
      else { computeScores(); renderNow(); }
    });
    renderRuleLinks(); renderAbout(); installHint();
    setSpot(S.settings.spot, true);
    var lastTab = C.Store._get('nf.tab', 'now');
    if (lastTab && lastTab !== 'now' && lastTab !== 'me') setTimeout(function () { showView(lastTab); }, 0);
    load(false);
    if (S.settings.useGps) locate(false);
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
    setInterval(function () { if (S.wx) { computeScores(); renderNow(); } }, 5 * 60000);
    setInterval(function () {
      if (el('v-maps').classList.contains('on') && S.radarSource === 'bom' && S.liveRadar) bomBuild();
    }, 5 * 60000);
  }

  function bindTabs() {
    var tabs = el('tabs');
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      if (b.classList.contains('on') && el('v-' + b.dataset.v).classList.contains('on')) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
      C.Store._set('nf.tab', b.dataset.v);
      Array.prototype.forEach.call(tabs.children, function (x) { x.classList.toggle('on', x === b); });
      ['now', 'forecast', 'tides', 'maps', 'fish', 'lb', 'me'].forEach(function (v) {
        var node = el('v-' + v); if (node) node.classList.toggle('on', v === b.dataset.v);
      });
      el('fab').style.display = b.dataset.v === 'now' ? '' : 'none';
      window.scrollTo(0, 0);
      if (b.dataset.v === 'maps') syncMaps();
      if (b.dataset.v === 'tides') renderTides();
    });
    /* the settings pane has no tab of its own — the gear opens it */
    el('spotBtn').addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function showView(v) {
    var b = document.querySelector('#tabs button[data-v="' + v + '"]');
    if (b) b.click();
    else {
      ['now', 'forecast', 'tides', 'maps', 'fish', 'lb', 'me'].forEach(function (x) {
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

  function spotById(id) {
    if (id == null) return null;
    if (id >= 1000) return C.Store.customs().filter(function (x) { return x.id === id; })[0] || null;
    return D.SPOTS[id] || null;
  }

  /* A place he searched for. Borrows tides, swell point and forecast district
     from the nearest listed spot when it is close enough to share a coast;
     otherwise it is treated as inland water. */
  function makeCustomSpot(name, admin, lat, lon) {
    var near = nearestSpot(lat, lon), rid = null, rd = 1e9;
    Object.keys(D.RADARS).forEach(function (id) {
      var d = haversine(lat, lon, D.RADARS[id].lat, D.RADARS[id].lon);
      if (d < rd) { rd = d; rid = id; }
    });
    var coastal = near.spot && near.spot.port && near.km <= 25;
    var sp = { name: name, region: (admin ? admin + ' · ' : '') + 'my place', lat: lat, lon: lon, custom: true, faces: null, radar: rid,
      sea: coastal ? { lat: lat - 0.005, lon: near.spot.sea ? Math.max(near.spot.sea.lon, lon + 0.35) : lon + 0.4 } : null,
      port: coastal ? near.spot.port : null, hwOff: coastal ? near.spot.hwOff : 0, lwOff: coastal ? near.spot.lwOff : 0,
      district: coastal ? near.spot.district : null, kinds: coastal ? near.spot.kinds.slice() : ['f'], damped: coastal ? near.spot.damped : false,
      note: coastal ? 'Tides and coastal forecast borrowed from ' + near.spot.name + ', ' + Math.round(near.km) + ' km away.' : 'Treated as inland water — no tides or swell.' };
    if (coastal && sp.kinds.indexOf('f') >= 0 && sp.kinds.length > 1) sp.kinds = sp.kinds.filter(function (k) { return k !== 'f'; });
    return C.Store.addCustom(sp);
  }

  /* everything on the Maps tab follows the current spot */
  function syncMaps() {
    if (!el('v-maps').classList.contains('on')) return;
    initRadar();
    if (S.mapMode === 'wind') setWindy('windyFrame', 'wind');
    if (S.mapMode === 'waves') setWindy('waveFrame', 'waves');
  }
  function posKey() { return S.lat.toFixed(2) + ',' + S.lon.toFixed(2); }

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
    var s = spotById(id) || D.SPOTS[0];
    S.spot = s; S.lat = s.lat; S.lon = s.lon; S.gpsFix = null;
    el('spotName').textContent = s.name;
    el('spotRegion').textContent = s.region;
    renderNote();
    if (!quiet) { C.Store.saveSettings({ spot: s.id }); S.settings = C.Store.settings(); C.Store.pushRecent(s.id); load(true); }
  }

  function renderNote() {
    var sp = S.spot; if (!sp) return;
    var n = C.Store.note(sp.id);
    el('noteTitle').textContent = 'My notes — ' + sp.name;
    el('spotNote').value = n;
    el('noteMeta').textContent = n ? 'Saved on this phone.' : '';
    el('noteCard').style.display = n ? '' : 'none';
  }

  /* Safari only installs from its share sheet — say so once, on an iPhone
     that is still running the app inside the browser. */
  function installHint() {
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (ios && !standalone && !C.Store._get('nf.installHintDone', false)) el('installCard').style.display = '';
  }

  function bindPullToRefresh() {
    var ptr = el('ptr'), y0 = null, dy = 0, armed = false;
    document.addEventListener('touchstart', function (e) {
      if (window.scrollY > 2 || el('sheet').classList.contains('on')) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0; armed = false;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 24 && window.scrollY <= 2) {
        ptr.classList.add('show');
        armed = dy > 90;
        ptr.classList.toggle('armed', armed);
        ptr.textContent = armed ? 'Release to refresh' : 'Pull to refresh';
      } else ptr.classList.remove('show');
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (y0 == null) return;
      ptr.classList.remove('show', 'armed');
      if (armed) load(true);
      y0 = null; armed = false;
    });
  }

  function locate(explicit) {
    if (!navigator.geolocation) { if (explicit) alertBanner('This browser will not share a location.'); return; }
    el('gpsBtn').classList.add('spin');
    navigator.geolocation.getCurrentPosition(function (pos) {
      el('gpsBtn').classList.remove('spin');
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      var near = nearestSpot(lat, lon);
      S.gpsFix = { lat: lat, lon: lon, km: near.km };
      S.lat = lat; S.lon = lon;
      if (near.km > 40) {
        /* nowhere near a listed spot — treat it as inland water so the app
           does not quote tides and swell from a coast 100 km away */
        var rid = null, rd = 1e9;
        Object.keys(D.RADARS).forEach(function (id) {
          var d = haversine(lat, lon, D.RADARS[id].lat, D.RADARS[id].lon);
          if (d < rd) { rd = d; rid = id; }
        });
        S.spot = { id: -1, name: 'Your location', region: 'Inland — ' + Math.round(near.km) + ' km from ' + near.spot.name,
                   lat: lat, lon: lon, sea: null, port: null, hwOff: 0, lwOff: 0, radar: rid, district: null,
                   kinds: ['f'], note: '', damped: false, faces: null };
        el('spotName').textContent = 'Your location';
        el('spotRegion').textContent = S.spot.region;
        renderNote();
      } else {
        S.spot = near.spot;
        el('spotName').textContent = near.km < 3 ? near.spot.name : ('Near ' + near.spot.name);
        el('spotRegion').textContent = near.km < 3 ? near.spot.region
          : (near.km.toFixed(0) + ' km from ' + near.spot.name);
        renderNote();
      }
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
      kinds: effectiveKinds(),
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

  /* the spot's kinds, narrowed to the one he says he is fishing today */
  function effectiveKinds() {
    var sk = S.spot ? S.spot.kinds : ['e'], k = S.settings.kind;
    return k && sk.indexOf(k) >= 0 ? [k] : sk;
  }

  function renderKindSeg() {
    var seg = el('kindSeg'), sp = S.spot;
    if (!sp || sp.kinds.length < 2) { seg.style.display = 'none'; return; }
    var cur = sp.kinds.indexOf(S.settings.kind) >= 0 ? S.settings.kind : '';
    seg.style.display = '';
    seg.innerHTML = '<button data-k=""' + (cur === '' ? ' class="on"' : '') + '>Anywhere</button>' + sp.kinds.map(function (k) {
      return '<button data-k="' + k + '"' + (cur === k ? ' class="on"' : '') + '>' + D.KIND_NAME[k] + '</button>';
    }).join('');
    seg.onclick = function (e) {
      var b = e.target.closest('button[data-k]'); if (!b) return;
      S.settings = C.Store.saveSettings({ kind: b.dataset.k });
      renderKindSeg();
      if (S.wx) { computeScores(); renderAll(); }
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
    S.factorBase = S.series.baseline || {};
    var top = S.series.reduce(function (m, p) { return Math.max(m, p.score); }, 0);
    S.windows = C.Score.windows(S.series, Math.max(48, top - 18), TZ);
    S.bets = bestBets(c, cc);
  }

  /* Score every species that suits this water, now and at its best over the
     next 24 h. The first pick drives the headline score; this is the answer
     to "what should I actually chase". */
  function bestBets(c, cc) {
    var kinds = c.kinds, out = [];
    var m = A.parts(new Date(), TZ).month - 1;
    D.SPECIES.forEach(function (sp) {
      if (sp.protected || sp.closed) return;
      if (kinds.indexOf(sp.cat) < 0 && S.settings.species.indexOf(sp.n) < 0) return;
      if (sp.season[m] === 0) return;
      var one = { kinds: cc.kinds, faces: cc.faces, weights: cc.weights, access: cc.access, windLimit: cc.windLimit,
                  swellLimit: cc.swellLimit, species: [sp], month: cc.month };
      var now = C.Score.at(Date.now(), S.wx, S.marine, S.tide, S.sun, S.sol.periods, one).score;
      var peak = now, peakAt = Date.now(), sunC = {}, solC = {}, h0 = Math.ceil(Date.now() / HOUR) * HOUR;
      for (var h = 1; h <= 24; h += 2) {
        var t = h0 + h * HOUR, dk = A.parts(new Date(t), TZ), key = dk.year + '-' + dk.month + '-' + dk.day;
        if (!sunC[key]) { sunC[key] = A.sunTimes(new Date(t), S.lat, S.lon, TZ); solC[key] = A.solunar(new Date(t), S.lat, S.lon, TZ).periods; }
        var sc = C.Score.at(t, S.wx, S.marine, S.tide, sunC[key], solC[key], { kinds: cc.kinds, faces: cc.faces, weights: cc.weights, access: cc.access,
          windLimit: cc.windLimit, swellLimit: cc.swellLimit, species: [sp], month: dk.month - 1 }).score;
        if (sc > peak) { peak = sc; peakAt = t; }
      }
      out.push({ n: sp.n, now: now, peak: peak, peakAt: peakAt, pick: S.settings.species.indexOf(sp.n) >= 0 });
    });
    out.sort(function (a, b) { return b.now - a.now || b.peak - a.peak; });
    return out;
  }

  function renderBestBets() {
    var card = el('bestCard'), bets = S.bets || [];
    if (!bets.length) { card.style.display = 'none'; el('bestBet').style.display = 'none'; return; }
    card.style.display = '';
    el('bestTitle').textContent = 'Best bets at ' + (S.spot ? S.spot.name : 'this spot') + ' right now';
    el('bestList').innerHTML = bets.slice(0, 6).map(function (b) {
      return '<button class="best" data-s="' + esc(b.n) + '"><div style="width:44%"><div class="bn">' + esc(b.n) + (b.pick ? ' <span class="muted">· your pick</span>' : '') + '</div>' +
        '<div class="bm">' + (b.peak > b.now + 4 ? 'better at ' + t(b.peakAt) + ' (' + b.peak + ')' : 'as good as it gets today') + '</div></div>' +
        '<div class="bar"><i style="width:' + b.now + '%;background:' + scoreColor(b.now) + '"></i></div>' +
        '<div class="pill" style="background:' + scoreColor(b.now) + '">' + b.now + '</div></button>';
    }).join('');
    el('bestList').onclick = function (e) { var b = e.target.closest('button[data-s]'); if (b) openSpecies(b.dataset.s); };
    /* headline hint when something clearly beats the first pick */
    var first = S.settings.species[0], top = bets[0], mine = bets.filter(function (b) { return b.n === first; })[0];
    var hint = el('bestBet');
    if (top && (!mine || (top.n !== first && top.now >= mine.now + 8))) {
      hint.style.display = '';
      hint.innerHTML = 'Better bet right now: <b style="display:inline;color:var(--ink)">' + esc(top.n) + '</b> (' + top.now + ')' + (mine ? ' vs ' + esc(first) + ' (' + mine.now + ')' : '') + ' — tap Fish for the list.';
    } else hint.style.display = 'none';
  }

  function renderAll() {
    renderNow(); renderForecast(); renderTides(); renderFish(); renderBestBets(); renderSettings(); renderBomLinks(); renderStatus(); syncMaps();
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
    if (S.stale) foot.push('Showing the last forecast that downloaded (' + t(S.wxAt) + ').');
    else if (S.wxAt) foot.push('Updated ' + t(S.wxAt) + '.');
    foot.push('Model: ' + (S.fellBack ? 'best available (BOM model unavailable)'
      : S.settings.model === 'bom_access_global' ? 'BOM ACCESS-G' : 'best available'));
    el('scoreFoot').textContent = foot.join(' ');

    /* hazard + warning banners */
    var box = el('alerts'); box.innerHTML = '';
    if (S.stale || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      box.innerHTML += '<div class="banner info"><b>Offline</b>Showing the forecast from ' + t(S.wxAt) + '. It will refresh itself when there is signal.</div>';
    }
    if (d.hazard) {
      box.innerHTML += '<div class="banner warn"><b>Big swell running</b>' +
        'Around ' + n1(d.wave) + ' m. Rock and beach ledges get dangerous fast — stay well back, wear a lifejacket and never fish alone.</div>';
    }
    if (d.wind != null && d.wind > S.settings.windLimit) {
      box.innerHTML += '<div class="banner warn"><b>Over your wind limit</b>' +
        wv(d.wind) + ' ' + wu() + ' now, gusting ' + wv(d.gust) + ' — you set ' + wv(S.settings.windLimit) + ' ' + wu() + '.</div>';
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
    var exText = '';
    if (S.spot && S.spot.faces != null && d.dir != null && d.wind != null && d.wind >= 4) {
      var ex = C.exposure(d.dir, S.spot.faces);
      exText = ex.on > 0.6 ? ' · onshore' : ex.off > 0.6 ? ' · offshore' : ' · cross-shore';
    }
    cell('Wind', wv(d.wind) + ' <small>' + wu() + '</small> ' + arrow(d.dir, 17),
      C.degToCompass(d.dir) + ' · gusts ' + wv(d.gust) + ' ' + wu() + exText);
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

    renderKindSeg(); renderBaro(); renderStation(); renderTideNow(); renderSunMoon(); renderWindows(); renderBomText();
  }

  function renderBaro() {
    var card = el('baroCard'), H = S.wx && S.wx.hourly;
    if (!H || !H.pressure_msl) { card.style.display = 'none'; return; }
    var now = Date.now(), t0 = now - 24 * HOUR, t1 = now + 24 * HOUR, pts = [], min = 1e9, max = -1e9;
    for (var i = 0; i < H.time.length; i++) {
      var ts = H.time[i] * 1000, v = H.pressure_msl[i];
      if (ts < t0 || ts > t1 || v == null) continue;
      pts.push([ts, v]); if (v < min) min = v; if (v > max) max = v;
    }
    if (pts.length < 6) { card.style.display = 'none'; return; }
    card.style.display = '';
    var lo = Math.floor(min - 1), hi = Math.ceil(max + 1); if (hi - lo < 6) { var mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
    var w = 340, h = 96, padL = 30, padB = 16;
    var X = function (t) { return padL + (t - t0) / (t1 - t0) * (w - padL - 4); };
    var Y = function (v) { return 8 + (hi - v) / (hi - lo) * (h - padB - 8); };
    var path = pts.map(function (p, k) { return (k ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join(' ');
    var nx = X(now), grid = '';
    [lo, (lo + hi) / 2, hi].forEach(function (v) {
      grid += '<line x1="' + padL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (w - 4) + '" y2="' + Y(v).toFixed(1) + '" stroke="var(--line)" stroke-dasharray="3 3"/>' +
        '<text x="2" y="' + (Y(v) + 3.5).toFixed(1) + '" font-size="9.5" fill="var(--ink3)">' + Math.round(v) + '</text>';
    });
    var obsDot = S.obs && S.obs.pressure != null ? '<circle cx="' + nx.toFixed(1) + '" cy="' + Y(S.obs.pressure).toFixed(1) + '" r="3.5" fill="var(--accent2)"/>' : '';
    el('baroChart').innerHTML = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:96px">' + grid +
      '<line x1="' + nx.toFixed(1) + '" y1="4" x2="' + nx.toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--accent2)" stroke-width="1.5" stroke-dasharray="4 3"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>' + obsDot +
      '<text x="' + (padL + 2) + '" y="' + (h - 3) + '" font-size="9.5" fill="var(--ink3)">yesterday</text>' +
      '<text x="' + (nx + 3).toFixed(1) + '" y="' + (h - 3) + '" font-size="9.5" fill="var(--accent2)">now</text>' +
      '<text x="' + (w - 4) + '" y="' + (h - 3) + '" font-size="9.5" fill="var(--ink3)" text-anchor="end">tomorrow</text></svg>';
    var d = S.detail, p24 = C.sampleSeries(H.time, H.pressure_msl, now - 24 * HOUR), n24 = C.sampleSeries(H.time, H.pressure_msl, now + 24 * HOUR);
    var bits = [];
    if (d && d.pressureTrend != null) bits.push(d.pressureTrend <= -0.6 ? 'Falling ' + n1(Math.abs(d.pressureTrend)) + ' hPa over 3 h — the classic pre-front feed'
      : d.pressureTrend >= 0.5 ? 'Rising ' + n1(d.pressureTrend) + ' hPa over 3 h — fish often go quiet behind a change' : 'Steady over the last 3 h');
    if (p24 != null && d && d.pressure != null) bits.push(n0(p24) + ' → ' + n0(d.pressure) + ' hPa since yesterday');
    if (n24 != null && d && d.pressure != null && Math.abs(n24 - d.pressure) >= 2) bits.push('heading to ' + n0(n24) + ' by tomorrow');
    el('baroNote').innerHTML = bits.join(' · ') + (S.obs && S.obs.pressure != null ? ' · <span style="color:var(--accent2)">●</span> station reading' : '');
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
      '<div class="muted">' + o.km + ' km away · read ' + ago(o.ageMin) + '</div></div>' +
      '<div class="chip">BOM station</div></div>' +
      '<div class="grid" style="margin-top:10px">' +
      '<div class="cell"><div class="k">Wind</div><div class="v">' + wv(o.windKt) + ' <small>' + wu() + '</small> ' + arrow(o.windDir, 16) + '</div>' +
      '<div class="x">' + (o.windDirText || C.degToCompass(o.windDir)) + (o.gustKt != null ? ' · gusts ' + wv(o.gustKt) : '') + '<br>' + (d ? delta(d.wind, 'kt') : '') + '</div></div>' +
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
      '<path d="' + path + ' L' + w + ' ' + h + ' L0 ' + h + 'Z" fill="var(--t-accent-16)"/>' +
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
        '<div class="w2">' + windowSummary(w) +
        (conf ? ' · <span style="color:' + toneColor(conf.tone) + '">' + conf.text.toLowerCase().replace(' confidence', ' conf.') + '</span>' : '') + '</div></div>' +
        '<div class="pill" style="background:' + scoreColor(w.peak) + '">' + w.peak + '</div></div>';
    }).join('') + (S.spread ? '<div class="muted">Confidence comes from how tightly the ' + S.spread.members + ' members of BOM\u2019s ensemble agree on the wind.</div>' : '');
  }

  /* "8 kt W · run-in · dawn" for a window */
  function windowSummary(w) {
    var H = S.wx.hourly, mid = (w.start + w.end) / 2, bits = [];
    var kt = C.sampleSeries(H.time, H.wind_speed_10m, mid), dir = C.sampleSeries(H.time, H.wind_direction_10m, mid);
    if (kt != null) bits.push(wv(kt) + ' ' + wu() + ' ' + C.degToCompass(dir));
    if (S.tide) {
      var st = C.Tides.state(S.tide, w.start);
      if (st) bits.push(st.rising ? 'run-in' : 'run-out');
    }
    var sun = A.sunTimes(new Date(mid), S.lat, S.lon, TZ);
    if (sun.sunrise && sun.sunset) {
      var sr = sun.sunrise.valueOf(), ss = sun.sunset.valueOf();
      if (w.start <= sr + 90 * 60000 && w.end >= sr - 90 * 60000) bits.push('dawn');
      else if (w.start <= ss + 90 * 60000 && w.end >= ss - 90 * 60000) bits.push('dusk');
      else if (mid < sr || mid > ss) bits.push('night');
      else bits.push('daytime');
    }
    var sol = A.solunar(new Date(mid), S.lat, S.lon, TZ).periods;
    if (sol.some(function (p) { return p.kind === 'major' && p.start.valueOf() < w.end && p.end.valueOf() > w.start; })) bits.push('moon major');
    return bits.join(' · ');
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
    var w = 340, h = 210, padL = 28, padB = 26, now = Date.now();
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
      '<path d="' + path + ' L' + X(t1).toFixed(1) + ' ' + (h - padB) + ' L' + X(t0).toFixed(1) + ' ' + (h - padB) + 'Z" fill="var(--t-accent2-12)"/>' +
      (fpath ? '<path d="' + fpath + '" fill="none" stroke="var(--ink3)" stroke-width="1.4" stroke-dasharray="4 3"/>' : '') +
      '<path d="' + path + '" fill="none" stroke="var(--accent2)" stroke-width="2.4" stroke-linejoin="round"/>' +
      '<line x1="' + nx.toFixed(1) + '" y1="10" x2="' + nx.toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3"/>' +
      labels + '</svg>';
    var obs = S.obs && S.obs.temp != null ? ' · station reading ' + n1(S.obs.temp) + '° now' : '';
    el('tempFoot').textContent = 'Air temperature at ' + (S.gpsFix ? 'your location' : S.spot.name) + ', hourly for seven days. Dashed line is feels-like.' + obs;
  }

  function renderScoreChart() {
    var w = 340, h = 200, pad = 22;
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
        if (b > a) nights += '<rect x="' + X(a).toFixed(1) + '" y="14" width="' + (X(b) - X(a)).toFixed(1) + '" height="' + (h - 40) + '" fill="var(--t-ink-9)"/>';
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
    var sm = pts.map(function (p, i) {
      var a = pts[Math.max(0, i - 1)].score, c = pts[Math.min(pts.length - 1, i + 1)].score;
      return { t: p.t, score: (a + 2 * p.score + c) / 4 };
    });
    var path = sm.map(function (p, i) { return (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.score).toFixed(1); }).join(' ');
    var area = path + ' L' + X(t1).toFixed(1) + ' ' + (h - 26) + ' L' + X(t0).toFixed(1) + ' ' + (h - 26) + 'Z';
    var nowX = X(Math.max(t0, Math.min(t1, Date.now())));

    el('scoreChart').innerHTML = '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:200px">' +
      nights + ticks + bars +
      '<path d="' + area + '" fill="var(--t-accent-14)"/>' +
      '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round"/>' +
      S.windows.slice(0, 4).map(function (win) {
        return '<rect x="' + X(win.start).toFixed(1) + '" y="14" width="' + Math.max(2, X(win.end) - X(win.start)).toFixed(1) + '" height="' + (h - 40) + '" fill="var(--t-great-13)"/>';
      }).join('') +
      '<line x1="' + nowX.toFixed(1) + '" y1="14" x2="' + nowX.toFixed(1) + '" y2="' + (h - 26) + '" stroke="var(--accent2)" stroke-width="1.6" stroke-dasharray="4 3"/>' +
      '<text x="2" y="' + (Y(100) + 4) + '" font-size="10" fill="var(--ink3)">100</text>' +
      '<text x="2" y="' + (Y(50) + 4) + '" font-size="10" fill="var(--ink3)">50</text>' +
      '</svg>';
  }

  function renderHourStrip() {
    var H = S.wx.hourly, out = [], now = Date.now(), nowDone = false;
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
      var isNow = !nowDone && ts >= now - 30 * 60000;
      if (isNow) nowDone = true;
      out.push('<div class="hour' + (night ? ' night' : '') + (isNow ? ' now' : '') + '">' +
        '<div class="t">' + (isNow ? 'Now' : t(ts)) + '</div>' +
        '<div class="ic">' + wxIcon(code, night) + '</div>' +
        '<div class="tm">' + (H.temperature_2m[i] != null ? n0(H.temperature_2m[i]) + '°' : '·') + '</div>' +
        '<div class="wd">' + (H.wind_speed_10m[i] != null ? arrow(H.wind_direction_10m[i], 12) + ' ' + wv(H.wind_speed_10m[i]) : '·') + '</div>' +
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
      var di = Math.round((A.startOfLocalDay(new Date(ts), TZ).valueOf() - A.startOfLocalDay(new Date(), TZ).valueOf()) / DAY);
      out.push('<div class="day' + (di >= 0 && di < 7 ? ' tap" data-di="' + di : '') + '"><div><div class="dn">' + relDay(ts) + '</div><div class="dd">' + fDate.format(new Date(ts)) +
        (sdDay ? '<br><span style="color:' + toneColor(sdDay.tone) + '">' + sdDay.text.split(' ')[0] + ' conf.</span>' : '') + '</div></div>' +
        '<div class="di">' + wx(Dy.weather_code[i])[1] + '</div>' +
        '<div><div class="dt">' + n0(Dy.temperature_2m_min[i]) + '° – ' + n0(Dy.temperature_2m_max[i]) + '°' +
        (Dy.precipitation_sum[i] > 0.2 ? ' · ' + n1(Dy.precipitation_sum[i]) + ' mm' : '') + '</div>' +
        '<div class="dw">' + arrow(Dy.wind_direction_10m_dominant[i], 12) + ' ' + wv(Dy.wind_speed_10m_max[i]) + ' ' + wu() + ' max' +
        (swell != null ? ' · swell ' + n1(swell) + ' m' : '') +
        (dayWins.length ? ' · best ' + t(dayWins[0].start) : '') + '</div></div>' +
        '<div class="pill" style="background:' + scoreColor(best) + '">' + best + '</div></div>');
    }
    el('dayList').innerHTML = out.join('');
    el('dayList').onclick = function (e) {
      var r = e.target.closest('.day[data-di]'); if (!r) return;
      S.tideDay = +r.dataset.di; showView('tides');
    };
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
    var w = 340, h = 120, pad = 22;
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
      '<path d="' + path + ' L' + X(t1).toFixed(1) + ' ' + (h - 22) + ' L' + X(t0).toFixed(1) + ' ' + (h - 22) + 'Z" fill="var(--t-accent-13)"/>' +
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

    renderPlanner();
  }

  /* Moon + tide planning score for a day, weather-free: how well the moon
     periods and tide changes line up with first and last light, plus the
     phase and the size of the tide. 0-100. */
  function planDay(dayStart) {
    var sun = A.sunTimes(dayStart, S.lat, S.lon, TZ), sol = A.solunar(dayStart, S.lat, S.lon, TZ);
    var edges = [sun.sunrise, sun.sunset].filter(Boolean).map(function (x) { return x.valueOf(); });
    function nearEdge(ms, tol) { return edges.some(function (e) { return Math.abs(e - ms) <= tol * 60000; }); }
    var score = 20, why = [];
    var majAtLight = sol.periods.some(function (p) { return p.kind === 'major' && (nearEdge(p.start.valueOf(), 75) || nearEdge(p.end.valueOf(), 75) || nearEdge((p.start.valueOf() + p.end.valueOf()) / 2, 75)); });
    var minAtLight = sol.periods.some(function (p) { return p.kind === 'minor' && nearEdge((p.start.valueOf() + p.end.valueOf()) / 2, 60); });
    if (majAtLight) { score += 30; why.push('major on the light change'); }
    else if (minAtLight) { score += 12; why.push('minor on the light change'); }
    var ex = S.tide ? C.Tides.extremesForDay(S.tide, dayStart.valueOf()) : [];
    var changesAtLight = ex.filter(function (e) { return nearEdge(e.t, 90); }).length;
    if (changesAtLight) { score += Math.min(35, 25 * changesAtLight); why.push('tide change at ' + (changesAtLight > 1 ? 'both' : 'dawn or dusk')); }
    var il = sol.illumination.fraction;
    if (il >= 0.9 || il <= 0.1) { score += 15; why.push(il >= 0.9 ? 'full moon' : 'new moon'); }
    else if (il >= 0.4 && il <= 0.6) score -= 3;
    if (ex.length >= 2) {
      var hi = Math.max.apply(null, ex.map(function (e) { return e.h; })), lo = Math.min.apply(null, ex.map(function (e) { return e.h; }));
      var rng = hi - lo, ref = S.tideRangeRef || 1.6;
      score += Math.round(10 * Math.min(1.2, rng / ref));
      if (rng / ref > 1.05) why.push('big tides');
    }
    return { score: Math.max(0, Math.min(100, Math.round(score))), why: why, sun: sun, sol: sol, ex: ex };
  }

  function renderPlanner() {
    var box = el('planner'); if (!box) return;
    if (S.tide && S.tide.extremes.length > 4) {
      var rngs = [];
      for (var k = 1; k < S.tide.extremes.length; k++) rngs.push(Math.abs(S.tide.extremes[k].h - S.tide.extremes[k - 1].h));
      rngs.sort(function (a, b) { return a - b; });
      S.tideRangeRef = rngs[Math.floor(rngs.length * 0.6)] || 1.6;
    }
    var glyphs = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
    function short(ms) { return t(ms).replace(':00', '').replace('am', 'a').replace('pm', 'p'); }
    var rows = [];
    for (var i = 0; i < 28; i++) {
      var ds = A.addDaysLocal(new Date(), i, TZ), pd = planDay(ds);
      var majors = pd.sol.periods.filter(function (p) { return p.kind === 'major'; }).sort(function (x, y) { return x.start - y.start; }).map(function (p) { return short(p.start); });
      var tides = pd.ex.map(function (e) { return (e.type === 'high' ? 'H' : 'L') + ' ' + short(e.t); });
      rows.push('<div class="plan' + (i < 7 ? ' tap' : '') + (i === S.tideDay ? ' sel' : '') + '" data-pi="' + i + '">' +
        '<div class="pd"><b>' + (i === 0 ? 'Today' : dayName(ds)) + '</b><span>' + fDate.format(ds) + '</span></div>' +
        '<div class="pm"><span class="mt">' + glyphs[pd.sol.illumination.index] + ' ' + Math.round(pd.sol.illumination.fraction * 100) + '% · major' + (majors.length > 1 ? 's ' : ' ') + (majors.join(' & ') || '—') + '</span><br>' +
        (tides.length ? tides.join(' · ') : (S.tide ? '<span class="muted">tides not published yet</span>' : '<span class="muted">no tide here</span>')) +
        (pd.why.length ? '<br><span class="muted">' + esc(pd.why.join(' · ')) + '</span>' : '') + '</div>' +
        '<div class="pill" style="background:' + scoreColor(pd.score) + '">' + pd.score + '</div></div>');
    }
    box.innerHTML = rows.join('');
    box.onclick = function (e) {
      var r = e.target.closest('.plan.tap'); if (!r) return;
      S.tideDay = +r.dataset.pi; renderTides();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
  }

  function tideDayChart(dayStart, sun, sol) {
    var w = 340, h = 190, padL = 28, padB = 24;
    var t0 = dayStart.valueOf(), t1 = t0 + DAY;
    var X = function (x) { return padL + (x - t0) / DAY * (w - padL - 10); };
    var bands = '';
    if (sun.sunrise) bands += '<rect x="' + X(t0) + '" y="8" width="' + (X(sun.sunrise) - X(t0)) + '" height="' + (h - padB - 8) + '" fill="var(--t-ink-10)"/>';
    if (sun.sunset) bands += '<rect x="' + X(sun.sunset) + '" y="8" width="' + (X(t1) - X(sun.sunset)) + '" height="' + (h - padB - 8) + '" fill="var(--t-ink-10)"/>';
    sol.periods.forEach(function (p) {
      var a = Math.max(t0, p.start.valueOf()), b = Math.min(t1, p.end.valueOf());
      if (b <= a) return;
      bands += '<rect x="' + X(a).toFixed(1) + '" y="8" width="' + (X(b) - X(a)).toFixed(1) + '" height="' + (h - padB - 8) + '" fill="' + (p.kind === 'major' ? 'var(--t-accent2-22)' : 'var(--t-accent2-12)') + '"/>';
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
      var anchor = x < padL + 52 ? 'start' : x > w - 52 ? 'end' : 'middle';
      var ly = e.type === 'high' ? Math.max(11, y - 9) : Math.min(h - padB - 2, y + 15);
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.2" fill="var(--accent)"/>' +
        '<text x="' + x.toFixed(1) + '" y="' + ly.toFixed(1) + '" font-size="11" font-weight="600" fill="var(--ink)" text-anchor="' + anchor + '">' +
        t(e.t) + ' · ' + n1(e.h) + 'm</text>';
    }).join('');
    var nowLine = '';
    if (Date.now() >= t0 && Date.now() <= t1) {
      var nx = X(Date.now());
      nowLine = '<line x1="' + nx.toFixed(1) + '" y1="8" x2="' + nx.toFixed(1) + '" y2="' + (h - padB) + '" stroke="var(--accent2)" stroke-width="1.8" stroke-dasharray="4 3"/>';
    }
    return '<svg class="chart" viewBox="0 0 ' + w + ' ' + h + '" style="height:190px">' + bands + hours +
      '<path d="' + path + ' L' + X(pts[pts.length - 1][0]).toFixed(1) + ' ' + (h - padB) + ' L' + X(pts[0][0]).toFixed(1) + ' ' + (h - padB) + 'Z" fill="var(--t-accent-15)"/>' +
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
    el('bomRadarPick').addEventListener('change', function () { S.bomRadarId = this.value; S.bomRadarFor = posKey(); bomBuild(); });
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

  /* BOM still serves the frame PNGs to a plain <img> from any site, so the
     loop is loaded straight from the Bureau. The GitHub feed only supplies
     the cadence (which minutes this radar publishes on) and the static map
     layers, and stands in for any frame BOM will not hand over. */
  function bomStamp(sec) {
    var d = new Date(sec * 1000);
    return d.toISOString().slice(0, 16).replace(/[-T:]/g, '');
  }
  function probeFrame(url) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () { res(true); };
      im.onerror = function () { res(false); };
      im.src = url;
    });
  }

  function bomBuild() {
    var R = S.liveRadar; if (!R || !R.radars) return;
    var ids = Object.keys(R.radars).filter(function (id) { return R.radars[id].frames && R.radars[id].frames.length; });
    if (!ids.length) return;
    if (S.bomRadarFor !== posKey()) { S.bomRadarId = null; S.bomRadarFor = posKey(); }
    if (!S.bomRadarId || !R.radars[S.bomRadarId]) {
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
      var km = m ? Math.round(C.haversine(S.lat, S.lon, m.lat, m.lon)) : null;
      return '<option value="' + id + '"' + (id === S.bomRadarId ? ' selected' : '') + '>' + esc(m ? m.name : id) + (km != null ? ' · ' + km + ' km away' : '') + '</option>';
    }).join('');
    var r = R.radars[S.bomRadarId], base = C.Api.liveBase(), id = S.bomRadarId;
    var stage = el('bomStage');
    var m = D.RADARS[id];
    var dot = '';
    if (m) {
      var dy = (S.lat - m.lat) * 111.2, dx = (S.lon - m.lon) * 111.2 * Math.cos(m.lat * Math.PI / 180);
      var px = 50 + dx / 256 * 100, py = 50 - dy / 256 * 100;
      if (px > 2 && px < 98 && py > 2 && py < 98) dot = '<div class="bdot" style="left:' + px.toFixed(1) + '%;top:' + py.toFixed(1) + '%"></div>';
    }
    var layers = ['background', 'topography', 'locations', 'range'].map(function (l) {
      return r.layers && r.layers[l] ? '<img class="bl" src="' + base + r.layers[l] + '" alt="">' : '';
    }).join('');
    stage.innerHTML = layers + dot + (r.layers && r.layers.legend ? '<img class="blegend" src="' + base + r.layers.legend + '" alt="">' : '');
    el('bomMeta').textContent = 'Checking the Bureau for the latest frames…';
    bomStop();

    /* cadence from the feed */
    var known = r.frames.map(function (f) { return f.time; }).filter(Boolean).sort();
    var step = (r.stepMin || 5) * 60;
    var phase = known.length ? known[known.length - 1] % step : 0;
    var now = Math.floor(Date.now() / 1000);
    var latest = now - ((now - phase) % step + step) % step;
    var cands = [];
    for (var t = latest; t > now - 75 * 60 && cands.length < 14; t -= step) cands.push(t);

    var token = (S.bomToken = (S.bomToken || 0) + 1);
    Promise.all(cands.map(function (t) {
      var url = 'https://www.bom.gov.au/radar/' + id + '.T.' + bomStamp(t) + '.png';
      return probeFrame(url).then(function (ok) { return ok ? { time: t, src: url, live: true } : null; });
    })).then(function (found) {
      if (token !== S.bomToken) return;
      var frames = found.filter(Boolean);
      var direct = frames.length;
      /* fill gaps and the failure case from the feed's copies */
      r.frames.forEach(function (f) {
        if (!frames.some(function (x) { return x.time === f.time; })) frames.push({ time: f.time, src: base + f.file, live: false });
      });
      frames.sort(function (a, b) { return a.time - b.time; });
      frames = frames.slice(-8);
      S.bomFrames = frames;
      stage.querySelectorAll('.bf').forEach(function (n) { n.remove(); });
      var legend = stage.querySelector('.blegend');
      frames.forEach(function (f, i) {
        var im = document.createElement('img');
        im.className = 'bf'; im.alt = ''; im.style.opacity = '0'; im.dataset.i = i; im.src = f.src;
        stage.insertBefore(im, legend || null);
      });
      el('bomScrub').max = String(Math.max(0, frames.length - 1));
      S.bomFrameIx = Math.max(0, frames.length - 1);
      var newest = frames.length ? frames[frames.length - 1].time : null;
      var farKm = m ? Math.round(C.haversine(S.lat, S.lon, m.lat, m.lon)) : 0;
      el('bomMeta').textContent = (farKm > 150 ? 'This spot is ' + farKm + ' km from the ' + m.name + ' radar — outside its 128 km picture. Use Map view for rain here. ' : '') +
        'Bureau of Meteorology ' + (m ? m.name : id) + ' radar · ' +
        (direct ? 'live from BOM, latest frame ' + (newest ? Math.round((now - newest) / 60) : '?') + ' min old' :
          'BOM would not serve frames directly — showing the feed\u2019s copies, ' + Math.round((now - (newest || now)) / 60) + ' min old') +
        ' · every ' + Math.round(step / 60) + ' min.';
      bomShow(); bomPlay();
    });
  }

  function bomShow() {
    var frames = S.bomFrames || []; if (!frames.length) return;
    var imgs = el('bomStage').querySelectorAll('.bf');
    Array.prototype.forEach.call(imgs, function (im, i) { im.style.opacity = i === S.bomFrameIx ? 1 : 0; });
    el('bomScrub').value = String(S.bomFrameIx);
    var f = frames[S.bomFrameIx];
    el('bomTime').textContent = f ? t(f.time * 1000) : '—';
  }
  function bomPlay() {
    S.bomPlaying = true; clearInterval(S.bomTimer);
    el('bomPlay').innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" stroke="none"/></svg>';
    S.bomTimer = setInterval(function () {
      var frames = S.bomFrames || []; if (!frames.length) return;
      S.bomFrameIx = (S.bomFrameIx + 1) % frames.length; bomShow();
    }, 700);
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
    if (S.mapFor !== posKey()) {
      S.map.setView(S.lat, S.lon, S.map.z);
      S.mapFor = posKey();
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
    out.push(['BOM rain radar & weather maps', 'https://www.bom.gov.au/weather-and-climate/rain-radar-and-weather-maps', 'BOM']);
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
    if (fishFilter === 'now') {
      var picks = S.settings.species;
      list.sort(function (a, b) {
        var pa = picks.indexOf(a.n) >= 0 ? 0 : 1, pb = picks.indexOf(b.n) >= 0 ? 0 : 1;
        return pa - pb || a.n.localeCompare(b.n);
      });
    }

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
          (v === 2 ? 'var(--accent)' : v === 1 ? 'var(--t-accent-35)' : 'var(--card2)') +
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
      '<button class="btn ghost" id="logSpecies" style="margin-top:8px">Log a ' + esc(s.n.toLowerCase()) + '</button>' +
      '<div class="footnote" style="margin-top:12px">Limits checked against NSW DPIRD, ' + D.RULES.asAt + '. Rules change — check the official tables before you keep a fish.</div>';
    openSheet(body);
    var lb = el('logSpecies');
    if (lb) lb.addEventListener('click', function () { closeSheet(); setTimeout(function () { openCatchForm(s.n); }, 250); });
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
    seg('unitSeg', 'u', function (v) { S.settings = C.Store.saveSettings({ unitsWind: v }); renderAll(); });
    seg('textSeg', 'x', function (v) { S.settings = C.Store.saveSettings({ textSize: v }); applyTheme(); });
    seg('learnSeg', 'l', function (v) { S.settings = C.Store.saveSettings({ learn: v === '1' }); computeScores(); renderAll(); });
    el('resetWeights').addEventListener('click', function () {
      S.settings = C.Store.saveSettings({ weights: {} }); computeScores(); renderAll();
    });
    el('windLim').addEventListener('input', function () {
      S.settings = C.Store.saveSettings({ windLimit: +this.value });
      el('windLimVal').textContent = wv(+this.value) + ' ' + wu();
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
    setSeg('unitSeg', 'u', S.settings.unitsWind);
    setSeg('textSeg', 'x', S.settings.textSize || 'normal');
    el('windLimVal').textContent = wv(S.settings.windLimit) + ' ' + wu();
    el('windLim').value = S.settings.windLimit;
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
      ? 'Learned from ' + L.n + ' catches' + (L.usingBlanks ? ' against ' + L.blanks + ' blank sessions' : '') + (L.notes.length ? ': ' + esc(L.notes.join(', ')) + '.' : '. Nothing stands out yet.') + (L.n < 15 ? ' Still easing in — full strength at 15 catches.' : '')
      : 'Log ' + Math.max(0, 6 - (L.n || 0)) + ' more catches and the app starts weighting what actually produces for you.' + (L.blanks ? ' Blank sessions sharpen it once you have a few of each.' : '');
    setSeg('learnSeg', 'l', S.settings.learn ? '1' : '0');
  }

  function bagLimit(name) {
    var sp = D.SPECIES.filter(function (x) { return x.n === name; })[0];
    if (!sp || !sp.bag) return null;
    var m = String(sp.bag).match(/\d+/);
    return m ? +m[0] : null;
  }

  function renderToday(l) {
    var day0 = A.startOfLocalDay(new Date(), TZ).valueOf(), tally = {}, order = [];
    l.forEach(function (e) {
      if (e.blank || e.t < day0) return;
      if (!tally[e.species]) { tally[e.species] = 0; order.push(e.species); }
      tally[e.species]++;
    });
    el('logToday').innerHTML = order.length ? '<div class="today">' + order.map(function (n) {
      var bag = bagLimit(n), full = bag != null && tally[n] >= bag;
      return '<span class="chip' + (full ? ' full' : '') + '">' + esc(n) + ' ' + tally[n] + (bag != null ? ' / ' + bag : '') + (full ? ' — bag full' : '') + '</span>';
    }).join('') + '</div>' : '';
  }

  function renderLog() {
    var l = C.Store.log();
    renderToday(l);
    el('shareLogBtn').style.display = l.length ? '' : 'none';
    el('logList').innerHTML = l.length ? l.slice(0, 12).map(function (e) {
      return '<div class="logitem"><div><div>' + (e.blank ? '<span class="muted">Fished, nothing</span>' : esc(e.species) + (e.length ? ' · ' + e.length + ' cm' : '')) + '</div>' +
        '<div class="lm">' + esc(e.spot) + ' · ' + fDate.format(new Date(e.t)) + ' ' + t(e.t) +
        (e.tide ? ' · ' + esc(e.tide) : '') + (e.wind != null ? ' · ' + n0(e.wind) + ' kt' : '') + '</div></div>' +
        '<button class="chip" data-del="' + e.id + '">✕</button></div>';
    }).join('') + (l.length > 12 ? '<div class="muted" style="margin-top:6px">' + (l.length - 12) + ' more in the shared CSV.</div>' : '') : '<div class="empty">No catches logged yet. Every one you log records the tide, wind, moon and barometer with it.</div>';
    el('logList').onclick = function (e) {
      var b = e.target.closest('button[data-del]'); if (!b) return;
      C.Store.removeCatch(b.dataset.del); renderLog();
    };
    el('logInsight').innerHTML = logInsight(l);
  }

  function logInsight(all) {
    var l = all.filter(function (e) { return !e.blank; }), blanks = all.length - l.length;
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
    if (blanks) bits.push(blanks + ' blank session' + (blanks > 1 ? 's' : '') + ' logged');
    return '<div class="banner info" style="margin-top:12px"><b>Your ' + l.length + ' logged catches</b>' + bits.join(' · ') + '</div>';
  }

  function openCatchForm(presetSpecies, blank) {
    var opts = D.SPECIES.map(function (s) { return '<option>' + esc(s.n) + '</option>'; }).join('');
    var st = S.tide ? C.Tides.state(S.tide, Date.now()) : null;
    openSheet((blank ? '<h3>Fished, nothing</h3><div class="sub">A blank session is worth logging — it tells the pattern-finder what did not work. It is kept out of the learning until you have enough catches to compare it with.</div>'
      : '<h3>Log a catch</h3><div class="sub">Conditions are saved with it automatically.</div>') +
      (blank ? '<div class="field"><label>What you were after</label><select id="cSpecies"><option>Anything</option>' + opts + '</select></div>'
        : '<div class="field"><label>Species</label><select id="cSpecies">' + opts + '</select></div>' +
      '<div class="field"><label>Length (cm) — optional</label><input type="number" id="cLen" inputmode="numeric" placeholder="e.g. 42"></div>') +
      '<div class="field"><label>Notes — optional</label><input type="text" id="cNote" placeholder="Bait, spot, what it took"></div>' +
      '<div class="muted" style="margin-bottom:12px">Recording: ' + esc(S.spot ? S.spot.name : '') +
      (st ? ' · ' + (st.rising ? 'running in' : 'running out') : '') +
      (S.detail && S.detail.wind != null ? ' · ' + n0(S.detail.wind) + ' kt ' + C.degToCompass(S.detail.dir) : '') +
      (S.detail && S.detail.pressure != null ? ' · ' + n0(S.detail.pressure) + ' hPa' : '') + '</div>' +
      '<button class="btn" id="cSave">' + (blank ? 'Save blank session' : 'Save catch') + '</button>');
    if (typeof presetSpecies === 'string') el('cSpecies').value = presetSpecies;
    else if (!blank && S.settings.species[0]) el('cSpecies').value = S.settings.species[0];
    el('cSave').addEventListener('click', function () {
      var moonNow = S.sol ? A.solunarStrength(new Date(), S.sol.periods) > 0.2 : false;
      var lowLight = false;
      if (S.sun && S.sun.sunrise && S.sun.sunset) {
        var m = Math.min(Math.abs(Date.now() - S.sun.sunrise.valueOf()), Math.abs(Date.now() - S.sun.sunset.valueOf())) / 60000;
        lowLight = m < 90;
      }
      C.Store.addCatch({
        id: String(Date.now()), t: Date.now(),
        blank: !!blank,
        species: el('cSpecies').value,
        length: !blank && el('cLen').value ? +el('cLen').value : null,
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
        parts: S.detail ? S.detail.parts.map(function (p) { return { key: p.key, f: Math.round(p.f * 100) / 100, b: S.factorBase && S.factorBase[p.key] != null ? Math.round(S.factorBase[p.key] * 100) / 100 : null }; }) : null
      });
      closeSheet(); renderLog();
      if (S.settings.learn) { computeScores(); renderNow(); }
      alertBanner(blank ? 'Blank session logged.' : 'Catch logged.', 'info');
    });
  }

  /* ================= share / export ================================== */

  function shareText(text, title) {
    if (navigator.share) return navigator.share({ title: title, text: text }).catch(function () {});
    return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(function () { alertBanner('Copied — paste it into a message.', 'info'); },
            function () { openSheet('<h3>' + esc(title) + '</h3><pre style="white-space:pre-wrap;font:inherit;font-size:14px">' + esc(text) + '</pre>'); });
  }

  function shareConditions() {
    if (!S.detail || !S.spot) return;
    var d = S.detail, v = C.Score.verdict(d.score), L = [];
    L.push(S.spot.name + ' — ' + fFull.format(new Date()) + ' ' + t(Date.now()));
    L.push('Bite score ' + d.score + ' — ' + v.label);
    var now = ['Wind ' + wv(d.wind) + ' ' + wu() + ' ' + C.degToCompass(d.dir) + (d.gust != null ? ' gusting ' + wv(d.gust) : '')];
    if (d.wave != null) now.push('swell ' + n1(d.wave) + ' m' + (d.period ? ' ' + n0(d.period) + ' s' : ''));
    if (d.sst != null) now.push('water ' + n1(d.sst) + '°');
    if (d.pressure != null) now.push(n0(d.pressure) + ' hPa' + (d.pressureTrend != null ? (d.pressureTrend > 0.3 ? ' rising' : d.pressureTrend < -0.3 ? ' falling' : ' steady') : ''));
    L.push(now.join(' · '));
    if (S.tide) {
      var st = C.Tides.state(S.tide, Date.now());
      if (st) L.push('Tide ' + (st.rising ? 'running in' : 'running out') + ', ' + (st.next.type === 'high' ? 'high' : 'low') + ' ' + n1(st.next.h) + ' m at ' + t(st.next.t));
    }
    if (S.sol) {
      var nx = S.sol.periods.filter(function (p) { return p.end.valueOf() > Date.now(); })[0];
      if (nx) L.push('Next moon ' + nx.kind + ' ' + t(nx.start) + '–' + t(nx.end));
    }
    if (S.windows && S.windows.length) L.push('Best windows: ' + S.windows.slice(0, 3).map(function (w) {
      return relDay(w.start) + ' ' + t(w.start) + '–' + t(w.end) + ' (' + w.peak + ')';
    }).join(', '));
    L.push(location.origin + location.pathname);
    shareText(L.join('\n'), 'Dawson\u2019s Fish Finder Pro');
  }

  function shareLog() {
    var l = C.Store.log(); if (!l.length) return;
    var cols = ['date', 'time', 'species', 'length_cm', 'spot', 'tide', 'tide_m', 'wind_kt', 'wind_dir', 'pressure_hpa', 'water_c', 'moon_pct', 'moon_period', 'low_light', 'score', 'blank', 'notes'];
    function q(v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var rows = l.slice().reverse().map(function (e) {
      return [fDate.format(new Date(e.t)) + ' ' + new Date(e.t).getFullYear(), t(e.t), e.species, e.length, e.spot, e.tide, e.tideHeight, e.wind,
        e.windDir != null ? C.degToCompass(e.windDir) : '', e.pressure, e.sst, e.moon, e.moonPeriod ? 'yes' : 'no', e.lowLight ? 'yes' : 'no', e.score, e.blank ? 'yes' : 'no', e.note].map(q).join(',');
    });
    var csv = cols.join(',') + '\n' + rows.join('\n');
    try {
      var file = new File([csv], 'catch-log.csv', { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Catch log' }).catch(function () {}); return; }
    } catch (e) {}
    shareText(csv, 'Catch log');
  }

  function backup() {
    var keys = {}, i;
    try { for (i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('nf.') === 0 && k.indexOf('nf.cache.') < 0) keys[k] = localStorage.getItem(k); } } catch (e) {}
    var json = JSON.stringify({ app: 'dffp', v: 1, at: new Date().toISOString(), data: keys });
    try {
      var file = new File([json], 'fish-finder-backup.json', { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Fish Finder backup' }).catch(function () {}); return; }
    } catch (e) {}
    shareText(json, 'Fish Finder backup');
  }

  function restore() {
    openSheet('<h3>Restore a backup</h3><div class="sub">Paste the contents of a fish-finder-backup.json file. It replaces the settings, favourites, notes and catch log on this phone.</div>' +
      '<div class="field"><textarea id="rsText" rows="6" style="width:100%;padding:10px;border-radius:12px;border:1px solid var(--line);background:var(--card2);color:var(--ink);font:inherit" placeholder="{&quot;app&quot;:&quot;dffp&quot;, …}"></textarea></div>' +
      '<button class="btn" id="rsGo">Restore</button><div class="muted" id="rsMsg" style="margin-top:8px"></div>');
    el('rsGo').addEventListener('click', function () {
      var j; try { j = JSON.parse(el('rsText').value); } catch (e) { el('rsMsg').textContent = 'That is not a backup file.'; return; }
      if (!j || j.app !== 'dffp' || !j.data) { el('rsMsg').textContent = 'That is not a Fish Finder backup.'; return; }
      var n = 0; for (var k in j.data) if (k.indexOf('nf.') === 0) { try { localStorage.setItem(k, j.data[k]); n++; } catch (e) {} }
      el('rsMsg').textContent = 'Restored ' + n + ' items — reloading.';
      setTimeout(function () { location.reload(); }, 700);
    });
  }

  function wipeApp() {
    var b = el('wipeBtn');
    if (!b.dataset.armed) {
      b.dataset.armed = '1'; b.textContent = 'Tap again to wipe everything on this phone'; b.classList.add('danger');
      setTimeout(function () { b.dataset.armed = ''; b.textContent = 'Start fresh — wipe settings and log'; b.classList.remove('danger'); }, 6000);
      return;
    }
    C.Store.wipe();
    location.reload();
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
    if (S.obs) row('Station', S.obs.ageMin != null && S.obs.ageMin < 90 ? 'ok' : 'warn', esc(S.obs.name) + ' · ' + S.obs.km + ' km · ' + (S.obs.ageMin != null ? 'read ' + ago(S.obs.ageMin) : 'age unknown'));
    else row('Station', 'warn', S.live ? 'No BOM station within 45 km yet — the feed maps more stations every 10 min' : 'Live feed not reachable');
    var nR = S.liveRadar && S.liveRadar.radars ? Object.keys(S.liveRadar.radars).length : 0;
    row('BOM radar', nR ? 'ok' : 'warn', nR ? nR + ' radars · frames load live from BOM; the feed (last ran ' + ago(Math.round((Date.now() - S.liveRadar.fetched * 1000) / 60000)) + ') supplies the map layers' : 'No frames yet — run “Live BOM feed” in GitHub Actions');
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

  function bindSheetSwipe() {
    var sh = el('sheet'), y0 = null, dy = 0;
    sh.addEventListener('touchstart', function (e) {
      if (sh.scrollTop > 4) { y0 = null; return; }
      y0 = e.touches[0].clientY; dy = 0;
    }, { passive: true });
    sh.addEventListener('touchmove', function (e) {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) sh.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    sh.addEventListener('touchend', function () {
      if (y0 == null) return;
      sh.style.transform = '';
      if (dy > 90) closeSheet();
      y0 = null;
    });
  }

  function openWelcome() {
    var chips = ['Snapper', 'Yellowfin bream', 'Dusky flathead', 'Tailor', 'Australian salmon', 'Mulloway', 'Yellowtail kingfish', 'Luderick', 'Sand whiting', 'Australian bass', 'Trout (rainbow & brown)']
      .map(function (n) { return '<button class="chip" data-wsp="' + esc(n) + '">' + esc(n) + '</button>'; }).join('');
    openSheet('<h3>G\u2019day.</h3><div class="sub">Thirty seconds of setup and the bite score is tuned to you. Everything can be changed later under the gear.</div>' +
      '<div class="field"><label>Your name</label><input type="text" id="wName" placeholder="Phill" autocomplete="off"></div>' +
      '<div class="field"><label>How you mostly fish</label><div class="seg" id="wAccess"><button data-a="land" class="on">Land based</button><button data-a="boat">In the boat</button></div></div>' +
      '<div class="field"><label>What you chase most (tap a few)</label><div class="chips" id="wSpecies">' + chips + '</div></div>' +
      '<button class="btn" id="wGo">Use my location and get started</button>' +
      '<button class="btn ghost" id="wSkip" style="margin-top:8px">Pick a spot instead</button>');
    var picked = [];
    el('wAccess').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-a]'); if (!b) return;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.toggle('on', x === b); });
    });
    el('wSpecies').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-wsp]'); if (!b) return;
      b.classList.toggle('sel');
      var n = b.dataset.wsp, i = picked.indexOf(n);
      if (i >= 0) picked.splice(i, 1); else picked.push(n);
    });
    function finish(useGps) {
      var access = el('wAccess').querySelector('.on').dataset.a;
      S.settings = C.Store.saveSettings({ name: el('wName').value.trim(), access: access, species: picked.slice(0, 4), useGps: useGps });
      C.Store._set('nf.onboarded', true);
      closeSheet();
      if (useGps) locate(true); else setTimeout(openSpotPicker, 300);
      computeScores && S.wx && (computeScores(), renderAll());
    }
    el('wGo').addEventListener('click', function () { finish(true); });
    el('wSkip').addEventListener('click', function () { finish(false); });
  }

  function openSheet(html) {
    el('sheetBody').onclick = null;
    el('sheetBody').innerHTML = html;
    el('sheet').classList.add('on'); el('sheetBg').classList.add('on');
    el('sheet').scrollTop = 0;
  }
  function closeSheet() { el('sheet').classList.remove('on'); el('sheetBg').classList.remove('on'); }

  function spotRow(s, favs) {
    var fav = favs.indexOf(s.id) >= 0, note = C.Store.note(s.id);
    return '<div class="spotrow"><button data-id="' + s.id + '"' + (S.spot && s.id === S.spot.id ? ' class="on"' : '') + '>' + esc(s.name) +
      '<div class="r">' + s.kinds.map(function (k) { return D.KIND_NAME[k]; }).join(' · ') + (note ? ' · has notes' : '') + '</div></button>' +
      '<button class="star' + (fav ? ' on' : '') + '" data-fav="' + s.id + '" aria-label="Favourite">' + (fav ? '★' : '☆') + '</button>' +
      (s.custom ? '<button class="star" data-rm="' + s.id + '" aria-label="Remove">✕</button>' : '') + '</div>';
  }

  function openSpotPicker() {
    var groups = {}, order = [], favs = C.Store.favs();
    D.SPOTS.forEach(function (s) {
      if (!groups[s.region]) { groups[s.region] = []; order.push(s.region); }
      groups[s.region].push(s);
    });
    var top = '';
    var favSpots = favs.map(spotById).filter(Boolean);
    if (favSpots.length) top += '<div class="groupname">Favourites</div><div class="spotlist">' + favSpots.map(function (s) { return spotRow(s, favs); }).join('') + '</div>';
    var rec = C.Store.recent().filter(function (id) { return favs.indexOf(id) < 0 && !(S.spot && S.spot.id === id); }).map(spotById).filter(Boolean).slice(0, 3);
    if (rec.length) top += '<div class="groupname">Recent</div><div class="spotlist">' + rec.map(function (s) { return spotRow(s, favs); }).join('') + '</div>';
    var customs = C.Store.customs();
    if (customs.length) top += '<div class="groupname">My places</div><div class="spotlist">' + customs.map(function (s) { return spotRow(s, favs); }).join('') + '</div>';
    var html = '<h3>Pick a spot</h3><div class="sub">Tap the star to keep a spot at the top. The target icon up top uses your location.</div>' +
      '<div class="field"><input type="text" id="spotSearch" placeholder="Search spots, or any town in Australia" autocomplete="off"></div>' +
      '<div id="geo"></div>' +
      '<div id="spotTop">' + top + '</div>' +
      '<div id="spotResults">' + order.map(function (r) {
        return '<div class="groupname">' + esc(r) + '</div><div class="spotlist">' + groups[r].map(function (s) { return spotRow(s, favs); }).join('') + '</div>';
      }).join('') + '</div>' +
      '<div class="footnote" style="margin-top:16px">Settings, catch log and licence links live under the gear below.</div>' +
      '<button class="btn ghost" id="toSettings" style="margin-top:10px">Settings &amp; catch log</button>';
    openSheet(html);
    el('sheetBody').onclick = function (e) {
      var f = e.target.closest('button[data-fav]');
      if (f) {
        var id = +f.dataset.fav, on = C.Store.favs().indexOf(id) < 0;
        C.Store.toggleFav(id);
        Array.prototype.forEach.call(el('sheetBody').querySelectorAll('button[data-fav="' + id + '"]'), function (x) { x.classList.toggle('on', on); x.textContent = on ? '★' : '☆'; });
        return;
      }
      var rm = e.target.closest('button[data-rm]');
      if (rm) {
        var rid = +rm.dataset.rm;
        C.Store.removeCustom(rid);
        if (C.Store.favs().indexOf(rid) >= 0) C.Store.toggleFav(rid);
        if (S.spot && S.spot.id === rid) { S.settings = C.Store.saveSettings({ spot: 58 }); setSpot(58); }
        closeSheet(); setTimeout(openSpotPicker, 250);
        return;
      }
      var g = e.target.closest('button[data-geo]');
      if (g) {
        var r = S.geoResults && S.geoResults[+g.dataset.geo]; if (!r) return;
        var sp = makeCustomSpot(r.name, r.admin1 || '', r.latitude, r.longitude);
        C.Store.saveSettings({ useGps: false }); S.settings = C.Store.settings();
        setSpot(sp.id); closeSheet();
        alertBanner('Added ' + esc(sp.name) + ' to your places. ' + esc(sp.note), 'info');
        return;
      }
      var b = e.target.closest('button[data-id]'); if (!b) return;
      C.Store.saveSettings({ useGps: false });
      S.settings = C.Store.settings();
      setSpot(+b.dataset.id); closeSheet();
    };
    el('toSettings').addEventListener('click', function () { closeSheet(); showView('me'); });
    var geoTimer = null;
    function geocode(q) {
      var box = el('geo'); if (!box) return;
      box.innerHTML = '<div class="muted" style="margin:6px 0 10px">Searching Australia for “' + esc(q) + '”…</div>';
      var url = 'https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=6&language=en&format=json&countryCode=AU';
      fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        if (!el('geo') || el('spotSearch').value.trim() !== q) return;
        var res = (j.results || []).filter(function (r) { return r.latitude != null; });
        S.geoResults = res;
        el('geo').innerHTML = res.length ? '<div class="groupname">Anywhere in Australia</div><div class="spotlist">' + res.map(function (r, i) {
          return '<button data-geo="' + i + '">' + esc(r.name) + '<div class="r">' + esc([r.admin2, r.admin1].filter(Boolean).join(', ')) + ' · add to my places</div></button>';
        }).join('') + '</div>' : '<div class="muted" style="margin:6px 0 10px">Nothing by that name in Australia.</div>';
      }).catch(function () { if (el('geo')) el('geo').innerHTML = '<div class="muted" style="margin:6px 0 10px">Could not reach the place search — check the signal.</div>'; });
    }
    el('spotSearch').addEventListener('input', function () {
      var q = this.value.toLowerCase();
      el('spotTop').style.display = q ? 'none' : '';
      clearTimeout(geoTimer);
      var raw = this.value.trim();
      if (raw.length >= 3) geoTimer = setTimeout(function () { geocode(raw); }, 500);
      else el('geo').innerHTML = '';
      Array.prototype.forEach.call(el('spotResults').querySelectorAll('.spotrow'), function (b) {
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
