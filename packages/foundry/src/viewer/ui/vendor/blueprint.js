/*!
 * blueprint.js · explainer scenes drawn like a patent sheet
 * A scene is a plain object: parts placed on a sheet, lines between them, and
 * steps that draw parts in, move things along lines and change state, each
 * with one caption. No dependencies. In a browser it defines
 * <blueprint-scene>; in Node it exports layout() and compile() for checks.
 */
(function (root, factory) {
  'use strict';
  var prev = root.BLUEPRINT;
  var api = factory(root);
  if (prev && prev._queue) prev._queue.forEach(function (a) { api.scene(a[0], a[1]); });
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BLUEPRINT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '0.2.0';
  var HAS_DOM = typeof document !== 'undefined';

  /* ───────────── maths ───────────── */
  var clamp = function (v, a, b) { a = a == null ? 0 : a; b = b == null ? 1 : b; return v < a ? a : v > b ? b : v; };
  var ease = function (k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; };
  var lin = function (t, a, b) { return b <= a ? (t >= a ? 1 : 0) : clamp((t - a) / (b - a)); };
  var seg = function (t, a, b) { return ease(lin(t, a, b)); };
  var trap = function (t, a, b, r) { r = r || 0.2; return (t < a || t > b) ? 0 : Math.min(1, (t - a) / r, (b - t) / r); };
  var r2 = function (n) { return Math.round(n * 100) / 100; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var arr = function (v) { return v == null ? [] : Array.isArray(v) ? v : [v]; };
  var hasOwn = function (o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); };
  var dict = function () { return Object.create(null); };
  // A number from a number or a numeric string; NaN for anything else.
  var num = function (v) { return typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN; };
  var fin = function (v) { return typeof v === 'number' && isFinite(v); };
  var isObj = function (v) { return v != null && typeof v === 'object' && !Array.isArray(v); };
  var ID_RE = /^[A-Za-z0-9_-]+$/;
  // CJK ideographs, kana, hangul and full-width forms take two columns of monospace text,
  // and take about twice as long to read per character.
  var WIDE_RE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
  function cols(s) { s = String(s); var n = 0; for (var i = 0; i < s.length; i++) n += WIDE_RE.test(s.charAt(i)) ? 2 : 1; return n; }
  function lev(a, b) {
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) d[i] = [i];
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // ' (did you mean "steps"?)' when a known key is close to the unknown one.
  function hint(k, list) {
    var best = null, bd = Infinity, lk = String(k).toLowerCase();
    list.forEach(function (c) { var d = lev(lk, c.toLowerCase()); if (d < bd) { bd = d; best = c; } });
    return best && bd <= (lk.length > 4 ? 2 : 1) ? ' (did you mean "' + best + '"?)' : '';
  }
  function unknownKeys(o, known, where, warnings) {
    Object.keys(o).forEach(function (k) { if (known.indexOf(k) < 0) warnings.push(where + ': unknown key "' + k + '" is ignored' + hint(k, known)); });
  }

  /* ───────────── papers ───────────── */
  var THEMES = {
    blue:  { bg: '#1d4b8a', grid: '#2a5b9e', ink: '#eaf2ff', muted: '#a9c3ea', accent: '#ffcf4a', fail: '#ff8f80', ok: '#9df0c0' },
    linen: { bg: '#f3efe4', grid: '#e3dccb', ink: '#1c2433', muted: '#6d6656', accent: '#c4531b', fail: '#b42a1f', ok: '#2c7a4b' }
  };
  var FONT = "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace";
  // Colours go into SVG attributes and a style attribute, so only plain colour
  // syntax is accepted: #hex, rgb()/rgba()/hsl()/hsla() with numbers, a colour
  // name, or var(--name).
  var COLOR_RE = /^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgba?|hsla?)\(\s*(?:[-+]?(?:\d+\.?\d*|\.\d+)(?:%|deg|turn|rad)?\s*[,\/]?\s*){3,4}\)|[a-zA-Z]+|var\(--[A-Za-z0-9_-]+\))$/;
  var isColor = function (v) { return typeof v === 'string' && v.length <= 64 && COLOR_RE.test(v); };
  function resolveTheme(spec, opts, warnings) {
    var paper = opts.paper || spec.paper || 'blue';
    if (!hasOwn(THEMES, paper) || !isObj(THEMES[paper])) { warnings.push('unknown paper "' + paper + '" (papers: ' + Object.keys(THEMES).join(', ') + '); using blue'); paper = 'blue'; }
    var keys = Object.keys(THEMES.blue), T = Object.assign({}, THEMES[paper]);
    [['colors', spec.colors], ['opts.colors', opts.colors]].forEach(function (src) {
      var c = src[1];
      if (c == null) return;
      if (!isObj(c)) { warnings.push(src[0] + ' must be an object like { accent: "#ffcf4a" }; ignored'); return; }
      Object.keys(c).forEach(function (k) {
        if (keys.indexOf(k) < 0) { warnings.push(src[0] + ': unknown colour "' + k + '" is ignored (colours: ' + keys.join(', ') + ')' + hint(k, keys)); return; }
        var v = typeof c[k] === 'string' ? c[k].trim() : c[k];
        if (isColor(v)) T[k] = v;
        else warnings.push(src[0] + '.' + k + ': ' + JSON.stringify(String(c[k]).slice(0, 40)) + ' is not a colour (use #hex, rgb(), hsl(), a colour name or var(--name)); ignored');
      });
    });
    keys.forEach(function (k) { if (!isColor(T[k])) { warnings.push('paper "' + paper + '": colour "' + k + '" is not a colour; using the blue paper\'s'); T[k] = THEMES.blue[k]; } });
    return T;
  }

  /* ───────────── drawing helpers (local coords) ───────────── */
  function ln(d, cls) { return '<path class="bp-ln' + (cls ? ' ' + cls : '') + '" d="' + d + '" pathLength="1"/>'; }
  function sh(d) { return ln(d, 'bp-sh'); }
  function thin(d) { return ln(d, 'bp-thin'); }
  function circ(cx, cy, r, cls) { return '<circle class="bp-ln' + (cls ? ' ' + cls : '') + '" cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(r) + '" pathLength="1"/>'; }
  function pf(d) { return '<path class="bp-pf" d="' + d + '"/>'; }
  function rect(x, y, w, h) { return 'M' + r2(x) + ' ' + r2(y) + ' H' + r2(x + w) + ' V' + r2(y + h) + ' H' + r2(x) + ' Z'; }
  function shadeRect(x, y, w, h) { return 'M' + r2(x + w) + ' ' + r2(y) + ' V' + r2(y + h) + ' H' + r2(x); }
  function housing(w, h) { return pf(rect(0, 0, w, h)) + ln(rect(0, 0, w, h)) + sh(shadeRect(0, 0, w, h)); }

  /* ───────────── the parts kit ─────────────
     Every kind: size (default [w,h]), draw(w,h,p) -> markup in a box from
     (0,0) to (w,h), optional upd(k,w,h,S) for live state, labelAt default,
     and state: the keys `set` may change. */
  var KINDS = {
    box: {
      size: [96, 56], labelAt: 'in', state: ['text'],
      draw: function (w, h, p) { return housing(w, h) + (p.hatch ? '<path class="bp-ht" d="' + rect(0, 0, w, h) + '"/>' : ''); }
    },
    screen: {
      size: [100, 74], labelAt: 'in', inY: 0.4, state: ['text'],
      draw: function (w, h) {
        var s = h * 0.8;
        return pf(rect(0, 0, w, s)) + ln(rect(0, 0, w, s)) + sh(shadeRect(0, 0, w, s)) + thin(rect(5, 5, w - 10, s - 10)) +
          ln('M' + r2(w / 2 - 5) + ' ' + r2(s) + ' V' + r2(h - 2) + ' M' + r2(w / 2 + 5) + ' ' + r2(s) + ' V' + r2(h - 2)) +
          sh('M' + r2(w / 2 - 18) + ' ' + r2(h) + ' H' + r2(w / 2 + 18));
      }
    },
    cabinet: {
      size: [80, 96], labelAt: 's',
      draw: function (w, h, p) {
        var rows = p.rows || 3, o = housing(w, h);
        for (var i = 1; i < rows; i++) o += ln('M3 ' + r2(h * i / rows) + ' H' + r2(w - 3));
        for (var j = 0; j < rows; j++) o += sh('M' + r2(w / 2 - 7) + ' ' + r2(h * (j + 0.5) / rows) + ' H' + r2(w / 2 + 7));
        return o + ln('M5 ' + h + ' V' + (h + 5) + ' M' + (w - 5) + ' ' + h + ' V' + (h + 5));
      }
    },
    drum: {
      size: [72, 86], labelAt: 's',
      draw: function (w, h) {
        var e = Math.min(12, h * 0.15), a = r2(w / 2);
        var body = 'M0 ' + e + ' V' + r2(h - e) + ' A' + a + ' ' + e + ' 0 0 0 ' + w + ' ' + r2(h - e) + ' V' + e + ' Z';
        var top = 'M0 ' + e + ' A' + a + ' ' + e + ' 0 1 0 ' + w + ' ' + e + ' A' + a + ' ' + e + ' 0 1 0 0 ' + e;
        var band = function (y) { return thin('M0 ' + r2(y) + ' A' + a + ' ' + e + ' 0 0 0 ' + w + ' ' + r2(y)); };
        return pf(body) + pf(top) + ln(top) + ln('M0 ' + e + ' V' + r2(h - e)) + sh('M' + w + ' ' + e + ' V' + r2(h - e)) +
          ln('M0 ' + r2(h - e) + ' A' + a + ' ' + e + ' 0 0 0 ' + w + ' ' + r2(h - e)) + band(h * 0.4) + band(h * 0.66);
      }
    },
    drawer: {
      size: [76, 36], labelAt: 's', state: ['fill'],
      draw: function (w, h, p) {
        var n = p.slots || 3, t = h * 0.38, o = pf('M0 ' + r2(t) + ' L' + r2(w * 0.08) + ' 0 H' + r2(w * 0.92) + ' L' + w + ' ' + r2(t) + ' V' + h + ' H0 Z');
        o += ln('M0 ' + r2(t) + ' L' + r2(w * 0.08) + ' 0 H' + r2(w * 0.92) + ' L' + w + ' ' + r2(t));
        o += ln(rect(0, t, w, h - t)) + sh(shadeRect(0, t, w, h - t)) + sh('M' + r2(w / 2 - 7) + ' ' + r2(t + (h - t) / 2) + ' H' + r2(w / 2 + 7));
        for (var i = 1; i < n; i++) o += thin('M' + r2(w * 0.08 + (w * 0.84) * i / n) + ' 0 L' + r2(w * i / n) + ' ' + r2(t));
        for (var j = 0; j < n; j++) o += '<rect class="bp-ac" data-k="it' + j + '" x="' + r2(w * (j + 0.5) / n - 4.5) + '" y="' + r2(t * 0.5 - 3) + '" width="9" height="6.5" rx="1" opacity="0"/>';
        return o;
      },
      upd: function (k, w, h, S) { var f = S.get('fill', 0), n = S.p.slots || 3; for (var j = 0; j < n; j++) k['it' + j].setAttribute('opacity', r2(clamp(f - j))); }
    },
    wheel: {
      size: [50, 50], labelAt: 's',
      draw: function (w, h) {
        var r = Math.min(w, h) / 2, c = 'translate(' + r2(w / 2) + ' ' + r2(h / 2) + ')', o = '<g transform="' + c + '"><g data-k="rot">' + pf('M' + -r + ' 0 A' + r + ' ' + r + ' 0 1 0 ' + r + ' 0 A' + r + ' ' + r + ' 0 1 0 ' + -r + ' 0') + circ(0, 0, r) + circ(0, 0, r * 0.22);
        for (var i = 0; i < 6; i++) { var a = i * Math.PI / 3; o += thin('M' + r2(Math.cos(a) * r * 0.22) + ' ' + r2(Math.sin(a) * r * 0.22) + ' L' + r2(Math.cos(a) * r) + ' ' + r2(Math.sin(a) * r)); }
        return o + '</g></g>';
      },
      upd: function (k, w, h, S) { k.rot.setAttribute('transform', 'rotate(' + r2(S.spin) + ')'); }
    },
    gear: {
      size: [50, 50], labelAt: 's',
      draw: function (w, h, p) {
        var n = p.teeth || 10, ro = Math.min(w, h) / 2, ri = ro * 0.78, d = '', N = n * 4;
        for (var i = 0; i < N; i++) {
          var a = (i / N) * Math.PI * 2, rr = (i % 4 < 2) ? ro : ri;
          d += (i ? 'L' : 'M') + r2(Math.cos(a) * rr) + ' ' + r2(Math.sin(a) * rr) + ' ';
        }
        d += 'Z';
        return '<g transform="translate(' + r2(w / 2) + ' ' + r2(h / 2) + ')"><g data-k="rot">' + pf(d) + ln(d) + circ(0, 0, ro * 0.5, 'bp-thin') + circ(0, 0, ro * 0.18) + '</g></g>';
      },
      upd: function (k, w, h, S) { k.rot.setAttribute('transform', 'rotate(' + r2(S.spin) + ')'); }
    },
    hopper: {
      size: [58, 46], labelAt: 's',
      draw: function (w, h) {
        var d = 'M0 0 H' + w + ' L' + r2(w * 0.62) + ' ' + r2(h * 0.7) + ' V' + h + ' H' + r2(w * 0.38) + ' V' + r2(h * 0.7) + ' Z';
        return pf(d) + ln(d) + sh('M-3 0 H' + (w + 3)) + thin('M' + r2(w * 0.38) + ' ' + r2(h * 0.7) + ' H' + r2(w * 0.62));
      }
    },
    valve: {
      size: [30, 30], labelAt: 's', state: ['open'],
      draw: function (w, h) {
        var r = Math.min(w, h) / 2 * 0.9, cx = w / 2, cy = h / 2;
        return pf('M' + r2(cx - r) + ' ' + r2(cy) + ' A' + r2(r) + ' ' + r2(r) + ' 0 1 0 ' + r2(cx + r) + ' ' + r2(cy) + ' A' + r2(r) + ' ' + r2(r) + ' 0 1 0 ' + r2(cx - r) + ' ' + r2(cy)) +
          circ(cx, cy, r) + ln('M' + r2(cx) + ' ' + r2(cy - r) + ' V' + r2(cy - r - 7)) + sh('M' + r2(cx - 7) + ' ' + r2(cy - r - 7) + ' H' + r2(cx + 7)) +
          '<g transform="translate(' + r2(cx) + ' ' + r2(cy) + ')"><g data-k="rot">' + sh('M' + r2(-r * 0.75) + ' 0 H' + r2(r * 0.75)) + '</g></g>';
      },
      upd: function (k, w, h, S) { k.rot.setAttribute('transform', 'rotate(' + r2(90 * (1 - S.get('open', 1))) + ')'); }
    },
    gate: {
      // inkBox: the post, the only part of the drawing that never moves; numbered leaders end on it.
      size: [76, 44], labelAt: 's', state: ['open'], inkBox: [0, 0.2, 0.12, 1],
      draw: function (w, h) {
        var px = w * 0.06, py = h * 0.32, o = pf(rect(0, h * 0.2, w * 0.12, h * 0.8)) + ln(rect(0, h * 0.2, w * 0.12, h * 0.8)) + sh(shadeRect(0, h * 0.2, w * 0.12, h * 0.8));
        var arm = 'M' + r2(px) + ' ' + r2(py - 3) + ' H' + w + ' V' + r2(py + 3) + ' H' + r2(px) + ' Z';
        o += '<g data-k="arm">' + pf(arm) + ln(arm);
        for (var i = 1; i < 4; i++) { var x = px + (w - px) * i / 4; o += thin('M' + r2(x) + ' ' + r2(py - 3) + ' L' + r2(x + 5) + ' ' + r2(py + 3)); }
        return o + '</g>' + circ(px, py, 2.4);
      },
      upd: function (k, w, h, S) { k.arm.setAttribute('transform', 'rotate(' + r2(-76 * S.get('open', 0)) + ' ' + r2(w * 0.06) + ' ' + r2(h * 0.32) + ')'); }
    },
    gauge: {
      size: [56, 56], labelAt: 's', state: ['value'],
      draw: function (w, h) {
        var r = Math.min(w, h) / 2, cx = w / 2, cy = h / 2, o = pf('M' + r2(cx - r) + ' ' + r2(cy) + ' A' + r + ' ' + r + ' 0 1 0 ' + r2(cx + r) + ' ' + r2(cy) + ' A' + r + ' ' + r + ' 0 1 0 ' + r2(cx - r) + ' ' + r2(cy)) + circ(cx, cy, r);
        for (var i = 0; i <= 6; i++) { var a = (-120 + i * 40 - 90) * Math.PI / 180; o += (i === 6 ? sh : thin)('M' + r2(cx + Math.cos(a) * r * 0.74) + ' ' + r2(cy + Math.sin(a) * r * 0.74) + ' L' + r2(cx + Math.cos(a) * r * 0.9) + ' ' + r2(cy + Math.sin(a) * r * 0.9)); }
        return o + '<g transform="translate(' + r2(cx) + ' ' + r2(cy) + ')"><g data-k="rot">' + sh('M0 0 V' + r2(-r * 0.7)) + '</g></g><circle class="bp-ink" cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="3"/>';
      },
      upd: function (k, w, h, S) { k.rot.setAttribute('transform', 'rotate(' + r2(-120 + 240 * clamp(S.get('value', 0))) + ')'); }
    },
    clock: {
      size: [46, 46], labelAt: 's',
      draw: function (w, h) {
        var r = Math.min(w, h) / 2 - 2, cx = w / 2, cy = h / 2 + 2, o = pf('M' + r2(cx - r) + ' ' + r2(cy) + ' A' + r + ' ' + r + ' 0 1 0 ' + r2(cx + r) + ' ' + r2(cy) + ' A' + r + ' ' + r + ' 0 1 0 ' + r2(cx - r) + ' ' + r2(cy)) + circ(cx, cy, r);
        for (var i = 0; i < 12; i++) { var a = i * Math.PI / 6; o += thin('M' + r2(cx + Math.cos(a) * r * 0.8) + ' ' + r2(cy + Math.sin(a) * r * 0.8) + ' L' + r2(cx + Math.cos(a) * r * 0.93) + ' ' + r2(cy + Math.sin(a) * r * 0.93)); }
        o += ln('M' + r2(cx) + ' ' + r2(cy - r) + ' V' + r2(cy - r - 3)) + sh('M' + r2(cx - 4) + ' ' + r2(cy - r - 3) + ' H' + r2(cx + 4));
        return o + '<g transform="translate(' + r2(cx) + ' ' + r2(cy) + ')"><g data-k="rot">' + sh('M0 0 V' + r2(-r * 0.68)) + '</g>' + ln('M0 0 L' + r2(r * 0.42) + ' 0') + '</g>';
      },
      upd: function (k, w, h, S) { k.rot.setAttribute('transform', 'rotate(' + r2(S.spin) + ')'); }
    },
    bell: {
      size: [40, 42], labelAt: 's',
      draw: function (w, h) {
        var d = 'M' + r2(w * 0.18) + ' ' + r2(h * 0.8) + ' C' + r2(w * 0.18) + ' ' + r2(h * 0.18) + ' ' + r2(w * 0.82) + ' ' + r2(h * 0.18) + ' ' + r2(w * 0.82) + ' ' + r2(h * 0.8) + ' Z';
        return '<g data-k="sw">' + ln('M' + r2(w / 2) + ' 0 V' + r2(h * 0.3)) + pf(d) + ln(d) + sh('M' + r2(w * 0.06) + ' ' + r2(h * 0.8) + ' H' + r2(w * 0.94)) + circ(w / 2, h * 0.9, 3.4) + '</g>';
      },
      upd: function (k, w, h, S) { k.sw.setAttribute('transform', 'rotate(' + r2(S.ring * 16 * Math.sin(S.t * 38)) + ' ' + r2(w / 2) + ' 0)'); }
    },
    lamp: {
      size: [30, 42], labelAt: 's', state: ['on'],
      draw: function (w, h) {
        var cx = w / 2, cy = h * 0.38, r = w * 0.42, o = '<circle class="bp-ac" data-k="glow" cx="' + r2(cx) + '" cy="' + r2(cy) + '" r="' + r2(r) + '" opacity="0"/>';
        o += circ(cx, cy, r) + thin('M' + r2(cx - 5) + ' ' + r2(cy + 4) + ' L' + r2(cx - 2) + ' ' + r2(cy - 3) + ' L' + r2(cx + 2) + ' ' + r2(cy + 3) + ' L' + r2(cx + 5) + ' ' + r2(cy - 4));
        o += pf(rect(w * 0.3, h * 0.74, w * 0.4, h * 0.22)) + ln(rect(w * 0.3, h * 0.74, w * 0.4, h * 0.22)) + thin('M' + r2(w * 0.3) + ' ' + r2(h * 0.85) + ' H' + r2(w * 0.7));
        o += '<g data-k="rays" opacity="0">';
        for (var i = 0; i < 6; i++) { var a = (-150 + i * 24) * Math.PI / 180; o += '<path class="bp-ray" d="M' + r2(cx + Math.cos(a) * (r + 3)) + ' ' + r2(cy + Math.sin(a) * (r + 3)) + ' L' + r2(cx + Math.cos(a) * (r + 9)) + ' ' + r2(cy + Math.sin(a) * (r + 9)) + '"/>'; }
        return o + '</g>';
      },
      upd: function (k, w, h, S) { var on = clamp(Math.max(S.get('on', 0), S.light)); k.glow.setAttribute('opacity', r2(on * 0.9)); k.rays.setAttribute('opacity', r2(on)); }
    },
    lock: {
      size: [32, 40], labelAt: 's', state: ['open'],
      draw: function (w, h) {
        return '<g data-k="sk">' + ln('M' + r2(w * 0.22) + ' ' + r2(h * 0.46) + ' V' + r2(h * 0.26) + ' A' + r2(w * 0.28) + ' ' + r2(w * 0.28) + ' 0 0 1 ' + r2(w * 0.78) + ' ' + r2(h * 0.26) + ' V' + r2(h * 0.46), 'bp-sh') + '</g>' +
          pf(rect(0, h * 0.42, w, h * 0.58)) + ln(rect(0, h * 0.42, w, h * 0.58)) + sh(shadeRect(0, h * 0.42, w, h * 0.58)) + circ(w / 2, h * 0.64, 2.6) + ln('M' + r2(w / 2) + ' ' + r2(h * 0.68) + ' V' + r2(h * 0.82));
      },
      upd: function (k, w, h, S) { k.sk.setAttribute('transform', 'translate(0 ' + r2(-h * 0.18 * S.get('open', 0)) + ')'); }
    },
    key: {
      size: [38, 16], labelAt: 's',
      draw: function (w, h) { var r = h * 0.45; return circ(r + 1, h / 2, r) + circ(r + 1, h / 2, r * 0.35, 'bp-thin') + ln('M' + r2(2 * r + 1) + ' ' + r2(h / 2) + ' H' + w) + ln('M' + r2(w - 3) + ' ' + r2(h / 2) + ' V' + r2(h) + ' M' + r2(w - 9) + ' ' + r2(h / 2) + ' V' + r2(h * 0.86)); }
    },
    stack: {
      size: [56, 72], labelAt: 's', state: ['count'],
      draw: function (w, h, p) {
        var n = p.max || 6, ph = (h - 4) / n, o = sh('M-5 ' + h + ' H' + (w + 5)) + '<path class="bp-ht" d="' + rect(-5, h, w + 10, 5) + '"/>';
        for (var i = 0; i < n; i++) { var y = h - 2 - (i + 1) * ph; o += '<g data-k="pl' + i + '" opacity="0"><path class="bp-pf" d="' + rect(3, y + 1, w - 6, ph - 2.5) + '"/><path class="bp-sl" d="' + rect(3, y + 1, w - 6, ph - 2.5) + '"/></g>'; }
        return o;
      },
      upd: function (k, w, h, S) { var c = S.get('count', 0), n = S.p.max || 6; for (var i = 0; i < n; i++) { var v = clamp(c - i); k['pl' + i].setAttribute('opacity', r2(v)); k['pl' + i].setAttribute('transform', 'translate(0 ' + r2(-(1 - v) * 10) + ')'); } }
    },
    queue: {
      size: [130, 30], labelAt: 's', state: ['count'],
      draw: function (w, h, p) {
        var n = p.slots || 5, o = housing(w, h);
        for (var i = 1; i < n; i++) o += thin('M' + r2(w * i / n) + ' 3 V' + r2(h - 3));
        for (var j = 0; j < n; j++) o += '<rect class="bp-ac" data-k="it' + j + '" x="' + r2(w * (j + 0.5) / n - 6) + '" y="' + r2(h / 2 - 5) + '" width="12" height="10" rx="1.5" opacity="0"/>';
        return o;
      },
      upd: function (k, w, h, S) { var c = S.get('count', 0), n = S.p.slots || 5; for (var j = 0; j < n; j++) k['it' + j].setAttribute('opacity', r2(clamp(c - (n - 1 - j)))); }
    },
    tank: {
      size: [56, 78], labelAt: 's', state: ['level'],
      draw: function (w, h) {
        var o = pf(rect(0, 0, w, h)) + '<rect class="bp-ac" data-k="lvl" x="2" y="' + h + '" width="' + (w - 4) + '" height="0" opacity=".38"/>';
        o += '<path class="bp-acl" data-k="wave" d="" opacity="0"/>';
        o += ln('M0 0 V' + h + ' H' + w + ' V0') + sh('M' + w + ' 0 V' + h + ' H0') + ln('M-4 0 H0 M' + w + ' 0 H' + (w + 4));
        for (var i = 1; i < 4; i++) o += thin('M' + r2(w - 6) + ' ' + r2(h * i / 4) + ' H' + w);
        return o;
      },
      upd: function (k, w, h, S) {
        var L = clamp(S.get('level', 0)), y = h - (h - 3) * L;
        k.lvl.setAttribute('y', r2(y)); k.lvl.setAttribute('height', r2(h - y));
        var d = 'M2 ' + r2(y); for (var x = 2; x <= w - 2; x += 4) d += ' L' + x + ' ' + r2(y + Math.sin(x * 0.5 + S.t * 5) * 1.2);
        k.wave.setAttribute('d', d); k.wave.setAttribute('opacity', L > 0.01 ? 1 : 0);
      }
    },
    sieve: {
      size: [62, 36], labelAt: 's',
      draw: function (w, h) {
        var d = 'M0 0 H' + w + ' L' + r2(w * 0.8) + ' ' + h + ' H' + r2(w * 0.2) + ' Z', o = pf(d);
        for (var i = 1; i < 3; i++) { var y = h * i / 3, x0 = w * 0.2 * (y / h); o += thin('M' + r2(x0) + ' ' + r2(y) + ' H' + r2(w - x0)); }
        for (var j = 1; j < 6; j++) { var x = w * j / 6; o += thin('M' + r2(x) + ' 0 V' + r2(h * (x < w * 0.2 || x > w * 0.8 ? 0.5 : 1))); }
        return o + ln(d) + sh('M-3 0 H' + (w + 3));
      }
    },
    switch: {
      size: [48, 48], labelAt: 's', state: ['to'],
      draw: function (w, h, p) {
        var px = w * 0.18, py = h / 2, R = w * 0.72, outs = p.outs || [-35, 35], o = '';
        outs.forEach(function (a) { var t = a * Math.PI / 180; o += circ(px + Math.cos(t) * R, py + Math.sin(t) * R, 3); });
        return o + '<g transform="translate(' + r2(px) + ' ' + r2(py) + ')"><g data-k="rot">' + sh('M0 0 H' + r2(R - 4)) + '</g></g>' + circ(px, py, 4.5) + '<circle class="bp-ink" cx="' + r2(px) + '" cy="' + r2(py) + '" r="1.8"/>';
      },
      upd: function (k, w, h, S) {
        var outs = S.p.outs || [-35, 35], v = clamp(S.get('to', 0), 0, outs.length - 1), i = Math.floor(v), f = v - i;
        var a = outs[i] + ((outs[Math.min(i + 1, outs.length - 1)] - outs[i]) * f);
        k.rot.setAttribute('transform', 'rotate(' + r2(a) + ')');
      }
    },
    press: {
      size: [58, 82], labelAt: 's', state: ['down'],
      draw: function (w, h) {
        return pf(rect(0, 0, w, h * 0.12)) + ln(rect(0, 0, w, h * 0.12)) + sh(shadeRect(0, 0, w, h * 0.12)) +
          ln('M' + r2(w * 0.08) + ' ' + r2(h * 0.12) + ' V' + h + ' M' + r2(w * 0.92) + ' ' + r2(h * 0.12) + ' V' + h) +
          '<g data-k="ram">' + ln('M' + r2(w / 2) + ' ' + r2(h * 0.12) + ' V' + r2(h * 0.3)) + pf(rect(w * 0.24, h * 0.3, w * 0.52, h * 0.15)) + ln(rect(w * 0.24, h * 0.3, w * 0.52, h * 0.15)) + sh(shadeRect(w * 0.24, h * 0.3, w * 0.52, h * 0.15)) + '</g>' +
          pf(rect(w * 0.18, h * 0.86, w * 0.64, h * 0.14)) + '<path class="bp-ht" d="' + rect(w * 0.18, h * 0.86, w * 0.64, h * 0.14) + '"/>' + ln(rect(w * 0.18, h * 0.86, w * 0.64, h * 0.14));
      },
      upd: function (k, w, h, S) { k.ram.setAttribute('transform', 'translate(0 ' + r2(h * 0.36 * clamp(S.get('down', 0))) + ')'); }
    },
    letter: {
      size: [36, 24], labelAt: 's',
      draw: function (w, h) { return pf(rect(0, 0, w, h)) + ln(rect(0, 0, w, h)) + sh(shadeRect(0, 0, w, h)) + ln('M0 0 L' + r2(w / 2) + ' ' + r2(h * 0.58) + ' L' + w + ' 0'); }
    },
    book: {
      size: [74, 54], labelAt: 's', state: ['lines'],
      draw: function (w, h, p) {
        var L = 'M' + r2(w / 2) + ' ' + r2(h * 0.08) + ' Q' + r2(w * 0.25) + ' 0 0 ' + r2(h * 0.06) + ' V' + h + ' Q' + r2(w * 0.25) + ' ' + r2(h * 0.92) + ' ' + r2(w / 2) + ' ' + h + ' Z';
        var R = 'M' + r2(w / 2) + ' ' + r2(h * 0.08) + ' Q' + r2(w * 0.75) + ' 0 ' + w + ' ' + r2(h * 0.06) + ' V' + h + ' Q' + r2(w * 0.75) + ' ' + r2(h * 0.92) + ' ' + r2(w / 2) + ' ' + h + ' Z';
        var o = pf(L) + pf(R) + ln(L) + ln(R) + sh('M' + w + ' ' + r2(h * 0.06) + ' V' + h), n = p.max || 10, per = Math.ceil(n / 2);
        for (var i = 0; i < n; i++) {
          var left = i < per, row = i % per, y = h * 0.22 + row * (h * 0.7 / per), x0 = left ? w * 0.08 : w * 0.58, x1 = left ? w * 0.42 : w * 0.92;
          o += '<path class="bp-sl" data-k="ln' + i + '" d="M' + r2(x0) + ' ' + r2(y) + ' H' + r2(x1) + '" opacity="0"/>';
        }
        return o;
      },
      upd: function (k, w, h, S) { var c = S.get('lines', 0), n = S.p.max || 10; for (var i = 0; i < n; i++) k['ln' + i].setAttribute('opacity', r2(clamp(c - i))); }
    },
    tower: {
      size: [40, 84], labelAt: 's', state: ['on'],
      draw: function (w, h) {
        var o = ln('M' + r2(w * 0.12) + ' ' + h + ' L' + r2(w / 2) + ' ' + r2(h * 0.16) + ' L' + r2(w * 0.88) + ' ' + h) + ln('M' + r2(w / 2) + ' ' + r2(h * 0.16) + ' V0') + sh('M0 ' + h + ' H' + w);
        for (var i = 1; i < 4; i++) { var y = h * 0.16 + (h * 0.84) * i / 4, half = (w * 0.38) * i / 4; o += thin('M' + r2(w / 2 - half) + ' ' + r2(y) + ' H' + r2(w / 2 + half)); }
        o += '<g data-k="waves" opacity="0">';
        [7, 13].forEach(function (r) { o += '<path class="bp-ray" d="M' + r2(w / 2 - r) + ' ' + r2(-r * 0.2) + ' A' + r + ' ' + r + ' 0 0 1 ' + r2(w / 2 + r) + ' ' + r2(-r * 0.2) + '"/>'; });
        return o + '</g>';
      },
      upd: function (k, w, h, S) { k.waves.setAttribute('opacity', r2(clamp(Math.max(S.get('on', 0), S.light)))); }
    },
    zone: {
      size: [220, 150], labelAt: 'top', back: true,
      draw: function (w, h) { return '<rect class="bp-zone" x="0" y="0" width="' + w + '" height="' + h + '" rx="10"/>'; }
    },
    label: {
      size: [80, 14], labelAt: 'c', state: ['text'],
      draw: function () { return ''; }
    },
    dot: {
      size: [8, 8], labelAt: 's',
      draw: function (w, h) { return '<circle class="bp-ink" cx="' + r2(w / 2) + '" cy="' + r2(h / 2) + '" r="' + r2(Math.min(w, h) / 2) + '"/>'; }
    }
  };

  /* ───────────── layout ───────────── */
  var PORT_RE = /^([A-Za-z0-9_-]+)(?:\.(n|s|e|w|c|ne|nw|se|sw))?(?:([+-]\d+(?:\.\d+)?))?$/;
  var LEAD = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0], ne: [1, -1], nw: [-1, -1], se: [1, 1], sw: [-1, 1] };

  function boxOf(p) {
    var d = KINDS[p.kind].size, sz = Array.isArray(p.size) ? p.size : [], w = num(p.w != null ? p.w : (sz[0] != null ? sz[0] : d[0])), h = num(p.h != null ? p.h : (sz[1] != null ? sz[1] : d[1]));
    var cx = num(p.at[0]), cy = num(p.at[1]);
    return { x: cx - w / 2, y: cy - h / 2, w: w, h: h, cx: cx, cy: cy };
  }

  function port(ref, parts) {
    if (Array.isArray(ref)) {
      var px = num(ref[0]), py = num(ref[1]);
      if (ref.length !== 2 || !fin(px) || !fin(py)) throw new Error('a point must be [x, y] with two numbers');
      return { x: px, y: py, side: null };
    }
    var m = PORT_RE.exec(String(ref));
    if (!m) throw new Error('cannot read port "' + ref + '" (use "id", "id.e", "id.n+10" or [x, y])');
    var P = parts[m[1]];
    if (!P) throw new Error('unknown part "' + m[1] + '" in "' + ref + '"');
    var b = P.box, side = m[2] || 'c', off = m[3] ? +m[3] : 0, x = b.cx, y = b.cy;
    if (side.indexOf('n') >= 0) y = b.y;
    if (side.indexOf('s') >= 0) y = b.y + b.h;
    if (side.indexOf('e') >= 0) x = b.x + b.w;
    if (side.indexOf('w') >= 0) x = b.x;
    if (side === 'e' || side === 'w') y += off; else if (side === 'n' || side === 's') x += off;
    return { x: x, y: y, side: side === 'c' ? null : side };
  }

  function route(a, b, via, bend) {
    var pts = [[a.x, a.y]];
    if (via && via.length) via.forEach(function (v) { pts.push(v); });
    else if (bend !== 'straight' && Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5) {
      var ah = a.side === 'e' || a.side === 'w', bh = b.side === 'e' || b.side === 'w';
      var av = a.side === 'n' || a.side === 's', bv = b.side === 'n' || b.side === 's';
      var mode = bend || (ah && bv ? 'hv' : av && bh ? 'vh' : av || bv ? 'v' : 'h');
      if (mode === 'hv') pts.push([b.x, a.y]);
      else if (mode === 'vh') pts.push([a.x, b.y]);
      else if (mode === 'v') { var my = r2((a.y + b.y) / 2); pts.push([a.x, my], [b.x, my]); }
      else { var mx = r2((a.x + b.x) / 2); pts.push([mx, a.y], [mx, b.y]); }
    }
    pts.push([b.x, b.y]);
    return pts.filter(function (p, i) { return i === 0 || Math.abs(p[0] - pts[i - 1][0]) > 0.01 || Math.abs(p[1] - pts[i - 1][1]) > 0.01; });
  }

  function roundPath(pts, r) {
    var d = 'M' + r2(pts[0][0]) + ' ' + r2(pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) {
      var p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      var l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), rr = Math.min(r, l1 / 2, l2 / 2);
      if (rr < 0.5) { d += ' L' + r2(p1[0]) + ' ' + r2(p1[1]); continue; }
      var q1 = [p1[0] - (p1[0] - p0[0]) / l1 * rr, p1[1] - (p1[1] - p0[1]) / l1 * rr], q2 = [p1[0] + (p2[0] - p1[0]) / l2 * rr, p1[1] + (p2[1] - p1[1]) / l2 * rr];
      d += ' L' + r2(q1[0]) + ' ' + r2(q1[1]) + ' Q' + r2(p1[0]) + ' ' + r2(p1[1]) + ' ' + r2(q2[0]) + ' ' + r2(q2[1]);
    }
    var l = pts[pts.length - 1];
    return d + ' L' + r2(l[0]) + ' ' + r2(l[1]);
  }

  function polyAt(pts, k) {
    var L = 0, segs = [];
    for (var i = 1; i < pts.length; i++) { var s = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(s); L += s; }
    var want = L * clamp(k);
    for (var j = 0; j < segs.length; j++) {
      if (want <= segs[j] || j === segs.length - 1) { var f = segs[j] ? want / segs[j] : 0; return { x: pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, y: pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f, dx: pts[j + 1][0] - pts[j][0], dy: pts[j + 1][1] - pts[j][1] }; }
      want -= segs[j];
    }
    return { x: pts[0][0], y: pts[0][1], dx: 1, dy: 0 };
  }

  function leaderOf(P) {
    var p = P.p, b = P.box;
    if (!p.n && p.n !== 0) return null;
    var v, len = p.leadLen || 22, end;
    if (Array.isArray(p.lead)) { end = [b.cx + p.lead[0], b.cy + p.lead[1]]; var m = Math.hypot(p.lead[0], p.lead[1]) || 1; v = [p.lead[0] / m, p.lead[1] / m]; }
    else { v = LEAD[p.lead || 'ne'] || LEAD.ne; }
    var start = [b.cx + v[0] * b.w / 2 * 0.7, b.cy + v[1] * b.h / 2 * 0.7], ink = P.kind && P.kind.inkBox;
    // A part whose drawing fills only some of its box points its leader at the ink, not the gap.
    if (ink) start = [clamp(start[0], b.x + ink[0] * b.w, b.x + ink[2] * b.w), clamp(start[1], b.y + ink[1] * b.h, b.y + ink[3] * b.h)];
    if (!end) { var dia = v[0] && v[1] ? 0.72 : 1; end = [b.cx + v[0] * (b.w / 2 + len * dia), b.cy + v[1] * (b.h / 2 + len * dia)]; }
    var mx = (start[0] + end[0]) / 2, my = (start[1] + end[1]) / 2, dx = end[0] - start[0], dy = end[1] - start[1], dl = Math.hypot(dx, dy) || 1;
    var ctrl = [mx - dy / dl * 5, my + dx / dl * 5];
    var anchor = v[0] > 0.3 ? 'start' : v[0] < -0.3 ? 'end' : 'middle';
    var tx = end[0] + v[0] * 4, ty = end[1] + (v[1] > 0.3 ? 11 : v[1] < -0.3 ? -3 : 4);
    // A part that opens another sheet says so on its numeral: "3 ↗".
    return { d: 'M' + r2(start[0]) + ' ' + r2(start[1]) + ' Q' + r2(ctrl[0]) + ' ' + r2(ctrl[1]) + ' ' + r2(end[0]) + ' ' + r2(end[1]), tx: tx, ty: ty, anchor: anchor, text: String(p.n) + (p.link ? ' ↗' : '') };
  }

  // Where a part's ✓/✕ badge sits: off its top-right corner, or its top-left when the part's
  // numbered leader already goes up and to the right (the default "ne").
  function badgeAt(P) {
    var b = P.box, ld = leaderOf(P), m = ld && ld.d.match(/-?\d+(?:\.\d+)?/g), ex = m && +m[4], ey = m && +m[5];
    return ld && ex > b.cx && ey < b.cy ? { x: b.x - 2, y: b.y - 2 } : { x: b.x + b.w + 2, y: b.y - 2 };
  }

  function labelGeom(P) {
    var p = P.p, b = P.box, K = P.kind;
    if (p.label == null || p.label === '') return null;
    var lines = String(p.label).split('\n'), at = p.labelAt || K.labelAt || 's', x = b.w / 2, y, anchor = 'middle', n = lines.length;
    if (at === 'in' || at === 'c') y = b.h * (at === 'in' ? (K.inY || 0.5) : 0.5) + 3.3 - (n - 1) * 5.5;
    else if (at === 'n') y = -9 - (n - 1) * 11;
    else if (at === 'top') { x = 9; anchor = 'start'; y = 15; }
    else if (at === 'e') { x = b.w + 9; anchor = 'start'; y = b.h / 2 + 3.3 - (n - 1) * 5.5; }
    else if (at === 'w') { x = -9; anchor = 'end'; y = b.h / 2 + 3.3 - (n - 1) * 5.5; }
    else y = b.h + 15;
    if (p.kind === 'cabinet' && at === 's') y += 5;
    return { x: x, y: y, anchor: anchor, lines: lines, at: at };
  }

  var SPEC_KEYS = ['title', 'fig', 'sheet', 'paper', 'size', 'parts', 'lines', 'steps', 'colors', 'sources'];
  var PART_COMMON = ['id', 'kind', 'at', 'size', 'w', 'h', 'label', 'labelAt', 'n', 'lead', 'leadLen', 'name', 'note', 'muted', 'link'];
  var PART_EXTRA = { box: ['hatch'], cabinet: ['rows'], drawer: ['slots'], gear: ['teeth', 'rate', 'angle'], wheel: ['rate', 'angle'], clock: ['rate', 'angle'], stack: ['max'], queue: ['slots'], book: ['max'], switch: ['outs'] };
  var LINE_KEYS = ['id', 'from', 'to', 'via', 'bend', 'kind', 'label', 'labelPos', 'heavy', 'arrow', 'r'];
  var LINE_KINDS = ['track', 'pipe', 'belt', 'wire', 'dim'];
  var LABEL_AT = ['in', 'c', 's', 'n', 'e', 'w', 'top'];
  var COUNT_MAX = 64;
  var partKeys = function (kind) {
    return PART_COMMON.concat(PART_EXTRA[kind] || [], (KINDS[kind].state || []).filter(function (k) { return k !== 'text'; }));
  };
  var allPartKeys = function () {
    var all = PART_COMMON.slice();
    Object.keys(KINDS).forEach(function (k) { partKeys(k).forEach(function (x) { if (all.indexOf(x) < 0) all.push(x); }); });
    return all;
  };

  // A checked copy of a part: numbers coerced, absurd counts capped, bad
  // optional values dropped (with a warning) so the kind's default applies.
  function cleanPart(p, warnings) {
    var q = Object.assign({}, p), where = 'part "' + p.id + '"', known = partKeys(p.kind);
    Object.keys(p).forEach(function (k) {
      if (known.indexOf(k) >= 0) return;
      if (k === 'text') warnings.push(where + ': "text" does nothing on a part (use "label"; "text" belongs in a step\'s set)');
      else if (allPartKeys().indexOf(k) >= 0) warnings.push(where + ': "' + k + '" does nothing on a ' + p.kind);
      else warnings.push(where + ': unknown key "' + k + '" is ignored' + hint(k, known));
    });
    q.at = [num(p.at[0]), num(p.at[1])];
    ['slots', 'teeth', 'max', 'rows'].forEach(function (k) {
      if (q[k] == null) return;
      var v = num(q[k]);
      if (!fin(v) || v < 1) { warnings.push(where + ': "' + k + '" must be a number of at least 1; using the default'); delete q[k]; }
      else if (v > COUNT_MAX) { warnings.push(where + ': "' + k + '" is capped at ' + COUNT_MAX); q[k] = COUNT_MAX; }
      else q[k] = v;
    });
    ['leadLen', 'rate', 'angle'].forEach(function (k) {
      if (q[k] == null) return;
      var v = num(q[k]);
      if (fin(v)) q[k] = v; else { warnings.push(where + ': "' + k + '" must be a number; ignored'); delete q[k]; }
    });
    if (q.lead != null) {
      if (Array.isArray(q.lead)) {
        var lx = num(q.lead[0]), ly = num(q.lead[1]);
        if (q.lead.length === 2 && fin(lx) && fin(ly)) q.lead = [lx, ly]; else { warnings.push(where + ': "lead" as [dx, dy] needs two numbers; using ne'); delete q.lead; }
      } else if (!hasOwn(LEAD, q.lead)) { warnings.push(where + ': unknown lead "' + q.lead + '" (use n, s, e, w, ne, nw, se, sw or [dx, dy]); using ne'); delete q.lead; }
    }
    if (q.labelAt != null && LABEL_AT.indexOf(q.labelAt) < 0) warnings.push(where + ': unknown labelAt "' + q.labelAt + '" (use ' + LABEL_AT.join(', ') + ')');
    if (q.link != null && !(typeof q.link === 'string' && ID_RE.test(q.link))) { warnings.push(where + ': "link" must be a scene id (letters, digits, _ and -); ignored'); delete q.link; }
    if (q.outs != null) {
      var outs = Array.isArray(q.outs) ? q.outs.slice(0, COUNT_MAX).map(num) : [];
      if (outs.length && outs.every(fin)) { if (q.outs.length > COUNT_MAX) warnings.push(where + ': "outs" is capped at ' + COUNT_MAX); q.outs = outs; }
      else { warnings.push(where + ': "outs" must be a list of angles in degrees; using the default'); delete q.outs; }
    }
    return q;
  }

  function layout(spec) {
    var errors = [], warnings = [], size = [640, 320], parts = dict(), order = [], lines = dict();
    if (!isObj(spec)) { errors.push('the scene must be an object with parts, lines and steps'); spec = {}; }
    unknownKeys(spec, SPEC_KEYS, 'scene', warnings);
    if (spec.size != null) {
      var sw = Array.isArray(spec.size) ? num(spec.size[0]) : NaN, sh2 = Array.isArray(spec.size) ? num(spec.size[1]) : NaN;
      if (spec.size.length === 2 && fin(sw) && fin(sh2) && sw > 0 && sh2 > 0) size = [sw, sh2];
      else errors.push('"size" must be [width, height] with two positive numbers, like [640, 320]; using [640, 320]');
    }
    arr(spec.parts).forEach(function (p, i) {
      if (!isObj(p) || p.id == null || p.id === '') { errors.push('parts[' + i + '] has no id'); return; }
      if (!ID_RE.test(String(p.id))) { errors.push('parts[' + i + ']: id ' + JSON.stringify(String(p.id)) + ' may use only letters, digits, _ and -'); return; }
      if (parts[p.id]) { errors.push('duplicate part id "' + p.id + '"'); return; }
      if (!hasOwn(KINDS, p.kind)) { errors.push('part "' + p.id + '": unknown kind "' + p.kind + '" (kinds: ' + Object.keys(KINDS).join(', ') + ')'); return; }
      if (!Array.isArray(p.at) || p.at.length !== 2 || !fin(num(p.at[0])) || !fin(num(p.at[1]))) { errors.push('part "' + p.id + '": "at" must be [x, y], the centre, with two numbers'); return; }
      var q = cleanPart(p, warnings), box = boxOf(q);
      if (!fin(box.w) || !fin(box.h) || box.w < 0 || box.h < 0) { errors.push('part "' + p.id + '": "size" (or w, h) must be two numbers of 0 or more'); return; }
      parts[p.id] = { p: q, box: box, kind: KINDS[p.kind] }; order.push(String(p.id));
    });
    arr(spec.lines).forEach(function (l, i) {
      if (!isObj(l) || l.id == null || l.id === '') { errors.push('lines[' + i + '] has no id'); return; }
      if (!ID_RE.test(String(l.id))) { errors.push('lines[' + i + ']: id ' + JSON.stringify(String(l.id)) + ' may use only letters, digits, _ and -'); return; }
      if (lines[l.id] || parts[l.id]) { errors.push('duplicate id "' + l.id + '"'); return; }
      var where = 'line "' + l.id + '"';
      unknownKeys(l, LINE_KEYS, where, warnings);
      if (l.kind != null && LINE_KINDS.indexOf(l.kind) < 0) warnings.push(where + ': unknown kind "' + l.kind + '" (kinds: ' + LINE_KINDS.join(', ') + '); drawn as a track');
      var via = null;
      if (l.via != null) {
        if (!Array.isArray(l.via)) errors.push(where + ': "via" must be a list of [x, y] points; ignored');
        else {
          try { via = l.via.map(function (v) { var pt = port(Array.isArray(v) ? v : [NaN, NaN], parts); return [pt.x, pt.y]; }); }
          catch (e) { errors.push(where + ': every "via" point must be [x, y] with two numbers; ignored'); via = null; }
        }
      }
      try {
        var a = port(l.from, parts), b = port(l.to, parts), pts = route(a, b, via, l.bend);
        if (pts.length < 2) { errors.push(where + ': both ends are the same point, so there is nothing to draw (check "from" and "to")'); pts = [pts[0], pts[0].slice()]; }
        lines[l.id] = { l: l, pts: pts };
      } catch (e) { errors.push(where + ': ' + e.message); }
    });
    return { W: size[0], H: size[1], parts: parts, order: order, lines: lines, errors: errors, warnings: warnings };
  }

  /* ───────────── timeline ───────────── */
  var STEP_KEYS = ['say', 'draw', 'erase', 'run', 'spin', 'glow', 'ring', 'light', 'fail', 'ok', 'set', 'note', 'view', 'then', 'hold'];
  var THEN_KEYS = ['set', 'glow', 'ring', 'light', 'fail', 'ok', 'note', 'spin', 'hold'];
  var RUN_KEYS = ['on', 'from', 'to', 'item', 'text', 'dur', 'at', 'with', 'count', 'gap', 'arrive', 'back', 'dir', 'span', 'stay', 'ease', 'color'];
  var ARRIVE_KEYS = ['set', 'glow', 'ring', 'light', 'fail', 'ok', 'note', 'spin'];
  var NOTE_KEYS = ['at', 'text', 'dx', 'dy', 'anchor', 'keep', 'pos'];
  var ANCHORS = ['start', 'middle', 'end'];
  var RUN_COUNT_MAX = 50;
  // Reading speed in columns a second: 17 Latin characters, about 8.5 CJK ones.
  var READ_CPS = 17, REST_MIN = 1.4;
  var readTime = function (text) { return cols(text) / READ_CPS; };

  // Captions can come in several languages: say: { en: '…', zh: '…' }. The scene's languages
  // are the codes its captions use, in the order they first appear; the first is the default.
  var LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
  function sceneLangs(spec) {
    var out = [];
    arr(isObj(spec) ? spec.steps : null).forEach(function (s) {
      if (isObj(s) && isObj(s.say)) Object.keys(s.say).forEach(function (k) {
        var v = s.say[k];
        if (LANG_RE.test(k) && typeof v === 'string' && v.trim() && out.indexOf(k) < 0) out.push(k);
      });
    });
    return out;
  }
  // The scene language for a reader who prefers `wants` (most preferred first): for each
  // preference, the same tag, then the same base language (zh-CN finds zh, zh finds zh-Hans).
  function matchLang(langs, wants) {
    var low = langs.map(function (l) { return l.toLowerCase(); }), base = function (l) { return l.toLowerCase().split('-')[0]; };
    var list = arr(wants).filter(function (w) { return typeof w === 'string' && w; });
    for (var i = 0; i < list.length; i++) {
      var k = low.indexOf(list[i].toLowerCase());
      if (k >= 0) return langs[k];
      for (var j = 0; j < langs.length; j++) if (base(langs[j]) === base(list[i])) return langs[j];
    }
    return null;
  }
  // A step's caption in a language, or in the first of the scene's languages it has.
  function sayIn(st, lang, langs) {
    if (!st.says) return st.text;
    if (lang && st.says[lang] != null) return st.says[lang];
    for (var i = 0; i < langs.length; i++) if (st.says[langs[i]] != null) return st.says[langs[i]];
    return '';
  }

  // speed: how fast the motion plays (1 = as written). Rests play in real seconds at any speed,
  // and a default rest stretches so the step's caption is up long enough to read, in the
  // slowest of its languages. lang: which language st.say holds (default: the scene's first).
  function compile(spec, L, speed, lang) {
    L = L || layout(spec);
    if (!isObj(spec)) spec = {};
    speed = fin(speed) && speed > 0 ? speed : 1;
    var errors = L.errors, warnings = L.warnings, has = function (id) { return !!(L.parts[id] || L.lines[id]); };
    var langs = sceneLangs(spec);
    var sayLang = function (st) { for (var i = 0; i < langs.length; i++) if (st.says[langs[i]] != null) return langs[i]; return ''; };
    var tl = { steps: [], draws: dict(), sets: dict(), glows: [], marks: [], spins: [], rings: [], lights: [], runs: [], notes: [], views: [],
      langs: langs, lang: langs.length ? matchLang(langs, [lang]) || langs[0] : null };
    var push = function (map, id, ev) { (map[id] = map[id] || []).push(ev); };
    var check = function (where, ids, partsOnly) {
      return arr(ids).filter(function (id) {
        if (partsOnly ? L.parts[id] : has(id)) return true;
        errors.push(where + ': unknown ' + (partsOnly ? 'part' : 'part or line') + ' "' + id + '"'); return false;
      });
    };
    // An optional number: the default when absent, a warning and the default when not a number.
    var opt = function (v, def, where, min) {
      if (v == null) return def;
      var n = num(v);
      if (fin(n) && (min == null || n >= min)) return n;
      warnings.push(where + ': ' + JSON.stringify(v) + ' is not ' + (min == null ? 'a number' : 'a number of at least ' + min) + '; using ' + def);
      return def;
    };
    var steps = arr(spec.steps), t = 0.5, runSeq = 0, lastIdx = -1;
    steps.forEach(function (s, i) { if (isObj(s)) lastIdx = i; });
    steps.forEach(function (s, i) {
      var w = 'step ' + (i + 1);
      if (!isObj(s)) { errors.push(w + ' is ' + (s === null ? 'null' : 'not an object') + '; it is skipped (a step is { say, draw, run, … })'); return; }
      unknownKeys(s, STEP_KEYS, w, warnings);
      var si = tl.steps.length, st = { i: i, a: t, says: null, text: '' }, cur = t;
      if (isObj(s.say)) {
        st.says = dict();
        Object.keys(s.say).forEach(function (k) {
          var v = s.say[k];
          if (!LANG_RE.test(k)) warnings.push(w + ' say: "' + k + '" is not a language code like en, zh or pt-BR; ignored');
          else if (typeof v !== 'string' || !v.trim()) warnings.push(w + ' say: the "' + k + '" caption is empty');
          else st.says[k] = v;
        });
        var have = Object.keys(st.says);
        if (!have.length) warnings.push(w + ': no caption ("say")');
        else langs.forEach(function (k) { if (!st.says[k]) warnings.push(w + ': no "' + k + '" caption, so that language shows the "' + sayLang(st) + '" one'); });
      } else {
        st.text = s.say != null ? String(s.say) : '';
        if (!s.say) warnings.push(w + ': no caption ("say")');
        else if (langs.length) warnings.push(w + ': the caption is one plain string, so it shows in every language; give it { ' + langs.join(', ') + ' }');
      }
      st.say = sayIn(st, tl.lang, langs);
      check(w + ' draw', s.draw).forEach(function (id, k) { var a = t + k * 0.16, b = a + 0.85; push(tl.draws, id, { type: 'draw', a: a, b: b }); cur = Math.max(cur, b + 0.2); });
      check(w + ' erase', s.erase).forEach(function (id) { push(tl.draws, id, { type: 'erase', a: t, b: t + 0.5 }); cur = Math.max(cur, t + 0.5); });
      if (s.view) {
        var v = s.view, okView = v === 'all';
        if (Array.isArray(v) && v.length && v.every(fin)) {
          okView = v.length === 4 && v[2] > 0 && v[3] > 0;
          if (!okView) warnings.push(w + ' view: [x, y, w, h] needs four numbers with a positive width and height; ignored');
        } else if (!okView) {
          var ids = arr(v);
          okView = ids.length > 0 && ids.every(function (id) { return typeof id === 'string'; });
          if (!okView) warnings.push(w + ' view: use part or line ids, [x, y, w, h] or "all"; ignored');
          else ids.forEach(function (id) { if (!has(id)) warnings.push(w + ' view: unknown part or line "' + id + '"'); });
        }
        if (okView) tl.views.push({ a: t, b: t + 1.1, view: v });
      }
      var act = cur, end = act, prevEnd = act, prevStart = act;
      var arrivals = [];
      arr(s.run).forEach(function (r, j) {
        var rw = w + ' run ' + (j + 1);
        if (!isObj(r)) { errors.push(rw + ' is not an object; skipped'); return; }
        unknownKeys(r, RUN_KEYS, rw, warnings);
        if (r.on && !L.lines[r.on]) { errors.push(rw + ': unknown line "' + r.on + '"'); return; }
        if (!r.on && !(r.from && r.to)) { errors.push(rw + ': needs "on" (a line id) or "from" and "to"'); return; }
        if (!r.on) { try { port(r.from, L.parts); port(r.to, L.parts); } catch (e) { errors.push(rw + ': ' + e.message); return; } }
        var dur = opt(r.dur, 1.2, rw + ' dur', 0), at = opt(r.at, null, rw + ' at'), gap = opt(r.gap, 0.32, rw + ' gap', 0);
        var count = r.count == null ? 1 : opt(r.count, 1, rw + ' count', 1);
        if (count > RUN_COUNT_MAX) { warnings.push(rw + ': count is capped at ' + RUN_COUNT_MAX); count = RUN_COUNT_MAX; }
        count = Math.floor(count);
        var a = at != null ? act + at : r.with ? prevStart : prevEnd, rid = ++runSeq;
        for (var c = 0; c < count; c++) tl.runs.push({ r: r, a: a + c * gap, b: a + c * gap + dur, step: si, rid: rid });
        var b = a + (count - 1) * gap + dur;
        if (r.arrive != null) {
          if (!isObj(r.arrive)) errors.push(rw + ' arrive: must be an object like { set: { … } }; ignored');
          else { unknownKeys(r.arrive, ARRIVE_KEYS, rw + ' arrive', warnings); arrivals.push({ src: r.arrive, a: b, wh: rw + ' arrive' }); }
        }
        prevStart = a; prevEnd = r.with ? Math.max(prevEnd, b) : b; end = Math.max(end, b);
      });
      var winEnd = Math.max(end, act + 1.2);
      var stepMarks = [];
      var effects = function (src, a, b, wh) {
        check(wh + ' spin', src.spin, true).forEach(function (id) { tl.spins.push({ id: id, a: a, b: b }); });
        check(wh + ' glow', src.glow).forEach(function (id) { tl.glows.push({ id: id, a: a, b: b }); });
        check(wh + ' ring', src.ring, true).forEach(function (id) { tl.rings.push({ id: id, a: a, b: Math.min(b, a + 1.4) }); });
        check(wh + ' light', src.light, true).forEach(function (id) { tl.lights.push({ id: id, a: a, b: b }); });
        check(wh + ' fail', src.fail, true).forEach(function (id) { var m = { id: id, kind: 'fail', a: a }; tl.marks.push(m); stepMarks.push(m); });
        check(wh + ' ok', src.ok, true).forEach(function (id) { var m = { id: id, kind: 'ok', a: a }; tl.marks.push(m); stepMarks.push(m); });
        if (src.set != null && !isObj(src.set)) errors.push(wh + ' set: must be an object like { drawer: { fill: 1 } }; ignored');
        else if (src.set) Object.keys(src.set).forEach(function (id) {
          if (!L.parts[id]) { errors.push(wh + ' set: unknown part "' + id + '"'); return; }
          var K = L.parts[id].kind, vals = src.set[id];
          if (!isObj(vals)) { errors.push(wh + ' set: "' + id + '" needs an object of state values, like { ' + ((K.state || ['text'])[0]) + ': 1 }, not ' + (vals === null ? 'null' : JSON.stringify(vals))); return; }
          Object.keys(vals).forEach(function (key) {
            if ((K.state || []).indexOf(key) < 0 && key !== 'text') warnings.push(wh + ' set: "' + key + '" does nothing on a ' + L.parts[id].p.kind + ' (it takes: ' + ((K.state || []).concat(['text']).join(', ')) + ')');
            push(tl.sets, id, { a: a, key: key, v: vals[key] });
          });
        });
        arr(src.note).forEach(function (n) {
          if (!isObj(n) || n.text == null) { errors.push(wh + ' note: needs "text"'); return; }
          unknownKeys(n, NOTE_KEYS, wh + ' note', warnings);
          if (Array.isArray(n.at)) { try { port(n.at, L.parts); } catch (e) { errors.push(wh + ' note: ' + e.message); return; } }
          else if (!L.lines[n.at]) { try { port(n.at, L.parts); } catch (e) { errors.push(wh + ' note: ' + e.message); return; } }
          if (n.anchor != null && ANCHORS.indexOf(n.anchor) < 0) warnings.push(wh + ' note: anchor must be start, middle or end; ignored');
          var m = { n: n, a: a }; tl.notes.push(m); stepMarks.push(m);
        });
      };
      effects(s, act, winEnd, w);
      arrivals.forEach(function (x) { effects(x.src, x.a, x.a + 0.9, x.wh); });
      var last = winEnd;
      if (s.then != null && !isObj(s.then)) errors.push(w + ' then: must be an object like { set: { … } }; ignored');
      else if (s.then) {
        Object.keys(s.then).forEach(function (k) { if (THEN_KEYS.indexOf(k) < 0) warnings.push(w + ' then: "' + k + '" is not allowed here' + hint(k, THEN_KEYS)); });
        effects(s.then, winEnd, winEnd + 1.0, w + ' then');
        last = winEnd + 0.9;
      }
      var hv = s.hold != null ? s.hold : (isObj(s.then) && s.then.hold != null ? s.then.hold : null), hold = num(hv);
      // Reading time per language; the step rests for the slowest, so one timeline fits all.
      st.reads = dict();
      if (st.says) Object.keys(st.says).forEach(function (k) { st.reads[k] = readTime(st.says[k]); });
      else st.reads[''] = readTime(st.text);
      st.r = last; st.read = Math.max.apply(null, [0].concat(Object.keys(st.reads).map(function (k) { return st.reads[k]; })));
      st.held = hv != null && fin(hold) && hold >= 0;
      if (hv != null && !st.held) warnings.push(w + ' hold: ' + JSON.stringify(hv) + ' is not a number of at least 0; using the default rest');
      st.b = last + (st.held ? hold : Math.max(REST_MIN, st.read - (last - st.a) / speed));
      var isLast = i === lastIdx;
      stepMarks.forEach(function (m) { m.b = (m.n && m.n.keep) || isLast ? Infinity : st.b + 0.25; });
      tl.steps.push(st);
      t = st.b;
    });
    // State changes apply in time order, whatever order the runs were written in.
    Object.keys(tl.sets).forEach(function (id) { tl.sets[id].sort(function (x, y) { return x.a - y.a; }); });
    tl.total = t + 0.4;
    tl.period = tl.total + 1.1;
    tl.speed = speed;
    return tl;
  }

  // Real seconds against timeline seconds. Motion (up to each step's rest, r) plays at the
  // timeline's speed; rests (r to b) and the finished sheet play in real time.
  function pace(tl) {
    var s = tl.speed || 1, ks = [[0, 0]], at = 0, real = 0;
    var to = function (t, rate) { if (t > at) { real += (t - at) / rate; at = t; ks.push([at, real]); } };
    tl.steps.forEach(function (st) { to(st.r, s); to(st.b, 1); });
    to(tl.period, 1);
    var map = function (x, i, j) {
      for (var k = 1; k < ks.length; k++) if (x <= ks[k][i] || k === ks.length - 1) {
        var p = ks[k - 1], q = ks[k];
        return q[i] === p[i] ? q[j] : p[j] + (q[j] - p[j]) * (x - p[i]) / (q[i] - p[i]);
      }
      return x;
    };
    return { total: map(tl.total, 0, 1), period: real, scene: function (r) { return map(r, 1, 0); }, real: function (t) { return map(t, 0, 1); } };
  }

  /* ───────────── state at time t ───────────── */
  function drawState(evs, t) {
    if (!evs || !evs.length) return { d: 1, o: 1, first: null };
    var first = null, last = null;
    for (var i = 0; i < evs.length; i++) { if (evs[i].type === 'draw' && !first) first = evs[i]; if (evs[i].a <= t) last = evs[i]; }
    if (!last) return { d: first ? 0 : 1, o: 1, first: first };
    if (last.type === 'draw') return { d: seg(t, last.a, last.b), o: 1, first: first, cur: last };
    return { d: 1, o: 1 - seg(t, last.a, last.b), first: first };
  }
  function valueAt(list, key, t, init) {
    var v = init;
    if (!list) return v;
    for (var i = 0; i < list.length; i++) {
      var s = list[i]; if (s.key !== key || s.a > t) continue;
      var k = seg(t, s.a, s.a + 0.45), to = s.v;
      if (typeof to === 'boolean') to = to ? 1 : 0;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      if (typeof to === 'number' && typeof v === 'number') v = v + (to - v) * k; else v = k >= 0.5 ? to : v;
    }
    return v;
  }

  /* ───────────── browser rendering ───────────── */
  var SCENES = dict();
  var uid = 0;
  var CSS = [
    'blueprint-scene{display:block}',
    '.bp-wrap{position:relative}',
    '.bp-svg{display:block;width:100%;height:auto;border-radius:6px;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.bp-svg .bp-ln{fill:none;stroke:var(--bp-ink);stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1 1}',
    '.bp-svg .bp-sh{stroke-width:2.6}',
    '.bp-svg .bp-thin{stroke-width:.85}',
    '.bp-svg .bp-pf{fill:var(--bp-paper);stroke:none}',
    '.bp-svg .bp-ht{fill:var(--bp-hatch);stroke:none}',
    '.bp-svg .bp-sl{fill:none;stroke:var(--bp-ink);stroke-width:1.2;stroke-linecap:round}',
    '.bp-svg .bp-ac{fill:var(--bp-accent)}',
    '.bp-svg .bp-acl{fill:none;stroke:var(--bp-accent);stroke-width:1.4}',
    '.bp-svg .bp-ray{fill:none;stroke:var(--bp-accent);stroke-width:1.6;stroke-linecap:round}',
    '.bp-svg .bp-ink{fill:var(--bp-ink)}',
    '.bp-svg .bp-zone{fill:none;stroke:var(--bp-muted);stroke-width:1;stroke-dasharray:6 4}',
    '.bp-svg .bp-wire{fill:none;stroke:var(--bp-muted);stroke-width:1.1;stroke-dasharray:4 3;stroke-linecap:round}',
    '.bp-svg .bp-po{stroke-width:8}',
    '.bp-svg .bp-pi{stroke:var(--bp-paper);stroke-width:5}',
    '.bp-svg .bp-bo{stroke-width:7}',
    '.bp-svg .bp-bi{stroke:var(--bp-paper);stroke-width:4.4}',
    '.bp-svg .bp-bt{fill:none;stroke:var(--bp-ink);stroke-width:4.4;stroke-dasharray:1.5 7;opacity:.55}',
    '.bp-svg text{font-family:var(--bp-font);fill:var(--bp-ink)}',
    '.bp-svg .bp-tx{font-size:9.5px;letter-spacing:.08em}',
    '.bp-svg .bp-num{font-size:12px;font-weight:500}',
    '.bp-svg .bp-mu{fill:var(--bp-muted)}',
    '.bp-svg .bp-cap{font-size:11px;letter-spacing:.06em}',
    '.bp-svg .bp-hd{font-size:10px;letter-spacing:.16em}',
    '.bp-svg .bp-note{font-size:9.5px;letter-spacing:.04em;fill:var(--bp-accent)}',
    '.bp-svg .bp-glow{fill:none;stroke:var(--bp-accent);stroke-width:1.6;stroke-dasharray:4 3}',
    '.bp-bar{display:flex;align-items:center;gap:6px;margin-top:8px;font:500 11px/1 var(--bp-font);letter-spacing:.06em;flex-wrap:wrap}',
    '.bp-bar button{font:inherit;letter-spacing:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.45);border-radius:6px;padding:6px 9px;cursor:pointer;min-height:28px}',
    '.bp-bar button:hover{border-color:currentColor}',
    '.bp-bar button:focus-visible{outline:2px solid currentColor;outline-offset:2px}',
    '.bp-bar .bp-pos{opacity:.7;padding:0 4px;font-variant-numeric:tabular-nums}',
    '.bp-dots{display:flex;gap:2px;margin-left:auto}',
    '.bp-dots button{border:0;padding:0 3px;min-height:24px;min-width:18px;display:flex;align-items:center}',
    '.bp-dots button::before{content:"";display:block;width:14px;height:5px;border-radius:3px;background:currentColor;opacity:.25}',
    '.bp-dots button[aria-current="step"]::before{opacity:1}',
    '.bp-key{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:4px;font:400 12px/1.45 var(--bp-font)}',
    '.bp-key b{font-weight:600;display:inline-block;min-width:1.6em}',
    '.bp-svg:focus-visible{outline:2px solid var(--bp-accent);outline-offset:-5px}',
    '.bp-svg .bp-link{cursor:pointer;outline:none}',
    '.bp-svg .bp-lring{fill:none;stroke:var(--bp-accent);stroke-width:1.4;stroke-dasharray:4 3;opacity:0;transition:opacity .15s}',
    '.bp-svg .bp-link:hover .bp-lring,.bp-svg .bp-link:focus-visible .bp-lring{opacity:1}',
    '.bp-bar [aria-pressed="true"]{border-color:currentColor}',
    '.bp-err{border:1.6px solid;border-radius:6px;padding:18px 20px;font:400 12px/1.5 ' + FONT + ';letter-spacing:.04em;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.bp-err-hd{font-size:10px;letter-spacing:.16em;opacity:.8;margin:0 0 6px}'
  ].join('\n');

  // The base CSS and the web font are separate: a scene mounted with
  // font: false never stops a later scene from loading the font.
  function injectCSS() {
    if (!HAS_DOM || document.getElementById('bp-css')) return;
    var s = document.createElement('style'); s.id = 'bp-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  function injectFont() {
    if (!HAS_DOM || document.getElementById('bp-font')) return;
    var l = document.createElement('link'); l.id = 'bp-font'; l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap'; document.head.appendChild(l);
  }

  // The first characters of s that fit in n columns.
  function fitCols(s, n) { var c = 0, i = 0; while (i < s.length && c + cols(s.charAt(i)) <= n) { c += cols(s.charAt(i)); i++; } return s.slice(0, i); }
  // Where a caption may break: between words, and between CJK characters (which have no
  // spaces), but never before closing punctuation. sp: a space comes before this piece.
  var CLOSE_RE = /^[\u3001\u3002\uff0c\uff0e\uff01\uff1f\uff1a\uff1b\uff09\u300d\u300f\u3009\u300b,.!?:;)]$/;
  function capTokens(text, max) {
    var out = [];
    text.split(' ').forEach(function (w, wi) {
      var cur = '', first = true;
      var push = function (s) { if (!s) return; out.push({ t: s, sp: first && wi > 0 }); first = false; };
      for (var i = 0; i < w.length; i++) {
        var ch = w.charAt(i);
        if (WIDE_RE.test(ch) && !CLOSE_RE.test(ch)) { push(cur); cur = ''; push(ch); }
        else if (CLOSE_RE.test(ch) && !cur && out.length && !first) out[out.length - 1].t += ch;
        else cur += ch;
      }
      push(cur);
    });
    // A word wider than a whole row is cut into pieces that fit.
    var fit = [];
    out.forEach(function (x) { var t = x.t, sp = x.sp; while (cols(t) > max) { var k = fitCols(t, max); fit.push({ t: k, sp: sp }); t = t.slice(k.length); sp = false; } if (t) fit.push({ t: t, sp: sp }); });
    return fit;
  }
  // Up to `rows` rows of at most `max` columns. Two rows are balanced; a
  // longer caption fills rows greedily and the last row ends in an ellipsis.
  var CAP_ROWS = 3;
  function wrapCaption(text, max, rows) {
    rows = rows || CAP_ROWS; max = Math.max(8, max);
    text = String(text).replace(/\s+/g, ' ').trim();
    if (cols(text) <= max) return [text];
    var tk = capTokens(text, max), join = function (a, x) { return a ? a + (x.sp ? ' ' : '') + x.t : x.t; };
    var half = Math.min(max, Math.ceil(cols(text) / 2) + 6), a = tk[0].t, i = 1;
    while (i < tk.length && cols(join(a, tk[i])) <= half) { a = join(a, tk[i]); i++; }
    var b = ''; for (var j = i; j < tk.length; j++) b = join(b, tk[j]);
    if (cols(b) <= max) return b ? [a, b] : [a];
    var out = [], cur = '';
    tk.forEach(function (x) { if (!cur) cur = x.t; else if (cols(join(cur, x)) <= max) cur = join(cur, x); else { out.push(cur); cur = x.t; } });
    if (cur) out.push(cur);
    if (out.length > rows) { out = out.slice(0, rows); out[rows - 1] = fitCols(out[rows - 1], max - 1).replace(/\s+$/, '') + '\u2026'; }
    return out;
  }

  function tokenMarkup(r) {
    var kind = r.item || 'ball', col = r.color === 'fail' ? 'var(--bp-fail)' : r.color === 'ok' ? 'var(--bp-ok)' : r.color === 'ink' ? 'var(--bp-ink)' : 'var(--bp-accent)';
    var st = 'fill:' + col;
    if (kind === 'packet') return '<rect x="-6.5" y="-4.5" width="13" height="9" rx="1.5" style="' + st + '"/>';
    if (kind === 'bit') return '<rect x="-3.5" y="-3.5" width="7" height="7" style="' + st + '"/>';
    if (kind === 'letter') return '<rect x="-8" y="-5.5" width="16" height="11" style="' + st + '"/><path d="M-8 -5.5 L0 1 L8 -5.5" style="fill:none;stroke:var(--bp-paper);stroke-width:1.2"/>';
    if (kind === 'key') return '<circle cx="-5" cy="0" r="4" style="fill:none;stroke:' + col + ';stroke-width:2.2"/><path d="M-1 0 H8 M6 0 V4 M3 0 V3" style="fill:none;stroke:' + col + ';stroke-width:2.2;stroke-linecap:round"/>';
    if (kind === 'chip') {
      var txt = String(r.text || ''), w = Math.max(18, txt.length * 6.1 + 10);
      return '<rect x="' + r2(-w / 2) + '" y="-7.5" width="' + r2(w) + '" height="15" rx="3" style="' + st + '"/><text x="0" y="3.2" text-anchor="middle" style="fill:var(--bp-paper);font-size:9px;font-weight:600;letter-spacing:.04em">' + esc(txt) + '</text>';
    }
    return '<circle r="4.6" style="' + st + '"/>';
  }

  function build(spec, theme, speed, lang) {
    var L = layout(spec), tl = compile(spec, L, speed, lang), id = 'bp' + (++uid), W = L.W, H = L.H;
    var OW = W + 32, OH = H + 96, T = theme;
    var o = '<svg class="bp-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + OW + ' ' + OH + '" role="img" style="--bp-ink:' + T.ink + ';--bp-muted:' + T.muted + ';--bp-accent:' + T.accent + ';--bp-paper:' + T.bg + ';--bp-fail:' + T.fail + ';--bp-ok:' + T.ok + ';--bp-font:' + FONT + ';--bp-hatch:url(#' + id + '-h)">';
    o += '<defs><pattern id="' + id + '-g" width="16" height="16" patternUnits="userSpaceOnUse"><path d="M16 0 H0 V16" fill="none" stroke="' + T.grid + '" stroke-width=".7"/></pattern>' +
      '<pattern id="' + id + '-h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0 V5" stroke="' + T.ink + '" stroke-width=".8" opacity=".55"/></pattern></defs>';
    o += '<rect width="' + OW + '" height="' + OH + '" fill="' + T.bg + '"/><rect width="' + OW + '" height="' + OH + '" fill="url(#' + id + '-g)"/>';
    o += '<rect x="6.5" y="6.5" width="' + (OW - 13) + '" height="' + (OH - 13) + '" fill="none" stroke="' + T.ink + '" stroke-width="1.6"/><rect x="10.5" y="10.5" width="' + (OW - 21) + '" height="' + (OH - 21) + '" fill="none" stroke="' + T.ink + '" stroke-width=".6"/>';
    o += '<text class="bp-hd" x="22" y="30">FIG. ' + esc(spec.fig || 1) + '</text>';
    o += '<text class="bp-hd" x="' + OW / 2 + '" y="30" text-anchor="middle">' + esc(String(spec.title || '').toUpperCase()) + '</text>';
    o += '<text class="bp-hd bp-mu" x="' + (OW - 22) + '" y="30" text-anchor="end">' + esc(spec.sheet || 'SHEET 1 OF 1') + '</text>';
    o += '<line x1="10.5" y1="40.5" x2="' + (OW - 10.5) + '" y2="40.5" stroke="' + T.ink + '" stroke-width=".6"/>';
    o += '<svg data-k="cam" x="16" y="44" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" overflow="hidden"><g data-k="all">';
    // zones behind lines, then lines, then parts
    var partMarkup = function (pid) {
      var P = L.parts[pid], b = P.box, K = P.kind, ld = leaderOf(P), s = '';
      var settable = (tl.sets[pid] || []).some(function (e) { return e.key === 'text'; });
      var lg = labelGeom(P) || (settable ? labelGeom({ p: Object.assign({}, P.p, { label: ' ' }), box: b, kind: K }) : null);
      var link = P.p.link, to = link && SCENES[link], go = link ? 'Open ' + (to ? (to.fig != null ? 'FIG. ' + to.fig + ': ' : '') + (to.title || link) : 'the sheet "' + link + '"') : '';
      s += '<g data-part="' + pid + '"' + (link ? ' class="bp-link" data-link="' + esc(link) + '" tabindex="0" role="link" aria-label="' + esc((P.p.name || P.p.label || pid) + '. ' + go) + '"' : '') + ' transform="translate(' + r2(b.x) + ' ' + r2(b.y) + ')">';
      if (link) s += '<title>' + esc(go) + '</title><rect class="bp-lring" x="-7" y="-7" width="' + r2(b.w + 14) + '" height="' + r2(b.h + 14) + '" rx="7"/>';
      s += '<g data-k="body">' + K.draw(b.w, b.h, P.p);
      s += '</g>';
      if (lg) s += '<text class="bp-tx' + (P.p.muted ? ' bp-mu' : '') + '" data-k="label" x="' + r2(lg.x) + '" y="' + r2(lg.y) + '" text-anchor="' + lg.anchor + '">' + lg.lines.map(function (t, i) { return '<tspan x="' + r2(lg.x) + '" dy="' + (i ? 11 : 0) + '">' + esc(t) + '</tspan>'; }).join('') + '</text>';
      if (ld) s += '<g data-k="lead"><path class="bp-ln bp-thin" d="' + ld.d + '" pathLength="1" transform="translate(' + r2(-b.x) + ' ' + r2(-b.y) + ')"/><text class="bp-num" x="' + r2(ld.tx - b.x) + '" y="' + r2(ld.ty - b.y) + '" text-anchor="' + ld.anchor + '">' + esc(ld.text) + '</text></g>';
      return s + '</g>';
    };
    L.order.filter(function (p) { return L.parts[p].kind.back; }).forEach(function (p) { o += partMarkup(p); });
    Object.keys(L.lines).forEach(function (lid) {
      var X = L.lines[lid], l = X.l, d = roundPath(X.pts, fin(num(l.r)) ? num(l.r) : 10), k = l.kind || 'track', s = '<g data-line="' + lid + '">';
      if (k === 'pipe') s += ln(d, 'bp-po') + ln(d, 'bp-pi');
      else if (k === 'belt') s += ln(d, 'bp-bo') + ln(d, 'bp-bi') + '<path class="bp-bt" data-k="belt" d="' + d + '"/>';
      else if (k === 'wire') s += '<path class="bp-wire" d="' + d + '"/>';
      else if (k === 'dim') {
        s += ln(d, 'bp-thin');
        [[X.pts[0], X.pts[1]], [X.pts[X.pts.length - 1], X.pts[X.pts.length - 2]]].forEach(function (e) {
          var tip = e[0], pr = e[1], dx = tip[0] - pr[0], dy = tip[1] - pr[1], m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
          s += thin('M' + r2(tip[0] - dx * 7 - dy * 3.5) + ' ' + r2(tip[1] - dy * 7 + dx * 3.5) + ' L' + r2(tip[0]) + ' ' + r2(tip[1]) + ' L' + r2(tip[0] - dx * 7 + dy * 3.5) + ' ' + r2(tip[1] - dy * 7 - dx * 3.5));
          s += thin('M' + r2(tip[0] - dy * 7) + ' ' + r2(tip[1] + dx * 7) + ' L' + r2(tip[0] + dy * 7) + ' ' + r2(tip[1] - dx * 7));
        });
      }
      else s += ln(d, l.heavy ? 'bp-sh' : '');
      s += '<path data-k="path" d="' + d + '" fill="none" stroke="none"/>';
      var ends = l.arrow === 'both' ? ['end', 'start'] : l.arrow ? ['end'] : [];
      ends.forEach(function (e) {
        var pts = X.pts, tip = e === 'end' ? pts[pts.length - 1] : pts[0], pr = e === 'end' ? pts[pts.length - 2] : pts[1];
        var dx = tip[0] - pr[0], dy = tip[1] - pr[1], m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m;
        s += ln('M' + r2(tip[0] - dx * 8 - dy * 4.5) + ' ' + r2(tip[1] - dy * 8 + dx * 4.5) + ' L' + r2(tip[0]) + ' ' + r2(tip[1]) + ' L' + r2(tip[0] - dx * 8 + dy * 4.5) + ' ' + r2(tip[1] - dy * 8 - dx * 4.5));
      });
      if (l.label) {
        var at = polyAt(X.pts, fin(num(l.labelPos)) ? num(l.labelPos) : 0.5), horiz = Math.abs(at.dx) >= Math.abs(at.dy), tw = String(l.label).length * 6.3 + 6;
        var lx = horiz ? at.x : at.x + 8, ly = horiz ? at.y - (k === 'pipe' ? 9 : 6) : at.y + 3.3, an = horiz ? 'middle' : 'start';
        var bx = an === 'middle' ? lx - tw / 2 : lx - 3;
        s += '<rect class="bp-pf" data-k="lbg" x="' + r2(bx) + '" y="' + r2(ly - 9) + '" width="' + r2(tw) + '" height="12"/><text class="bp-tx bp-mu" data-k="label" x="' + r2(lx) + '" y="' + r2(ly) + '" text-anchor="' + an + '">' + esc(l.label) + '</text>';
      }
      o += s + '</g>';
    });
    L.order.filter(function (p) { return !L.parts[p].kind.back; }).forEach(function (p) { o += partMarkup(p); });
    // marks layer
    tl.glows.forEach(function (g, i) {
      var P = L.parts[g.id], b;
      if (P) b = P.box; else { var pts = L.lines[g.id].pts, xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; }); b = { x: Math.min.apply(0, xs), y: Math.min.apply(0, ys) }; b.w = Math.max.apply(0, xs) - b.x; b.h = Math.max.apply(0, ys) - b.y; }
      o += '<rect class="bp-glow" data-k="glow' + i + '" x="' + r2(b.x - 7) + '" y="' + r2(b.y - 7) + '" width="' + r2(b.w + 14) + '" height="' + r2(b.h + 14) + '" rx="7" opacity="0"/>';
    });
    tl.marks.forEach(function (m, i) {
      var at = badgeAt(L.parts[m.id]), x = at.x, y = at.y, c = m.kind === 'fail' ? 'var(--bp-fail)' : 'var(--bp-ok)';
      o += '<g data-k="mark' + i + '" opacity="0" transform="translate(' + r2(x) + ' ' + r2(y) + ')"><circle r="8" style="fill:var(--bp-paper);stroke:' + c + ';stroke-width:1.8"/>' +
        (m.kind === 'fail' ? '<path d="M-3.4 -3.4 L3.4 3.4 M3.4 -3.4 L-3.4 3.4" style="fill:none;stroke:' + c + ';stroke-width:2;stroke-linecap:round"/>' : '<path d="M-3.8 0.2 L-1 3 L4 -3" style="fill:none;stroke:' + c + ';stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/>') + '</g>';
    });
    tl.notes.forEach(function (m, i) {
      var n = m.n, pos = fin(num(n.pos)) ? num(n.pos) : 0.5, ndx = num(n.dx), ndy = num(n.dy);
      var p = !Array.isArray(n.at) && L.lines[n.at] ? (function (q) { return { x: q.x, y: q.y, side: 'n' }; })(polyAt(L.lines[n.at].pts, pos)) : port(n.at, L.parts);
      var dx = fin(ndx) ? ndx : (p.side && p.side.indexOf('w') >= 0 ? -6 : 6), dy = fin(ndy) ? ndy : (p.side === 'n' ? -6 : p.side === 's' ? 14 : 3);
      var an = ANCHORS.indexOf(n.anchor) >= 0 ? n.anchor : (dx < 0 ? 'end' : p.side === 'n' || p.side === 's' ? 'middle' : 'start');
      o += '<text class="bp-note" data-k="note' + i + '" opacity="0" x="' + r2(p.x + dx) + '" y="' + r2(p.y + dy) + '" text-anchor="' + an + '">' + String(n.text).split('\n').map(function (t, j) { return '<tspan x="' + r2(p.x + dx) + '" dy="' + (j ? 11 : 0) + '">' + esc(t) + '</tspan>'; }).join('') + '</text>';
    });
    tl.runs.forEach(function (R, i) {
      if (!R.r.on) { var a = port(R.r.from, L.parts), b = port(R.r.to, L.parts); o += '<path data-k="rp' + i + '" d="M' + r2(a.x) + ' ' + r2(a.y) + ' L' + r2(b.x) + ' ' + r2(b.y) + '" fill="none" stroke="none"/>'; }
      o += '<g data-k="tok' + i + '" opacity="0">' + tokenMarkup(R.r) + '</g>';
    });
    o += '</g></svg>';
    // caption band
    o += '<line x1="10.5" y1="' + (OH - 46.5) + '" x2="' + (OW - 10.5) + '" y2="' + (OH - 46.5) + '" stroke="' + T.ink + '" stroke-width=".6"/>';
    o += '<text class="bp-cap" data-k="cap" x="22" y="' + (OH - 25) + '"></text>';
    o += '<text class="bp-hd bp-mu" data-k="pos" x="' + (OW - 22) + '" y="' + (OH - 25) + '" text-anchor="end"></text>';
    o += '</svg>';
    return { markup: o, L: L, tl: tl, OW: OW, OH: OH };
  }

  function viewRect(v, L) {
    if (v === 'all' || !v) return [0, 0, L.W, L.H];
    var r;
    if (typeof v[0] === 'number') r = v.slice();
    else {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      arr(v).forEach(function (id) {
        var P = L.parts[id]; if (P) { x0 = Math.min(x0, P.box.x); y0 = Math.min(y0, P.box.y); x1 = Math.max(x1, P.box.x + P.box.w); y1 = Math.max(y1, P.box.y + P.box.h); }
        var X = L.lines[id]; if (X) X.pts.forEach(function (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); });
      });
      if (x0 === Infinity) return [0, 0, L.W, L.H];
      r = [x0 - 44, y0 - 44, x1 - x0 + 88, y1 - y0 + 88];
    }
    var minW = L.W * 0.55; if (r[2] < minW) { r[0] -= (minW - r[2]) / 2; r[2] = minW; }
    var asp = L.W / L.H;
    if (r[2] / r[3] > asp) { var nh = r[2] / asp; r[1] -= (nh - r[3]) / 2; r[3] = nh; } else { var nw = r[3] * asp; r[0] -= (nw - r[2]) / 2; r[2] = nw; }
    if (r[2] > L.W) return [0, 0, L.W, L.H];
    r[0] = clamp(r[0], 0, L.W - r[2]); r[1] = clamp(r[1], 0, L.H - r[3]);
    return r;
  }

  // Scenes that are playing and on screen. The frame loop stops when it is empty.
  var live = new Set(), raf = 0, lastNow = 0;
  function loop(now) {
    var dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0; lastNow = now;
    live.forEach(function (c) { c._tick(dt); });
    raf = live.size ? root.requestAnimationFrame(loop) : 0; if (!raf) lastNow = 0;
  }
  function wake() { if (!raf && live.size) { lastNow = 0; raf = root.requestAnimationFrame(loop); } }

  // Write an attribute or style only when its value changed.
  function sa(el, k, v) { var c = el.__bpa || (el.__bpa = {}); if (c[k] === v) return; c[k] = v; el.setAttribute(k, v); }
  function ss(el, k, v) { var c = el.__bps || (el.__bps = {}); if (c[k] === v) return; c[k] = v; el.style[k] = v; }

  // A belt moves while something runs on it: once per run (not per copy), at
  // one speed, in the direction of the run that started last.
  function beltSegs(runs) {
    var byRun = dict(), list = [], cuts = [], segs = [];
    runs.forEach(function (R) {
      var g = byRun[R.rid];
      if (!g) { g = byRun[R.rid] = { a: R.a, b: R.b, s: (R.r.back || R.r.dir === -1) ? -1 : 1 }; list.push(g); }
      else { g.a = Math.min(g.a, R.a); g.b = Math.max(g.b, R.b); }
    });
    list.forEach(function (g) { cuts.push(g.a, g.b); });
    cuts.sort(function (x, y) { return x - y; });
    for (var i = 0; i < cuts.length - 1; i++) {
      var u = cuts[i], v = cuts[i + 1], act = null;
      if (v - u < 1e-9) continue;
      list.forEach(function (g) { if (g.a <= u && g.b >= v && (!act || g.a >= act.a)) act = g; });
      if (act) segs.push({ a: u, b: v, s: act.s });
    }
    return segs;
  }

  var MODES = ['loop', 'view', 'click', 'still'];
  var SPEED_MIN = 0.1, SPEED_MAX = 10;

  // A scene that cannot be drawn shows why, in the sheet's colours, instead of
  // leaving the element blank.
  function showError(host, e, spec, opts) {
    if (!HAS_DOM || !host || typeof host.appendChild !== 'function') return;
    injectCSS();
    Array.prototype.slice.call(host.children || []).forEach(function (c) { if (c.className === 'bp-err') host.removeChild(c); });
    var paper = (opts && opts.paper) || (isObj(spec) && spec.paper), T = paper === 'linen' ? THEMES.linen : THEMES.blue;
    var box = document.createElement('div'); box.className = 'bp-err'; box.setAttribute('role', 'alert');
    box.style.background = T.bg; box.style.color = T.ink; box.style.borderColor = T.ink;
    var hd = document.createElement('div'); hd.className = 'bp-err-hd'; hd.textContent = 'BLUEPRINT · THIS SCENE COULD NOT BE DRAWN';
    var msg = document.createElement('div');
    msg.textContent = (isObj(spec) && spec.title ? String(spec.title) + ': ' : '') + String((e && e.message) || e);
    box.appendChild(hd); box.appendChild(msg); host.appendChild(box);
  }

  function mount(host, spec, opts) {
    opts = opts || {};
    var held = { wrap: null, ctl: null };
    try { return mountScene(host, spec, opts, held); }
    catch (e) {
      try { if (held.ctl) held.ctl.destroy(); else if (held.wrap && held.wrap.parentNode) held.wrap.parentNode.removeChild(held.wrap); } catch (e2) { /* keep the first error */ }
      showError(host, e, spec, opts);
      if (root.console) root.console.error('[blueprint] could not draw ' + (isObj(spec) && spec.title ? '"' + spec.title + '"' : 'the scene') + ': ' + ((e && e.message) || e));
      throw e;
    }
  }

  function mountScene(host, spec, opts, held) {
    if (!host || typeof host.appendChild !== 'function') throw new Error('mount(el, spec): el must be an element');
    if (!isObj(spec)) throw new Error('mount(el, spec): no scene to draw (the spec is ' + (spec === null ? 'null' : typeof spec) + ')');
    injectCSS();
    if (opts.font !== false) injectFont();
    var extra = [], theme = resolveTheme(spec, opts, extra);
    var mode = opts.play || 'loop';
    if (MODES.indexOf(mode) < 0) { extra.push('unknown play "' + mode + '" (use ' + MODES.join(', ') + '); using loop'); mode = 'loop'; }
    var speed = opts.speed == null ? 1 : num(opts.speed);
    if (!fin(speed) || speed <= 0) { extra.push('speed ' + JSON.stringify(opts.speed) + ' is not a positive number; using 1'); speed = 1; }
    else if (speed < SPEED_MIN || speed > SPEED_MAX) { extra.push('speed ' + speed + ' is outside ' + SPEED_MIN + '…' + SPEED_MAX + '; clamped'); speed = clamp(speed, SPEED_MIN, SPEED_MAX); }
    // Caption language: the one asked for, else the reader's browser languages, else the scene's first.
    var langs = sceneLangs(spec), lang = null;
    if (langs.length) {
      if (opts.lang != null && opts.lang !== '') {
        lang = matchLang(langs, [String(opts.lang)]);
        if (!lang) extra.push('lang "' + opts.lang + '" is not one of this scene\'s languages (' + langs.join(', ') + ')');
      }
      var nav = root.navigator, prefs = nav ? (nav.languages && nav.languages.length ? nav.languages : [nav.language]) : [];
      lang = lang || matchLang(langs, prefs) || langs[0];
    }
    var B = build(spec, theme, speed, lang), L = B.L, tl = B.tl, P = pace(tl);
    extra.forEach(function (w) { L.warnings.push(w); });
    var trail = arr(opts._trail), resume = opts._resume || null;
    if (root.console) {
      var name = '[blueprint] ' + (spec.title || '');
      if (L.errors.length) root.console.error(name + '\n  ' + L.errors.join('\n  '));
      if (L.warnings.length) root.console.warn(name + '\n  ' + L.warnings.join('\n  '));
    }
    var wrap = document.createElement('div'); wrap.className = 'bp-wrap'; wrap.innerHTML = B.markup; held.wrap = wrap;
    var svg = wrap.firstChild, q = function (sel, el) { return (el || svg).querySelector(sel); };
    var mq = root.matchMedia ? root.matchMedia('(prefers-reduced-motion: reduce)') : null, reduce = !!(mq && mq.matches);
    var sayOf = function (i) { return sayIn(tl.steps[i], ctl ? ctl.lang : tl.lang, tl.langs); };
    var keyboard = opts.controls === false, hasLinks = !!svg.querySelector('[data-link]');
    function setLabel() {
      var description = (spec.title ? spec.title + '. ' : '') + tl.steps.map(function (s, i) { return 'Step ' + (i + 1) + ': ' + sayOf(i); }).join(' ');
      svg.setAttribute('aria-label', description + (keyboard ? (reduce ? ' Press Space or Enter to show the next step.' : ' Press Space or Enter to play or pause.') : '') + (hasLinks ? ' Parts marked with an arrow open their own sheet.' : ''));
    }
    // A sheet with links is a group, so the linked parts inside it can be reached and announced.
    if (hasLinks) svg.setAttribute('role', 'group');
    if (tl.lang) svg.setAttribute('lang', tl.lang);
    // cache nodes
    var keyed = function (el) { var k = {}; Array.prototype.forEach.call(el.querySelectorAll('[data-k]'), function (n) { k[n.getAttribute('data-k')] = n; }); return k; };
    var parts = L.order.map(function (pid) {
      var el = q('[data-part="' + pid + '"]'), body = q('[data-k="body"]', el), lead = q('[data-k="lead"]', el), lab = q('[data-k="label"]', el);
      var P = L.parts[pid];
      return {
        id: pid, P: P, el: el, k: keyed(body), lead: lead, leadLn: lead ? lead.querySelectorAll('.bp-ln') : [], leadTx: lead ? lead.querySelector('text') : null, label: lab, labelText: P.p.label != null ? String(P.p.label) : null,
        lns: body.querySelectorAll('.bp-ln'), fills: Array.prototype.filter.call(body.querySelectorAll('.bp-pf,.bp-ht,.bp-ink,.bp-zone,.bp-sl,text'), function (n) { return !n.hasAttribute('data-k'); }),
        draws: tl.draws[pid], sets: tl.sets[pid],
        spins: tl.spins.filter(function (s) { return s.id === pid; }), rings: tl.rings.filter(function (s) { return s.id === pid; }), lights: tl.lights.filter(function (s) { return s.id === pid; }),
        fails: tl.marks.filter(function (m) { return m.id === pid && m.kind === 'fail'; })
      };
    });
    var lines = Object.keys(L.lines).map(function (lid) {
      var el = q('[data-line="' + lid + '"]'), runsOn = tl.runs.filter(function (R) { return R.r.on === lid; });
      return { id: lid, el: el, path: q('[data-k="path"]', el), belt: q('[data-k="belt"]', el), lns: el.querySelectorAll('.bp-ln'), soft: el.querySelectorAll('.bp-wire,[data-k="label"],[data-k="lbg"]'), draws: tl.draws[lid], runs: runsOn, beltSegs: beltSegs(runsOn) };
    });
    var lineById = dict(); lines.forEach(function (x) { lineById[x.id] = x; });
    var glows = tl.glows.map(function (g, i) { return { g: g, el: q('[data-k="glow' + i + '"]') }; });
    var marks = tl.marks.map(function (m, i) { return { m: m, el: q('[data-k="mark' + i + '"]') }; });
    var notes = tl.notes.map(function (m, i) { return { m: m, el: q('[data-k="note' + i + '"]') }; });
    var runs = tl.runs.map(function (R, i) { var p = R.r.on ? lineById[R.r.on].path : q('[data-k="rp' + i + '"]'); return { R: R, el: q('[data-k="tok' + i + '"]'), path: p, len: 0 }; });
    var cam = q('[data-k="cam"]'), all = q('[data-k="all"]'), cap = q('[data-k="cap"]'), pos = q('[data-k="pos"]');
    var views = tl.views.map(function (v) { return { a: v.a, b: v.b, r: viewRect(v.view, L) }; });
    var capMax = Math.floor((B.OW - 120) / 6.9), lastCap = null, lastStep = -2;

    function stepAt(t) { var s = -1; for (var i = 0; i < tl.steps.length; i++) if (tl.steps[i].a <= t + 1e-6) s = i; return s; }
    function spinAt(list, t, rate) { var a = 0; list.forEach(function (s) { a += 360 * rate * Math.max(0, Math.min(t, s.b) - s.a); }); return a; }

    function update(t) {
      var fade = t > tl.total ? 1 - seg(t, tl.total, tl.period - 0.15) : 1;
      sa(all, 'opacity', r2(fade));
      // camera
      var vr = [0, 0, L.W, L.H];
      views.forEach(function (v) { if (t >= v.a) { var k = seg(t, v.a, v.b); vr = vr.map(function (x, i) { return x + (v.r[i] - x) * k; }); } });
      sa(cam, 'viewBox', vr.map(r2).join(' '));
      // parts
      parts.forEach(function (x) {
        var ds = drawState(x.draws, t), d = ds.d;
        sa(x.el, 'opacity', r2(ds.o));
        ss(x.el, 'display', (d <= 0.001 && ds.first) ? 'none' : '');
        for (var i = 0; i < x.lns.length; i++) ss(x.lns[i], 'strokeDashoffset', r2(1 - d));
        var fo = r2(clamp((d - 0.15) / 0.55));
        for (var j = 0; j < x.fills.length; j++) ss(x.fills[j], 'opacity', fo);
        if (x.label) ss(x.label, 'opacity', fo);
        if (x.lead) {
          var lp = ds.first ? seg(t, ds.first.b - 0.25, ds.first.b + 0.35) : 1;
          for (var m = 0; m < x.leadLn.length; m++) ss(x.leadLn[m], 'strokeDashoffset', r2(1 - lp));
          ss(x.leadTx, 'opacity', r2(clamp((lp - 0.5) * 2)));
        }
        // shake on fail
        var jx = 0; x.fails.forEach(function (f) { var k = trap(t, f.a, f.a + 0.55, 0.1); if (k) jx += Math.sin((t - f.a) * 60) * 2.2 * k; });
        x.ringAmt = 0; x.rings.forEach(function (r) { x.ringAmt = Math.max(x.ringAmt, trap(t, r.a, r.b, 0.15)); });
        if (x.P.p.kind !== 'bell' && x.ringAmt) jx += Math.sin(t * 50) * 1.6 * x.ringAmt;
        sa(x.el, 'transform', 'translate(' + r2(x.P.box.x + jx) + ' ' + r2(x.P.box.y) + ')');
        var S = {
          p: x.P.p, t: t, ring: x.ringAmt,
          spin: (x.P.p.angle || 0) + spinAt(x.spins, t, x.P.p.rate || (x.P.p.kind === 'clock' ? 1.2 : 0.7)),
          light: x.lights.reduce(function (m, s) { return Math.max(m, trap(t, s.a, s.b, 0.2)); }, 0),
          get: function (key, def) { return valueAt(x.sets, key, t, x.P.p[key] != null ? x.P.p[key] : def); }
        };
        if (x.P.kind.upd) x.P.kind.upd(x.k, x.P.box.w, x.P.box.h, S);
        if (x.label && x.sets) {
          var txt = valueAt(x.sets, 'text', t, x.labelText);
          if (txt !== x.shown) {
            x.shown = txt; var lg = labelGeom({ p: Object.assign({}, x.P.p, { label: txt }), box: x.P.box, kind: x.P.kind });
            if (lg) { x.label.setAttribute('y', r2(lg.y)); x.label.innerHTML = lg.lines.map(function (s, i) { return '<tspan x="' + r2(lg.x) + '" dy="' + (i ? 11 : 0) + '">' + esc(s) + '</tspan>'; }).join(''); }
            else x.label.innerHTML = '';
          }
        }
      });
      // lines
      lines.forEach(function (x) {
        var ds = drawState(x.draws, t), d = ds.d;
        sa(x.el, 'opacity', r2(ds.o));
        ss(x.el, 'display', (d <= 0.001 && ds.first) ? 'none' : '');
        for (var i = 0; i < x.lns.length; i++) ss(x.lns[i], 'strokeDashoffset', r2(1 - d));
        for (var j = 0; j < x.soft.length; j++) ss(x.soft[j], 'opacity', r2(clamp((d - 0.3) / 0.5)));
        if (x.belt) {
          var mv = 0; x.beltSegs.forEach(function (g) { mv += g.s * Math.max(0, Math.min(t, g.b) - g.a); });
          ss(x.belt, 'strokeDashoffset', r2(-mv * 22)); ss(x.belt, 'opacity', r2(0.55 * clamp((d - 0.5) * 2)));
        }
      });
      glows.forEach(function (x) { sa(x.el, 'opacity', r2(trap(t, x.g.a, x.g.b, 0.25))); });
      marks.forEach(function (x) { sa(x.el, 'opacity', r2(t >= x.m.a && t < x.m.b ? Math.min(seg(t, x.m.a, x.m.a + 0.25), 1 - seg(t, x.m.b - 0.25, x.m.b)) : 0)); });
      notes.forEach(function (x) { sa(x.el, 'opacity', r2(t >= x.m.a && t < x.m.b ? Math.min(seg(t, x.m.a, x.m.a + 0.35), x.m.b === Infinity ? 1 : 1 - seg(t, x.m.b - 0.3, x.m.b)) : 0)); });
      runs.forEach(function (x) {
        var R = x.R, r = R.r;
        if (t < R.a || t > R.b + (r.stay ? 1e9 : 0.2)) { sa(x.el, 'opacity', 0); return; }
        if (r.stay && t > R.b && tl.steps[R.step] && t > tl.steps[R.step].b) { sa(x.el, 'opacity', 0); return; }
        if (!x.len) x.len = x.path.getTotalLength();
        var span = Array.isArray(r.span) ? r.span : [0, 1], k = lin(t, R.a, R.b); k = r.ease === 'linear' ? k : ease(k);
        var back = r.back || r.dir === -1, f = span[0] + (span[1] - span[0]) * k; if (back) f = 1 - f;
        var p = x.path.getPointAtLength(x.len * clamp(f));
        var op = t > R.b ? (r.stay ? 1 : 1 - lin(t, R.b, R.b + 0.2)) : Math.min(1, lin(t, R.a, R.a + 0.12));
        sa(x.el, 'opacity', r2(op));
        sa(x.el, 'transform', 'translate(' + r2(p.x) + ' ' + r2(p.y) + ')');
      });
      // caption
      var si = t > tl.total ? tl.steps.length - 1 : stepAt(t);
      var text = si >= 0 ? sayOf(si) : '';
      if (text !== lastCap) {
        lastCap = text; var rows = wrapCaption(String(text).toUpperCase(), capMax), dy = rows.length > 2 ? 11 : 13;
        cap.setAttribute('y', B.OH - (rows.length > 2 ? 37 : rows.length > 1 ? 31 : 25));
        cap.innerHTML = rows.map(function (s, i) { return '<tspan x="22" dy="' + (i ? dy : 0) + '">' + esc(s) + '</tspan>'; }).join('');
      }
      sa(cap, 'opacity', r2((si >= 0 ? seg(t, tl.steps[si].a, tl.steps[si].a + 0.35) : 0) * fade));
      if (si !== lastStep) { lastStep = si; pos.textContent = si >= 0 ? (si + 1) + ' / ' + tl.steps.length : ''; ctl.onStep(si); }
    }

    // Under reduced motion nothing tweens: playing shows the end of the next step.
    function nextStill() {
      var n = tl.steps.length;
      if (!n) { ctl.seek(tl.total); return; }
      var i = stepAt(ctl.t), lastEnd = tl.steps[n - 1].b - 0.05;
      ctl.seek(tl.steps[i < 0 || ctl.t >= lastEnd - 1e-6 ? 0 : i + 1].b - 0.05);
    }

    // controls
    var bar = null, dots = [], playBtn = null, backBtn = null, langBtns = [], io = null;
    var ctl = {
      t: 0, rt: 0, playing: false, stopAt: null, visible: true, destroyed: false, mode: mode, speed: speed, lang: tl.lang, langs: tl.langs,
      onStep: function (si) {
        dots.forEach(function (d, i) { if (i === si) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current'); });
      },
      _live: function () { if (this.playing && this.visible && !this.destroyed) { live.add(this); wake(); } else live.delete(this); },
      _tick: function (dt) {
        if (!this.playing || !this.visible) return;
        this.rt += dt; this.t = P.scene(this.rt);
        if (this.stopAt != null && this.t >= this.stopAt) { this.t = this.stopAt; this.rt = P.real(this.t); this.stopAt = null; this.pause(); }
        else if (this.t >= tl.total && this.mode !== 'loop') { this.t = tl.total; this.rt = P.real(this.t); this.pause(); }
        else if (this.t >= tl.period) this.t = this.rt = 0;
        update(this.t);
      },
      _run: function () { if (this.destroyed) return; if (this.t >= tl.total && this.mode !== 'loop') this.t = this.rt = 0; this.playing = true; this._live(); syncBtn(); },
      play: function () { if (this.destroyed) return; this.stopAt = null; if (reduce) { nextStill(); return; } this._run(); },
      pause: function () { this.playing = false; this._live(); syncBtn(); },
      toggle: function () { if (this.playing) this.pause(); else this.play(); },
      seek: function (t) { if (this.destroyed) return; t = num(t); if (!fin(t)) return; this.t = clamp(t, 0, tl.period); this.rt = P.real(this.t); update(this.t); },
      step: function (i) {
        i = Math.floor(num(i));
        if (this.destroyed || !tl.steps.length || !fin(i)) return;
        var s = tl.steps[clamp(i, 0, tl.steps.length - 1)];
        if (reduce) { this.pause(); this.seek(s.b - 0.05); return; }
        this.seek(s.a); this.stopAt = s.b - 0.05; this._run();
      },
      stepIndex: function () { return stepAt(this.t); },
      // Show the captions in another of the scene's languages, in place.
      setLang: function (code) {
        var l = matchLang(tl.langs, [code]);
        if (this.destroyed || !l || l === this.lang) return;
        this.lang = l; lastCap = null; svg.setAttribute('lang', l); setLabel(); syncLangs(); update(this.t);
      },
      // Linked sheets: open another scene in this one's place, and come back to where it was.
      open: function (id, fromPart) {
        if (this.destroyed) return null;
        var next = SCENES[id];
        if (!isObj(next)) { if (root.console) root.console.warn('[blueprint] no scene named "' + id + '" has been loaded, so there is no sheet to open'); return null; }
        var had = !!(document.activeElement && wrap.contains(document.activeElement));
        return swapTo(next, { _trail: trail.concat([{ spec: spec, t: this.t, part: fromPart || null }]), _autoplay: true, _focus: had ? 'back' : null });
      },
      back: function () {
        var prev = trail[trail.length - 1];
        if (this.destroyed || !prev) return null;
        var had = !!(document.activeElement && wrap.contains(document.activeElement));
        return swapTo(prev.spec, { _trail: trail.slice(0, -1), _resume: prev, _focus: had ? (prev.part || 'svg') : null });
      },
      depth: trail.length,
      timeline: tl, pace: P, layout: L,
      destroy: function () {
        if (this.destroyed) return;
        this.pause(); this.destroyed = true; live.delete(this);
        if (io) io.disconnect();
        if (mq) { if (mq.removeEventListener) mq.removeEventListener('change', onMotion); else if (mq.removeListener) mq.removeListener(onMotion); }
        svg.removeEventListener('click', onClick); svg.removeEventListener('keydown', onKey); svg.removeEventListener('keydown', onLinkKey);
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      }
    };
    held.ctl = ctl;
    // After a linked sheet replaces this one, calls on this controller reach the sheet now
    // showing (opts.onScene hands over the new controller as well).
    var own = {};
    ['play', 'pause', 'toggle', 'seek', 'step', 'stepIndex', 'setLang', 'open', 'back', 'destroy'].forEach(function (k) {
      var f = own[k] = ctl[k];
      ctl[k] = function () { return ctl._next ? ctl._next[k].apply(ctl._next, arguments) : f.apply(ctl, arguments); };
    });
    function swapTo(next, extra) {
      var o = Object.assign({}, opts, { _trail: null, _resume: null, _autoplay: false, _focus: null }, extra), c;
      try { c = mount(host, next, o); } catch (e) { return null; }   // mount shows why in the host; this sheet stays
      own.destroy.call(ctl); ctl._next = c;
      if (typeof opts.onScene === 'function') opts.onScene(c);
      return c;
    }
    setLabel();
    function syncBtn() {
      if (!playBtn) return;
      if (reduce) { playBtn.textContent = 'STEP'; playBtn.setAttribute('aria-label', 'Show the next step'); return; }
      playBtn.textContent = ctl.playing ? 'PAUSE' : 'PLAY'; playBtn.setAttribute('aria-label', ctl.playing ? 'Pause' : 'Play');
    }
    var langName = function (code) { try { return new root.Intl.DisplayNames([code], { type: 'language' }).of(code) || code; } catch (e) { return code; } };
    function syncLangs() {
      dots.forEach(function (b, i) { b.setAttribute('aria-label', 'Step ' + (i + 1) + ': ' + sayOf(i)); b.title = sayOf(i); });
      langBtns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === ctl.lang)); });
    }
    // The bar: Back (on a linked sheet, even without controls), then play and steps, then languages.
    if (opts.controls !== false || trail.length) {
      bar = document.createElement('div'); bar.className = 'bp-bar';
      if (trail.length) {
        var up = trail[trail.length - 1].spec;
        backBtn = document.createElement('button'); backBtn.type = 'button';
        backBtn.textContent = 'BACK' + (up.fig != null ? ' · FIG. ' + up.fig : '');
        backBtn.setAttribute('aria-label', 'Back to ' + (up.title || 'the previous sheet'));
        backBtn.addEventListener('click', function () { ctl.back(); });
        bar.appendChild(backBtn);
      }
    }
    if (opts.controls !== false) {
      bar.insertAdjacentHTML('beforeend', '<button type="button" data-a="play">PLAY</button><button type="button" data-a="prev" aria-label="Previous step">&larr;</button><button type="button" data-a="next" aria-label="Next step">&rarr;</button><div class="bp-dots"></div>');
      var dw = bar.querySelector('.bp-dots');
      if (tl.langs.length > 1) {
        var lg = document.createElement('div'); lg.setAttribute('role', 'group'); lg.setAttribute('aria-label', 'Caption language'); lg.style.display = 'flex'; lg.style.gap = '4px';
        tl.langs.forEach(function (code) {
          var b = document.createElement('button'); b.type = 'button'; b.textContent = code.toUpperCase(); b.title = langName(code);
          b.setAttribute('data-lang', code); b.setAttribute('lang', code); b.setAttribute('aria-label', langName(code));
          b.addEventListener('click', function () { ctl.setLang(code); });
          lg.appendChild(b); langBtns.push(b);
        });
        bar.insertBefore(lg, dw);
      }
      tl.steps.forEach(function (s, i) { var b = document.createElement('button'); b.type = 'button'; b.addEventListener('click', function () { ctl.step(i); }); dw.appendChild(b); dots.push(b); });
      syncLangs();
      playBtn = bar.querySelector('[data-a="play"]');
      playBtn.addEventListener('click', function () { ctl.toggle(); });
      bar.querySelector('[data-a="prev"]').addEventListener('click', function () {
        if (!tl.steps.length) return;
        var i = stepAt(ctl.t), s = tl.steps[i]; ctl.step(s && ctl.t - s.a < 0.6 ? i - 1 : i);
      });
      bar.querySelector('[data-a="next"]').addEventListener('click', function () {
        var n = tl.steps.length; if (!n) return;
        var i = stepAt(ctl.t), lastEnd = tl.steps[n - 1].b - 0.05;
        if (ctl.t >= lastEnd - 1e-6) ctl.step(0);                    // finished or fading out: start again
        else if (i >= n - 1 && !reduce) { ctl.pause(); ctl.seek(lastEnd); } // in the last step: finish it
        else ctl.step(i + 1);
      });
    }
    if (bar) wrap.appendChild(bar);
    if (opts.key) {
      var keyed2 = L.order.map(function (pid) { return L.parts[pid].p; }).filter(function (p) { return p.n != null && p.name; });
      if (keyed2.length) {
        var ol = document.createElement('ol'); ol.className = 'bp-key';
        ol.innerHTML = keyed2.sort(function (a, b) { return String(a.n).localeCompare(String(b.n), undefined, { numeric: true }); }).map(function (p) { return '<li><b>' + esc(p.n) + (p.link ? ' ↗' : '') + '</b>' + (p.link ? ' ' : '') + esc(p.name) + (p.note ? ' · <span style="opacity:.75">' + esc(p.note) + '</span>' : '') + '</li>'; }).join('');
        wrap.appendChild(ol);
      }
    }
    var linkOf = function (n) { while (n && n !== svg) { if (n.getAttribute && n.getAttribute('data-link')) return n; n = n.parentNode; } return null; };
    function onClick(e) { var a = linkOf(e.target); if (a) ctl.open(a.getAttribute('data-link'), a.getAttribute('data-part')); else ctl.toggle(); }
    function onKey(e) { if (linkOf(e.target)) return; if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') { e.preventDefault(); ctl.toggle(); } }
    function onLinkKey(e) {
      var a = linkOf(e.target);
      if (a && (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); ctl.open(a.getAttribute('data-link'), a.getAttribute('data-part')); }
    }
    svg.addEventListener('click', onClick);
    if (hasLinks) svg.addEventListener('keydown', onLinkKey);
    if (keyboard) { if (!hasLinks) svg.setAttribute('role', 'button'); svg.setAttribute('tabindex', '0'); svg.addEventListener('keydown', onKey); }
    function onMotion() {
      var was = reduce; reduce = !!mq.matches;
      if (reduce === was || ctl.destroyed) return;
      if (reduce) { var i = stepAt(ctl.t); ctl.pause(); ctl.stopAt = null; ctl.seek(i >= 0 && ctl.t <= tl.total ? tl.steps[i].b - 0.05 : tl.total); }
      else if (ctl.mode === 'loop') ctl._run();
      setLabel(); syncBtn();
    }
    if (mq) { if (mq.addEventListener) mq.addEventListener('change', onMotion); else if (mq.addListener) mq.addListener(onMotion); }
    host.appendChild(wrap);

    if (reduce || ctl.mode === 'still') ctl.seek(tl.total);
    else ctl.seek(0);
    // Off-screen scenes leave the frame loop; 'view' scenes start on first sight.
    // A sheet opened from a link plays at once; one returned to from a link waits where it was.
    if (resume) { ctl.pause(); ctl.seek(resume.t); }
    if ('IntersectionObserver' in root) {
      var played = !!(resume || opts._autoplay);
      io = new root.IntersectionObserver(function (es) {
        es.forEach(function (e) {
          ctl.visible = e.isIntersecting; ctl._live();
          if (e.isIntersecting && ctl.mode === 'view' && !played && !reduce) { played = true; ctl.play(); }
        });
      }, { threshold: 0.35 });
      io.observe(svg);
    }
    if (!reduce && !resume && (ctl.mode === 'loop' || (opts._autoplay && ctl.mode !== 'still'))) ctl.play();
    syncBtn();
    if (opts._focus) {
      // Keyboard focus follows the reader: to Back on a linked sheet, to the part it came from on return.
      var fe = opts._focus === 'back' ? backBtn : ID_RE.test(opts._focus) ? q('[data-part="' + opts._focus + '"][tabindex]') : null;
      if (fe && fe.focus) { try { fe.focus({ preventScroll: true }); } catch (e) { fe.focus(); } }
    }
    return ctl;
  }

  function scene(id, spec) {
    SCENES[id] = spec;
    if (HAS_DOM && root.dispatchEvent && typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('blueprint:scene', { detail: id }));
    return spec;
  }

  var MISSING_GRACE_MS = 1500;
  function missingScene(el, id) {
    var known = Object.keys(SCENES);
    var msg = !id ? 'This <blueprint-scene> has no scene attribute and no <script type="application/json"> scene inside it.'
      : 'No scene named "' + id + '" has been loaded' + (known.length ? ' (loaded: ' + known.join(', ') + ')' : '') +
        '. Check the scene attribute, and load the scene\'s file after blueprint.js (both with defer, in that order).';
    showError(el, new Error(msg), null, { paper: el.getAttribute('paper') || undefined });
    if (root.console) root.console.error('[blueprint] ' + msg);
  }

  if (HAS_DOM && root.customElements && !root.customElements.get('blueprint-scene')) {
    // A scene written inline: <blueprint-scene><script type="application/json">{ … }</script></blueprint-scene>
    var inlineScene = function (el) {
      return Array.prototype.filter.call(el.children, function (c) { return c.tagName === 'SCRIPT' && /^application\/json$/i.test((c.getAttribute('type') || '').trim()); })[0] || null;
    };
    var BlueprintScene = class extends HTMLElement {
      static get observedAttributes() { return ['lang']; }
      attributeChangedCallback(name, was, val) { if (name === 'lang' && this._c && val) this._c.setLang(val); }
      connectedCallback() {
        var self = this; if (self._c || self._wait || self._dom) return;
        var id = self.getAttribute('scene'), js = inlineScene(self);
        // With the runtime in <head> the element connects before its children are parsed:
        // look again once the page has been read.
        if (!js && !(id && SCENES[id]) && document.readyState === 'loading') {
          self._dom = function () { self._dom = null; self.connectedCallback(); };
          document.addEventListener('DOMContentLoaded', self._dom, { once: true });
          return;
        }
        var go = function (spec) {
          if (self._c || !self.isConnected) return;
          if (self._timer) { clearTimeout(self._timer); self._timer = null; }
          Array.prototype.slice.call(self.children).forEach(function (c) { if (c.className === 'bp-err') self.removeChild(c); });
          self._c = mount(self, spec || SCENES[id], {
            play: self.getAttribute('play') || 'loop', paper: self.getAttribute('paper') || undefined,
            controls: !self.hasAttribute('no-controls'), key: self.hasAttribute('key'), font: !self.hasAttribute('no-font'),
            speed: self.hasAttribute('speed') ? self.getAttribute('speed') : 1, lang: self.getAttribute('lang') || undefined,
            onScene: function (c) { self._c = c; }
          });
        };
        if (js) {
          var spec;
          try { spec = JSON.parse(js.textContent); }
          catch (e) {
            var bad = new Error('The scene inside this <blueprint-scene> is not valid JSON: ' + e.message);
            showError(self, bad, null, { paper: self.getAttribute('paper') || undefined });
            if (root.console) root.console.error('[blueprint] ' + bad.message);
            return;
          }
          // A scene attribute names the inline scene, so linked parts elsewhere can open it.
          if (id && ID_RE.test(id)) scene(id, spec);
          go(spec);
        }
        else if (id && SCENES[id]) go();
        else {
          // Wait for the scene's file. A scene that has not arrived a moment after the page has
          // loaded is reported in the element's place; if it turns up later it still draws.
          self._wait = function (e) { if (e.detail === id) { root.removeEventListener('blueprint:scene', self._wait); self._wait = null; go(); } };
          root.addEventListener('blueprint:scene', self._wait);
          var later = function () { self._timer = setTimeout(function () { self._timer = null; if (!self._c && self.isConnected) missingScene(self, id); }, MISSING_GRACE_MS); };
          if (document.readyState === 'complete') later(); else root.addEventListener('load', later, { once: true });
        }
      }
      disconnectedCallback() {
        if (this._dom) { document.removeEventListener('DOMContentLoaded', this._dom); this._dom = null; }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._wait) { root.removeEventListener('blueprint:scene', this._wait); this._wait = null; }
        if (this._c) { this._c.destroy(); this._c = null; }
      }
    };
    root.customElements.define('blueprint-scene', BlueprintScene);
  }

  return {
    version: VERSION, scene: scene, scenes: SCENES, mount: mount, themes: THEMES, kinds: KINDS,
    layout: layout, compile: compile, pace: pace, port: port, cols: cols, langs: sceneLangs, labelGeom: labelGeom, leaderOf: leaderOf, badgeAt: badgeAt, polyAt: polyAt
  };
});
