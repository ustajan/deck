/*
 * Visual editor for reveal.js decks. Loaded by edit.py when a deck is opened with ?edit.
 *
 * Model: the HTML file as it is on disk is parsed into a separate, inert "source" document. Every edit
 * is applied to both the live slides you see and the source; Save serialises the source, so reveal.js's
 * own runtime state (classes, inline styles, lazy-loaded src attributes, fitted font scales) never ends
 * up in the file. Live and source elements are matched by their element-index path under .slides.
 */
(function () {
  'use strict';
  var CFG = window.__REVEAL_EDIT || {};
  var FILE = CFG.file || 'index.html';
  var TOKEN = CFG.token || '';

  var srcDoc = null, baseHash = '', dirty = false;
  var rawPrefix = '<!DOCTYPE html>\n', rawSuffix = '\n', rawUsesNbspEntity = false;
  var rawText = '', rawSlides = null, origSections = null;   // for writing untouched slides back verbatim   // text around <html>…</html> in the file, kept verbatim
  var sel = null;            // selected live element (with several selected: the one picked last)
  var multi = [];            // all selected elements when more than one is selected
  var editingEl = null;      // live element in contenteditable mode
  var editBefore = null;     // undo snapshot taken when text editing started
  var undoStack = [], redoStack = [];
  var origKeyboard = true;
  var clip = null;           // internal element clipboard (source outerHTML)
  var ui = {};
  var gesture = null;        // current drag / resize
  var notesTimer = null, notesSnap = false;
  var SNAP = 5;              // slide px
  var PAGE = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var serverGone = false;

  // ------------------------------------------------------------------ keep-alive
  // The editor (reveal-edit) stops a few seconds after its last tab closes; this tab checks in every 30 s.
  function ping() {
    fetch('/__ping?page=' + PAGE, { method: 'POST', headers: { 'X-Edit-Token': TOKEN }, cache: 'no-store' })
      .then(function (r) { serverGone = !r.ok && r.status !== 404; })
      .catch(function () { serverGone = true; });
  }
  ping();
  setInterval(ping, 30000);
  window.addEventListener('pagehide', function () {
    try { navigator.sendBeacon('/__bye?page=' + PAGE + '&token=' + encodeURIComponent(TOKEN), ''); } catch (err) { /* ignore */ }
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted) ping(); });   // back/forward cache

  // ------------------------------------------------------------------ boot
  function boot() {
    if (!window.Reveal || !Reveal.isReady) return setTimeout(boot, 40);
    var go = function () {
      loadSource().then(init).catch(function (e) { fatal('Could not load the deck for editing: ' + e); });
    };
    if (Reveal.isReady()) go(); else Reveal.on('ready', go);
  }

  function loadSource() {
    return fetch('/' + encodeURI(FILE), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      baseHash = r.headers.get('X-File-Hash') || '';
      return r.text();
    }).then(function (text) {
      srcDoc = new DOMParser().parseFromString(text, 'text/html');
      rawUsesNbspEntity = text.indexOf('&nbsp;') >= 0;
      var i = text.search(/<html[\s>]/i), j = text.toLowerCase().lastIndexOf('</html>');
      if (i >= 0) rawPrefix = text.slice(0, i);
      if (j >= 0) rawSuffix = text.slice(j + 7);
      if (!srcRoot()) throw new Error('no .reveal .slides in ' + FILE);
      rawText = text;
      indexRawSlides();
    });
  }

  function init() {
    origKeyboard = Reveal.getConfig().keyboard;
    Reveal.configure({ fragments: false });
    document.documentElement.classList.add('re-on');
    buildUI();
    checkStructure();
    bindEvents();
    layoutChrome();
    onSlide();
    toast('Edit mode — click to select, double-click text to edit, ? for shortcuts', 4000);
  }

  function fatal(msg) {
    var d = document.createElement('div');
    d.className = 're-fatal';
    d.textContent = msg;
    document.body.appendChild(d);
  }

  // ------------------------------------------------------------------ live <-> source mapping
  function liveRoot() { return document.querySelector('.reveal .slides'); }
  function srcRoot() { return srcDoc && srcDoc.querySelector('.reveal .slides'); }

  function pathOf(el) {
    var root = liveRoot(), p = [];
    while (el && el !== root) {
      if (!el.parentElement) return null;
      p.unshift(Array.prototype.indexOf.call(el.parentElement.children, el));
      el = el.parentElement;
    }
    return el === root ? p : null;
  }
  function atPath(root, p) {
    var el = root;
    for (var i = 0; el && i < p.length; i++) el = el.children[p[i]];
    return el || null;
  }
  function srcOf(live) {
    var p = pathOf(live);
    return p ? atPath(srcRoot(), p) : null;
  }

  function checkStructure() {
    var bad = 0;
    (function walk(a, b, depth) {
      if (!a || !b || a.tagName !== b.tagName || a.children.length !== b.children.length) { bad++; return; }
      if (depth > 40) return;
      for (var i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i], depth + 1);
    })(liveRoot(), srcRoot(), 0);
    if (bad) toast('Warning: the page and the file differ in ' + bad + ' place(s); edits there may not save correctly.', 8000);
  }

  // ------------------------------------------------------------------ helpers
  function $(sel_, root) { return (root || document).querySelector(sel_); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function scale() { return (Reveal.getScale && Reveal.getScale()) || 1; }
  function curSection() { return Reveal.getCurrentSlide(); }
  function frameOf(section) {
    if (!section) return null;
    for (var i = 0; i < section.children.length; i++) if (section.children[i].classList.contains('sf')) return section.children[i];
    return section;
  }
  function slideSize() { var c = Reveal.getConfig(); return { w: c.width || 960, h: c.height || 700 }; }
  function px(v) { return Math.round(v * 100) / 100 + 'px'; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function isPositioned(e) { var p = getComputedStyle(e).position; return p === 'absolute' || p === 'fixed'; }
  function skippable(e) { return /^(SCRIPT|STYLE|TEMPLATE|ASIDE|BR)$/.test(e.tagName) || e.classList.contains('notes'); }

  function topItem(t) {
    if (!t || !t.closest) return null;
    var sec = t.closest('.reveal .slides section');
    if (!sec || sec !== curSection()) return null;
    var fr = frameOf(sec);
    if (!fr.contains(t) || t === fr || t === sec) return null;
    var e = t;
    while (e.parentElement && e.parentElement !== fr) e = e.parentElement;
    if (e.parentElement !== fr || skippable(e)) return null;
    return e;
  }
  function innerItem(t) {
    var top = topItem(t);
    if (!top) return null;
    var e = t.closest('.e');
    return e && top.contains(e) ? e : top;
  }
  function items() {
    var fr = frameOf(curSection());
    return fr ? Array.prototype.filter.call(fr.children, function (c) { return !skippable(c) && c.getClientRects().length; }) : [];
  }

  // geometry of an element in its offset parent's px (unrotated box)
  function boxOf(e) {
    var s = e.style;
    var l = num(s.left), t = num(s.top), w = num(s.width), h = num(s.height);
    if (/px$/.test(s.left) && /px$/.test(s.top) && /px$/.test(s.width) && /px$/.test(s.height)) return { x: l, y: t, w: w, h: h };
    return { x: e.offsetLeft, y: e.offsetTop, w: e.offsetWidth, h: e.offsetHeight };
  }
  // make sure an absolutely positioned element is expressed as left/top/width/height px
  function normalize(e) {
    var b = boxOf(e);
    var s = e.style;
    if (!/px$/.test(s.left) || !/px$/.test(s.top) || s.right || s.bottom || !/px$/.test(s.width) || !/px$/.test(s.height)) {
      s.removeProperty('right'); s.removeProperty('bottom');
      s.left = px(b.x); s.top = px(b.y); s.width = px(b.w); s.height = px(b.h);
      touched.add(e);
    }
    return b;
  }

  var touched = new Set();
  function syncStyle(live) {
    var src = srcOf(live);
    if (!src) return;
    var css = (live.getAttribute('style') || '').replace(/--fs\s*:[^;]*;?/g, '').trim();
    if (css) src.setAttribute('style', css); else src.removeAttribute('style');
  }
  function syncAttrs(live, names) {
    var src = srcOf(live);
    if (!src) return;
    names.forEach(function (n) {
      var v = live.getAttribute(n);
      if (v == null) src.removeAttribute(n); else src.setAttribute(n, v);
    });
  }
  function flushTouched() {
    touched.forEach(function (e) {
      syncStyle(e);
      if (e.tagName.toLowerCase() === 'svg') syncAttrs(e, ['width', 'height', 'preserveAspectRatio']);
    });
    touched.clear();
    flushShapes();
  }

  // resize an element to w x h, adapting what the converter put inside it
  function applySize(e, w, h) {
    if (isShp(e)) { resizeShape(e, w, h); touched.add(e); return; }
    var b = boxOf(e);
    var sx = b.w > 0.5 ? w / b.w : 1, sy = b.h > 0.5 ? h / b.h : 1;
    e.style.width = px(w); e.style.height = px(h); touched.add(e);
    var kids = Array.prototype.slice.call(e.children);
    if (e.classList.contains('g')) {           // group: scale child boxes (text keeps its size, like PowerPoint)
      kids.forEach(function (c) {
        if (!isPositioned(c) || skippable(c)) return;
        var cb = boxOf(c);
        c.style.left = px(cb.x * sx); c.style.top = px(cb.y * sy); touched.add(c);
        applySize(c, cb.w * sx, cb.h * sy);
      });
      return;
    }
    kids.forEach(function (c) {
      if (c.classList.contains('tx')) {
        if (/rotate\((90|270)deg\)/.test(c.style.transform)) {
          c.style.width = px(h); c.style.height = px(w); c.style.left = px((w - h) / 2); c.style.top = px((h - w) / 2);
        } else { c.style.width = px(w); c.style.height = px(h); }
        touched.add(c);
        refit(c);
      } else if (c.tagName.toLowerCase() === 'svg' && c.classList.contains('geo')) {
        var vb = c.viewBox && c.viewBox.baseVal;
        if (!vb) return;
        var pad = -vb.x, w0 = vb.width - 2 * pad, h0 = vb.height - 2 * pad;
        var gx = w0 > 0.5 ? w / w0 : 1, gy = h0 > 0.5 ? h / h0 : 1;
        c.setAttribute('preserveAspectRatio', 'none');
        c.setAttribute('width', (vb.width * gx).toFixed(2));
        c.setAttribute('height', (vb.height * gy).toFixed(2));
        c.style.left = px(-pad * gx); c.style.top = px(-pad * gy);
        touched.add(c);
      } else if (c.tagName === 'IFRAME' && e.classList.contains('embed')) {
        var m = /scale\(([\d.]+)\)/.exec(c.style.transform), s = m ? parseFloat(m[1]) : 1;
        c.style.width = px(w / s); c.style.height = px(h / s); touched.add(c);
      }
    });
  }

  function refit(tx) {
    if (!tx || !tx.classList || !tx.classList.contains('tx')) return;
    tx.style.removeProperty('--fs');
    var sec = tx.closest('section');
    if (sec) delete sec.dataset.fitted;
    if (typeof window.fitText === 'function') { try { window.fitText(sec); } catch (err) { /* deck without autofit */ } }
  }

  // ------------------------------------------------------------------ shapes, lines and arrows
  // Shapes drawn in the editor are stored as
  //   <div class="e shp" data-shape="rect" data-fill="#4f81bd" data-stroke="#2c5a8f" data-sw="2" data-dash="solid"
  //        [data-arrow="end"] [data-line="x1,y1,x2,y2"] [data-tbox] style="position:absolute;…">
  //     <svg class="geo">…</svg>  [<div class="tx">text…</div>]
  //   </div>
  // The SVG is regenerated from the data-* attributes after every change, so the file always holds plain,
  // self-contained SVG that presents without the editor. Lines keep their two end points in data-line,
  // relative to the element's box.
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SHAPES = [                    // the + Shape menu, four to a row
    ['line', 'Line'], ['arrow', 'Arrow'], ['darrow', 'Double arrow'], ['callout', 'Callout'],
    ['rect', 'Rectangle'], ['roundRect', 'Rounded rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'],
    ['rtTriangle', 'Right triangle'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'], ['star', 'Star'],
    ['rightArrow', 'Block arrow →'], ['leftArrow', 'Block arrow ←'], ['upArrow', 'Block arrow ↑'], ['downArrow', 'Block arrow ↓'],
    ['chevron', 'Chevron >'], ['chevronLeft', 'Chevron <'], ['chevronUp', 'Chevron ^'], ['chevronDown', 'Chevron v']
  ];
  // block arrows and chevrons: [kind, direction it points]
  var DIRSHAPES = { rightArrow: ['arrow', 'r'], leftArrow: ['arrow', 'l'], upArrow: ['arrow', 'u'], downArrow: ['arrow', 'd'],
                    chevron: ['chev', 'r'], chevronLeft: ['chev', 'l'], chevronUp: ['chev', 'u'], chevronDown: ['chev', 'd'] };
  function isVertical(t) { var d = DIRSHAPES[t]; return !!d && (d[1] === 'u' || d[1] === 'd'); }
  // drawn pointing right in a box L long and T thick, then turned to face its direction
  function dirShapePath(kind, dir, w, h) {
    var vert = dir === 'u' || dir === 'd', L = vert ? h : w, T = vert ? w : h, c = T / 2, k, pts;
    if (kind === 'arrow') {
      k = L - Math.min(L * 0.6, Math.min(L, T) * 0.5);
      pts = [[0, c - T / 4], [k, c - T / 4], [k, 0], [L, c], [k, T], [k, c + T / 4], [0, c + T / 4]];
    } else {
      k = Math.min(L * 0.5, T * 0.5);
      pts = [[0, 0], [L - k, 0], [L, c], [L - k, T], [0, T], [k, c]];
    }
    return poly(pts.map(function (p) {
      var u = p[0], v = p[1];
      return dir === 'r' ? [u, v] : dir === 'l' ? [w - u, v] : dir === 'd' ? [v, u] : [v, h - u];
    }));
  }
  function dirShapeInsets(kind, dir, w, h) {
    var vert = dir === 'u' || dir === 'd', L = vert ? h : w, T = vert ? w : h;
    // [side, head end, side, tail end] for the right-pointing shape
    var b = kind === 'arrow' ? [T * 0.25, L * 0.2, T * 0.25, 8] : [6, Math.min(L, T) * 0.5, 6, Math.min(L, T) * 0.5];
    switch (dir) {                      // -> [top, right, bottom, left]
      case 'l': return [b[0], b[3], b[2], b[1]];
      case 'u': return [b[1], b[0], b[3], b[2]];
      case 'd': return [b[3], b[0], b[1], b[2]];
      default: return b;
    }
  }
  var DEF = { line: { stroke: '#4f81bd', sw: 3, dash: 'solid' }, shape: { fill: '#4f81bd', stroke: '#2c5a8f', sw: 2, dash: 'solid' } };
  try { var saved = JSON.parse(localStorage.getItem('reveal-edit-shape-defaults') || 'null'); if (saved && saved.line && saved.shape) DEF = saved; } catch (err) { /* private mode */ }
  function saveDefaults() { try { localStorage.setItem('reveal-edit-shape-defaults', JSON.stringify(DEF)); } catch (err) { /* ignore */ } }
  var tool = null;                  // armed drawing tool {shape, arrow}
  var newTextShapes = new WeakSet(); // shapes whose text frame was just created (dropped again if left empty)
  var shapesToSync = new Set();
  var styleSnap = false;            // one undo step per colour-picker drag

  function r2(v) { return Math.round(v * 100) / 100; }
  function isShp(e) { return !!(e && e.classList && e.classList.contains('shp')); }
  function isLine(e) { return isShp(e) && e.getAttribute('data-shape') === 'line'; }

  function poly(pts) { return 'M' + pts.map(function (p) { return r2(p[0]) + ',' + r2(p[1]); }).join(' L') + ' Z'; }
  function shapePath(t, w, h) {
    var ss = Math.min(w, h), hc = w / 2, vc = h / 2, k, pts;
    if (DIRSHAPES[t]) return dirShapePath(DIRSHAPES[t][0], DIRSHAPES[t][1], w, h);
    switch (t) {
      case 'roundRect':
        var r = r2(Math.min(ss * 0.16, w / 2, h / 2));
        return 'M' + r + ',0 H' + r2(w - r) + ' A' + r + ',' + r + ' 0 0 1 ' + r2(w) + ',' + r + ' V' + r2(h - r) +
          ' A' + r + ',' + r + ' 0 0 1 ' + r2(w - r) + ',' + r2(h) + ' H' + r + ' A' + r + ',' + r + ' 0 0 1 0,' + r2(h - r) +
          ' V' + r + ' A' + r + ',' + r + ' 0 0 1 ' + r + ',0 Z';
      case 'ellipse':
        return 'M0,' + r2(vc) + ' A' + r2(hc) + ',' + r2(vc) + ' 0 1 1 ' + r2(w) + ',' + r2(vc) + ' A' + r2(hc) + ',' + r2(vc) + ' 0 1 1 0,' + r2(vc) + ' Z';
      case 'triangle': return poly([[hc, 0], [w, h], [0, h]]);
      case 'rtTriangle': return poly([[0, 0], [w, h], [0, h]]);
      case 'diamond': return poly([[hc, 0], [w, vc], [hc, h], [0, vc]]);
      case 'hexagon': k = Math.min(ss * 0.25, w / 2); return poly([[0, vc], [k, 0], [w - k, 0], [w, vc], [w - k, h], [k, h]]);
      case 'star':
        pts = [];
        for (k = 0; k < 10; k++) {
          var a = (-90 + k * 36) * Math.PI / 180, rr = k % 2 ? 0.382 : 1;
          pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
        }
        var y0 = -1, y1 = Math.sin(54 * Math.PI / 180), x1 = Math.cos(18 * Math.PI / 180);
        return poly(pts.map(function (p) { return [(p[0] + x1) / (2 * x1) * w, (p[1] - y0) / (y1 - y0) * h]; }));
      case 'callout': return poly([[0, 0], [w, 0], [w, h], [w * 0.42, h], [w * 0.18, h + Math.min(h * 0.45, 48)], [w * 0.25, h], [0, h]]);
      default: return poly([[0, 0], [w, 0], [w, h], [0, h]]);
    }
  }
  // padding that keeps text inside the shape's interior
  function textInsets(t, w, h) {
    if (DIRSHAPES[t]) return dirShapeInsets(DIRSHAPES[t][0], DIRSHAPES[t][1], w, h);
    switch (t) {
      case 'ellipse': return [h * 0.15 + 4, w * 0.15 + 4, h * 0.15 + 4, w * 0.15 + 4];
      case 'triangle': return [h * 0.45, w * 0.22, 6, w * 0.22];
      case 'rtTriangle': return [h * 0.45, w * 0.45, 6, 8];
      case 'diamond': return [h * 0.25, w * 0.25, h * 0.25, w * 0.25];
      case 'hexagon': return [6, Math.min(w, h) * 0.2, 6, Math.min(w, h) * 0.2];
      case 'star': return [h * 0.36, w * 0.3, h * 0.2, w * 0.3];
      default: return [6, 10, 6, 10];
    }
  }
  function dashAttr(dash, sw) {
    var s = Math.max(sw, 1);
    switch (dash) {
      case 'dash': return ' stroke-dasharray="' + r2(Math.max(4 * s, 6)) + ' ' + r2(Math.max(3 * s, 4)) + '"';
      case 'dot': return ' stroke-dasharray="0 ' + r2(Math.max(2 * s, 4)) + '" stroke-linecap="round"';
      case 'dashdot': return ' stroke-dasharray="' + r2(Math.max(4 * s, 6)) + ' ' + r2(Math.max(2 * s, 3)) + ' 0 ' + r2(Math.max(2 * s, 3)) + '" stroke-linecap="round"';
      default: return '';
    }
  }
  function shpAttrs(e) {
    return {
      t: e.getAttribute('data-shape') || 'rect', fill: e.getAttribute('data-fill') || 'none',
      stroke: e.getAttribute('data-stroke') || 'none', sw: parseFloat(e.getAttribute('data-sw')) || 0,
      dash: e.getAttribute('data-dash') || 'solid', arrow: e.getAttribute('data-arrow') || 'none'
    };
  }
  function lineOf(e) {
    var v = (e.getAttribute('data-line') || '').split(',').map(parseFloat), b = boxOf(e);
    return v.length === 4 && v.every(isFinite) ? v : [0, 0, b.w, b.h];
  }
  function lineAbs(e) { var b = boxOf(e), L = lineOf(e); return [b.x + L[0], b.y + L[1], b.x + L[2], b.y + L[3]]; }
  function setLineAbs(e, x1, y1, x2, y2) {
    var l = Math.min(x1, x2), t = Math.min(y1, y2);
    e.style.left = px(l); e.style.top = px(t); e.style.width = px(Math.abs(x2 - x1)); e.style.height = px(Math.abs(y2 - y1));
    e.setAttribute('data-line', [x1 - l, y1 - t, x2 - l, y2 - t].map(r2).join(','));
    renderShape(e);
  }
  function arrowHead(tip, from, sw, color) {
    var len = Math.max(sw * 4, 13), wid = Math.max(sw * 3.2, 11);
    var dx = tip[0] - from[0], dy = tip[1] - from[1], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    var bx = tip[0] - ux * len, by = tip[1] - uy * len;
    var pts = [tip, [bx - uy * wid / 2, by + ux * wid / 2], [bx + uy * wid / 2, by - ux * wid / 2]];
    return { svg: '<polygon points="' + pts.map(function (p) { return r2(p[0]) + ',' + r2(p[1]); }).join(' ') + '" fill="' + color + '"/>', cut: Math.min(len * 0.85, d * 0.45) };
  }
  function renderShape(e) {
    var a = shpAttrs(e), b = boxOf(e), w = b.w, h = b.h;
    var sw = a.stroke === 'none' ? 0 : a.sw;
    var pad = Math.ceil(sw * 4 + 10);
    var strokeA = sw > 0 ? ' stroke="' + a.stroke + '" stroke-width="' + r2(sw) + '" stroke-linejoin="round"' + dashAttr(a.dash, sw) : ' stroke="none"';
    var body;
    if (a.t === 'line') {
      var L = lineOf(e), p1 = [L[0], L[1]], p2 = [L[2], L[3]], q1 = p1.slice(), q2 = p2.slice(), heads = '';
      var cut = function (tip, from, n) { var dx = tip[0] - from[0], dy = tip[1] - from[1], d = Math.hypot(dx, dy) || 1; return [tip[0] - dx / d * n, tip[1] - dy / d * n]; };
      if (sw > 0 && (a.arrow === 'end' || a.arrow === 'both')) { var h2 = arrowHead(p2, p1, sw, a.stroke); heads += h2.svg; q2 = cut(p2, p1, h2.cut); }
      if (sw > 0 && (a.arrow === 'start' || a.arrow === 'both')) { var h1 = arrowHead(p1, p2, sw, a.stroke); heads += h1.svg; q1 = cut(p1, p2, h1.cut); }
      var dline = 'M' + r2(q1[0]) + ',' + r2(q1[1]) + ' L' + r2(q2[0]) + ',' + r2(q2[1]);
      body = '<path class="hit" d="M' + r2(p1[0]) + ',' + r2(p1[1]) + ' L' + r2(p2[0]) + ',' + r2(p2[1]) + '" fill="none" stroke="transparent" stroke-width="' + Math.max(12, sw + 8) + '"/>' +
        '<path d="' + dline + '" fill="none"' + strokeA + (a.dash === 'solid' ? ' stroke-linecap="butt"' : '') + '/>' + heads;
    } else {
      body = '<path d="' + shapePath(a.t, w, h) + '" fill="' + a.fill + '"' + strokeA + '/>';
    }
    var svg = null;
    for (var i = 0; i < e.children.length; i++) if (e.children[i].tagName.toLowerCase() === 'svg') { svg = e.children[i]; break; }
    if (!svg) { svg = document.createElementNS(SVGNS, 'svg'); e.insertBefore(svg, e.firstChild); }
    svg.setAttribute('class', 'geo');
    svg.setAttribute('width', r2(w + 2 * pad)); svg.setAttribute('height', r2(h + 2 * pad));
    svg.setAttribute('viewBox', [-pad, -pad, r2(w + 2 * pad), r2(h + 2 * pad)].join(' '));
    svg.setAttribute('style', 'position:absolute;left:' + (-pad) + 'px;top:' + (-pad) + 'px;overflow:visible;pointer-events:none');
    svg.removeAttribute('preserveAspectRatio');
    svg.innerHTML = body;
    var tx = e.querySelector(':scope > .tx');
    if (tx) {
      tx.style.width = px(w); tx.style.height = px(h);
      if (!e.hasAttribute('data-tbox')) {
        var ins = textInsets(a.t, w, h);
        tx.style.padding = ins.map(function (v) { return px(Math.max(0, v)); }).join(' ');
      }
    }
    shapesToSync.add(e);
  }
  function resizeShape(e, w, h) {
    var b = boxOf(e);
    if (isLine(e)) {
      var L = lineOf(e), sx = b.w > 0.5 ? w / b.w : 1, sy = b.h > 0.5 ? h / b.h : 1;
      if (b.w <= 0.5) w = b.w;
      if (b.h <= 0.5) h = b.h;
      e.setAttribute('data-line', [L[0] * sx, L[1] * sy, L[2] * sx, L[3] * sy].map(r2).join(','));
    }
    e.style.width = px(w); e.style.height = px(h);
    renderShape(e);
  }
  // remove editor/reveal runtime state from a copy of a live element before it goes into the file
  function cleanClone(live) {
    var c = live.cloneNode(true);
    [c].concat(Array.prototype.slice.call(c.querySelectorAll('*'))).forEach(function (n) {
      n.removeAttribute('contenteditable'); n.removeAttribute('spellcheck'); n.removeAttribute('data-lazy-loaded');
      if (n.classList && n.classList.length) {
        n.classList.remove('visible', 'current-fragment');
        if (!n.getAttribute('class')) n.removeAttribute('class');
      }
      var st = n.getAttribute('style');
      if (st && /--fs/.test(st)) { st = st.replace(/--fs\s*:[^;]*;?/g, '').trim(); if (st) n.setAttribute('style', st); else n.removeAttribute('style'); }
      if (n.hasAttribute('data-src') && n.hasAttribute('src')) n.removeAttribute('src');
    });
    return c;
  }
  function syncWhole(live) {
    var src = srcOf(live);
    if (src) src.replaceWith(srcDoc.importNode(cleanClone(live), true));
  }
  function flushShapes() {
    shapesToSync.forEach(function (e) { if (document.contains(e)) syncWhole(e); });
    shapesToSync.clear();
  }
  function shapeHTML(t, arrow, x, y, w, h, extra) {
    var line = t === 'line', d = line ? DEF.line : DEF.shape;
    var attrs = ' data-shape="' + t + '"' + (line ? '' : ' data-fill="' + d.fill + '"') + ' data-stroke="' + d.stroke + '" data-sw="' + d.sw + '" data-dash="' + d.dash + '"' +
      (line ? ' data-arrow="' + (arrow || 'none') + '" data-line="0,0,' + w + ',' + h + '"' : '') + (extra || '');
    return '<div class="e shp"' + attrs + ' style="position:absolute;box-sizing:border-box;left:' + r2(x) + 'px;top:' + r2(y) + 'px;width:' + r2(w) + 'px;height:' + r2(h) + 'px;"><svg class="geo"></svg></div>';
  }

  // ---- drawing
  function armTool(shape) {
    if (editingEl) endTextEdit();
    var arrow = shape === 'arrow' ? 'end' : shape === 'darrow' ? 'both' : 'none';
    tool = { shape: (shape === 'arrow' || shape === 'darrow') ? 'line' : shape, arrow: arrow, name: shape };
    deselect();
    document.documentElement.classList.add('re-drawing');
    ui.shapeBtn.classList.add('re-active');
    toast('Drag on the slide to draw' + (tool.shape === 'line' ? ' (Shift: 45° steps; ends snap to shapes)' : ' (Shift: keep it square)') + ' · click for default size · Esc cancels', 4000);
  }
  function disarmTool() {
    tool = null;
    document.documentElement.classList.remove('re-drawing');
    if (ui.shapeBtn) ui.shapeBtn.classList.remove('re-active');
  }
  function startDraw(ev) {
    ev.preventDefault(); ev.stopPropagation();
    var T = tool, p = slidePoint(ev), anchors = anchorPoints(null);
    if (T.shape === 'line' && !(ev.metaKey || ev.ctrlKey)) { var s0 = snapPoint(p, anchors); if (s0) p = { x: s0.x, y: s0.y }; }
    disarmTool();
    var node = insertItem(shapeHTML(T.shape, T.arrow, p.x, p.y, 0, 0));
    if (!node) return;
    renderShape(node);
    gesture = { kind: 'draw', el: node, p0: p, shape: T.shape, x0: ev.clientX, y0: ev.clientY, moved: false, anchors: anchors };
  }
  function startEndpoint(ev, end) {
    ev.preventDefault(); ev.stopPropagation();
    gesture = { kind: 'endpoint', el: sel, end: end, x0: ev.clientX, y0: ev.clientY, moved: false, anchors: anchorPoints(sel) };
  }
  function constrain(a, p, on) {
    if (!on) return p;
    var dx = p.x - a.x, dy = p.y - a.y, d = Math.hypot(dx, dy), ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d };
  }
  // points line ends snap to: other shapes' corners, edge midpoints and centres; other lines' ends
  function anchorPoints(exclude) {
    var pts = [];
    items().forEach(function (o) {
      if (o === exclude || !isPositioned(o)) return;
      if (isLine(o)) { var A = lineAbs(o); pts.push({ x: A[0], y: A[1] }, { x: A[2], y: A[3] }); return; }
      var b = boxOf(o);
      if (b.w < 2 && b.h < 2) return;
      [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]].forEach(function (f) {
        pts.push({ x: b.x + b.w * f[0], y: b.y + b.h * f[1] });
      });
    });
    return pts;
  }
  function snapPoint(p, pts) {
    var best = null, lim = 9 / Math.max(scale(), 0.25);
    pts.forEach(function (q) { var d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= lim && (!best || d < best.d)) best = { x: q.x, y: q.y, d: d }; });
    return best;
  }
  function frameToScreen(x, y) {
    var fr = frameOf(curSection()), r = fr.getBoundingClientRect(), s = scale();
    return { x: r.left + x * s, y: r.top + y * s };
  }
  function showSnapDot(p) {
    if (!p) { ui.snapdot.style.display = 'none'; return; }
    var q = frameToScreen(p.x, p.y);
    ui.snapdot.style.display = 'block'; ui.snapdot.style.left = q.x + 'px'; ui.snapdot.style.top = q.y + 'px';
  }
  function dragShape(ev) {   // mousemove for 'draw' and 'endpoint' gestures
    var g = gesture, p = slidePoint(ev), free = ev.metaKey || ev.ctrlKey || ev.shiftKey;   // Shift: angle wins over snapping
    if (!g.moved) {
      if (Math.abs(ev.clientX - g.x0) + Math.abs(ev.clientY - g.y0) < 3) return;
      g.moved = true;
      if (g.kind === 'endpoint') snapshot();
      ui.hover.style.display = 'none';
    }
    if (g.kind === 'endpoint') {
      var A = lineAbs(g.el), fixed = g.end === 1 ? { x: A[2], y: A[3] } : { x: A[0], y: A[1] };
      var q = constrain(fixed, p, ev.shiftKey), sn = free ? null : snapPoint(q, g.anchors);
      if (sn) q = sn;
      showSnapDot(sn);
      if (g.end === 1) setLineAbs(g.el, q.x, q.y, fixed.x, fixed.y); else setLineAbs(g.el, fixed.x, fixed.y, q.x, q.y);
    } else if (g.shape === 'line') {
      var q2 = constrain(g.p0, p, ev.shiftKey), sn2 = free ? null : snapPoint(q2, g.anchors);
      if (sn2) q2 = sn2;
      showSnapDot(sn2);
      setLineAbs(g.el, g.p0.x, g.p0.y, q2.x, q2.y);
    } else {
      var dx = p.x - g.p0.x, dy = p.y - g.p0.y;
      if (ev.shiftKey) { var m = Math.max(Math.abs(dx), Math.abs(dy)); dx = m * (dx < 0 ? -1 : 1); dy = m * (dy < 0 ? -1 : 1); }
      var e = g.el;
      e.style.left = px(Math.min(g.p0.x, g.p0.x + dx)); e.style.top = px(Math.min(g.p0.y, g.p0.y + dy));
      e.style.width = px(Math.abs(dx)); e.style.height = px(Math.abs(dy));
      renderShape(e);
    }
    placeOverlay();
    updateFields();
  }
  function endShapeGesture(g) {
    showSnapDot(null);
    if (g.kind === 'draw') {
      var e = g.el;
      if (!g.moved || (boxOf(e).w < 4 && boxOf(e).h < 4)) {      // a click: default size
        if (g.shape === 'line') setLineAbs(e, g.p0.x, g.p0.y, g.p0.x + 200, g.p0.y);
        else {
          var sq = /^(ellipse|star|hexagon|diamond)$/.test(g.shape) ? 140 : 0, vert = isVertical(g.shape);
          e.style.width = px(sq || (vert ? 120 : 200)); e.style.height = px(sq || (vert ? 200 : 120));
          renderShape(e);
        }
      }
      flushShapes();
      markDirty();
      sel = null; select(e);
    } else if (g.moved) {
      flushShapes();
      markDirty();
    }
    placeOverlay(); updateFields();
  }

  // ---- text inside shapes
  function ensureText(e) {
    var tx = e.querySelector(':scope > .tx');
    if (tx) return tx.querySelector('.tb');
    var b = boxOf(e);
    var font = isConverted() ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;" : '';
    tx = el('div', { 'class': 'tx', style: 'position:absolute;box-sizing:border-box;display:flex;flex-direction:column;left:0;top:0;width:' + px(b.w) + ';height:' + px(b.h) + ';justify-content:center;overflow:visible;' });
    tx.innerHTML = '<div class="tb"><div class="p" style="margin:0;white-space:pre-wrap;overflow-wrap:break-word;text-align:center;line-height:1.2;font-size:24px;color:#ffffff;' + font + '"><br></div></div>';
    e.appendChild(tx);
    newTextShapes.add(e);
    renderShape(e);
    shapesToSync.delete(e);   // nothing to save until text is typed
    return tx.querySelector('.tb');
  }
  function editShapeText(e) {
    if (isLine(e)) return toast('Lines cannot hold text — use + Text and place it next to the line');
    var tb = ensureText(e);
    startTextEdit(e, null);
    var p = tb.querySelector('.p') || tb, r = document.createRange();
    r.selectNodeContents(p); r.collapse(false);
    var s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  // text boxes grow and shrink with their text, like PowerPoint's "resize shape to fit text"
  function autoHeight(e) {
    if (!e || !e.hasAttribute('data-tbox')) return;
    var tx = e.querySelector(':scope > .tx'), tb = tx && tx.querySelector('.tb');
    if (!tb) return;
    var cs = getComputedStyle(tx);
    var need = tb.getBoundingClientRect().height / Math.max(scale(), 0.01) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    if (Math.abs(need - boxOf(e).h) > 0.5) { e.style.height = px(need); renderShape(e); }
  }
  function onTextInput() {
    var shp = editingEl && editingEl.closest('.shp[data-tbox]');
    if (shp) { autoHeight(shp); placeOverlay(); }
  }

  // ---- styling (fill, line colour, width, dash, arrowheads) for editor shapes, converted shapes and boxes
  function styleKind(e) {
    if (!e) return null;
    if (isShp(e)) return isLine(e) ? 'line' : 'shape';
    if (e.querySelector('svg.geo')) return 'geo';
    return 'box';
  }
  function closedPath(p) { return /[zZ]/.test(p.getAttribute('d') || ''); }
  function geoPaths(e) { return Array.prototype.slice.call(e.querySelectorAll('svg.geo path:not(.hit)')); }
  function getStyle(e) {
    var k = styleKind(e), s = { kind: k, fill: 'none', stroke: 'none', sw: 0, dash: 'solid', arrow: 'none' };
    if (k === 'line' || k === 'shape') { var a = shpAttrs(e); s.fill = a.fill; s.stroke = a.stroke; s.sw = a.sw; s.dash = a.dash; s.arrow = a.arrow; }
    else if (k === 'geo') {
      geoPaths(e).forEach(function (p) {
        var f = p.getAttribute('fill'), st = p.getAttribute('stroke');
        if (s.fill === 'none' && f && f !== 'none' && closedPath(p)) s.fill = f;
        if (s.stroke === 'none' && st && st !== 'none') { s.stroke = st; s.sw = parseFloat(p.getAttribute('stroke-width')) || 1; s.dash = p.getAttribute('stroke-dasharray') ? 'dash' : 'solid'; }
      });
    } else if (k === 'box') {
      var cs = getComputedStyle(e);
      if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) s.fill = cs.backgroundColor;
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) { s.stroke = cs.outlineColor; s.sw = parseFloat(cs.outlineWidth); }
    }
    return s;
  }
  function toHex(c) {
    if (!c || c === 'none') return null;
    if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map(function (x) { return x + x; }).join('').toLowerCase();
    var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    return m ? '#' + [m[1], m[2], m[3]].map(function (v) { return ('0' + (+v).toString(16)).slice(-2); }).join('') : null;
  }
  function applyStyle(prop, value, continuous) {
    if (!sel) {                                   // nothing selected: set what new shapes look like
      if (prop === 'fill') DEF.shape.fill = value;
      else if (prop !== 'arrow') { DEF.line[prop] = value; DEF.shape[prop] = value; }
      saveDefaults();
      if (!continuous) toast('New shapes and lines will use this ' + ({ fill: 'fill', stroke: 'line colour', sw: 'line width', dash: 'line style' }[prop] || 'style'));
      updateStyleControls();
      return;
    }
    var fits = function (e) { var k = styleKind(e); return !(prop === 'arrow' && k !== 'line') && !(prop === 'fill' && k === 'line'); };
    var list = selList().filter(fits);
    if (!list.length) {
      if (prop === 'arrow') return toast('Arrowheads apply to lines drawn in the editor');
      return toast('Lines have no fill — use Line colour');
    }
    if (!styleSnap) { snapshot(); styleSnap = true; }
    if (!continuous) styleSnap = false;
    list.forEach(function (e) { styleOne(e, prop, value); });
    markDirty();
    placeOverlay();
    updateStyleControls();
  }
  function styleOne(e, prop, value) {
    var k = styleKind(e);
    if (k === 'line' || k === 'shape') {
      if ((prop === 'sw' || prop === 'dash') && (e.getAttribute('data-stroke') || 'none') === 'none') e.setAttribute('data-stroke', (k === 'line' ? DEF.line : DEF.shape).stroke);
      if (prop === 'stroke' && value !== 'none' && !(parseFloat(e.getAttribute('data-sw')) > 0)) e.setAttribute('data-sw', '2');
      e.setAttribute({ fill: 'data-fill', stroke: 'data-stroke', sw: 'data-sw', dash: 'data-dash', arrow: 'data-arrow' }[prop], value);
      renderShape(e);
      flushShapes();
    } else if (k === 'geo') {
      Array.prototype.forEach.call(e.querySelectorAll('svg.geo'), function (svg) {
        if (svg.closest('.shp')) return;
        var paths = Array.prototype.slice.call(svg.querySelectorAll('path:not(.hit)'));
        var heads = svg.querySelectorAll('polygon, ellipse'), hstroke = svg.querySelectorAll('polyline');
        paths.forEach(function (p) {
          if (prop === 'fill' && closedPath(p)) p.setAttribute('fill', value);
          if (prop === 'stroke') p.setAttribute('stroke', value);
          if (prop === 'sw') { if (!p.getAttribute('stroke') || p.getAttribute('stroke') === 'none') p.setAttribute('stroke', DEF.shape.stroke); p.setAttribute('stroke-width', value); }
          if (prop === 'dash') {
            var sw = parseFloat(p.getAttribute('stroke-width')) || 1, m = /stroke-dasharray="([^"]*)"/.exec(dashAttr(value, sw));
            if (m) p.setAttribute('stroke-dasharray', m[1]); else p.removeAttribute('stroke-dasharray');
            if (value === 'dot' || value === 'dashdot') p.setAttribute('stroke-linecap', 'round');
          }
        });
        if (prop === 'stroke') {
          Array.prototype.forEach.call(heads, function (h) { h.setAttribute('fill', value); });
          Array.prototype.forEach.call(hstroke, function (h) { h.setAttribute('stroke', value); });
        }
        syncWhole(svg);
      });
    } else {
      if (prop === 'fill') e.style.background = value === 'none' ? '' : value;
      if (prop === 'stroke' || prop === 'sw') {
        var cur = getStyle(e), col = prop === 'stroke' ? value : (cur.stroke !== 'none' ? cur.stroke : DEF.shape.stroke);
        var w = prop === 'sw' ? value : (cur.sw || 2);
        if (col === 'none') { e.style.removeProperty('outline'); e.style.removeProperty('outline-offset'); }
        else { e.style.outline = w + 'px solid ' + col; e.style.outlineOffset = (-w / 2) + 'px'; }
      }
      syncStyle(e);
    }
  }
  function updateStyleControls() {
    if (!ui.fill) return;
    var s = sel ? getStyle(sel) : { kind: null, fill: DEF.shape.fill, stroke: DEF.line.stroke, sw: DEF.line.sw, dash: DEF.line.dash, arrow: 'none' };
    ui.fill.value = toHex(s.fill) || toHex(DEF.shape.fill) || '#4f81bd';
    ui.stroke.value = toHex(s.stroke) || toHex(DEF.line.stroke) || '#4f81bd';
    ui.noFill.classList.toggle('re-active', s.fill === 'none');
    ui.noLine.classList.toggle('re-active', s.stroke === 'none');
    var sw = String(s.sw || DEF.line.sw);
    if (!Array.prototype.some.call(ui.sw.options, function (o) { return o.value === sw; })) ui.sw.appendChild(el('option', { value: sw, text: sw + ' px' }));
    ui.sw.value = sw;
    ui.dash.value = s.dash || 'solid';
    ui.arrow.value = s.arrow || 'none';
    var all = selList();
    ui.arrow.disabled = !!sel && !all.some(isLine);
    ui.fill.disabled = ui.noFill.disabled = !!sel && all.every(isLine);
  }

  // ------------------------------------------------------------------ undo / dirty
  function snapshot() {
    undoStack.push({ html: srcRoot().innerHTML, idx: Reveal.getIndices() });
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    markDirty();
  }
  function markDirty() {
    dirty = true;
    ui.save.classList.add('re-dirty');
    ui.save.textContent = 'Save •';
  }
  function markClean() {
    dirty = false;
    ui.save.classList.remove('re-dirty');
    ui.save.textContent = 'Saved';
  }
  function doUndo() {
    if (editingEl) endTextEdit();
    var s = undoStack.pop();
    if (!s) return toast('Nothing to undo');
    redoStack.push({ html: srcRoot().innerHTML, idx: Reveal.getIndices() });
    srcRoot().innerHTML = s.html;
    rebuildLive(s.idx);
    markDirty();
  }
  function doRedo() {
    if (editingEl) endTextEdit();
    var s = redoStack.pop();
    if (!s) return toast('Nothing to redo');
    undoStack.push({ html: srcRoot().innerHTML, idx: Reveal.getIndices() });
    srcRoot().innerHTML = s.html;
    rebuildLive(s.idx);
    markDirty();
  }

  // re-create the live slides from the source (after undo/redo and slide re-ordering)
  function rebuildLive(idx) {
    deselect();
    liveRoot().innerHTML = srcRoot().innerHTML;
    Reveal.sync();
    var h = Math.max(0, Math.min(idx.h || 0, Reveal.getHorizontalSlides().length - 1));
    Reveal.slide(h, idx.v || 0);
    loadAround();
    if (typeof window.fitAround === 'function') { try { window.fitAround(); } catch (err) { /* ignore */ } }
    onSlide();
  }
  function loadAround() {
    var all = Reveal.getSlides(), cur = curSection(), i = all.indexOf(cur);
    all.slice(Math.max(0, i - 2), i + 3).forEach(function (s) {
      s.querySelectorAll('img[data-src], video[data-src], iframe[data-src]').forEach(function (m) {
        if (!m.getAttribute('src')) m.setAttribute('src', m.getAttribute('data-src'));
      });
    });
  }

  // ------------------------------------------------------------------ selection overlay
  function selList() { return multi.length ? multi.slice() : (sel ? [sel] : []); }
  function isMulti() { return multi.length > 1; }
  // select several elements (a list of one is a plain selection)
  function setSel(list, primary) {
    list = list.filter(function (x, i) { return x && document.contains(x) && list.indexOf(x) === i; });
    if (!list.length) { deselect(); return; }
    if (list.length === 1) { multi = []; sel = null; select(list[0]); return; }
    multi = list;
    sel = primary && list.indexOf(primary) >= 0 ? primary : list[list.length - 1];
    styleSnap = false;
    ui.hover.style.display = 'none';
    placeOverlay();
    updateFields();
  }
  // Shift-click: add the element to the selection, or take it out; returns whether it is selected now
  function toggleInSel(e) {
    var list = selList(), i = list.indexOf(e);
    if (i >= 0) { list.splice(i, 1); setSel(list, null); return false; }
    if (list.length && list[0].parentElement !== e.parentElement) { toast('Elements inside a group can only be selected one at a time'); return false; }
    list.push(e);
    setSel(list, e);
    return true;
  }
  function selectAll() {
    var list = items().filter(function (e) { return !e.hasAttribute('data-layout'); });
    if (!list.length) return toast('Nothing to select on this slide');
    setSel(list, null);
    toast(list.length + ' element' + (list.length === 1 ? '' : 's') + ' selected');
  }
  // the union of the positioned elements' boxes, in slide px
  function groupBox(list) {
    var bs = list.filter(isPositioned).map(boxOf);
    if (!bs.length) return null;
    var x = Math.min.apply(null, bs.map(function (b) { return b.x; })), y = Math.min.apply(null, bs.map(function (b) { return b.y; }));
    var r = Math.max.apply(null, bs.map(function (b) { return b.x + b.w; })), bt = Math.max.apply(null, bs.map(function (b) { return b.y + b.h; }));
    return { x: x, y: y, w: r - x, h: bt - y };
  }
  function select(e) {
    if (sel === e && !multi.length) return;
    multi = [];
    sel = e;
    styleSnap = false;
    ui.hover.style.display = 'none';
    placeOverlay();
    updateFields();
  }
  function deselect() {
    sel = null;
    multi = [];
    hideMulti();
    styleSnap = false;
    ui.sel.style.display = 'none';
    ui.ep[0].style.display = ui.ep[1].style.display = 'none';
    ui.hover.style.display = 'none';
    updateFields();
  }
  function rectOf(e) {
    var r = e.getBoundingClientRect();
    if (r.width < 6) { r = { left: r.left - 3, top: r.top, width: 6, height: r.height }; }
    if (r.height < 6) { r = { left: r.left, top: r.top - 3, width: r.width, height: 6 }; }
    return r;
  }
  function hideMulti() {
    if (!ui.sel) return;
    ui.sel.classList.remove('re-multi');
    (ui.mOut || []).forEach(function (o) { o.style.display = 'none'; });
  }
  function placeMulti() {
    var list = multi.filter(function (x) { return document.contains(x); });
    var L = Infinity, T = Infinity, R = -Infinity, B = -Infinity;
    list.forEach(function (e, k) {
      var r = rectOf(e);
      L = Math.min(L, r.left); T = Math.min(T, r.top); R = Math.max(R, r.left + r.width); B = Math.max(B, r.top + r.height);
      var o = ui.mOut[k];
      if (!o) { o = ui.mOut[k] = el('div', { 'class': 're-ui re-msel' }); document.body.appendChild(o); }
      o.style.display = 'block'; o.style.left = r.left + 'px'; o.style.top = r.top + 'px'; o.style.width = r.width + 'px'; o.style.height = r.height + 'px';
    });
    for (var k = list.length; k < ui.mOut.length; k++) ui.mOut[k].style.display = 'none';
    ui.sel.classList.remove('re-line', 're-static');
    ui.sel.classList.add('re-multi');
    var s = ui.sel.style;
    s.display = 'block'; s.left = L + 'px'; s.top = T + 'px'; s.width = (R - L) + 'px'; s.height = (B - T) + 'px';
    var gb = groupBox(list);
    ui.selLabel.textContent = list.length + ' selected' + (gb ? ' · ' + Math.round(gb.x) + ', ' + Math.round(gb.y) + '  ' + Math.round(gb.w) + '×' + Math.round(gb.h) : '');
  }
  function placeOverlay() {
    ui.ep[0].style.display = ui.ep[1].style.display = 'none';
    if (isMulti()) { placeMulti(); return; }
    hideMulti();
    if (!sel || !document.contains(sel)) { ui.sel.style.display = 'none'; return; }
    var line = isLine(sel);
    ui.sel.classList.toggle('re-line', line);
    if (line) {
      var A = lineAbs(sel);
      [0, 1].forEach(function (k) {
        var q = frameToScreen(A[2 * k], A[2 * k + 1]);
        ui.ep[k].style.display = 'block'; ui.ep[k].style.left = q.x + 'px'; ui.ep[k].style.top = q.y + 'px';
      });
    }
    var r = rectOf(sel);
    var s = ui.sel.style;
    s.display = 'block'; s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    var movable = isPositioned(sel);
    ui.sel.classList.toggle('re-static', !movable);
    var b = boxOf(sel);
    var build = sel.classList.contains('fragment') ? ' · build ' + (sel.getAttribute('data-fragment-index') || '') : '';
    if (line) {
      var LL = lineAbs(sel), len = Math.hypot(LL[2] - LL[0], LL[3] - LL[1]), ang = Math.round(-Math.atan2(LL[3] - LL[1], LL[2] - LL[0]) * 180 / Math.PI);
      ui.selLabel.textContent = 'length ' + Math.round(len) + ' · ' + ang + '°' + build;
      return;
    }
    ui.selLabel.textContent = movable ? Math.round(b.x) + ', ' + Math.round(b.y) + '  ' + Math.round(b.w) + '×' + Math.round(b.h) + build : 'not positioned' + build;
  }
  function showHover(e) {
    if (!e || e === sel || gesture || multi.indexOf(e) >= 0) { ui.hover.style.display = 'none'; return; }
    var r = rectOf(e), s = ui.hover.style;
    s.display = 'block'; s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
  }

  // ------------------------------------------------------------------ mouse: select / move / resize
  function onMouseDown(ev) {
    if (ev.button !== 0) return;
    var t = ev.target;
    if (t.closest && t.closest('.re-ui')) {
      if (t.classList.contains('re-h') && sel) startResize(ev, t.getAttribute('data-dir'));
      if (t.classList.contains('re-ep') && sel) startEndpoint(ev, +t.getAttribute('data-end'));
      return;
    }
    if (tool) {
      if (editingEl) endTextEdit();
      if (t.closest && t.closest('.reveal') && !Reveal.isOverview()) startDraw(ev);
      return;
    }
    if (editingEl) {
      if (editingEl.contains(t)) return;      // caret placement inside the text being edited
      endTextEdit();
    }
    if (!t.closest || !t.closest('.reveal') || t.closest('.reveal .controls, .reveal .progress') || Reveal.isOverview()) return;
    var it = t.closest('.reveal .slides') ? (ev.altKey ? innerItem(t) : topItem(t)) : null;
    if (!it) {                // an empty part of the slide: drag out a rectangle to select what is inside it
      ev.preventDefault();
      if (!ev.shiftKey) deselect();
      gesture = { kind: 'marquee', x0: ev.clientX, y0: ev.clientY, add: ev.shiftKey ? selList() : [], moved: false };
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    var collapse = null;
    if (ev.shiftKey) { if (!toggleInSel(it)) return; }                 // Shift-click: add to / take out of the selection
    else if (isMulti() && multi.indexOf(it) >= 0) collapse = it;       // drag moves them all; a plain click picks just this one
    else select(it);
    var list = selList().filter(isPositioned);
    if (!isPositioned(it) || !list.length) return;
    gesture = { kind: 'move', el: it, els: list, boxes: list.map(boxOf), x0: ev.clientX, y0: ev.clientY, b: groupBox(list),
                moved: false, snaps: snapTargets(list), collapse: collapse };
  }
  function dragMarquee(ev) {
    var g = gesture;
    if (!g.moved && Math.abs(ev.clientX - g.x0) + Math.abs(ev.clientY - g.y0) < 4) return;
    g.moved = true;
    var L = Math.min(g.x0, ev.clientX), T = Math.min(g.y0, ev.clientY), R = Math.max(g.x0, ev.clientX), B = Math.max(g.y0, ev.clientY);
    var s = ui.marquee.style;
    s.display = 'block'; s.left = L + 'px'; s.top = T + 'px'; s.width = (R - L) + 'px'; s.height = (B - T) + 'px';
    var hit = items().filter(function (e) {
      if (e.hasAttribute('data-layout')) return false;      // the layout's logo / footer: click those to pick them
      var r = e.getBoundingClientRect();
      return r.width + r.height > 0 && r.left >= L - 1 && r.top >= T - 1 && r.right <= R + 1 && r.bottom <= B + 1;
    });
    setSel(g.add.concat(hit.filter(function (x) { return g.add.indexOf(x) < 0; })), null);
  }

  function startResize(ev, dir) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!isPositioned(sel)) return toast('This element is laid out by the page, not positioned; it cannot be resized here.');
    gesture = { kind: 'resize', el: sel, dir: dir, x0: ev.clientX, y0: ev.clientY, b: boxOf(sel), moved: false,
                keep: /^(IMG|VIDEO)$/.test(sel.tagName) || sel.classList.contains('pic') || sel.classList.contains('vidwrap') };
  }

  function onMouseMove(ev) {
    if (!gesture) {
      if (!editingEl && ev.target.closest && !ev.target.closest('.re-ui')) showHover(topItem(ev.target));
      return;
    }
    if (gesture.kind === 'draw' || gesture.kind === 'endpoint') { dragShape(ev); return; }
    if (gesture.kind === 'marquee') { dragMarquee(ev); return; }
    var g = gesture, s = scale();
    var dx = (ev.clientX - g.x0) / s, dy = (ev.clientY - g.y0) / s;
    if (!g.moved) {
      if (Math.abs(ev.clientX - g.x0) + Math.abs(ev.clientY - g.y0) < 3) return;
      g.moved = true;
      snapshot();
      (g.els || [g.el]).forEach(normalize);
      ui.hover.style.display = 'none';
    }
    var e = g.el, b = g.b;
    if (g.kind === 'move') {
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      var x = b.x + dx, y = b.y + dy;
      var snapped = (ev.metaKey || ev.ctrlKey) ? null : snap(x, y, b.w, b.h, g.snaps);
      if (snapped) { x = snapped.x; y = snapped.y; }
      showGuides(snapped);
      g.els.forEach(function (m, i) { m.style.left = px(g.boxes[i].x + x - b.x); m.style.top = px(g.boxes[i].y + y - b.y); touched.add(m); });
    } else {
      var d = g.dir, nx = b.x, ny = b.y, nw = b.w, nh = b.h;
      if (d.indexOf('e') >= 0) nw = b.w + dx;
      if (d.indexOf('s') >= 0) nh = b.h + dy;
      if (d.indexOf('w') >= 0) { nw = b.w - dx; nx = b.x + dx; }
      if (d.indexOf('n') >= 0) { nh = b.h - dy; ny = b.y + dy; }
      var keep = (d.length === 2) && (g.keep !== ev.shiftKey);
      if (keep && b.w > 0 && b.h > 0) {
        var r = b.w / b.h;
        if (Math.abs(nw - b.w) / b.w > Math.abs(nh - b.h) / b.h) nh = nw / r; else nw = nh * r;
        if (d.indexOf('w') >= 0) nx = b.x + b.w - nw;
        if (d.indexOf('n') >= 0) ny = b.y + b.h - nh;
      }
      nw = Math.max(nw, 2); nh = Math.max(nh, 2);
      e.style.left = px(nx); e.style.top = px(ny); touched.add(e);
      applySize(e, nw, nh);
    }
    placeOverlay();
    updateFields();
  }

  function onMouseUp() {
    if (!gesture) return;
    var g = gesture;
    gesture = null;
    showGuides(null);
    if (g.kind === 'draw' || g.kind === 'endpoint') { endShapeGesture(g); return; }
    if (g.kind === 'marquee') { ui.marquee.style.display = 'none'; return; }
    if (g.moved) { flushTouched(); markDirty(); placeOverlay(); updateFields(); }
    else if (g.collapse) select(g.collapse);
  }

  // snapping to slide edges/centre and to other items on the slide
  function snapTargets(moving) {
    var list = Array.isArray(moving) ? moving : [moving];
    var S = slideSize(), xs = [0, S.w / 2, S.w], ys = [0, S.h / 2, S.h];
    if (list[0].parentElement === frameOf(curSection())) {
      items().forEach(function (o) {
        if (list.indexOf(o) >= 0 || !isPositioned(o)) return;
        var b = boxOf(o);
        xs.push(b.x, b.x + b.w / 2, b.x + b.w);
        ys.push(b.y, b.y + b.h / 2, b.y + b.h);
      });
    } else { xs = []; ys = []; }
    return { xs: xs, ys: ys };
  }
  function snap(x, y, w, h, T) {
    if (!T) return null;
    var best = function (vals, cands) {
      var m = null;
      vals.forEach(function (v, i) {
        cands.forEach(function (c) {
          var d = c - v;
          if (Math.abs(d) <= SNAP && (!m || Math.abs(d) < Math.abs(m.d))) m = { d: d, at: c, i: i };
        });
      });
      return m;
    };
    var bx = best([x, x + w / 2, x + w], T.xs), by = best([y, y + h / 2, y + h], T.ys);
    if (!bx && !by) return null;
    return { x: x + (bx ? bx.d : 0), y: y + (by ? by.d : 0), gx: bx ? bx.at : null, gy: by ? by.at : null };
  }
  function showGuides(sn) {
    var fr = frameOf(curSection());
    if (!sn || !fr) { ui.gv.style.display = ui.gh.style.display = 'none'; return; }
    var r = fr.getBoundingClientRect(), s = scale();
    if (sn.gx != null) { ui.gv.style.display = 'block'; ui.gv.style.left = (r.left + sn.gx * s) + 'px'; ui.gv.style.top = r.top + 'px'; ui.gv.style.height = r.height + 'px'; }
    else ui.gv.style.display = 'none';
    if (sn.gy != null) { ui.gh.style.display = 'block'; ui.gh.style.top = (r.top + sn.gy * s) + 'px'; ui.gh.style.left = r.left + 'px'; ui.gh.style.width = r.width + 'px'; }
    else ui.gh.style.display = 'none';
  }

  function onDblClick(ev) {
    var t = ev.target;
    if (t.closest && t.closest('.re-ui')) return;
    if (editingEl && editingEl.contains(t)) return;
    var it = ev.altKey ? innerItem(t) : topItem(t);
    if (!it) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (isShp(it) && !it.querySelector('.tb')) editShapeText(it);
    else if (textTarget(it, t)) startTextEdit(it, ev);
    else if (it.querySelector('img') || it.tagName === 'IMG') pickFile(function (f) { replaceImage(it, f); }, 'image/*');
  }
  function onClickCapture(ev) {
    var t = ev.target;
    if (t.closest && t.closest('.re-ui')) return;
    if (editingEl && editingEl.contains(t)) return;
    if (t.closest && t.closest('.reveal .slides')) { ev.preventDefault(); ev.stopPropagation(); }
  }

  // ------------------------------------------------------------------ text editing
  function textTarget(it, t) {
    var tb = it.querySelector('.tb') || (it.classList.contains('tb') ? it : null);
    if (tb) {
      // in a group, edit the text box that was double-clicked
      var inner = t && t.closest && t.closest('.tb');
      return inner && it.contains(inner) ? inner : tb;
    }
    if (it.querySelector('img, video, iframe, svg, canvas')) return null;
    return (it.textContent || '').trim() ? it : null;
  }
  function startTextEdit(it, ev) {
    var target = textTarget(it, ev && ev.target);
    if (!target) return toast('No text to edit here');
    select(it);
    editBefore = { html: srcRoot().innerHTML, idx: Reveal.getIndices() };
    editingEl = target;
    target.setAttribute('contenteditable', 'true');
    target.setAttribute('spellcheck', 'true');
    target.addEventListener('input', onTextInput);
    target.focus();
    if (ev && document.caretRangeFromPoint) {
      var rg = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (rg && target.contains(rg.startContainer)) { var s = getSelection(); s.removeAllRanges(); s.addRange(rg); }
    }
    Reveal.configure({ keyboard: false });
    document.documentElement.classList.add('re-texting');
    updateFields();
  }
  function endTextEdit() {
    if (!editingEl) return;
    var t = editingEl;
    editingEl = null;
    t.removeAttribute('contenteditable');
    t.removeAttribute('spellcheck');
    t.removeEventListener('input', onTextInput);
    var shp = t.closest('.shp');
    if (shp) {                                    // shapes and text boxes: save the whole element
      var tx = shp.querySelector(':scope > .tx');
      if (tx && newTextShapes.has(shp) && !(t.textContent || '').replace(/\u200b/g, '').trim()) tx.remove();
      newTextShapes.delete(shp);
      autoHeight(shp);
      shapesToSync.delete(shp);
      var ssrc = srcOf(shp), before = ssrc ? ssrc.outerHTML : null;
      syncWhole(shp);
      var after = srcOf(shp) ? srcOf(shp).outerHTML : null;
      if (before !== after) { undoStack.push(editBefore); redoStack.length = 0; markDirty(); }
      Reveal.configure({ keyboard: origKeyboard });
      document.documentElement.classList.remove('re-texting');
      placeOverlay(); updateFields();
      return;
    }
    var src = srcOf(t);
    if (src && src.innerHTML !== t.innerHTML) {
      undoStack.push(editBefore); redoStack.length = 0;
      src.innerHTML = t.innerHTML;
      markDirty();
      refit(t.closest('.tx'));
    }
    Reveal.configure({ keyboard: origKeyboard });
    document.documentElement.classList.remove('re-texting');
    placeOverlay();
    updateFields();
  }
  function textBox() {   // the text container to restyle: the one being edited, else the selected item's
    if (editingEl) return editingEl;
    if (!sel) return null;
    return sel.querySelector('.tb') || (textTarget(sel) || null);
  }
  function syncTextBox(box) {
    var src = srcOf(box);
    if (src) src.innerHTML = box.innerHTML;
    if (box.style) syncStyle(box);
    refit(box.closest('.tx'));
    markDirty();
    placeOverlay();
  }
  function textBoxes() {   // with several selected: every selected element's text
    if (editingEl || !isMulti()) { var b = textBox(); return b ? [b] : []; }
    return multi.map(function (e) { return e.querySelector('.tb') || textTarget(e); }).filter(Boolean);
  }
  function scaleFont(f) {
    var boxes = textBoxes();
    if (!boxes.length) return toast('Select a text box first');
    if (!editingEl) snapshot();
    boxes.forEach(function (box) {
      var nodes = [box].concat(Array.prototype.slice.call(box.querySelectorAll('[style]')));
      var hit = false;
      nodes.forEach(function (n) {
        var st = n.getAttribute('style');
        if (!st || !/font-size/.test(st)) return;
        hit = true;
        n.setAttribute('style', st.replace(/(font-size\s*:\s*(?:calc\()?\s*)([\d.]+)px/g, function (m, a, v) { return a + (Math.round(parseFloat(v) * f * 100) / 100) + 'px'; }));
      });
      if (!hit) box.style.fontSize = px(parseFloat(getComputedStyle(box).fontSize) * f);
      syncTextBox(box);
    });
  }
  function align(a) {
    var boxes = textBoxes();
    if (!boxes.length) return toast('Select a text box first');
    if (!editingEl) snapshot();
    boxes.forEach(function (box) {
      var ps = box.querySelectorAll('.p');
      if (ps.length) Array.prototype.forEach.call(ps, function (p) { p.style.textAlign = a; });
      else box.style.textAlign = a;
      syncTextBox(box);
    });
  }
  function fmt(cmd, val) {
    if (!editingEl) return toast('Double-click into text first, then select the words to format');
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, val);
  }

  // ------------------------------------------------------------------ element operations
  function needSel() { if (!sel) { toast('Select an element first'); return false; } return true; }

  function deleteSel() {
    if (!needSel()) return;
    var list = selList(), srcs = list.map(srcOf);    // find every source before removing any (paths come from the live tree)
    snapshot();
    srcs.forEach(function (src) { if (src) src.remove(); });
    list.forEach(function (e) { e.remove(); });
    deselect();
    if (list.length > 1) toast(list.length + ' elements deleted (⌘Z brings them back)');
  }
  function duplicateSel() {
    if (!needSel()) return;
    var list = selList().filter(function (e) { return srcOf(e); });
    if (!list.length) return;
    snapshot();
    var pos = function (e) { return Array.prototype.indexOf.call(e.parentElement.children, e); };
    var pairs = list.map(function (e) { return [e, srcOf(e)]; }).sort(function (a, b) { return pos(a[0]) - pos(b[0]); });
    var anchor = pairs[pairs.length - 1].slice(), copies = [];
    pairs.forEach(function (pr) {          // copies go just above the topmost original, in the same stacking order
      var sc = pr[1].cloneNode(true), lc = pr[0].cloneNode(true);
      anchor[1].after(sc); anchor[0].after(lc);
      anchor = [lc, sc];
      copies.push(lc);
    });
    copies.forEach(function (lc) {
      if (!isPositioned(lc)) return;
      normalize(lc);
      var b = boxOf(lc);
      lc.style.left = px(b.x + 16); lc.style.top = px(b.y + 16);
      syncStyle(lc);
    });
    touched.clear();
    setSel(copies, null);
  }
  // stacking order: ] [ one step, Shift (or } {) to the front / back; several selected move together
  function zorder(dir, toEnd) {
    if (!needSel()) return;
    var list = selList(), lp = list[0].parentElement, src0 = srcOf(list[0]);
    if (!src0) return;
    var sp = src0.parentElement;
    var kids = Array.prototype.slice.call(lp.children), skids = Array.prototype.slice.call(sp.children);
    if (kids.length !== skids.length) return;
    var slots = [], seq = [];
    kids.forEach(function (k, i) { if (!skippable(k)) { slots.push(i); seq.push(k); } });
    var S = new Set(list), i, tmp;
    if (toEnd) {
      var mine = seq.filter(function (x) { return S.has(x); }), rest = seq.filter(function (x) { return !S.has(x); });
      seq = dir > 0 ? rest.concat(mine) : mine.concat(rest);
    } else if (dir > 0) {
      for (i = seq.length - 2; i >= 0; i--) if (S.has(seq[i]) && !S.has(seq[i + 1])) { tmp = seq[i]; seq[i] = seq[i + 1]; seq[i + 1] = tmp; }
    } else {
      for (i = 1; i < seq.length; i++) if (S.has(seq[i]) && !S.has(seq[i - 1])) { tmp = seq[i]; seq[i] = seq[i - 1]; seq[i - 1] = tmp; }
    }
    var order = kids.slice();
    slots.forEach(function (pos, k) { order[pos] = seq[k]; });
    if (order.every(function (k, j) { return k === kids[j]; })) return;
    snapshot();
    var put = function (parent, wanted) {         // move only what is out of place (moving an iframe reloads it)
      wanted.forEach(function (node, j) { if (parent.children[j] !== node) parent.insertBefore(node, parent.children[j] || null); });
    };
    put(sp, order.map(function (k) { return skids[kids.indexOf(k)]; }));
    put(lp, order);
    placeOverlay();
  }
  function toggleBuild() {
    if (!needSel()) return;
    var list = selList().filter(function (e) { return srcOf(e); });
    if (!list.length) return;
    snapshot();
    var pairs = list.map(function (e) { return [e, srcOf(e)]; });
    if (pairs.every(function (pr) { return pr[1].classList.contains('fragment'); })) {
      pairs.forEach(function (pr) { pr.forEach(function (x) { x.classList.remove('fragment', 'appear', 'fade-out'); x.removeAttribute('data-fragment-index'); }); });
      toast(list.length > 1 ? 'Builds removed — these ' + list.length + ' elements are always visible' : 'Build removed — element is always visible');
    } else {
      var sec = pairs[0][1].closest('section'), max = 0;
      sec.querySelectorAll('.fragment[data-fragment-index]').forEach(function (f) {
        if (list.length > 1 && pairs.some(function (pr) { return pr[1] === f; })) return;
        max = Math.max(max, parseInt(f.getAttribute('data-fragment-index'), 10) || 0);
      });
      var k = String(max + 1);
      pairs.forEach(function (pr) { pr.forEach(function (x) { x.classList.add('fragment', 'appear'); x.setAttribute('data-fragment-index', k); }); pr[0].classList.add('visible'); });
      toast(list.length > 1 ? 'These ' + list.length + ' elements appear together on click #' + k + ' when presenting' : 'Appears on click #' + k + ' when presenting');
    }
    placeOverlay(); updateFields();
  }
  var nudgeTimer = null, nudging = false;
  function nudgeKey(dx, dy) {   // one undo step per burst of arrow presses
    if (!nudging) { snapshot(); nudging = true; }
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function () { nudging = false; }, 800);
    var list = selList().filter(isPositioned);
    if (!list.length) return;
    list.forEach(function (e) {
      normalize(e);
      var b = boxOf(e);
      e.style.left = px(b.x + dx); e.style.top = px(b.y + dy);
      touched.add(e);
    });
    flushTouched(); markDirty();
    placeOverlay(); updateFields();
  }
  function cycle(d) {
    var list = items();
    if (!list.length) return;
    var i = sel ? list.indexOf(sel) : -1;
    select(list[(i + d + list.length) % list.length]);
  }

  // insert an element (HTML string) into the current slide, on top
  function insertItem(html, quiet) {     // quiet: no undo step, no selection (the caller does both)
    var live = curSection(), src = srcOf(live);
    if (!src) return null;
    var lfr = frameOf(live), sfr = frameOf(src);
    if (!quiet) snapshot();
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var lnode = tmp.firstElementChild;
    var snode = srcDoc.importNode(lnode, true);
    var notesL = lfr.querySelector(':scope > aside.notes'), notesS = sfr.querySelector(':scope > aside.notes');
    lfr.insertBefore(lnode, notesL); sfr.insertBefore(snode, notesS);
    lnode.querySelectorAll('[data-src]').forEach(function (m) { m.setAttribute('src', m.getAttribute('data-src')); });
    if (lnode.hasAttribute('data-src')) lnode.setAttribute('src', lnode.getAttribute('data-src'));
    if (!quiet) select(lnode);
    return lnode;
  }
  function isConverted() { return !!frameOf(curSection()).classList.contains('sf'); }
  function addText() {
    var S = slideSize(), w = Math.round(S.w * 0.4), h = 60;
    var x = Math.round((S.w - w) / 2), y = Math.round((S.h - h) / 2);
    var conv = isConverted();
    var font = conv ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;color:#ffffff;" : '';
    var html = '<div class="e shp" data-shape="rect" data-fill="none" data-stroke="none" data-sw="2" data-dash="solid" data-tbox style="position:absolute;box-sizing:border-box;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;">' +
      '<svg class="geo"></svg><div class="tx" style="position:absolute;box-sizing:border-box;display:flex;flex-direction:column;left:0;top:0;width:' + w + 'px;height:' + h + 'px;padding:4.8px 9.6px;justify-content:flex-start;overflow:visible;">' +
      '<div class="tb"><div class="p" style="margin:0;white-space:pre-wrap;overflow-wrap:break-word;text-align:left;line-height:1.22;font-size:32px;' + font + '"><span>New text</span></div></div></div></div>';
    var n = insertItem(html);
    if (n) {
      renderShape(n); autoHeight(n); flushShapes();
      startTextEdit(n, null);
      var span = n.querySelector('span');
      var r = document.createRange(); r.selectNodeContents(span);
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  }
  function upload(file) {
    return fetch('/__upload?name=' + encodeURIComponent(file.name || 'pasted.png'), {
      method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/octet-stream' }, body: file
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j.url; }); });
  }
  function mediaSize(url, isVideo) {
    return new Promise(function (res) {
      if (isVideo) {
        var v = document.createElement('video');
        v.onloadedmetadata = function () { res({ w: v.videoWidth || 640, h: v.videoHeight || 360 }); };
        v.onerror = function () { res({ w: 640, h: 360 }); };
        v.src = url;
      } else {
        var im = new Image();
        im.onload = function () { res({ w: im.naturalWidth || 400, h: im.naturalHeight || 300 }); };
        im.onerror = function () { res({ w: 400, h: 300 }); };
        im.src = url;
      }
    });
  }
  function addMedia(file, at) {
    var isVideo = /^video\//.test(file.type) || /\.(mp4|webm|mov|m4v)$/i.test(file.name || '');
    toast('Adding ' + (file.name || 'image') + '…');
    upload(file).then(function (url) {
      return mediaSize(url, isVideo).then(function (sz) {
        var S = slideSize(), k = Math.min(1, S.w * 0.6 / sz.w, S.h * 0.6 / sz.h);
        var w = Math.round(sz.w * k), h = Math.round(sz.h * k);
        var x = at ? at.x - w / 2 : (S.w - w) / 2, y = at ? at.y - h / 2 : (S.h - h) / 2;
        x = Math.round(Math.max(0, Math.min(S.w - w, x))); y = Math.round(Math.max(0, Math.min(S.h - h, y)));
        var box = 'position:absolute;box-sizing:border-box;overflow:hidden;left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;';
        var html = isVideo
          ? '<div class="e vidwrap" style="' + box + '"><video class="vid" data-src="' + esc(url) + '" controls playsinline preload="metadata" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain"></video></div>'
          : '<div class="e pic" style="' + box + '"><img data-src="' + esc(url) + '" alt="" draggable="false" style="display:block;width:100%;height:100%;max-width:none;max-height:none;margin:0;border:0"></div>';
        insertItem(html);
        toast('Added ' + url);
      });
    }).catch(function (e) { toast('Could not add the file: ' + e.message, 6000); });
  }
  function replaceImage(it, file) {
    var img = it.tagName === 'IMG' ? it : it.querySelector('img');
    if (!img) return;
    upload(file).then(function (url) {
      var src = srcOf(img);
      snapshot();
      if (src) src.setAttribute(src.hasAttribute('data-src') ? 'data-src' : 'src', url);
      if (img.hasAttribute('data-src')) img.setAttribute('data-src', url);
      img.setAttribute('src', url);
      toast('Image replaced');
    }).catch(function (e) { toast('Could not replace: ' + e.message, 6000); });
  }
  function pickFile(cb, accept) {
    var inp = el('input', { type: 'file', accept: accept || 'image/*,video/*' });
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = function () { if (inp.files[0]) cb(inp.files[0]); inp.remove(); };
    inp.click();
  }
  // ------------------------------------------------------------------ clipboard (works across presentations)
  // Copy puts the element on the system clipboard as self-contained HTML plus a small JSON payload
  // (which deck it came from and which media files it uses). Pasting into another deck asks this deck's
  // reveal-edit to copy those media files into its own media/ folder (renaming on a name clash), then
  // inserts the element with its links rewritten. Plain text pasted from elsewhere becomes a text box.
  var DECK_PATH = null;      // this deck's folder on disk, from the editor server
  fetch('/__whoami', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { DECK_PATH = j.deck || null; }).catch(function () { /* old server */ });
  var CLIP_TYPE = 'application/x-reveal-edit';
  // layout rules the converter's page CSS provides, written inline so a copied element looks the same in any deck
  var BAKE = [
    ['.e', 'position:absolute;box-sizing:border-box;transform-origin:50% 50%'],
    ['.e.pic', 'overflow:hidden'],
    ['.e.g', 'overflow:visible'],
    ['.pic.crop img', 'position:absolute;left:0;top:0'],
    ['.pic img', 'display:block;position:static;max-width:none;max-height:none;margin:0;border:0;box-shadow:none;background:none'],
    ['.tx', 'position:absolute;box-sizing:border-box;display:flex;flex-direction:column;overflow:visible;transform-origin:50% 50%'],
    ['.tx.nowrap .p-c', 'left:50%;transform:translateX(-50%)'],
    ['.tx.nowrap .p-r', 'left:100%;transform:translateX(-100%)'],
    ['.tx.nowrap .p', 'margin:0;white-space:pre;width:max-content;position:relative'],
    ['.tx .p', 'margin:0;white-space:pre-wrap;overflow-wrap:break-word'],
    ['.bu i.bdot', 'border-radius:50%'],
    ['.bu i', 'display:inline-block;background:currentColor'],
    ['.bu', 'display:inline-block;text-indent:0;white-space:pre;line-height:1'],
    ['svg.geo', 'position:absolute;overflow:visible;pointer-events:none'],
    ['.vidwrap video', 'position:absolute;display:block;object-fit:fill;max-width:none;max-height:none;margin:0;border:0;box-shadow:none'],
    ['.vidwrap', 'overflow:hidden;background:#000'],
    ['.embed iframe', 'border:0;display:block;max-width:none;max-height:none;margin:0;box-shadow:none'],
    ['.embed', 'overflow:hidden']
  ];
  function bakeStyles(root) {
    [root].concat(Array.prototype.slice.call(root.querySelectorAll('*'))).forEach(function (n) {
      BAKE.forEach(function (r) {
        var m = false;
        try { m = n.matches(r[0]); } catch (err) { /* ignore */ }
        if (!m) return;
        r[1].split(';').forEach(function (decl) {
          var i = decl.indexOf(':'), prop = decl.slice(0, i), val = decl.slice(i + 1);
          if (!n.style.getPropertyValue(prop)) n.style.setProperty(prop, val);
        });
      });
    });
  }
  // what the presentation's theme gives an element, written inline so it looks the same under another theme
  var TEXT_PROPS = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align',
                    'text-transform', 'letter-spacing', 'text-shadow', 'white-space'];
  var BOX_PROPS = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
                   'display', 'list-style-type', 'list-style-position', 'vertical-align', 'border-top', 'border-right', 'border-bottom', 'border-left',
                   'background-color', 'box-shadow', 'border-radius'];
  function bakeRootText(live, copy) {             // inherited text styling, on the copied element itself
    var cs = getComputedStyle(live);
    TEXT_PROPS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v && !copy.style.getPropertyValue(p)) copy.style.setProperty(p, v); });
  }
  function bakeComputed(live, copy, parentCS) {   // a whole element laid out by the theme (hand-written decks)
    var cs = getComputedStyle(live);
    TEXT_PROPS.forEach(function (p) {
      var v = cs.getPropertyValue(p);
      if (v && (!parentCS || parentCS.getPropertyValue(p) !== v) && !copy.style.getPropertyValue(p)) copy.style.setProperty(p, v);
    });
    BOX_PROPS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v && !copy.style.getPropertyValue(p)) copy.style.setProperty(p, v); });
    if (/^(IMG|VIDEO|IFRAME|CANVAS|svg)$/.test(live.tagName)) {
      var r = live.getBoundingClientRect(), s = scale();
      copy.style.setProperty('width', px(r.width / s)); copy.style.setProperty('height', px(r.height / s));
      copy.style.setProperty('max-width', 'none'); copy.style.setProperty('max-height', 'none');
    }
    if (!parentCS) { copy.style.setProperty('margin', '0'); }
    for (var i = 0; i < live.children.length && i < copy.children.length; i++) bakeComputed(live.children[i], copy.children[i], cs);
  }
  var URL_ATTRS = ['src', 'data-src', 'poster', 'href', 'xlink:href', 'data-background-image'];
  function isRelative(u) { return u && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u.trim()); }
  function mediaRefs(html) {
    var t = document.createElement('template'), out = [];
    t.innerHTML = html;
    var add = function (u) { u = (u || '').trim().replace(/^["']|["']$/g, ''); if (isRelative(u) && out.indexOf(u) < 0) out.push(u); };
    t.content.querySelectorAll('*').forEach(function (n) {
      URL_ATTRS.forEach(function (a) { if (n.hasAttribute(a) && !(a === 'href' && n.tagName === 'A')) add(n.getAttribute(a)); });
      var st = n.getAttribute('style') || '', m, re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
      while ((m = re.exec(st))) add(m[2]);
    });
    return out;
  }
  function b64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function unb64(s) { return decodeURIComponent(escape(atob(s))); }
  function dirOf(f) { var i = (f || '').lastIndexOf('/'); return i >= 0 ? f.slice(0, i) : ''; }
  function clipItem(live) {
    var src = srcOf(live);
    if (!src) return null;
    var copy = src.cloneNode(true);
    copy.classList.remove('visible', 'current-fragment');
    if (!copy.getAttribute('class')) copy.removeAttribute('class');
    var raw = copy.outerHTML;          // as it is: used when pasting back into the same presentation
    bakeStyles(copy);
    var r = live.getBoundingClientRect(), fr = frameOf(curSection()).getBoundingClientRect(), s = scale();
    var box = { x: (r.left - fr.left) / s, y: (r.top - fr.top) / s, w: r.width / s, h: r.height / s };
    var positioned = isPositioned(live);
    if (!positioned) bakeComputed(live, copy, null);
    else if ((live.textContent || '').trim()) bakeRootText(live, copy);
    var html = copy.outerHTML;
    if (!positioned) {                 // wrap flow content in a positioned box so it can be placed anywhere
      html = '<div class="e" style="position:absolute;box-sizing:border-box;left:' + px(box.x) + ';top:' + px(box.y) +
        ';width:' + px(box.w) + ';height:' + px(box.h) + ';">' + html + '</div>';
    }
    var kind = live.querySelector('video') ? 'video' : live.querySelector('iframe') ? 'embedded page' :
      live.querySelector('img') || live.tagName === 'IMG' ? 'picture' : isShp(live) ? 'shape' : 'element';
    return { html: html, raw: raw, text: (live.innerText || '').trim(), kind: kind };
  }
  // the clipboard item for one or more elements (kept in stacking order, so pasting keeps it)
  function clipPayload(list) {
    var pos = function (e) { return Array.prototype.indexOf.call(e.parentElement.children, e); };
    var its = list.slice().sort(function (a, b) { return pos(a) - pos(b); }).map(clipItem).filter(Boolean);
    if (!its.length) return null;
    var S = slideSize(), media = [];
    its.forEach(function (it) { mediaRefs(it.html).forEach(function (m) { if (media.indexOf(m) < 0) media.push(m); }); });
    var texts = its.map(function (it) { return it.text; }).filter(Boolean);
    var plain = texts.length ? texts.join('\n') : its.length === 1 ? '[' + its[0].kind + ' from a reveal.js presentation]' : '[' + its.length + ' elements from a reveal.js presentation]';
    return { app: 'reveal-edit', v: 2, deck: DECK_PATH, file: FILE, w: S.w, h: S.h,
             items: its.map(function (it) { return { html: it.html, raw: it.raw }; }),
             html: its[0].html, raw: its[0].raw,         // (what a single-element reader expects)
             media: media, plain: plain };
  }
  function isSink(t) { return !!(t && t.classList && t.classList.contains('re-clipsink')); }
  function putOnClipboard(e, cut) {
    if (!sel || editingEl || inField(e.target) && !isSink(e.target)) return;
    var pl = clipPayload(selList());
    if (!pl) return;
    e.preventDefault();
    var json = JSON.stringify(pl), n = pl.items.length, what = n > 1 ? n + ' elements' : 'it';
    try {
      e.clipboardData.setData(CLIP_TYPE, json);
      e.clipboardData.setData('text/html', '<div data-reveal-edit="' + b64(json) + '">' + pl.items.map(function (it) { return it.html; }).join('') + '</div>');
      e.clipboardData.setData('text/plain', pl.plain);
    } catch (err) { /* clipboard refused: the copies below still work */ }
    clip = pl;
    // also into the slot every reveal-edit on this computer shares (browsers may keep the data above per site)
    fetch('/__clip/put', { method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' }, body: json }).catch(function () {});
    if (cut) { deleteSel(); toast((n > 1 ? 'Cut ' + n + ' elements' : 'Cut') + ' — paste ' + what + ' on any slide, in this or another presentation (⌘V)'); }
    else toast((n > 1 ? 'Copied ' + n + ' elements' : 'Copied') + ' — paste ' + what + ' on any slide, in this or another presentation (⌘V)');
  }
  // Safari only sends a copy event when something is selected: give it an invisible selection
  function primeClipboard() {
    var t = el('textarea', { 'class': 're-ui re-clipsink', 'aria-hidden': 'true' });
    t.value = ' ';
    t.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0';
    document.body.appendChild(t);
    t.focus(); t.select();
    setTimeout(function () { if (document.activeElement === t) t.blur(); t.remove(); }, 150);
  }
  function readPayload(cd) {
    var j = '';
    try { j = cd.getData(CLIP_TYPE); } catch (err) { /* type not allowed */ }
    if (!j) {
      var m = /data-reveal-edit="([A-Za-z0-9+\/=]+)"/.exec(cd.getData('text/html') || '');
      if (m) { try { j = unb64(m[1]); } catch (err) { j = ''; } }
    }
    if (!j) return null;
    try { var p = JSON.parse(j); return p && p.app === 'reveal-edit' && (p.html || (p.items && p.items.length)) ? p : null; } catch (err) { return null; }
  }
  function rewriteRefs(html, map) {
    if (!Object.keys(map).length) return html;
    var t = document.createElement('template');
    t.innerHTML = html;
    var swap = function (u) { var k = (u || '').trim(); return map.hasOwnProperty(k) ? map[k] : null; };
    t.content.querySelectorAll('*').forEach(function (n) {
      URL_ATTRS.forEach(function (a) {
        if (!n.hasAttribute(a)) return;
        var v = swap(n.getAttribute(a));
        if (v !== null) n.setAttribute(a, v);
      });
      if (n.hasAttribute('style')) {
        var st = n.getAttribute('style'), ns = st.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
          var v = swap(u); return v === null ? m : 'url(' + q + v + q + ')';
        });
        if (ns !== st) n.setAttribute('style', ns);
      }
    });
    return t.innerHTML;
  }
  // gradients and clip paths are referenced by id: give pasted ones new ids if this presentation already uses them
  function uniqueIds(html) {
    var t = document.createElement('template'), ren = {}, taken = function (id) {
      return document.getElementById(id) || (srcDoc && srcDoc.getElementById(id)) || Object.keys(ren).some(function (k) { return ren[k] === id; });
    };
    t.innerHTML = html;
    t.content.querySelectorAll('[id]').forEach(function (n) {
      var id = n.getAttribute('id');
      if (!id || !taken(id)) return;
      var k = 1, nid;
      do { nid = id + '-' + (k++); } while (taken(nid) || t.content.querySelector('[id="' + nid.replace(/"/g, '') + '"]'));
      ren[id] = nid; n.setAttribute('id', nid);
    });
    if (!Object.keys(ren).length) return html;
    t.content.querySelectorAll('*').forEach(function (n) {
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var v = a.value, nv = v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, function (m, q, id) { return ren[id] ? 'url(#' + ren[id] + ')' : m; });
        if (/(^|:)href$/.test(a.name) && v.charAt(0) === '#' && ren[v.slice(1)]) nv = '#' + ren[v.slice(1)];
        if (nv !== v) n.setAttribute(a.name, nv);
      });
    });
    return t.innerHTML;
  }
  function pastePayload(p) {
    var same = p.deck && DECK_PATH && p.deck === DECK_PATH && dirOf(p.file) === dirOf(FILE);
    var need = !same && p.media && p.media.length;
    var step = need ? (p.deck ? fetch('/__import', {
      method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: p.deck, file: p.file, files: p.media, into: FILE })
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      : Promise.resolve({ map: {}, missing: p.media })) : Promise.resolve({ map: {}, missing: [] });
    if (need) toast('Pasting — copying ' + p.media.length + ' media file' + (p.media.length === 1 ? '' : 's') + ' into this presentation…', 6000);
    return step.then(function (res) {
      var its = p.items && p.items.length ? p.items : [{ html: p.html, raw: p.raw }];
      if (!srcOf(curSection())) return;
      snapshot();                          // one undo step for everything pasted
      var nodes = [];
      its.forEach(function (it) {
        var n = insertItem(uniqueIds(same && it.raw ? it.raw : rewriteRefs(it.html, res.map || {})), true);
        if (n) nodes.push(n);
      });
      if (!nodes.length) return;
      var pos = nodes.filter(isPositioned);
      if (pos.length) {                    // same place as the original; nudge if it would sit exactly on top of it, keep it on the slide
        var S = slideSize(), gb = groupBox(pos), f0 = boxOf(pos[0]), dx = 0, dy = 0;
        var clash = function () {
          return items().some(function (o) { return nodes.indexOf(o) < 0 && isPositioned(o) && Math.abs(boxOf(o).x - f0.x - dx) < 1 && Math.abs(boxOf(o).y - f0.y - dy) < 1; });
        };
        while (clash()) { dx += 16; dy += 16; }
        var x = gb.x + dx, y = gb.y + dy;
        if (x + gb.w > S.w) x = Math.max(0, S.w - gb.w);
        if (y + gb.h > S.h) y = Math.max(0, S.h - gb.h);
        if (x < 0 && gb.w <= S.w) x = 0;
        if (y < 0 && gb.h <= S.h) y = 0;
        dx = x - gb.x; dy = y - gb.y;
        if (dx || dy) pos.forEach(function (n) { var b = normalize(n); n.style.left = px(b.x + dx); n.style.top = px(b.y + dy); syncStyle(n); });
        touched.clear();
      }
      setSel(nodes, null);
      var miss = (res.missing || []).length, what = nodes.length > 1 ? nodes.length + ' elements' : '';
      if (miss) toast('Pasted' + (what ? ' ' + what : '') + ', but ' + miss + ' media file' + (miss === 1 ? ' was' : 's were') + ' not found in the source presentation: ' + res.missing.slice(0, 3).join(', '), 7000);
      else toast('Pasted' + (what ? ' ' + what : '') + (need ? ', with ' + (nodes.length > 1 ? 'their' : 'its') + ' media copied into this presentation' : ''));
    }).catch(function (e) { toast('Paste failed: ' + e.message, 7000); });
  }
  function pasteText(txt) {
    addText();
    if (!editingEl) return;
    document.execCommand('insertText', false, txt);
  }

  // ------------------------------------------------------------------ slide operations (on the source, then rebuild)
  function sections(root) { return Array.prototype.filter.call(root.children, function (c) { return c.tagName === 'SECTION'; }); }
  function isStack(s) { return sections(s).length > 0; }
  function unitOf(root, h) { return sections(root)[h]; }
  function srcSlide(idx) {
    var u = unitOf(srcRoot(), idx.h);
    if (!u) return null;
    return isStack(u) ? sections(u)[idx.v || 0] : u;
  }
  function tidyStacks() {   // a stack left with one slide becomes a plain slide
    sections(srcRoot()).forEach(function (u) {
      var kids = sections(u);
      if (kids.length === 1 && u.children.length === 1) u.replaceWith(kids[0]);
    });
  }
  function slideOp(fn) {
    if (editingEl) endTextEdit();
    var idx = Reveal.getIndices();
    var before = srcRoot().innerHTML;
    var next = fn(idx);
    if (!next) return;
    undoStack.push({ html: before, idx: idx }); redoStack.length = 0;
    tidyStacks();
    rebuildLive(next);
    markDirty();
  }
  function inStack(idx) { var u = unitOf(srcRoot(), idx.h); return u && isStack(u); }

  function newSlide() {
    slideOp(function (idx) {
      var cur = srcSlide(idx);
      var fr = frameOf(cur);
      var s = srcDoc.createElement('section');
      if (fr !== cur) {
        var f = srcDoc.createElement('div');
        f.className = fr.className;
        if (fr.getAttribute('style')) f.setAttribute('style', fr.getAttribute('style'));
        Array.prototype.forEach.call(fr.querySelectorAll(':scope > [data-layout]'), function (d) { f.appendChild(d.cloneNode(true)); });
        s.appendChild(f);
      }
      cur.after(s);
      return inStack(idx) ? { h: idx.h, v: (idx.v || 0) + 1 } : { h: idx.h + 1, v: 0 };
    });
  }
  function duplicateSlide() {
    slideOp(function (idx) {
      var cur = srcSlide(idx);
      cur.after(cur.cloneNode(true));
      return inStack(idx) ? { h: idx.h, v: (idx.v || 0) + 1 } : { h: idx.h + 1, v: 0 };
    });
  }
  function deleteSlide() {
    if (Reveal.getTotalSlides() <= 1) return toast('The deck needs at least one slide');
    if (!confirm('Delete this slide? (You can undo with ⌘Z.)')) return;
    slideOp(function (idx) {
      var cur = srcSlide(idx);
      var stacked = inStack(idx);
      cur.remove();
      if (stacked) return { h: idx.h, v: Math.max(0, (idx.v || 0) - 1) };
      return { h: Math.min(idx.h, sections(srcRoot()).length - 1), v: 0 };
    });
  }
  function moveUnit(d) {     // move the current slide (or its whole stack) left/right
    var what = null;
    slideOp(function (idx) {
      var units = sections(srcRoot()), u = units[idx.h], o = units[idx.h + d];
      if (!o) { toast(d < 0 ? 'Already the first slide' : 'Already the last slide'); return null; }
      if (d < 0) o.before(u); else o.after(u);
      what = isStack(u) ? 'The stack of ' + sections(u).length + ' slides' : 'Slide';
      return { h: idx.h + d, v: idx.v || 0 };
    });
    if (what) {
      var n = Reveal.getSlides().indexOf(Reveal.getCurrentSlide()) + 1;
      toast(what + ' moved ' + (d < 0 ? 'left' : 'right') + ' — this is now slide ' + n + ' of ' + Reveal.getTotalSlides());
    }
  }
  function moveInStack(d) {  // move up/down within a vertical stack
    var where = null;
    slideOp(function (idx) {
      if (!inStack(idx)) { toast('This slide is not in a vertical stack (⌘← ⌘→ move it left / right)'); return null; }
      var u = unitOf(srcRoot(), idx.h), kids = sections(u), cur = kids[idx.v || 0], o = kids[(idx.v || 0) + d];
      if (!o) { toast(d < 0 ? 'Already at the top of the stack' : 'Already at the bottom of the stack'); return null; }
      if (d < 0) o.before(cur); else o.after(cur);
      where = [(idx.v || 0) + d + 1, kids.length];
      return { h: idx.h, v: (idx.v || 0) + d };
    });
    if (where) toast('Slide moved ' + (d < 0 ? 'up' : 'down') + ' — now ' + where[0] + ' of ' + where[1] + ' in its stack' + (where[0] === 1 ? ' (the one shown in the main row)' : ''));
  }
  function nestUnderPrevious() {
    slideOp(function (idx) {
      if (idx.h === 0) { toast('There is no slide before this one'); return null; }
      if (inStack(idx) && (idx.v || 0) > 0) { toast('Already inside a stack — use "Move out of stack" first'); return null; }
      var units = sections(srcRoot()), prev = units[idx.h - 1], u = units[idx.h];
      var wasStack = isStack(u);
      var moving = wasStack ? sections(u) : [u];
      if (!isStack(prev)) {                       // turn the previous slide into a stack
        var st = srcDoc.createElement('section');
        prev.before(st);
        st.appendChild(prev);
        prev = st;
      }
      var v0 = sections(prev).length;
      moving.forEach(function (m) { prev.appendChild(m); });
      if (wasStack) u.remove();                   // the emptied stack container
      return { h: idx.h - 1, v: v0 };
    });
  }
  function unnest() {
    slideOp(function (idx) {
      if (!inStack(idx)) { toast('This slide is not in a vertical stack'); return null; }
      var u = unitOf(srcRoot(), idx.h), cur = sections(u)[idx.v || 0];
      u.after(cur);
      var left = sections(u).length;
      return { h: left ? idx.h + 1 : idx.h, v: 0 };
    });
  }

  // ------------------------------------------------------------------ slide numbers
  // Slide-number boxes are the small text boxes that hold only a number (e.g. PowerPoint's slide-number
  // placeholder). They are recognised by a data-slidenum marker, or — in decks converted from PowerPoint —
  // by showing the slide's original number near the bottom of the slide, and then by sharing the exact
  // position of a box already recognised elsewhere. Other numbers on a slide (axis labels, years) are left alone.
  var NUM_RE = /^\d{1,3}(?:\.\d{1,2})?$/;
  function styleNum(e, prop) {
    var m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(-?[\\d.]+)px').exec(e.getAttribute('style') || '');
    return m ? parseFloat(m[1]) : null;
  }
  function plainText(e) { return (e.textContent || '').replace(/[​\s]/g, ''); }
  function slideList() {      // non-hidden slides of the source document, in file order
    var out = [];
    sections(srcRoot()).forEach(function (u, h) {
      (isStack(u) ? sections(u) : [u]).forEach(function (sec, v) {
        if (sec.getAttribute('data-visibility') !== 'hidden') out.push({ sec: sec, h: h, v: v, stacked: v > 0 });
      });
    });
    return out;
  }
  function findNumberBoxes(list) {
    var H = slideSize().h, sigs = [];
    var cands = list.map(function (s) {
      return Array.prototype.filter.call(frameOf(s.sec).children, function (c) { return !skippable(c) && NUM_RE.test(plainText(c)); });
    });
    var found = cands.map(function (cs, i) {
      return cs.filter(function (c) {
        var top = styleNum(c, 'top'), left = styleNum(c, 'left');
        var yes = c.hasAttribute('data-slidenum') ||
          (plainText(c) === list[i].sec.getAttribute('data-pptx-slide') && top != null && top >= H * 0.8);
        if (yes && top != null && left != null) sigs.push([left, top]);
        return yes;
      });
    });
    cands.forEach(function (cs, i) {
      cs.forEach(function (c) {
        if (found[i].indexOf(c) >= 0) return;
        var top = styleNum(c, 'top'), left = styleNum(c, 'left');
        if (top != null && left != null && sigs.some(function (s) { return Math.abs(s[0] - left) < 2.5 && Math.abs(s[1] - top) < 2.5; })) found[i].push(c);
      });
    });
    return found;
  }
  function numberLabels(list, scheme) {
    var labels = [], main = 0, curMain = 0, sub = 0;
    list.forEach(function (s, i) {
      if (scheme === 'doc') { labels[i] = String(i + 1); return; }
      if (!s.stacked) { main++; curMain = main; sub = 0; labels[i] = String(main); }
      else if (scheme === 'sub') { sub++; labels[i] = curMain + '.' + sub; }
    });
    if (scheme === 'after') list.forEach(function (s, i) { if (s.stacked) labels[i] = String(++main); });
    return labels;
  }
  function setNumberText(box, label) {
    var walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT), n, done = false, changed = false;
    while ((n = walker.nextNode())) {
      if (!/\d/.test(n.nodeValue)) continue;
      var v = done ? n.nodeValue.replace(/\d+(?:\.\d+)?/g, '') : n.nodeValue.replace(/\d+(?:\.\d+)?/, label);
      if (v !== n.nodeValue) { n.nodeValue = v; changed = true; }
      done = true;
    }
    if (changed && !box.hasAttribute('data-slidenum')) box.setAttribute('data-slidenum', '');
    return changed;
  }
  function range(labels, idx) {
    var xs = idx.map(function (i) { return labels[i]; });
    return xs.length ? (xs.length > 1 ? xs[0] + '–' + xs[xs.length - 1] : xs[0]) : '';
  }
  function renumberDialog() {
    if (editingEl) endTextEdit();
    var list = slideList(), found = findNumberBoxes(list);
    var total = found.reduce(function (a, f) { return a + f.length; }, 0);
    if (!total) return toast('No slide-number boxes found — this works on decks whose slides carry their own number box (like decks converted from PowerPoint).', 7000);
    var stackedIdx = [], mainIdx = [], missing = [];
    list.forEach(function (s, i) { (s.stacked ? stackedIdx : mainIdx).push(i); if (!found[i].length) missing.push(i + 1); });
    var A = numberLabels(list, 'after'), Sb = numberLabels(list, 'sub');
    var opts = stackedIdx.length ? [
      ['after', 'Main slides first, stacked slides after', 'Main flow ' + range(A, mainIdx) + ' (no gaps while presenting); stacked slides ' + range(A, stackedIdx)],
      ['sub', 'Stacked slides numbered under their slide', 'Main flow ' + range(Sb, mainIdx) + '; stacked slides ' + Sb[stackedIdx[0]] + ', ' + Sb[stackedIdx[1] != null ? stackedIdx[1] : stackedIdx[0]] + ' …'],
      ['doc', 'In file order', '1–' + list.length + ', stacked slides counted where they sit']
    ] : [['doc', 'In order', '1–' + list.length]];
    var d = el('div', { 'class': 're-ui re-dialog-back' });
    var box = el('div', { 'class': 're-dialog' });
    box.appendChild(el('h3', { text: 'Renumber slides' }));
    box.appendChild(el('p', { 'class': 're-dim', text: 'Found ' + total + ' slide-number box' + (total === 1 ? '' : 'es') + ' on ' + (list.length - missing.length) + ' of ' + list.length + ' slides.' }));
    opts.forEach(function (o, k) {
      var lab = el('label', { 'class': 're-radio' });
      var r = el('input', { type: 'radio', name: 're-scheme', value: o[0] });
      if (k === 0) r.checked = true;
      lab.appendChild(r);
      lab.appendChild(el('span', {}, '<b>' + esc(o[1]) + '</b><br><span class="re-dim">' + esc(o[2]) + '</span>'));
      box.appendChild(lab);
    });
    var add = null;
    if (missing.length) {
      var lab2 = el('label', { 'class': 're-radio' });
      add = el('input', { type: 'checkbox' });
      lab2.appendChild(add);
      lab2.appendChild(el('span', {}, 'Also add a number box to the ' + missing.length + ' slide' + (missing.length === 1 ? '' : 's') + ' without one <span class="re-dim">(slide' + (missing.length === 1 ? ' ' : 's ') + esc(missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', …' : '')) + '; copied from the nearest similar slide)</span>'));
      box.appendChild(lab2);
    }
    var row = el('div', { 'class': 're-dialog-btns' });
    var close = function () { d.remove(); document.removeEventListener('keydown', onEsc, true); };
    var onEsc = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    row.appendChild(btn('Cancel', 'Close without changes', close));
    row.appendChild(btn('Renumber', 'Rewrite the slide numbers', function () {
      var scheme = (box.querySelector('input[name="re-scheme"]:checked') || {}).value || 'after';
      close();
      applyRenumber(scheme, !!(add && add.checked));
    }, 're-primary'));
    box.appendChild(row);
    d.appendChild(box);
    d.addEventListener('mousedown', function (e) { if (e.target === d) close(); });
    document.addEventListener('keydown', onEsc, true);
    document.body.appendChild(d);
  }
  // ------------------------------------------------------------------ navigation arrows (reveal.js controls)
  // A presentation-wide setting: written into the Reveal.initialize({...}) options in the file (controls,
  // controlsLayout) plus a small <style id="reveal-edit-controls"> for their colour. These live outside the
  // slides, so they are spliced into the file text directly, the rest of the file staying byte-for-byte.
  function skipJs(s, k) {             // k at a quote or comment start: index of its last character, or -1
    var c = s[k];
    if (c === '/' && s[k + 1] === '/') { var e = s.indexOf('\n', k); return e < 0 ? s.length - 1 : e; }
    if (c === '/' && s[k + 1] === '*') { var e2 = s.indexOf('*/', k + 2); return e2 < 0 ? -1 : e2 + 1; }
    for (var j = k + 1; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === c) return j; }
    return -1;
  }
  function isJsSkip(s, k) { var c = s[k]; return c === '"' || c === "'" || c === '`' || (c === '/' && (s[k + 1] === '/' || s[k + 1] === '*')); }
  // the options object passed to Reveal.initialize, outside [skipA, skipB): {open, close} or {empty: index of ')'}
  function findInitObject(s, skipA, skipB) {
    var re = /Reveal\s*\.\s*initialize\s*\(\s*/g, m;
    while ((m = re.exec(s))) {
      if (m.index >= skipA && m.index < skipB) continue;
      var i = m.index + m[0].length;
      if (s[i] === ')') return { empty: i };
      if (s[i] !== '{') continue;
      var depth = 0;
      for (var k = i; k < s.length; k++) {
        if (isJsSkip(s, k)) { k = skipJs(s, k); if (k < 0) break; continue; }
        var c = s[k];
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') { if (--depth === 0) return c === '}' ? { open: i, close: k } : null; }
      }
    }
    return null;
  }
  // top-level "key: value" entries of the object at [open, close]: [{key, start, valA, valB}]
  function initEntries(s, o) {
    var out = [], segA = o.open + 1, depth = 0;
    var finish = function (b) {
      var seg = s.slice(segA, b), m = /^(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)(['"]?)([A-Za-z_$][\w$]*)\2\s*:\s*/.exec(seg);
      if (m) {
        var vb = b; while (vb > segA && /\s/.test(s[vb - 1])) vb--;
        out.push({ key: m[3], start: segA + m[1].length, valA: segA + m[0].length, valB: vb });
      }
    };
    for (var k = o.open + 1; k < o.close; k++) {
      if (isJsSkip(s, k)) { k = skipJs(s, k); if (k < 0) return out; continue; }
      var c = s[k];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (c === ',' && depth === 0) { finish(k); segA = k + 1; }
    }
    finish(o.close);
    return out;
  }
  // set Reveal.initialize option `key` to the JS literal `lit` in s; returns the edited text, or null if not possible
  function setInitOption(s, key, lit, skipA, skipB, onlyIfPresent) {
    var o = findInitObject(s, skipA, skipB);
    if (!o) return null;
    if (o.empty != null) return onlyIfPresent ? s : s.slice(0, o.empty) + '{ ' + key + ': ' + lit + ' }' + s.slice(o.empty);
    var ents = initEntries(s, o), hit = ents.filter(function (e) { return e.key === key; })[0];
    if (hit) return s.slice(0, hit.valA) + lit + s.slice(hit.valB);
    if (onlyIfPresent) return s;
    var after = ents.filter(function (e) { return e.key === 'controls'; })[0];
    if (after) return s.slice(0, after.valB) + ', ' + key + ': ' + lit + s.slice(after.valB);
    if (!ents.length) return s.slice(0, o.open + 1) + ' ' + key + ': ' + lit + ' ' + s.slice(o.open + 1);
    var nl = /^\n([ \t]*)/.exec(s.slice(o.open + 1, ents[0].start));
    return s.slice(0, o.open + 1) + (nl ? '\n' + nl[1] : ' ') + key + ': ' + lit + ',' + s.slice(o.open + 1);
  }
  var CTRL_STYLE_ID = 'reveal-edit-controls';
  function ctrlCss(color) {
    var light = lumOfHex(color) > 0.5;
    return '.reveal .controls { color: ' + color + '; filter: drop-shadow(0 0 1.5px rgba(' + (light ? '0,0,0,.6' : '255,255,255,.6') + ')); }';
  }
  function lumOfHex(h) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || '');
    return m ? (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) / 255 : 0;
  }
  function rgbToHex(c) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(c || '');
    if (!m) return null;
    return '#' + [m[1], m[2], m[3]].map(function (v) { return ('0' + Math.round(+v).toString(16)).slice(-2); }).join('');
  }
  // is the bottom-right corner of the current slide dark? (decides the arrows' default colour)
  function cornerIsDark() {
    var fr = frameOf(curSection()), cs = getComputedStyle(fr);
    var lum = function (c) {
      var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(c || '');
      if (!m || (m[4] !== undefined && +m[4] < 0.1)) return null;
      return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
    };
    var byColor = function () {
      var cands = [fr, curSection(), document.querySelector('.reveal .backgrounds .slide-background.present')];
      for (var i = 0; i < cands.length; i++) {
        if (!cands[i]) continue;
        var l = lum(getComputedStyle(cands[i]).backgroundColor);
        if (l !== null) return l < 0.5;
      }
      return false;                     // reveal.js's own default: light page, dark arrows
    };
    var url = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(cs.backgroundImage || '');
    if (!url) return Promise.resolve(byColor());
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = 64; c.height = 36;
          var g = c.getContext('2d'); g.drawImage(im, 0, 0, 64, 36);
          var d = g.getImageData(46, 25, 18, 11).data, s = 0, n = 0;
          for (var i = 0; i < d.length; i += 4) { s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
          res(s / n / 255 < 0.5);
        } catch (err) { res(byColor()); }
      };
      im.onerror = function () { res(byColor()); };
      im.src = url[1];
    });
  }
  function liveArrows(on, layout, color) {
    Reveal.configure({ controls: on, controlsLayout: layout });
    var st = document.getElementById(CTRL_STYLE_ID);
    if (color) {
      if (!st) { st = document.createElement('style'); st.id = CTRL_STYLE_ID; document.head.appendChild(st); }
      st.textContent = ctrlCss(color); st.setAttribute('data-color', color);
    }
  }
  // edit the file text outside the slides: rawText (slide spans moved along) and the parsed source kept in step
  function spanIn(t) {                  // where the (untouched) slides block sits in text t: [start, end], or [-1, -1]
    if (!rawSlides) return [-1, -1];
    var a = rawSlides[0][0], b = rawSlides[rawSlides.length - 1][1], at = t.indexOf(rawText.slice(a, b));
    return at < 0 ? null : [at, at + (b - a)];
  }
  function replaceRaw(next) {
    var sp = spanIn(next);
    if (!sp) return false;
    if (rawSlides) { var d = sp[0] - rawSlides[0][0]; if (d) rawSlides = rawSlides.map(function (s) { return [s[0] + d, s[1] + d]; }); }
    rawText = next;
    return true;
  }
  function writeArrows(on, layout, color) {
    var t = rawText, sp = spanIn(t);
    t = setInitOption(t, 'controls', on ? 'true' : 'false', sp[0], sp[1], on);   // reveal's default is on
    if (t === null) return false;
    sp = spanIn(t) || sp;
    t = setInitOption(t, 'controlsLayout', "'" + layout + "'", sp[0], sp[1], layout === 'bottom-right') || t;
    if (color) {
      var css = ctrlCss(color), tag = '<style id="' + CTRL_STYLE_ID + '" data-color="' + color + '">' + css + '</style>';
      var re = new RegExp('<style id="' + CTRL_STYLE_ID + '"[^>]*>[\\s\\S]*?</style>');
      if (re.test(t)) t = t.replace(re, tag);
      else {
        var h = t.search(/<\/head\s*>/i);
        t = h >= 0 ? t.slice(0, h) + tag + '\n' + t.slice(h) : t.replace(/<\/body\s*>(?![\s\S]*<\/body)/i, tag + '\n$&');
      }
    }
    if (!replaceRaw(t)) return false;
    // the parsed source (used when the file can't be written back slide by slide)
    var sc = Array.prototype.filter.call(srcDoc.querySelectorAll('script'), function (x) { return /Reveal\s*\.\s*initialize\s*\(/.test(x.textContent); })[0];
    if (sc) {
      var js = setInitOption(sc.textContent, 'controls', on ? 'true' : 'false', -1, -1, on);
      if (js !== null) js = setInitOption(js, 'controlsLayout', "'" + layout + "'", -1, -1, layout === 'bottom-right') || js;
      if (js !== null) sc.textContent = js;
    }
    if (color) {
      var ss = srcDoc.getElementById(CTRL_STYLE_ID);
      if (!ss) { ss = srcDoc.createElement('style'); ss.id = CTRL_STYLE_ID; (srcDoc.head || srcDoc.body).appendChild(ss); }
      ss.setAttribute('data-color', color); ss.textContent = ctrlCss(color);
    }
    return true;
  }
  function arrowsDialog() {
    if (editingEl) endTextEdit();
    var cfg = Reveal.getConfig(), on0 = cfg.controls !== false, lay0 = cfg.controlsLayout === 'edges' ? 'edges' : 'bottom-right';
    var st0 = document.getElementById(CTRL_STYLE_ID), css0 = st0 ? st0.textContent : null;
    var col0 = st0 && st0.getAttribute('data-color');
    var picked = !!col0, colorTouched = false;
    var d = el('div', { 'class': 're-ui re-dialog-back re-dialog-light' });
    var box = el('div', { 'class': 're-dialog' });
    box.appendChild(el('h3', { text: 'Navigation arrows' }));
    box.appendChild(el('p', { 'class': 're-dim', text: 'The arrows reveal.js shows while presenting. Click them to move between slides; ↓ appears on a slide with slides stacked under it. This setting is for the whole presentation.' }));
    var showLab = el('label', { 'class': 're-radio' }), show = el('input', { type: 'checkbox' });
    show.checked = on0;
    showLab.appendChild(show); showLab.appendChild(el('span', {}, '<b>Show navigation arrows</b>'));
    box.appendChild(showLab);
    var opts = el('div', { 'class': 're-dialog-sub' });
    [['bottom-right', 'In the bottom-right corner'], ['edges', 'At the edges of the screen <span class="re-dim">(← → at the sides, ↑ ↓ at top and bottom)</span>']].forEach(function (o) {
      var lab = el('label', { 'class': 're-radio' }), r = el('input', { type: 'radio', name: 're-ctl-layout', value: o[0] });
      r.checked = o[0] === lay0;
      lab.appendChild(r); lab.appendChild(el('span', {}, o[1]));
      opts.appendChild(lab);
    });
    var colLab = el('label', { 'class': 're-radio' }), col = el('input', { type: 'color', 'class': 're-color' });
    col.value = col0 || rgbToHex(getComputedStyle(document.querySelector('.reveal .controls') || document.body).color) || '#000000';
    colLab.appendChild(col); colLab.appendChild(el('span', {}, 'Colour <span class="re-dim">(they get a faint outline so they show on any background)</span>'));
    opts.appendChild(colLab);
    box.appendChild(opts);
    var layout = function () { return (box.querySelector('input[name="re-ctl-layout"]:checked') || {}).value || 'bottom-right'; };
    var preview = function () {
      opts.style.opacity = show.checked ? '' : '.45';
      liveArrows(show.checked, layout(), picked || colorTouched ? col.value : null);
    };
    var suggest = function () {    // first time on, with no colour of our own yet: pick one that shows on this slide
      if (picked || colorTouched) return;
      cornerIsDark().then(function (dark) {
        if (picked || colorTouched) return;
        col.value = dark ? '#ffffff' : '#222222'; picked = true; preview();
      });
    };
    show.addEventListener('change', function () { if (show.checked) suggest(); preview(); });
    box.querySelectorAll('input[name="re-ctl-layout"]').forEach(function (r) { r.addEventListener('change', preview); });
    col.addEventListener('input', function () { colorTouched = true; preview(); });
    if (on0 && !picked) {           // already on with the theme's colour: keep it unless they pick another
      opts.style.opacity = '';
    } else if (on0) preview(); else opts.style.opacity = '.45';
    var row = el('div', { 'class': 're-dialog-btns' });
    var close = function () { d.remove(); document.removeEventListener('keydown', onEsc, true); };
    var cancel = function () {
      Reveal.configure({ controls: on0, controlsLayout: lay0 });
      var st = document.getElementById(CTRL_STYLE_ID);
      if (css0 === null) { if (st) st.remove(); } else if (st) { st.textContent = css0; st.setAttribute('data-color', col0 || ''); }
      close();
    };
    var onEsc = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    row.appendChild(btn('Cancel', 'Close without changes', cancel));
    row.appendChild(btn('Apply', 'Use these settings (saved with the presentation)', function () {
      var on = show.checked, lay = layout();
      var color = on && (colorTouched || (picked && col.value !== col0)) ? col.value : null;
      if (on === on0 && lay === lay0 && !color) { close(); return; }
      if (!writeArrows(on, lay, color)) {
        cancel();
        toast('Could not find Reveal.initialize({ … }) in ' + FILE + ' — add  controls: ' + on + '  to its options by hand.', 8000);
        return;
      }
      liveArrows(on, lay, color);
      close();
      markDirty();
      toast(on ? 'Navigation arrows on — save (⌘S) to keep it' : 'Navigation arrows off — save (⌘S) to keep it', 3500);
    }, 're-primary'));
    box.appendChild(row);
    d.appendChild(box);
    d.addEventListener('mousedown', function (e) { if (e.target === d) cancel(); });
    document.addEventListener('keydown', onEsc, true);
    document.body.appendChild(d);
  }
  // ------------------------------------------------------------------ PDF
  // reveal-edit prints the presentation's own print view (?print-pdf) with headless Chrome / Edge / Brave and
  // saves NAME.pdf next to NAME.html. Without such a browser, the print view opens for the browser's own
  // "Save as PDF".
  function pdfDialog() {
    if (editingEl) endTextEdit();
    var base = FILE.split('/').pop(), pdfName = base.replace(/\.html?$/i, '') + '.pdf';
    var d = el('div', { 'class': 're-ui re-dialog-back' });
    var box = el('div', { 'class': 're-dialog' });
    var busy = false;
    var close = function () { if (busy) return; d.remove(); document.removeEventListener('keydown', onEsc, true); };
    var onEsc = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    var check = function (label, on) {
      var lab = el('label', { 'class': 're-radio' }), c = el('input', { type: 'checkbox' });
      c.checked = !!on;
      lab.appendChild(c); lab.appendChild(el('span', {}, label));
      box.appendChild(lab);
      return c;
    };
    var buttons = function (list) {
      var row = el('div', { 'class': 're-dialog-btns' });
      list.forEach(function (b) { row.appendChild(btn(b[0], b[0], b[1], b[2])); });
      box.appendChild(row);
    };
    var printView = function (builds, notes) {
      return '/' + encodeURI(FILE) + '?print-pdf&autoprint' + (builds ? '&pdfSeparateFragments=true' : '') + (notes ? '&showNotes=separate-page' : '');
    };
    box.appendChild(el('h3', { text: 'Save as PDF' }));
    box.appendChild(el('p', { 'class': 're-dim' }, 'One page per slide, saved next to the presentation as <code>' + esc(pdfName) + '</code>' +
      (dirty ? ' — your unsaved changes are saved first.' : '.')));
    var builds = check('One page per build step <span class="re-dim">(otherwise each slide appears complete)</span>', false);
    var notes = check('Add a page with the speaker notes after each slide', false);
    buttons([['Cancel', close], ['Make PDF', function () { go(); }, 're-primary']]);
    function show(title, html, list) {
      box.innerHTML = '';
      box.appendChild(el('h3', { text: title }));
      box.appendChild(el('div', {}, html));
      if (list) buttons(list);
    }
    function go() {
      var b = builds.checked, n = notes.checked, t0 = Date.now();
      busy = true;
      show('Making the PDF…', '<div class="re-pdf-busy"><div class="re-spin"></div><span class="re-dim">Printing ' + Reveal.getTotalSlides() +
        ' slides in the background. This can take a minute for a long presentation with large pictures.</span></div>');
      (dirty ? save(false) : Promise.resolve()).then(function () {
        if (dirty) throw new Error('the presentation could not be saved first');
        return fetch('/__pdf', { method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ builds: b, notes: n }) });
      }).then(function (r) {
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
      }).then(function (j) {
        busy = false;
        if (!j.ok && j.reason === 'no-browser') {
          show('Save as PDF', '<p>reveal-edit makes the PDF with Google Chrome (or Microsoft Edge, Brave or Chromium), and none of them is installed.</p>' +
            '<p class="re-dim">Instead, open the print view: the print dialog comes up by itself — choose <b>Save as PDF</b>, ' +
            'with margins <b>None</b> and <b>Background graphics</b> on. This works best in Chrome.</p>',
            [['Close', close], ['Open print view', function () { window.open(printView(b, n), '_blank'); close(); }, 're-primary']]);
          return;
        }
        var secs = Math.round((Date.now() - t0) / 1000);
        show('PDF ready', '<p>Saved <code>' + esc(j.file) + '</code> next to the presentation' + (j.pages ? ' — ' + j.pages + ' page' + (j.pages === 1 ? '' : 's') : '') +
          '.</p><p class="re-dim">Printed by ' + esc(j.browser) + ' in ' + secs + ' s. Making it again replaces it.</p>',
          [['Close', close]].concat(j.canShow ? [['Show in Finder', function () {
            fetch('/__pdf/show', { method: 'POST', headers: { 'X-Edit-Token': TOKEN } });
          }]] : []).concat([['Open PDF', function () { window.open('/' + j.url + '?t=' + Date.now(), '_blank'); }, 're-primary']]));
      }).catch(function (e) {
        busy = false;
        show('No PDF', '<p>' + esc(e.message) + '</p><p class="re-dim">You can still use the browser’s own print: the print view opens with the print dialog — choose <b>Save as PDF</b>.</p>',
          [['Close', close], ['Open print view', function () { window.open(printView(b, n), '_blank'); close(); }, 're-primary']]);
      });
    }
    d.appendChild(box);
    d.addEventListener('mousedown', function (e) { if (e.target === d) close(); });
    document.addEventListener('keydown', onEsc, true);
    document.body.appendChild(d);
  }
  function applyRenumber(scheme, addMissing) {
    var idx = Reveal.getIndices(), before = srcRoot().innerHTML;
    var list = slideList(), found = findNumberBoxes(list), labels = numberLabels(list, scheme);
    var changed = 0, added = 0;
    if (addMissing) {
      var bg = function (s) { return frameOf(s.sec).getAttribute('style') || ''; };
      list.forEach(function (s, i) {
        if (found[i].length) return;
        var tpl = -1, j;
        for (j = i - 1; j >= 0 && tpl < 0; j--) if (found[j].length && bg(list[j]) === bg(s)) tpl = j;
        for (j = i + 1; j < list.length && tpl < 0; j++) if (found[j].length && bg(list[j]) === bg(s)) tpl = j;
        for (j = i - 1; j >= 0 && tpl < 0; j--) if (found[j].length) tpl = j;
        if (tpl < 0) return;
        var fr = frameOf(s.sec), notes = fr.querySelector(':scope > aside.notes');
        found[tpl].filter(function (c) { return !c.hasAttribute('data-layout'); }).forEach(function (c) {
          var copy = c.cloneNode(true);
          copy.classList.remove('fragment', 'appear', 'fade-out'); copy.removeAttribute('data-fragment-index');
          copy.setAttribute('data-slidenum', '');
          fr.insertBefore(copy, notes);
          found[i].push(copy); added++;
        });
      });
    }
    list.forEach(function (s, i) { found[i].forEach(function (b) { if (setNumberText(b, labels[i])) changed++; }); });
    if (!changed && !added) return toast('Slide numbers were already in order');
    undoStack.push({ html: before, idx: idx }); redoStack.length = 0;
    rebuildLive(idx);
    markDirty();
    toast('Renumbered: ' + changed + ' number' + (changed === 1 ? '' : 's') + ' changed' + (added ? ', ' + added + ' added' : '') + ' — ⌘Z to undo, ⌘S to save', 5000);
  }

  // ------------------------------------------------------------------ speaker notes
  function notesText(aside) {
    var ps = aside.querySelectorAll('p');
    if (!ps.length) return (aside.textContent || '').trim();
    return Array.prototype.map.call(ps, function (p) { return p.textContent; }).join('\n');
  }
  function loadNotes() {
    var src = srcOf(curSection());
    var a = src && src.querySelector(':scope > aside.notes');
    ui.notes.value = a ? notesText(a) : '';
    notesSnap = false;
  }
  function writeNotes() {
    clearTimeout(notesTimer);
    notesTimer = null;
    var live = curSection(), src = srcOf(live);
    if (!src) return;
    var text = ui.notes.value.replace(/\s+$/, '');
    var html = text ? text.split('\n').map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') : '';
    if (!notesSnap) { snapshot(); notesSnap = true; }
    [[live, document], [src, srcDoc]].forEach(function (pair) {
      var sec = pair[0], doc = pair[1];
      var a = sec.querySelector(':scope > aside.notes');
      if (!html) { if (a) a.remove(); return; }
      if (!a) { a = doc.createElement('aside'); a.className = 'notes'; sec.appendChild(a); }
      a.innerHTML = html;
    });
    markDirty();
  }

  // ------------------------------------------------------------------ save
  // Locate each top-level <section> of .slides in the file text, so slides you did not touch are written
  // back byte-for-byte (keeping your own formatting and comments) and only edited slides are re-serialised.
  function indexRawSlides() {
    rawSlides = origSections = null;
    var m = /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bslides\b[^"']*["'][^>]*>/i.exec(rawText);
    if (!m) return;
    var re = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>|<section\b[^>]*>|<\/section\s*>|<div\b[^>]*>|<\/div\s*>/gi;
    re.lastIndex = m.index + m[0].length;
    var depth = 0, divs = 0, start = -1, spans = [], end = -1, tok;
    while ((tok = re.exec(rawText))) {
      var t = tok[0].slice(0, 9).toLowerCase();
      if (t.indexOf('<!--') === 0 || t.indexOf('<script') === 0 || t.indexOf('<style') === 0) continue;
      if (t.indexOf('<section') === 0) { if (depth === 0) start = tok.index; depth++; }
      else if (t.indexOf('</section') === 0) { if (depth > 0 && --depth === 0) spans.push([start, re.lastIndex]); }
      else if (depth === 0) {
        if (t.indexOf('<div') === 0) divs++;
        else if (divs > 0) divs--;
        else { end = tok.index; break; }
      }
    }
    var secs = sections(srcRoot());
    if (end < 0 || !spans.length || spans.length !== secs.length) return;
    origSections = new Map();
    secs.forEach(function (sec, k) { if (!origSections.has(sec.outerHTML)) origSections.set(sec.outerHTML, k); });
    rawSlides = spans;
  }
  function tidyMarkup(out) {
    out = out.replace(/ (data-autofit|data-autoplay|data-preload|data-layout|data-tbox|data-slidenum|muted|loop|playsinline|controls|hidden|allowfullscreen)=""/g, ' $1');
    out = out.replace(/<(path|polygon|polyline|ellipse|circle|rect|line|stop|image|use)(\s[^<>]*)?><\/\1>/g, '<$1$2/>');
    out = out.replace(/\u200b/g, '&#8203;');
    if (!rawUsesNbspEntity) out = out.replace(/&nbsp;/g, '\u00a0');
    return out;
  }
  // serialise the source document, writing markup the way the file had it so a save without edits is a no-op
  function serialize() {
    if (rawSlides) {
      var parts = sections(srcRoot()).map(function (sec) {
        var h = sec.outerHTML, k = origSections.has(h) ? origSections.get(h) : -1;
        return { k: k, text: k >= 0 ? rawText.slice(rawSlides[k][0], rawSlides[k][1]) : tidyMarkup(h) };
      });
      var body = '';
      parts.forEach(function (p, i) {
        if (i > 0) {
          var a = parts[i - 1];
          body += (a.k >= 0 && p.k === a.k + 1) ? rawText.slice(rawSlides[a.k][1], rawSlides[p.k][0]) : '\n';
        }
        body += p.text;
      });
      return rawText.slice(0, rawSlides[0][0]) + body + rawText.slice(rawSlides[rawSlides.length - 1][1]);
    }
    var out = srcDoc.documentElement.outerHTML;
    out = out.replace(/ (data-autofit|data-autoplay|data-preload|data-layout|data-tbox|data-slidenum|muted|loop|playsinline|controls|hidden|allowfullscreen)=""/g, ' $1');
    out = out.replace(/<(path|polygon|polyline|ellipse|circle|rect|line|stop|image|use)(\s[^<>]*)?><\/\1>/g, '<$1$2/>');
    out = out.replace(/\u200b/g, '&#8203;');
    if (!rawUsesNbspEntity) out = out.replace(/&nbsp;/g, '\u00a0');
    out = out.replace(/^(<html[^>]*>)<head>/i, '$1\n<head>');
    return rawPrefix + out + rawSuffix;
  }
  function save(force) {
    if (editingEl) endTextEdit();
    if (notesTimer) writeNotes();
    ui.save.textContent = 'Saving…';
    var sent = serialize();
    return fetch('/__save?file=' + encodeURIComponent(FILE), {
      method: 'POST',
      headers: { 'X-Edit-Token': TOKEN, 'X-Base-Hash': baseHash, 'X-Force': force ? '1' : '0', 'Content-Type': 'text/html; charset=utf-8' },
      body: sent
    }).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 409) {
          ui.save.textContent = 'Save •';
          if (confirm(FILE + ' was changed on disk after you opened the editor (another editor or the rebuild script?).\n\nOverwrite it with your version? The version on disk is kept in _backups either way.')) return save(true);
          return;
        }
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        baseHash = j.hash;
        rawText = sent;
        indexRawSlides();
        markClean();
        toast('Saved ' + FILE + (j.backup ? ' — previous version kept in ' + j.backup : ''), 3500);
      });
    }).catch(function (e) {
      ui.save.textContent = 'Save •';
      if (confirm('Could not save: the editor is not running any more (' + e.message + ').\n\nDownload your edited file instead? ' +
                  'Then put it in the presentation folder in place of ' + FILE + ', or open the deck with reveal-edit again.')) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([sent], { type: 'text/html' }));
        a.download = FILE.split('/').pop();
        document.body.appendChild(a); a.click(); a.remove();
      }
    });
  }

  // ------------------------------------------------------------------ UI
  function btn(label, title, fn, cls) {
    var b = el('button', { type: 'button', title: title, 'class': 're-btn' + (cls ? ' ' + cls : '') });
    b.innerHTML = label;
    b.addEventListener('click', function (e) { e.preventDefault(); fn(e); });
    b.addEventListener('mousedown', function (e) { if (editingEl) e.preventDefault(); });   // keep the text selection while formatting
    return b;
  }
  function group(cls) { return el('div', { 'class': 're-group ' + (cls || '') }); }
  function field(name) {
    var lab = el('label', { 'class': 're-field' });
    lab.appendChild(document.createTextNode(name));
    var inp = el('input', { type: 'number', step: '1' });
    inp.addEventListener('change', function () { setField(name, parseFloat(inp.value)); });
    lab.appendChild(inp);
    ui['f' + name] = inp;
    return lab;
  }
  function setField(name, v) {
    if (isMulti()) {                      // several selected: X / Y move them together
      var list = multi.filter(isPositioned), gb = groupBox(list);
      if (!gb || !isFinite(v) || (name !== 'X' && name !== 'Y')) return;
      snapshot();
      list.forEach(function (e) {
        var b = normalize(e);
        if (name === 'X') e.style.left = px(b.x + v - gb.x); else e.style.top = px(b.y + v - gb.y);
        touched.add(e);
      });
      flushTouched(); markDirty(); placeOverlay(); updateFields();
      return;
    }
    if (!sel || !isFinite(v) || !isPositioned(sel)) return;
    snapshot();
    var b = normalize(sel);
    b = boxOf(sel);
    if (name === 'X') sel.style.left = px(v);
    if (name === 'Y') sel.style.top = px(v);
    touched.add(sel);
    if (name === 'W') applySize(sel, Math.max(2, v), b.h);
    if (name === 'H') applySize(sel, b.w, Math.max(2, v));
    flushTouched(); markDirty(); placeOverlay(); updateFields();
  }
  function updateFields() {
    if (isMulti()) {
      var gb = groupBox(multi);
      ['X', 'Y'].forEach(function (n) { ui['f' + n].disabled = !gb; });
      ui.fW.disabled = ui.fH.disabled = true;
      ui.fX.value = gb ? Math.round(gb.x) : ''; ui.fY.value = gb ? Math.round(gb.y) : '';
      ui.fW.value = gb ? Math.round(gb.w) : ''; ui.fH.value = gb ? Math.round(gb.h) : '';
      document.documentElement.classList.add('re-has-sel');
      ui.build.classList.toggle('re-active', multi.every(function (e) { return e.classList.contains('fragment'); }));
      updateStyleControls();
      return;
    }
    var on = !!sel && isPositioned(sel);
    ['X', 'Y', 'W', 'H'].forEach(function (n) { ui['f' + n].disabled = !on; });
    if (on) {
      var b = boxOf(sel);
      ui.fX.value = Math.round(b.x); ui.fY.value = Math.round(b.y); ui.fW.value = Math.round(b.w); ui.fH.value = Math.round(b.h);
    } else { ui.fX.value = ui.fY.value = ui.fW.value = ui.fH.value = ''; }
    document.documentElement.classList.toggle('re-has-sel', !!sel);
    ui.build.classList.toggle('re-active', !!sel && sel.classList.contains('fragment'));
    updateStyleControls();
  }
  function menu(label, title, entries) {
    var wrap = el('div', { 'class': 're-menu' });
    var b = btn(label + ' ▾', title, function () { wrap.classList.toggle('re-open'); });
    wrap.appendChild(b);
    var list = el('div', { 'class': 're-menu-list' });
    entries.forEach(function (e) {
      if (e === '-') { list.appendChild(el('hr')); return; }
      var it = btn(e[0] + (e[2] ? '<span class="re-kbd">' + e[2] + '</span>' : ''), e[0], function () { wrap.classList.remove('re-open'); e[1](); });
      list.appendChild(it);
    });
    wrap.appendChild(list);
    document.addEventListener('mousedown', function (ev) { if (!wrap.contains(ev.target)) wrap.classList.remove('re-open'); }, true);
    return wrap;
  }

  function shapeIcon(t) {
    var body;
    if (t === 'line' || t === 'arrow' || t === 'darrow') {
      body = '<path d="M4,15 L22,3" stroke="currentColor" stroke-width="1.6" fill="none"/>';
      if (t !== 'line') body += '<polygon points="23,2.3 15.9,4.6 19.6,9.4" fill="currentColor"/>';
      if (t === 'darrow') body += '<polygon points="3,15.7 10.1,13.4 6.4,8.6" fill="currentColor"/>';
    } else {
      var vert = isVertical(t), w = vert ? 12 : 20, h = t === 'callout' ? 10 : vert ? 15 : 13, d = shapePath(t, w, h);
      var tx = vert ? 7 : 3, ty = t === 'callout' ? 2 : vert ? 1.5 : 2.5;
      body = '<path d="' + d + '" transform="translate(' + tx + ',' + ty + ')" fill="currentColor" fill-opacity=".22" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>';
    }
    return '<svg viewBox="0 0 26 18" aria-hidden="true">' + body + '</svg>';
  }
  function shapeMenu() {
    var wrap = el('div', { 'class': 're-menu re-menu-left' });
    ui.shapeBtn = btn('+ Shape ▾', 'Draw a line, arrow or shape', function () { wrap.classList.toggle('re-open'); });
    wrap.appendChild(ui.shapeBtn);
    var grid = el('div', { 'class': 're-menu-list re-grid' });
    SHAPES.forEach(function (sh) {
      grid.appendChild(btn(shapeIcon(sh[0]), sh[1], function () { wrap.classList.remove('re-open'); armTool(sh[0]); }));
    });
    wrap.appendChild(grid);
    document.addEventListener('mousedown', function (ev) { if (!wrap.contains(ev.target)) wrap.classList.remove('re-open'); }, true);
    return wrap;
  }
  function selectCtl(title, opts, prop, cls) {
    var s_ = el('select', { title: title, 'class': 're-select ' + (cls || '') });
    opts.forEach(function (o) { s_.appendChild(el('option', { value: o[0], text: o[1] })); });
    s_.addEventListener('change', function () { applyStyle(prop, prop === 'sw' ? parseFloat(s_.value) : s_.value); s_.blur(); });
    return s_;
  }
  function colorCtl(title, prop) {
    var c = el('input', { type: 'color', title: title, 'class': 're-color' });
    c.addEventListener('input', function () { applyStyle(prop, c.value, true); });
    c.addEventListener('change', function () { styleSnap = false; });
    return c;
  }

  function buildUI() {
    var bar = el('div', { 'class': 're-ui re-bar' });
    var row1 = el('div', { 'class': 're-row' }), row2 = el('div', { 'class': 're-row' });
    bar.appendChild(row1); bar.appendChild(row2);

    var g1 = group();
    g1.appendChild(el('span', { 'class': 're-title', text: 'Edit' }));
    ui.where = el('span', { 'class': 're-where' });
    g1.appendChild(ui.where);
    row1.appendChild(g1);

    var g2 = group();
    g2.appendChild(btn('+ Text', 'Add a text box', addText));
    g2.appendChild(shapeMenu());
    g2.appendChild(btn('+ Image', 'Add an image or video (or drop / paste one onto the slide)', function () { pickFile(function (f) { addMedia(f); }); }));
    row1.appendChild(g2);

    var g3 = group('re-need-sel');
    g3.appendChild(btn('Duplicate', 'Duplicate element (⌘D)', duplicateSel));
    g3.appendChild(btn('Delete', 'Delete element (⌫)', deleteSel));
    g3.appendChild(btn('Forward', 'Bring forward (]) — Shift: to front', function (e) { zorder(1, e.shiftKey); }));
    g3.appendChild(btn('Back', 'Send backward ([) — Shift: to back', function (e) { zorder(-1, e.shiftKey); }));
    ui.build = btn('Build', 'Make the element appear on a click when presenting (toggle)', toggleBuild);
    g3.appendChild(ui.build);
    row1.appendChild(g3);

    var g6 = group('re-right');
    g6.appendChild(menu('Slide', 'Slide operations', [
      ['New slide after this one', newSlide],
      ['Duplicate slide', duplicateSlide],
      ['Delete slide', deleteSlide],
      '-',
      ['Move slide left', function () { moveUnit(-1); }, '⌘←'],
      ['Move slide right', function () { moveUnit(1); }, '⌘→'],
      ['Move up in stack', function () { moveInStack(-1); }, '⌘↑'],
      ['Move down in stack', function () { moveInStack(1); }, '⌘↓'],
      '-',
      ['Nest under previous slide', nestUnderPrevious],
      ['Move out of stack', unnest],
      '-',
      ['Renumber slides…', renumberDialog],
      ['Navigation arrows…', arrowsDialog]
    ]));
    g6.appendChild(btn('Renumber', 'Renumber the slide-number boxes so they run in order', renumberDialog));
    g6.appendChild(btn('↶', 'Undo (⌘Z)', doUndo));
    g6.appendChild(btn('↷', 'Redo (⇧⌘Z)', doRedo));
    ui.notesBtn = btn('Notes', 'Speaker notes for this slide', toggleNotes);
    g6.appendChild(ui.notesBtn);
    g6.appendChild(btn('Preview', 'Open the deck (without the editor) at this slide in a new tab', function () {
      var i = Reveal.getIndices();
      window.open('/' + encodeURI(FILE) + '#/' + i.h + (i.v ? '/' + i.v : ''), '_blank');
    }));
    g6.appendChild(btn('PDF', 'Save the presentation as a PDF, one page per slide', pdfDialog));
    g6.appendChild(btn('?', 'Keyboard shortcuts', toggleHelp));
    ui.save = btn('Saved', 'Save (⌘S)', function () { save(false); }, 're-save');
    g6.appendChild(ui.save);
    row1.appendChild(g6);

    var g4 = group('re-fields');
    ['X', 'Y', 'W', 'H'].forEach(function (n) { g4.appendChild(field(n)); });
    row2.appendChild(g4);

    var g5 = group('re-text');
    g5.appendChild(el('span', { 'class': 're-lab', text: 'Text' }));
    g5.appendChild(btn('A−', 'Smaller text', function () { scaleFont(1 / 1.1); }));
    g5.appendChild(btn('A+', 'Larger text', function () { scaleFont(1.1); }));
    g5.appendChild(btn('<b>B</b>', 'Bold (⌘B) — select words while editing', function () { fmt('bold'); }));
    g5.appendChild(btn('<i>I</i>', 'Italic (⌘I)', function () { fmt('italic'); }));
    var color = el('input', { type: 'color', title: 'Text colour (select words while editing)', 'class': 're-color', value: '#ff5f1f' });
    color.addEventListener('mousedown', function () { saveRange(); });
    color.addEventListener('input', function () { restoreRange(); fmt('foreColor', color.value); });
    g5.appendChild(color);
    g5.appendChild(btn('⟸', 'Align left', function () { align('left'); }));
    g5.appendChild(btn('⟺', 'Centre', function () { align('center'); }));
    g5.appendChild(btn('⟹', 'Align right', function () { align('right'); }));
    row2.appendChild(g5);

    var g7 = group('re-style');
    g7.appendChild(el('span', { 'class': 're-lab', text: 'Fill' }));
    ui.fill = colorCtl('Fill colour', 'fill');
    g7.appendChild(ui.fill);
    ui.noFill = btn('∅', 'No fill', function () { applyStyle('fill', 'none'); }, 're-none');
    g7.appendChild(ui.noFill);
    g7.appendChild(el('span', { 'class': 're-lab', text: 'Line' }));
    ui.stroke = colorCtl('Line colour', 'stroke');
    g7.appendChild(ui.stroke);
    ui.noLine = btn('∅', 'No line', function () { applyStyle('stroke', 'none'); }, 're-none');
    g7.appendChild(ui.noLine);
    ui.sw = selectCtl('Line width', [1, 1.5, 2, 3, 4, 6, 8, 12].map(function (v) { return [String(v), v + ' px']; }), 'sw');
    g7.appendChild(ui.sw);
    ui.dash = selectCtl('Line style', [['solid', '———'], ['dash', '– – –'], ['dot', '· · · ·'], ['dashdot', '– · – ·']], 'dash');
    g7.appendChild(ui.dash);
    ui.arrow = selectCtl('Arrowheads (lines)', [['none', 'no arrows'], ['end', '——▶'], ['start', '◀——'], ['both', '◀—▶']], 'arrow');
    g7.appendChild(ui.arrow);
    row2.appendChild(g7);

    document.body.appendChild(bar);
    ui.bar = bar;

    ui.ep = [1, 2].map(function (k) {
      var h = el('div', { 'class': 're-ui re-ep', 'data-end': String(k), title: 'Drag to move this end (Shift: 45° steps)' });
      document.body.appendChild(h);
      return h;
    });
    ui.snapdot = el('div', { 'class': 're-ui re-snapdot' });
    document.body.appendChild(ui.snapdot);

    ui.mOut = [];
    ui.marquee = el('div', { 'class': 're-ui re-marquee' });
    document.body.appendChild(ui.marquee);
    ui.sel = el('div', { 'class': 're-ui re-sel' });
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (d) { ui.sel.appendChild(el('div', { 'class': 're-h re-h-' + d, 'data-dir': d })); });
    ui.selLabel = el('div', { 'class': 're-sel-label' });
    ui.sel.appendChild(ui.selLabel);
    document.body.appendChild(ui.sel);
    ui.hover = el('div', { 'class': 're-ui re-hover' });
    document.body.appendChild(ui.hover);
    ui.gv = el('div', { 'class': 're-ui re-guide re-gv' });
    ui.gh = el('div', { 'class': 're-ui re-guide re-gh' });
    document.body.appendChild(ui.gv); document.body.appendChild(ui.gh);

    ui.notesPanel = el('div', { 'class': 're-ui re-notes' });
    ui.notesPanel.appendChild(el('div', { 'class': 're-notes-title', text: 'Speaker notes' }));
    ui.notes = el('textarea', { placeholder: 'Notes for this slide (shown in the speaker view, key S)' });
    ui.notes.addEventListener('input', function () { clearTimeout(notesTimer); notesTimer = setTimeout(writeNotes, 400); });
    ui.notes.addEventListener('blur', function () { if (notesTimer) writeNotes(); notesSnap = false; });
    ui.notesPanel.appendChild(ui.notes);
    document.body.appendChild(ui.notesPanel);

    ui.toast = el('div', { 'class': 're-ui re-toast' });
    document.body.appendChild(ui.toast);

    ui.help = el('div', { 'class': 're-ui re-help' }, [
      '<h3>Editing shortcuts</h3><table>',
      '<tr><td>Click</td><td>select an element (Option-click: an element inside a group)</td></tr>',
      '<tr><td>Shift-click · drag</td><td>select several: Shift-click adds or removes one; drag across an empty part of the slide to select what is inside · ⌘A selects everything on the slide. Then move, nudge, copy, delete, duplicate, restyle or build them together</td></tr>',
      '<tr><td>Drag / handles</td><td>move / resize — Shift: straight line or free aspect · ⌘ while dragging: no snapping</td></tr>',
      '<tr><td>Double-click</td><td>edit text (Esc to finish) · on a picture: replace it</td></tr>',
      '<tr><td>+ Shape</td><td>pick a line, arrow or shape, then drag on the slide (click: default size) · Shift: square / 45° · Esc cancels</td></tr>',
      '<tr><td>Line ends</td><td>drag the round handles; they snap to corners, edge midpoints and centres of other shapes (⌘: no snapping)</td></tr>',
      '<tr><td>Fill · Line</td><td>colour, ∅ none, width, style, arrowheads — with nothing selected they set the look of new shapes</td></tr>',
      '<tr><td>Enter</td><td>type into the selected shape or text box</td></tr>',
      '<tr><td>Arrows</td><td>nudge 1 px (Shift: 10 px) · with nothing selected they change slides</td></tr>',
      '<tr><td>Tab</td><td>select next element on the slide</td></tr>',
      '<tr><td>⌘D · ⌫</td><td>duplicate · delete</td></tr>',
      '<tr><td>] [</td><td>bring forward · send backward (Shift: front / back)</td></tr>',
      '<tr><td>⌘C ⌘X ⌘V</td><td>copy / cut an element and paste it on any slide — also into another presentation (its pictures come along) · paste text to make a text box · paste or drop an image file to add it</td></tr>',
      '<tr><td>⌘← · ⌘→</td><td>move the slide left / right (a stack moves as a whole)</td></tr>',
      '<tr><td>⌘↑ · ⌘↓</td><td>move the slide up / down within its stack</td></tr>',
      '<tr><td>Slide menu</td><td>new, duplicate, delete, move and nest slides · Renumber slides… · Navigation arrows… (the arrows shown while presenting)</td></tr>',
      '<tr><td>⌘Z · ⇧⌘Z</td><td>undo · redo</td></tr>',
      '<tr><td>⌘S</td><td>save (the previous version goes to _backups/)</td></tr>',
      '<tr><td>PDF</td><td>save the presentation as NAME.pdf next to it, one page per slide (optionally one per build step, with notes pages)</td></tr>',
      '<tr><td>O · Esc</td><td>slide overview (with nothing selected)</td></tr>',
      '</table><p>Builds (click-to-appear) are shown all at once while editing.</p><p class="re-help-close">click anywhere to close</p>'
    ].join(''));
    ui.help.addEventListener('mousedown', function (e) { e.stopPropagation(); toggleHelp(); });
    document.body.appendChild(ui.help);
  }
  var savedRange = null;
  function saveRange() { var s = getSelection(); savedRange = s.rangeCount ? s.getRangeAt(0).cloneRange() : null; }
  function restoreRange() { if (savedRange && editingEl) { var s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); } }
  function toggleHelp() { ui.help.classList.toggle('re-open'); }
  function toggleNotes() {
    document.documentElement.classList.toggle('re-notes-on');
    ui.notesBtn.classList.toggle('re-active');
    layoutChrome();
  }
  function layoutChrome() {
    var top = ui.bar.offsetHeight;
    var right = document.documentElement.classList.contains('re-notes-on') ? ui.notesPanel.offsetWidth : 0;
    document.documentElement.style.setProperty('--re-top', top + 'px');
    document.documentElement.style.setProperty('--re-right', right + 'px');
    Reveal.layout();
    setTimeout(placeOverlay, 0);
  }
  var toastTimer = null;
  function toast(msg, ms) {
    ui.toast.textContent = msg;
    ui.toast.classList.add('re-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { ui.toast.classList.remove('re-open'); }, ms || 2200);
  }
  function onSlide() {
    if (editingEl) endTextEdit();
    deselect();
    var cur = curSection(), i = Reveal.getIndices();
    var n = Reveal.getSlides().indexOf(cur) + 1;
    var tag = cur && cur.getAttribute('data-pptx-slide');
    ui.where.textContent = 'slide ' + n + '/' + Reveal.getTotalSlides() + (i.v ? '  (stack ' + (i.v + 1) + ')' : '') + (tag ? '  · PowerPoint #' + tag : '');
    loadNotes();
  }

  // ------------------------------------------------------------------ events
  function inField(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && t.closest('.re-ui'); }
  function onKey(e) {
    var mod = e.metaKey || e.ctrlKey, k = e.key;
    var stop = function () { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    if (mod && k.toLowerCase() === 's') { stop(); save(false); return; }
    if (inField(e.target)) {
      if ((k === 'Enter' && e.target.tagName === 'INPUT') || k === 'Escape') { e.target.blur(); if (k === 'Escape') e.preventDefault(); }
      e.stopPropagation();
      return;
    }
    if (editingEl) {
      if (k === 'Escape') { stop(); endTextEdit(); }
      else e.stopPropagation();
      return;
    }
    if (ui.help.classList.contains('re-open') && k === 'Escape') { stop(); toggleHelp(); return; }
    if (mod && k.toLowerCase() === 'z') { stop(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && k.toLowerCase() === 'y') { stop(); doRedo(); return; }
    if (k === '?' && !mod) { stop(); toggleHelp(); return; }
    // ⌘← / ⌘→ (Ctrl on Windows/Linux): move the slide (with its stack) left / right — even with an element selected
    if (mod && !e.altKey && !e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { stop(); moveUnit(k === 'ArrowLeft' ? -1 : 1); return; }
    // ⌘↑ / ⌘↓: move the slide up / down within its stack
    if (mod && !e.altKey && !e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) { stop(); moveInStack(k === 'ArrowUp' ? -1 : 1); return; }
    if (mod && !e.altKey && k.toLowerCase() === 'a') { stop(); selectAll(); return; }
    if (k === 'Tab') { stop(); cycle(e.shiftKey ? -1 : 1); return; }
    if (tool && k === 'Escape') { stop(); disarmTool(); toast('Drawing cancelled'); return; }
    if (mod && k.toLowerCase() === 'v' && !e.shiftKey && !e.altKey) { primeClipboard(); return; }   // Safari: paste needs a focused field
    if (!sel) return;    // reveal keeps its keys (arrows, space, O, S, F...)
    var step = e.shiftKey ? 10 : 1;
    switch (k) {
      case 'Escape': stop(); deselect(); return;
      case 'Delete': case 'Backspace': stop(); deleteSel(); return;
      case 'ArrowLeft': stop(); nudgeKey(-step, 0); return;
      case 'ArrowRight': stop(); nudgeKey(step, 0); return;
      case 'ArrowUp': stop(); nudgeKey(0, -step); return;
      case 'ArrowDown': stop(); nudgeKey(0, step); return;
      case 'Enter': stop(); if (isMulti()) { toast('Select one element to type into it'); return; } if (isShp(sel) && !sel.querySelector('.tb')) editShapeText(sel); else startTextEdit(sel, null); return;
      case ']': stop(); zorder(1, e.shiftKey); return;
      case '[': stop(); zorder(-1, e.shiftKey); return;
      case '}': stop(); zorder(1, true); return;
      case '{': stop(); zorder(-1, true); return;
    }
    if (mod && k.toLowerCase() === 'd') { stop(); duplicateSel(); return; }
    if (mod && (k.toLowerCase() === 'c' || k.toLowerCase() === 'x') && !(getSelection() && String(getSelection()))) { primeClipboard(); return; }
  }
  function onPaste(e) {
    if (inField(e.target) && !isSink(e.target)) return;
    if (editingEl) {          // paste plain text only, so foreign formatting doesn't leak in
      e.preventDefault();
      var txt = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, txt);
      return;
    }
    var cd = e.clipboardData;
    var files = cd && cd.files;
    if (files && files.length) { e.preventDefault(); Array.prototype.forEach.call(files, function (f) { addMedia(f); }); return; }
    var p = cd ? readPayload(cd) : null;
    if (p) { e.preventDefault(); pastePayload(p); return; }
    var txt = cd ? cd.getData('text/plain') : '';
    if (!txt) return;
    e.preventDefault();
    // the browser may not hand over our data between presentations (separate sites): if the clipboard text is
    // what we put there, the element is in this tab's copy or in the slot shared by every reveal-edit
    var norm = function (t) { return String(t || '').replace(/\s+/g, ' ').trim(); }, want = norm(txt);
    var match = function (c) { return c && c.app === 'reveal-edit' && c.html && norm(c.plain) === want ? c : null; };
    var fallback = function () { if (txt.trim()) pasteText(txt.replace(/\r\n?/g, '\n')); };
    fetch('/__clip/get', { method: 'POST', headers: { 'X-Edit-Token': TOKEN } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var c = match(j.item) || match(clip);
        if (c) pastePayload(c); else fallback();
      }, function () { var c = match(clip); if (c) pastePayload(c); else fallback(); });
  }
  function slidePoint(ev) {
    var fr = frameOf(curSection()), r = fr.getBoundingClientRect(), s = scale();
    return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s };
  }
  function bindEvents() {
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('dblclick', onDblClick, true);
    document.addEventListener('click', onClickCapture, true);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('paste', onPaste, true);
    document.addEventListener('copy', function (e) { putOnClipboard(e, false); }, true);
    document.addEventListener('cut', function (e) { putOnClipboard(e, true); }, true);
    window.addEventListener('dragover', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      var at = slidePoint(e);
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { addMedia(f, at); });
    });
    window.addEventListener('resize', function () { setTimeout(layoutChrome, 0); });
    Reveal.on('slidechanged', onSlide);
    Reveal.on('resize', function () { setTimeout(placeOverlay, 0); });
    Reveal.on('overviewshown', deselect);
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    if (window.ResizeObserver) new ResizeObserver(function () { layoutChrome(); }).observe(ui.bar);
  }

  boot();
})();
