/* map.js — a small slippy map. No dependencies, so nothing to break if a CDN
   is unreachable on the water. Handles drag, pinch, double-tap and an
   animated tile overlay for radar frames. */
(function (global) {
  'use strict';

  var TS = 256;

  function lon2x(lon, z) { return (lon + 180) / 360 * TS * Math.pow(2, z); }
  function lat2y(lat, z) {
    var s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TS * Math.pow(2, z);
  }
  function x2lon(x, z) { return x / (TS * Math.pow(2, z)) * 360 - 180; }
  function y2lat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / (TS * Math.pow(2, z));
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function MiniMap(container, opts) {
    opts = opts || {};
    this.el = container;
    this.z = opts.zoom || 9;
    this.minZ = opts.minZoom || 4;
    this.maxZ = opts.maxZoom || 13;
    this.center = { lat: opts.lat || -33.87, lon: opts.lon || 151.21 };
    this.layers = [];
    this.markers = [];
    this._raf = null;

    container.classList.add('mm');
    container.innerHTML = '';
    this.viewport = el('div', 'mm-vp');
    container.appendChild(this.viewport);
    this.markerLayer = el('div', 'mm-markers');
    container.appendChild(this.markerLayer);

    this._bind();
  }

  MiniMap.prototype.size = function () {
    return { w: this.el.clientWidth || 320, h: this.el.clientHeight || 320 };
  };

  MiniMap.prototype.addLayer = function (cfg) {
    /* cfg: {url(z,x,y)->string, opacity, maxNativeZoom, name} */
    var layer = {
      cfg: cfg, node: el('div', 'mm-layer'), tiles: {}, visible: cfg.visible !== false
    };
    layer.node.style.opacity = cfg.opacity == null ? 1 : cfg.opacity;
    layer.node.style.display = layer.visible ? '' : 'none';
    this.viewport.appendChild(layer.node);
    this.layers.push(layer);
    return layer;
  };

  MiniMap.prototype.clearLayers = function () {
    for (var i = 0; i < this.layers.length; i++) this.viewport.removeChild(this.layers[i].node);
    this.layers = [];
  };

  MiniMap.prototype.setView = function (lat, lon, z) {
    this.center.lat = lat; this.center.lon = lon;
    if (z != null) this.z = Math.max(this.minZ, Math.min(this.maxZ, z));
    this.render();
  };

  MiniMap.prototype.zoomBy = function (dz, anchor) {
    var nz = Math.max(this.minZ, Math.min(this.maxZ, this.z + dz));
    if (nz === this.z) return;
    var s = this.size();
    var ax = anchor ? anchor.x : s.w / 2, ay = anchor ? anchor.y : s.h / 2;
    var cx = lon2x(this.center.lon, this.z), cy = lat2y(this.center.lat, this.z);
    var px = cx - s.w / 2 + ax, py = cy - s.h / 2 + ay;
    var f = Math.pow(2, nz - this.z);
    var npx = px * f, npy = py * f;
    var ncx = npx - (ax - s.w / 2), ncy = npy - (ay - s.h / 2);
    this.z = nz;
    this.center.lon = x2lon(ncx, nz);
    this.center.lat = y2lat(ncy, nz);
    this.render();
  };

  MiniMap.prototype.render = function () {
    var self = this, s = this.size();
    var cx = lon2x(this.center.lon, this.z), cy = lat2y(this.center.lat, this.z);
    var left = cx - s.w / 2, top = cy - s.h / 2;
    var x0 = Math.floor(left / TS), x1 = Math.floor((left + s.w) / TS);
    var y0 = Math.floor(top / TS), y1 = Math.floor((top + s.h) / TS);
    var n = Math.pow(2, this.z);

    this.viewport.style.transform = 'translate3d(0,0,0)';

    this.layers.forEach(function (layer) {
      if (!layer.visible) { layer.node.style.display = 'none'; return; }
      layer.node.style.display = '';
      var keep = {};
      var nz = layer.cfg.maxNativeZoom != null ? Math.min(self.z, layer.cfg.maxNativeZoom) : self.z;
      var scale = Math.pow(2, self.z - nz);
      var tsz = TS * scale;
      var lx0 = Math.floor(left / tsz), lx1 = Math.floor((left + s.w) / tsz);
      var ly0 = Math.floor(top / tsz), ly1 = Math.floor((top + s.h) / tsz);
      var ln = Math.pow(2, nz);
      for (var x = lx0; x <= lx1; x++) {
        for (var y = ly0; y <= ly1; y++) {
          if (y < 0 || y >= ln) continue;
          var wx = ((x % ln) + ln) % ln;
          var key = nz + '/' + wx + '/' + y;
          keep[key] = true;
          var t = layer.tiles[key];
          if (!t) {
            t = new Image();
            t.className = 'mm-tile';
            t.decoding = 'async';
            t.alt = '';
            t.src = layer.cfg.url(nz, wx, y);
            t.onerror = function () { this.style.visibility = 'hidden'; };
            layer.tiles[key] = t;
            layer.node.appendChild(t);
          }
          t.style.width = tsz + 'px';
          t.style.height = tsz + 'px';
          t.style.transform = 'translate3d(' + (x * tsz - left) + 'px,' + (y * tsz - top) + 'px,0)';
        }
      }
      for (var k in layer.tiles) {
        if (!keep[k]) { layer.node.removeChild(layer.tiles[k]); delete layer.tiles[k]; }
      }
    });

    /* markers */
    this.markerLayer.innerHTML = '';
    this.markers.forEach(function (m) {
      var mx = lon2x(m.lon, self.z) - left, my = lat2y(m.lat, self.z) - top;
      var node = el('div', 'mm-marker ' + (m.cls || ''));
      node.style.transform = 'translate3d(' + mx + 'px,' + my + 'px,0)';
      if (m.label) node.setAttribute('data-label', m.label);
      self.markerLayer.appendChild(node);
    });

    if (this.onmove) this.onmove(this.center, this.z);
  };

  MiniMap.prototype.setMarkers = function (list) { this.markers = list || []; this.render(); };

  /* pixel position inside the container for a lat/lon, and back */
  MiniMap.prototype.project = function (lat, lon) {
    var s = this.size();
    return { x: lon2x(lon, this.z) - lon2x(this.center.lon, this.z) + s.w / 2,
             y: lat2y(lat, this.z) - lat2y(this.center.lat, this.z) + s.h / 2 };
  };
  MiniMap.prototype.unproject = function (x, y) {
    var s = this.size();
    return { lat: y2lat(lat2y(this.center.lat, this.z) - s.h / 2 + y, this.z),
             lon: x2lon(lon2x(this.center.lon, this.z) - s.w / 2 + x, this.z) };
  };
  MiniMap.prototype.bounds = function () {
    var s = this.size(), a = this.unproject(0, 0), b = this.unproject(s.w, s.h);
    return { north: a.lat, south: b.lat, west: a.lon, east: b.lon };
  };
  /* metres per pixel at the centre — the overlay sizes its grid from this */
  MiniMap.prototype.metresPerPixel = function () {
    return 40075016.686 * Math.cos(this.center.lat * Math.PI / 180) / (TS * Math.pow(2, this.z));
  };
  /* a canvas that sits over the tiles and under the markers; the caller
     draws on it after every render (see onmove) */
  MiniMap.prototype.addCanvas = function (cls) {
    var c = el('canvas', 'mm-canvas ' + (cls || ''));
    this.el.insertBefore(c, this.markerLayer);
    return c;
  };

  MiniMap.prototype._bind = function () {
    var self = this, drag = null, pinch = null, lastTap = 0;
    var vp = this.el;

    function pt(e, i) {
      var r = vp.getBoundingClientRect();
      var t = e.touches ? e.touches[i || 0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    function start(e) {
      if (e.touches && e.touches.length === 2) {
        pinch = { d: dist(pt(e, 0), pt(e, 1)), z: self.z,
                  mid: { x: (pt(e, 0).x + pt(e, 1).x) / 2, y: (pt(e, 0).y + pt(e, 1).y) / 2 } };
        drag = null;
        return;
      }
      var p = pt(e);
      drag = { x: p.x, y: p.y, lat: self.center.lat, lon: self.center.lon, moved: 0 };
      var now = Date.now();
      if (now - lastTap < 300) { self.zoomBy(1, p); lastTap = 0; drag = null; }
      else lastTap = now;
    }

    function move(e) {
      if (pinch && e.touches && e.touches.length === 2) {
        e.preventDefault();
        var d = dist(pt(e, 0), pt(e, 1));
        var dz = Math.log2(d / pinch.d);
        if (Math.abs(dz) > 0.55) {
          self.zoomBy(dz > 0 ? 1 : -1, pinch.mid);
          pinch.d = d; pinch.z = self.z;
        }
        return;
      }
      if (!drag) return;
      e.preventDefault();
      var p = pt(e);
      var dx = p.x - drag.x, dy = p.y - drag.y;
      drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
      var cx = lon2x(drag.lon, self.z) - dx, cy = lat2y(drag.lat, self.z) - dy;
      self.center.lon = x2lon(cx, self.z);
      self.center.lat = Math.max(-85, Math.min(85, y2lat(cy, self.z)));
      if (!self._raf) self._raf = requestAnimationFrame(function () { self._raf = null; self.render(); });
    }

    function end(e) {
      var tap = drag && drag.moved < 8 && !pinch ? drag : null;
      drag = null; pinch = null; self.render();
      /* a touch that did not move is a tap — hand the caller the spot under
         the finger (double-tap zoom has already fired by now and cleared drag) */
      if (tap && self.ontap) {
        var ll = self.unproject(tap.x, tap.y);
        self.ontap({ lat: ll.lat, lon: ll.lon, x: tap.x, y: tap.y });
      }
    }

    vp.addEventListener('touchstart', start, { passive: true });
    vp.addEventListener('touchmove', move, { passive: false });
    vp.addEventListener('touchend', end);
    vp.addEventListener('touchcancel', end);
    vp.addEventListener('mousedown', function (e) { start(e); e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (drag) move(e); });
    window.addEventListener('mouseup', end);
    vp.addEventListener('wheel', function (e) {
      e.preventDefault();
      self.zoomBy(e.deltaY < 0 ? 1 : -1, pt(e));
    }, { passive: false });

    var ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { self.render(); });
      ro.observe(vp);
    } else {
      window.addEventListener('resize', function () { self.render(); });
    }
  };

  /* ---- tile sources ---------------------------------------------------- */
  /* Government map services under Creative Commons Attribution, so nothing
     here depends on a company's free tier. Geoscience Australia's caches are
     in GDA94 (lat/lon), not Web Mercator, so they are asked for each tile's
     bounding box through the export endpoint, which reprojects on the fly. */
  var R = 6378137, HALF = Math.PI * R;
  function tileBBox3857(z, x, y) {
    var n = Math.pow(2, z);
    return [x / n * 2 * HALF - HALF, HALF - (y + 1) / n * 2 * HALF, (x + 1) / n * 2 * HALF - HALF, HALF - y / n * 2 * HALF];
  }
  function gaExport(service) {
    return function (z, x, y) {
      var bb = tileBBox3857(z, x, y);
      return 'https://services.ga.gov.au/gis/rest/services/' + service + '/MapServer/export?bbox=' +
        bb.map(function (v) { return v.toFixed(2); }).join(',') + '&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=false&dpi=96&f=image';
    };
  }
  /* NSW Spatial Services' cache extent (their published full extent, in
     metres); outside it their tiles are blank */
  var NSW_EXT = { x0: 15693108, x1: 17754693, y0: -4558115, y1: -3211289 };
  function inNsw(z, x, y) {
    var bb = tileBBox3857(z, x, y), cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    return cx >= NSW_EXT.x0 && cx <= NSW_EXT.x1 && cy >= NSW_EXT.y0 && cy <= NSW_EXT.y1;
  }

  var Basemaps = {
    map: {
      name: 'Map',
      url: gaExport('NationalBaseMap'),
      attribution: 'Base map © Geoscience Australia (CC BY 4.0)', maxNativeZoom: 14
    },
    topo: {
      name: 'Topo',
      url: gaExport('AUSTopo_Topographic_Basemap'),
      attribution: 'AUSTopo © Geoscience Australia (CC BY 4.0)', maxNativeZoom: 13
    },
    satellite: {
      name: 'Satellite',
      url: function (z, x, y) {
        if (inNsw(z, x, y)) return 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
        /* outside NSW there is no open imagery service yet; Esri fills the gap */
        return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x;
      },
      attribution: 'Imagery © State of NSW (Spatial Services), CC BY; outside NSW © Esri', maxNativeZoom: 18
    },
    streets: {
      name: 'Streets',
      url: function (z, x, y) { return 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Base_Map/MapServer/tile/' + z + '/' + y + '/' + x; },
      attribution: 'NSW Base Map © State of NSW (Spatial Services), CC BY', maxNativeZoom: 19
    }
  };

  global.MiniMap = MiniMap;
  global.MiniMap.Basemaps = Basemaps;
  global.MiniMap.tileBBox3857 = tileBBox3857;
})(typeof window !== 'undefined' ? window : globalThis);
