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
  var placingNow = false;
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
    document.documentElement.classList.add('re-on', 'dk-on');
    META = readMeta();
    if (META) { var td = themeDefaults(); DEF = { line: { stroke: td.line, sw: 3, dash: 'solid' }, shape: { fill: td.fill, stroke: td.line, sw: 2, dash: 'solid' } }; }
    buildUI();
    checkStructure();
    bindEvents();
    layoutChrome();
    buildFilm();
    onSlide();
    setTimeout(layoutChrome, 50);
    renderAllMath();
    toast(META ? 'Click to select · double-click text to edit · + Slide for a new slide · ? for shortcuts' : 'Editing a presentation made elsewhere — Deck menu › Add deck theme & master for layouts and themes', 5000);
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
    if (e.hasAttribute('data-master') && !masterMode) return null;
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
    updateConnectors(Array.from(touched));
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
    var s0 = null;
    if (T.shape === 'line' && !(ev.metaKey || ev.ctrlKey)) { s0 = snapPoint(p, anchors); if (s0) p = { x: s0.x, y: s0.y }; }
    disarmTool();
    var node = insertItem(shapeHTML(T.shape, T.arrow, p.x, p.y, 0, 0));
    if (!node) return;
    renderShape(node);
    if (s0 && s0.el) setLink(node, 1, s0.el, s0.anchor);
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
      Object.keys(ANCHORS).forEach(function (name) {
        var q = anchorPos(o, name);
        pts.push({ x: q.x, y: q.y, el: o, anchor: name });
      });
    });
    return pts;
  }
  function snapPoint(p, pts) {
    var best = null, lim = 9 / Math.max(scale(), 0.25);
    pts.forEach(function (q) { var d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= lim && (!best || d < best.d)) best = { x: q.x, y: q.y, d: d, el: q.el || null, anchor: q.anchor || null }; });
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
      setLink(g.el, g.end, sn && sn.el ? sn.el : null, sn && sn.anchor);
      if (g.end === 1) setLineAbs(g.el, q.x, q.y, fixed.x, fixed.y); else setLineAbs(g.el, fixed.x, fixed.y, q.x, q.y);
    } else if (g.shape === 'line') {
      var q2 = constrain(g.p0, p, ev.shiftKey), sn2 = free ? null : snapPoint(q2, g.anchors);
      if (sn2) q2 = sn2;
      showSnapDot(sn2);
      setLink(g.el, 2, sn2 && sn2.el ? sn2.el : null, sn2 && sn2.anchor);
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
    var font = isDeck() ? 'font-family:var(--dk-font);' : isConverted() ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;" : '';
    tx = el('div', { 'class': 'tx', style: 'position:absolute;box-sizing:border-box;display:flex;flex-direction:column;left:0;top:0;width:' + px(b.w) + ';height:' + px(b.h) + ';justify-content:center;overflow:visible;' });
    tx.innerHTML = '<div class="tb"><div class="p" style="margin:0;white-space:pre-wrap;overflow-wrap:break-word;text-align:center;line-height:1.2;font-size:24px;color:' + (isDeck() ? themeDefaults().text : '#ffffff') + ';' + font + '"><br></div></div>';
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
    if (sel && isTable(sel) && (prop === 'fill' || prop === 'stroke')) { if (prop === 'fill') tableFill(value); else tableBorders(value); return; }
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
    refreshThumbSoon();
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
    buildFilm();
    onSlide();
    renderAllMath();
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
    ui.sel.style.transform = '';
    if (isMulti()) { ui.rot.style.display = 'none'; placeMulti(); return; }
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
    var r = rectOf(sel), rot = isPositioned(sel) ? rotOf(sel) : 0;
    if (rot) { var bb = boxOf(sel), q0 = frameToScreen(bb.x, bb.y), sc = scale(); r = { left: q0.x, top: q0.y, width: bb.w * sc, height: bb.h * sc }; }
    var s = ui.sel.style;
    s.display = 'block'; s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    s.transform = rot ? 'rotate(' + rot + 'deg)' : '';
    ui.rot.style.display = isPositioned(sel) && !line ? 'block' : 'none';
    ui.sel.classList.toggle('re-cropping', cropMode === sel);
    placeCropGhost();
    var movable = isPositioned(sel);
    ui.sel.classList.toggle('re-static', !movable);
    var b = boxOf(sel);
    var build = sel.classList.contains('fragment') ? ' · build ' + (sel.getAttribute('data-fragment-index') || '') : '';
    if (line) {
      var LL = lineAbs(sel), len = Math.hypot(LL[2] - LL[0], LL[3] - LL[1]), ang = Math.round(-Math.atan2(LL[3] - LL[1], LL[2] - LL[0]) * 180 / Math.PI);
      ui.selLabel.textContent = 'length ' + Math.round(len) + ' · ' + ang + '°' + build;
      return;
    }
    ui.selLabel.textContent = movable ? Math.round(b.x) + ', ' + Math.round(b.y) + '  ' + Math.round(b.w) + '×' + Math.round(b.h) + (rot ? ' · ' + rot + '°' : '') + build : 'not positioned' + build;
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
      if (t.classList.contains('re-rot') && sel) startRotate(ev);
      return;
    }
    if (cropMode) {
      if (cropMode.contains(t)) {      // drag the picture inside its frame
        ev.preventDefault(); ev.stopPropagation();
        gesture = { kind: 'pan', el: cropMode, x0: ev.clientX, y0: ev.clientY, W: imgWorld(cropMode), moved: false };
        return;
      }
      exitCrop();
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
    if (document.activeElement && inField(document.activeElement)) document.activeElement.blur();
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
                keep: !(cropMode === sel) && (/^(IMG|VIDEO)$/.test(sel.tagName) || sel.classList.contains('pic') || sel.classList.contains('vidwrap')),
                W: cropMode === sel ? imgWorld(sel) : null };
  }

  function onMouseMove(ev) {
    if (!gesture) {
      if (!editingEl && ev.target.closest && !ev.target.closest('.re-ui')) showHover(topItem(ev.target));
      return;
    }
    if (gesture.kind === 'draw' || gesture.kind === 'endpoint') { dragShape(ev); return; }
    if (gesture.kind === 'marquee') { dragMarquee(ev); return; }
    if (gesture.kind === 'rotate') { dragRotate(ev); return; }
    var g = gesture, s = scale();
    var dx = (ev.clientX - g.x0) / s, dy = (ev.clientY - g.y0) / s;
    if (g.kind === 'pan') {
      if (!g.moved) { if (Math.abs(ev.clientX - g.x0) + Math.abs(ev.clientY - g.y0) < 3) return; g.moved = true; snapshot(); }
      setImgWorld(g.el, { x: g.W.x + dx, y: g.W.y + dy, w: g.W.w, h: g.W.h });
      placeCropGhost();
      return;
    }
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
      var d = g.dir, nx = b.x, ny = b.y, nw = b.w, nh = b.h, rot = rotOf(e);
      if (rot) { var loc = toLocal(dx, dy, rot); dx = loc.x; dy = loc.y; }
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
      if (rot) { var fix = keepOpposite(b, nx, ny, nw, nh, rot); nx = fix.x; ny = fix.y; }
      e.style.left = px(nx); e.style.top = px(ny); touched.add(e);
      applySize(e, nw, nh);
      if (cropMode === e && g.W) { setImgWorld(e, g.W); placeCropGhost(); }
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
    if (g.kind === 'pan') { if (g.moved) { syncWhole(g.el); markDirty(); } return; }
    if (g.kind === 'rotate') { if (g.moved) { flushTouched(); markDirty(); } placeOverlay(); updateFields(); return; }
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
    var mth = t.closest && t.closest('.math[data-tex]');
    if (mth && it.contains(mth)) { if (editingEl) endTextEdit(); select(it); equationDialog(mth); return; }
    if (it.classList.contains('pic') && it.hasAttribute('data-ph') && !it.querySelector('img')) pickFile(function (f) { fillPicturePlaceholder(it, f); }, 'image/*');
    else if (isShp(it) && !it.querySelector('.tb')) editShapeText(it);
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
    if (isTable(it)) { var cell = t && t.closest && t.closest('td, th'); return cell && it.contains(cell) ? cell : it.querySelector('td, th'); }
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
    var ph = it.closest('[data-ph]'); if (ph) { ph.removeAttribute('data-empty'); if (!(target.textContent || '').length && !target.querySelector('.p br')) { var p0 = target.querySelector('.p'); if (p0 && !p0.textContent) p0.innerHTML = '<br>'; } }
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
    updateEmpty(t.closest('[data-ph]'));
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
    dropLinksTo(list);
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
    var list = items().filter(function (e) { return !e.hasAttribute('data-master') || masterMode; });
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
    var font = isDeck() ? 'font-family:var(--dk-font);color:var(--dk-text);' : conv ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;color:#ffffff;" : '';
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
    if (masterMode) exitMaster(true);
    if (notesTimer) writeNotes();
    if (META) stampMaster();
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
      if (ui.fRot) { ui.fRot.disabled = true; ui.fRot.value = ''; }
      if (ui.cropBtn) ui.cropBtn.disabled = true;
      updateStyleControls();
      updateTextControls();
      updateMediaOpts();
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
    if (ui.fRot) { ui.fRot.disabled = !on; ui.fRot.value = on ? Math.round(rotOf(sel)) : ''; }
    if (ui.cropBtn) { ui.cropBtn.disabled = !(sel && isPic(sel)); ui.cropBtn.classList.toggle('re-active', !!cropMode); }
    updateStyleControls();
    updateTextControls();
    updateMediaOpts();
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

  var savedRange = null;
  function saveRange() { var s = getSelection(); savedRange = s.rangeCount ? s.getRangeAt(0).cloneRange() : null; }
  function restoreRange() { if (savedRange && editingEl) { var s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); } }
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
    ui.where.textContent = masterMode ? 'master' : 'slide ' + n + '/' + Reveal.getTotalSlides() + (i.v ? '  (stack ' + (i.v + 1) + ')' : '') + (tag ? '  · PowerPoint #' + tag : '');
    if (cropMode) exitCrop();
    loadNotes();
    markCurrentThumb();
    updateSlidePanel();
    updateBuildsPanel();
    updateTextControls();
  }

  // ================================================================== the deck file: settings, theme, master, layouts
  // A deck made with this tool carries its settings in <script id="deck-meta">, its theme CSS in
  // <style id="deck-theme"> and the master elements (footer, slide number, logo…) in <template id="deck-master">,
  // which are stamped onto every slide when saving. Presentations made elsewhere (pptx2reveal, by hand) have
  // none of these; the editor works on them too, and can add them on request.
  var META = null;
  var LAYOUTS = CFG.layouts || [], THEMES = CFG.themes || {}, FONTS = CFG.fonts || {}, PROMPTS = CFG.prompts || {};
  function readMeta() {
    var s = srcDoc && srcDoc.getElementById('deck-meta');
    if (!s) return null;
    try { var m = JSON.parse(s.textContent); return m && m.deck ? m : null; } catch (err) { return null; }
  }
  function isDeck() { return !!META; }
  function headBlock(re, inner) {         // rewrite one head element's content in the file text (slides untouched)
    if (!rawSlides) return;
    var t = rawText.replace(re, function (m, a, b) { return a + inner + b; });
    if (t !== rawText) replaceRaw(t);
  }
  function writeMeta() {
    if (!META) return;
    var json = JSON.stringify(META);
    [srcDoc, document].forEach(function (d) { var s = d.getElementById('deck-meta'); if (s) s.textContent = json; });
    headBlock(/(<script id="deck-meta"[^>]*>)[\s\S]*?(<\/script>)/, json);
    markDirty();
  }
  function themeCss(meta) {
    var t = meta.theme || {}, base = THEMES[t.name] || THEMES.dark || { bg: '#000', text: '#fff', accent: '#ff6a2a', muted: 'rgba(255,255,255,.72)', line: '#9bb7d6', fill: '#2e5c8a' };
    var page = t.page || base.bg, text = t.text || base.text, accent = t.accent || base.accent;
    var font = FONTS[t.font || 'Carlito'] || t.font || FONTS.Carlito, tfont = FONTS[t.titleFont || 'Carlito'] || t.titleFont || font;
    var bg = page;
    if (t.bg) {
      var size = { cover: 'cover', contain: 'contain', stretch: '100% 100%' }[t.bgFit || 'cover'] || 'cover';
      bg = page + " url('" + t.bg.replace(/'/g, '%27') + "') center / " + size + ' no-repeat';
    }
    return '/* theme: ' + (t.name || 'dark') + ' */\n' +
      ':root { --dk-page: ' + page + '; --dk-text: ' + text + '; --dk-accent: ' + accent + '; --dk-title: ' + accent + '; --dk-muted: ' + base.muted + ';\n' +
      '  --dk-font: ' + font + '; --dk-title-font: ' + tfont + '; --dk-line: ' + base.line + '; --dk-fill: ' + base.fill + '; }\n' +
      '.reveal .sf { background: ' + bg + '; color: var(--dk-text); font-family: var(--dk-font); }\n' +
      '.reveal .sf .p { line-height: 1.2; }\n';
  }
  function applyTheme() {
    if (!META) return;
    var css = themeCss(META);
    [srcDoc, document].forEach(function (d) {
      var s = d.getElementById('deck-theme');
      if (!s) { s = d.createElement('style'); s.id = 'deck-theme'; (d.head || d.body).appendChild(s); }
      s.textContent = '\n' + css;
    });
    headBlock(/(<style id="deck-theme">)[\s\S]*?(<\/style>)/, '\n' + css);
    writeMeta();
    refreshAllThumbs();
  }
  // defaults for new shapes and text follow the theme
  function themeDefaults() {
    var cs = getComputedStyle(document.documentElement);
    var v = function (n, d) { var x = cs.getPropertyValue(n).trim(); return x || d; };
    return { text: v('--dk-text', '#ffffff'), fill: v('--dk-fill', '#4f81bd'), line: v('--dk-line', '#2c5a8f'), accent: v('--dk-accent', '#ff6a2a'), font: v('--dk-font', '') };
  }

  // ---------------------------------------------------------------- master: footer, slide number, logo
  function masterHtml() { var t = srcDoc.getElementById('deck-master'); return t ? t.innerHTML : ''; }
  function setMasterHtml(html) {
    [srcDoc, document].forEach(function (d) {
      var t = d.getElementById('deck-master');
      if (!t) { t = d.createElement('template'); t.id = 'deck-master'; d.head.appendChild(t); }
      t.innerHTML = html;
    });
    headBlock(/(<template id="deck-master">)[\s\S]*?(<\/template>)/, html);
  }
  function stampFrame(frame, html, label) {   // put the master elements (with the slide's number) behind this slide's content
    var d = frame.ownerDocument;
    Array.prototype.slice.call(frame.children).forEach(function (c) { if (c.hasAttribute && c.hasAttribute('data-master')) c.remove(); });
    if (!html || frame.closest('section').hasAttribute('data-dk-nomaster')) return;
    var t = d.createElement('template');
    t.innerHTML = html;
    var first = frame.firstChild;
    Array.prototype.slice.call(t.content.children).forEach(function (m) {
      var c = d.importNode(m, true);
      if (c.hasAttribute('data-slidenum') && label != null) setNumberText(c, label);
      frame.insertBefore(c, first);
    });
  }
  function stampMaster() {                  // every slide, source and live
    if (!META) return;
    var html = masterHtml(), list = slideList(), labels = numberLabels(list, META.numbering || 'doc');
    var liveSecs = sections(liveRoot()).reduce(function (a, u) { return a.concat(isStack(u) ? sections(u) : [u]); }, []);
    var srcSecs = sections(srcRoot()).reduce(function (a, u) { return a.concat(isStack(u) ? sections(u) : [u]); }, []);
    srcSecs.forEach(function (sec, i) {
      var fr = frameOf(sec);
      if (!fr || fr === sec || sec.hasAttribute('data-dk-master-edit')) return;
      var li = list.findIndex(function (s) { return s.sec === sec; });
      var label = li >= 0 ? labels[li] : '';
      stampFrame(fr, html, label);
      var lsec = liveSecs[i], lfr = lsec && frameOf(lsec);
      if (lfr && lfr !== lsec) stampFrame(lfr, html, label);
    });
    refreshAllThumbs();
  }
  // master editing: a temporary slide holding the master elements, edited like any other slide
  var masterMode = false;
  function enterMaster() {
    if (!META) return toast('This presentation has no master yet — Deck menu › Add deck theme & master');
    if (masterMode) return;
    if (editingEl) endTextEdit();
    var idx = Reveal.getIndices(), cur = srcSlide(idx);
    var mk = function (d) {
      var sec = d.createElement('section');
      sec.setAttribute('data-dk-master-edit', '');
      var fr = d.createElement('div'); fr.className = 'sf';
      var t = d.createElement('template'); t.innerHTML = masterHtml();
      Array.prototype.slice.call(t.content.children).forEach(function (m) {
        var c = d.importNode(m, true); c.removeAttribute('data-layout'); fr.appendChild(c);
      });
      sec.appendChild(fr);
      return sec;
    };
    var unit = unitOf(srcRoot(), idx.h);
    unit.after(mk(srcDoc));
    var lunit = unitOf(liveRoot(), idx.h);
    lunit.after(mk(document));
    masterMode = true;
    undoStack.length = 0; redoStack.length = 0;
    document.documentElement.classList.add('dk-master');
    Reveal.sync();
    Reveal.slide(idx.h + 1, 0);
    loadAround();
    onSlide();
    ui.masterBar.style.display = 'flex';
    toast('Editing the master: what you put here appears on every slide. Done when finished.', 5000);
  }
  function exitMaster(keep) {
    if (!masterMode) return;
    if (editingEl) endTextEdit();
    deselect();
    var ssec = srcRoot().querySelector('section[data-dk-master-edit]'), lsec = liveRoot().querySelector('section[data-dk-master-edit]');
    var h = Math.max(0, sections(liveRoot()).indexOf(lsec) - 1);
    if (keep && ssec) {
      var fr = frameOf(ssec), out = [];
      Array.prototype.slice.call(fr.children).forEach(function (c) {
        var k = cleanClone(c);
        k.setAttribute('data-layout', '');
        if (!k.hasAttribute('data-master')) k.setAttribute('data-master', 'x' + Math.random().toString(36).slice(2, 7));
        out.push(k.outerHTML);
      });
      setMasterHtml(out.join(''));
    }
    if (ssec) ssec.remove(); if (lsec) lsec.remove();
    masterMode = false;
    document.documentElement.classList.remove('dk-master');
    ui.masterBar.style.display = 'none';
    undoStack.length = 0; redoStack.length = 0;
    if (keep) { stampMaster(); markDirty(); }
    rebuildLive({ h: h, v: 0 });
    toast(keep ? 'Master updated on every slide' : 'Master unchanged');
  }

  // ---------------------------------------------------------------- layouts
  function layoutById(id) { return LAYOUTS.filter(function (l) { return l.id === id; })[0] || null; }
  function nextId(frame) {
    var n = 0;
    frame.querySelectorAll('[data-id]').forEach(function (e) { var v = parseInt(e.getAttribute('data-id'), 10); if (v > n) n = v; });
    return n + 1;
  }
  function ensureId(e) {
    if (!e.hasAttribute('data-id')) { e.setAttribute('data-id', String(nextId(frameOf(curSection())))); var s = srcOf(e); if (s) s.setAttribute('data-id', e.getAttribute('data-id')); }
    return e.getAttribute('data-id');
  }
  function placeholderHtml(ph, W, H, n) {
    var x = ph.x * W, y = ph.y * H, bw = ph.w * W, bh = ph.h * H;
    var box = 'left:' + px(x) + ';top:' + px(y) + ';width:' + px(bw) + ';height:' + px(bh) + ';';
    if (ph.kind === 'picture') return '<div class="e pic" data-id="' + n + '" data-ph="picture" data-empty data-prompt="' + esc(PROMPTS.picture || 'Double-click to add a picture') + '" style="' + box + '"></div>';
    var title = ph.kind === 'title', pad = ph.size >= 40 ? 7.2 : 4.8;
    var just = { start: 'flex-start', center: 'center', end: 'flex-end' }[ph.anchor || 'start'];
    return '<div class="e" data-id="' + n + '" data-ph="' + ph.kind + '" data-empty style="' + box + '">' +
      '<div class="tx" data-autofit style="left:0;top:0;width:' + px(bw) + ';height:' + px(bh) + ';padding:' + px(pad) + ' ' + px(pad * 2) + ';justify-content:' + just + ';">' +
      '<div class="tb"><div class="p" data-prompt="' + esc(PROMPTS[ph.kind] || 'Click to add text') + '"' + (ph.bullets ? ' data-bu="dot"' : '') +
      ' style="text-align:' + ph.align + ';font-size:calc(' + ph.size + 'px*var(--fs,1));font-family:var(--dk-' + (title ? 'title-' : '') + 'font);color:var(--dk-' + (title ? 'title' : 'text') + ');' + (title ? 'font-weight:700;' : '') + '"><span></span></div></div></div></div>';
  }
  // move this slide's placeholders to where the layout puts them; add the missing ones; drop empty extra ones
  function applyLayout(secSrc, id) {
    var L = layoutById(id);
    if (!L) return;
    var fr = frameOf(secSrc), S = slideSize(), used = [];
    secSrc.setAttribute('data-dk-layout', id);
    var phs = Array.prototype.slice.call(fr.querySelectorAll(':scope > [data-ph]'));
    L.boxes.forEach(function (b) {
      var e = phs.filter(function (p) { return used.indexOf(p) < 0 && p.getAttribute('data-ph') === b.kind; })[0];
      if (e) {
        used.push(e);
        e.style.left = px(b.x * S.w); e.style.top = px(b.y * S.h); e.style.width = px(b.w * S.w); e.style.height = px(b.h * S.h);
        var tx = e.querySelector(':scope > .tx');
        if (tx) { tx.style.width = px(b.w * S.w); tx.style.height = px(b.h * S.h); }
        var img = e.querySelector(':scope > img');
        if (img && e.classList.contains('pic')) { img.style.width = '100%'; img.style.height = '100%'; }
      } else {
        var t = srcDoc.createElement('template');
        t.innerHTML = placeholderHtml(b, S.w, S.h, nextId(fr));
        fr.appendChild(t.content.firstElementChild);
      }
    });
    phs.forEach(function (p) { if (used.indexOf(p) < 0 && p.hasAttribute('data-empty')) p.remove(); });
  }
  function setSlideLayout(id) {
    slideOp(function (idx) { applyLayout(srcSlide(idx), id); return idx; });
    refreshThumb(curSection());
  }
  // a new slide after the current one (inside its stack when it is stacked), with a layout
  function newSlideWithLayout(id) {
    if (!META) return newSlide();
    slideOp(function (idx) {
      var cur = srcSlide(idx);
      var s = srcDoc.createElement('section');
      var f = srcDoc.createElement('div'); f.className = 'sf';
      s.appendChild(f);
      s.appendChild(srcDoc.createElement('aside')).className = 'notes';
      cur.after(s);
      applyLayout(s, id || 'content');
      return inStack(idx) ? { h: idx.h, v: (idx.v || 0) + 1 } : { h: idx.h + 1, v: 0 };
    });
    stampMaster();
    rebuildLive(Reveal.getIndices());
  }
  function defaultNextLayout() {
    var cur = curSection() && curSection().getAttribute('data-dk-layout');
    return (!cur || cur === 'title' || cur === 'section') ? 'content' : cur;
  }
  // placeholders: the prompt shows while they are empty; empty ones are hidden when presenting
  function updateEmpty(e) {
    if (!e || !e.hasAttribute || !e.hasAttribute('data-ph')) return;
    var empty = e.classList.contains('pic') ? !e.querySelector('img') : !(e.textContent || '').replace(/[​\s]/g, '');
    var src = srcOf(e);
    [e, src].forEach(function (x) { if (!x) return; if (empty) x.setAttribute('data-empty', ''); else x.removeAttribute('data-empty'); });
  }
  function fillPicturePlaceholder(ph, file) {
    upload(file).then(function (url) {
      return mediaSize(url, false).then(function (sz) {
        snapshot();
        var b = boxOf(ph), r = Math.min(b.w / sz.w, b.h / sz.h), w = sz.w * r, h = sz.h * r;
        ph.style.left = px(b.x + (b.w - w) / 2); ph.style.top = px(b.y + (b.h - h) / 2); ph.style.width = px(w); ph.style.height = px(h);
        ph.innerHTML = '<img src="' + esc(url) + '" data-src="' + esc(url) + '" alt="" style="width:100%;height:100%;" draggable="false">';
        ph.removeAttribute('data-empty'); ph.removeAttribute('data-prompt');
        syncWhole(ph); markDirty(); select(ph); placeOverlay(); updateFields(); refreshThumb(curSection());
      });
    }).catch(function (e) { toast('Could not add the picture: ' + e.message, 6000); });
  }

  // ---------------------------------------------------------------- give a foreign presentation a theme and master
  function adoptDeck() {
    if (META) return;
    var S = slideSize();
    META = { deck: 1, width: S.w, height: S.h, title: document.title || 'Presentation',
             theme: { name: 'dark', bg: '', bgFit: 'cover', font: 'Carlito', titleFont: 'Carlito', accent: '#ff6a2a', text: '#ffffff', page: '#000000' },
             footer: '', numbers: false, numbering: 'doc' };
    var mk = function (d) {
      var s = d.createElement('script'); s.id = 'deck-meta'; s.type = 'application/json'; s.textContent = JSON.stringify(META);
      var st = d.createElement('style'); st.id = 'deck-theme';
      var t = d.createElement('template'); t.id = 'deck-master';
      d.head.appendChild(st); d.head.appendChild(s); d.head.appendChild(t);
    };
    mk(srcDoc); mk(document);
    if (rawSlides) {
      var h = rawText.search(/<\/head\s*>/i);
      var block = '<style id="deck-theme"></style>\n<script id="deck-meta" type="application/json">' + JSON.stringify(META) + '</script>\n<template id="deck-master"></template>\n';
      replaceRaw(h >= 0 ? rawText.slice(0, h) + block + rawText.slice(h) : rawText);
    }
    applyTheme();        // slides that carry their own background keep it (inline styles win)
    fetch('/__vendor', { method: 'POST', headers: { 'X-Edit-Token': TOKEN } }).catch(function () {});
    buildSlidePanel(); updateSlidePanel();
    toast('Theme and master added. Deck menu › Edit master to put a footer, number or logo on every slide.', 6000);
  }

  // ---------------------------------------------------------------- presenting
  function present(presenter, fromStart) {
    if (dirty) save(false);
    var i = fromStart ? { h: 0, v: 0 } : Reveal.getIndices();
    var q = isDeck() ? ('?present' + (presenter ? '&presenter' : '')) : '';
    var w = window.open('/' + encodeURI(FILE) + q + '#/' + i.h + (i.v ? '/' + i.v : ''), '_blank');
    if (!isDeck()) toast('Presenting in a new tab — F: full screen · S: presenter view with notes', 5000);
    else if (!w) toast('The browser blocked the new window — allow pop-ups for this page', 5000);
  }

  // ================================================================== rich text: paragraphs, bullets, levels, fonts
  // Text lives in .tx > .tb > .p paragraphs (spans for runs). Bullets and numbering are paragraph attributes
  // (data-bu="dot"|"num", data-lvl="0".."4") drawn by the deck's CSS, so the file stays plain HTML.
  function paraOf(node) { var e = node && node.nodeType === 1 ? node : node && node.parentElement; return e && e.closest ? e.closest('.p') : null; }
  function curParas() {           // paragraphs the current selection touches (while editing), else all in the selected boxes
    if (editingEl) {
      var s = getSelection(), out = [], ps = editingEl.querySelectorAll('.p');
      if (!ps.length) return [editingEl];
      var r = s.rangeCount ? s.getRangeAt(0) : null;
      if (!r || !editingEl.contains(r.commonAncestorContainer)) r = savedRange && editingEl.contains(savedRange.commonAncestorContainer) ? savedRange : null;
      if (!r) return Array.prototype.slice.call(ps);       // focus is in a toolbar control: the whole box
      ps.forEach(function (p) { if (r.intersectsNode(p)) out.push(p); });
      if (!out.length) { var p0 = paraOf(r.startContainer); if (p0) out.push(p0); }
      return out;
    }
    var boxes = textBoxes(), all = [];
    boxes.forEach(function (b) { var ps = b.querySelectorAll('.p'); if (ps.length) Array.prototype.push.apply(all, ps); else all.push(b); });
    return all;
  }
  function afterParaChange(paras) {
    var boxes = [];
    paras.forEach(function (p) { var b = p.closest('.tb') || p; if (boxes.indexOf(b) < 0) boxes.push(b); });
    boxes.forEach(function (b) {
      if (editingEl && editingEl.contains(b)) return;      // saved when editing ends
      syncTextBox(b);
      var shp = b.closest('.shp[data-tbox]'); if (shp) { autoHeight(shp); syncWhole(shp); }
    });
    if (editingEl) { var shp2 = editingEl.closest('.shp[data-tbox]'); if (shp2) autoHeight(shp2); }
    placeOverlay(); updateTextControls();
    refreshThumbSoon();
  }
  function paraOp(fn) {
    var paras = curParas();
    if (!paras.length) return toast('Select a text box first');
    if (!editingEl) snapshot();
    paras.forEach(fn);
    afterParaChange(paras);
  }
  // bullets: the legacy marker spans from PowerPoint conversions are replaced by the attribute form
  function dropLegacyBullet(p) {
    var bu = p.querySelector(':scope > .bu');
    if (bu) { bu.remove(); p.style.removeProperty('text-indent'); p.style.removeProperty('padding-left'); }
  }
  function toggleBullets(kind) {
    var paras = curParas();
    if (!paras.length) return toast('Select a text box first');
    var all = paras.every(function (p) { return p.getAttribute('data-bu') === kind; });
    paraOp(function (p) {
      dropLegacyBullet(p);
      if (all) p.removeAttribute('data-bu'); else p.setAttribute('data-bu', kind);
    });
  }
  function indentParas(d) {
    paraOp(function (p) {
      var lvl = Math.max(0, Math.min(4, (parseInt(p.getAttribute('data-lvl'), 10) || 0) + d));
      if (lvl) p.setAttribute('data-lvl', String(lvl)); else p.removeAttribute('data-lvl');
    });
  }
  function setLineSpacing(v) { paraOp(function (p) { p.style.lineHeight = String(v); }); }
  function setParaAlign(a) { paraOp(function (p) { p.style.textAlign = a; }); }
  function setFontSizeOn(n, size) {
    var st = n.getAttribute('style') || '';
    if (/font-size\s*:\s*calc\(/.test(st)) n.setAttribute('style', st.replace(/(font-size\s*:\s*calc\(\s*)([\d.]+)px/, function (m, a) { return a + size + 'px'; }));
    else n.style.fontSize = size + 'px';
  }
  function hasTextSelection() {
    if (!editingEl) return false;
    var s = getSelection(), r = s.rangeCount ? s.getRangeAt(0) : null;
    if (r && editingEl.contains(r.commonAncestorContainer)) return !r.collapsed;
    if (savedRange && editingEl.contains(savedRange.commonAncestorContainer) && !savedRange.collapsed) { restoreRange(); editingEl.focus(); return true; }
    return false;
  }
  // an inline style on the selected words: wrapped in a span per paragraph (the browser's own commands
  // would strip the paragraphs' theme-relative sizes and colours)
  function wrapSelection(prop, value) {
    var s = getSelection(), r = s.getRangeAt(0), paras = curParas(), spans = [];
    paras.forEach(function (p) {
      var sub = r.cloneRange();
      if (!p.contains(sub.startContainer) || sub.startContainer === p && false) sub.setStart(p, 0);
      if (!p.contains(sub.endContainer)) sub.setEnd(p, p.childNodes.length);
      if (sub.collapsed) return;
      var frag = sub.extractContents(), span = document.createElement('span');
      span.style.setProperty(prop, value);
      span.appendChild(frag);
      span.querySelectorAll('[style]').forEach(function (n) { n.style.removeProperty(prop); if (!n.getAttribute('style')) n.removeAttribute('style'); });
      span.querySelectorAll(prop === 'color' ? 'font[color]' : prop === 'font-size' ? 'font[size]' : 'font[face]').forEach(function (f) { f.removeAttribute(prop === 'color' ? 'color' : prop === 'font-size' ? 'size' : 'face'); });
      sub.insertNode(span);
      spans.push(span);
    });
    paras.forEach(function (p) { p.querySelectorAll('span:empty').forEach(function (e) { e.remove(); }); p.normalize(); });
    if (spans.length) {
      var nr = document.createRange(); nr.setStartBefore(spans[0]); nr.setEndAfter(spans[spans.length - 1]);
      s.removeAllRanges(); s.addRange(nr);
    }
  }
  // font size: on the selected words while editing, otherwise on whole paragraphs (their runs follow)
  function setFontSize(size) {
    size = Math.max(4, Math.min(400, Math.round(size * 10) / 10));
    if (hasTextSelection()) { wrapSelection('font-size', size + 'px'); afterParaChange(curParas()); return; }
    paraOp(function (p) {
      setFontSizeOn(p, size);
      p.querySelectorAll('[style*="font-size"]').forEach(function (n) { n.style.removeProperty('font-size'); if (!n.getAttribute('style')) n.removeAttribute('style'); });
      p.querySelectorAll('font[size]').forEach(function (f) { f.removeAttribute('size'); });
    });
  }
  function setFontFamily(stack) {
    if (hasTextSelection()) { wrapSelection('font-family', stack); afterParaChange(curParas()); return; }
    paraOp(function (p) {
      p.style.fontFamily = stack;
      p.querySelectorAll('[style*="font-family"]').forEach(function (n) { n.style.removeProperty('font-family'); if (!n.getAttribute('style')) n.removeAttribute('style'); });
    });
  }
  function setTextColor(c) {
    if (hasTextSelection()) { wrapSelection('color', c); afterParaChange(curParas()); return; }
    paraOp(function (p) {
      p.style.color = c;
      p.querySelectorAll('[style*="color"]').forEach(function (n) { n.style.removeProperty('color'); if (!n.getAttribute('style')) n.removeAttribute('style'); });
      p.querySelectorAll('font[color]').forEach(function (f) { f.removeAttribute('color'); });
    });
  }
  function toggleInline(cmd) {        // bold / italic / underline: selection while editing, else the whole paragraphs
    if (editingEl) { fmt(cmd); afterParaChange(curParas()); return; }
    var prop = { bold: 'font-weight', italic: 'font-style', underline: 'text-decoration' }[cmd];
    var on = { bold: '700', italic: 'italic', underline: 'underline' }[cmd];
    var paras = curParas();
    if (!paras.length) return toast('Select a text box first');
    var all = paras.every(function (p) { return paraHas(p, cmd); });
    paraOp(function (p) {
      p.style.setProperty(prop, all ? (cmd === 'underline' ? 'none' : 'normal') : on);
      p.querySelectorAll('[style*="' + prop + '"]').forEach(function (n) { n.style.removeProperty(prop); if (!n.getAttribute('style')) n.removeAttribute('style'); });
      p.querySelectorAll(cmd === 'bold' ? 'b, strong' : cmd === 'italic' ? 'i, em' : 'u').forEach(function (n) { var sp = document.createElement('span'); while (n.firstChild) sp.appendChild(n.firstChild); n.replaceWith(sp); });
    });
  }
  function paraHas(p, cmd) {
    var probe = p.querySelector('span') || p, cs = getComputedStyle(probe);
    if (cmd === 'bold') return parseInt(cs.fontWeight, 10) >= 600;
    if (cmd === 'italic') return cs.fontStyle === 'italic';
    return /underline/.test(cs.textDecorationLine || cs.textDecoration);
  }
  function setAnchor(v) {             // vertical placement of the text in its box
    var boxes = textBoxes();
    if (!boxes.length) return toast('Select a text box first');
    if (!editingEl) snapshot();
    boxes.forEach(function (b) {
      var tx = b.closest('.tx'); if (!tx) return;
      tx.style.justifyContent = v;
      if (!editingEl) { syncStyle(tx); }
    });
    markDirty(); placeOverlay(); updateTextControls(); refreshThumbSoon();
  }
  function toggleAutofit() {
    var boxes = textBoxes();
    if (!boxes.length) return toast('Select a text box first');
    if (editingEl) endTextEdit();
    snapshot();
    var on = !boxes.every(function (b) { var tx = b.closest('.tx'); return tx && tx.hasAttribute('data-autofit'); });
    boxes.forEach(function (b) {
      var tx = b.closest('.tx'); if (!tx) return;
      if (on) tx.setAttribute('data-autofit', ''); else { tx.removeAttribute('data-autofit'); tx.style.removeProperty('--fs'); }
      syncAttrs(tx, ['data-autofit']); refit(tx);
    });
    markDirty(); updateTextControls();
    toast(on ? 'Text shrinks to fit the box' : 'Text keeps its size (the box may overflow)');
  }
  // what the toolbar shows for the current paragraph / selection
  function textState() {
    var paras = curParas();
    if (!paras.length) return null;
    var p = paras[0], probe = (function () {
      var s = getSelection();
      if (editingEl && s.rangeCount) { var n = s.getRangeAt(0).startContainer; n = n.nodeType === 1 ? n : n.parentElement; if (n && p.contains(n)) return n; }
      return p.querySelector('span') || p;
    })();
    var cs = getComputedStyle(probe), tx = p.closest('.tx');
    var scale_ = parseFloat(getComputedStyle(tx || p).getPropertyValue('--fs')) || 1;
    return {
      size: Math.round(parseFloat(cs.fontSize) / scale_ * 10) / 10, family: cs.fontFamily, color: toHex(cs.color),
      bold: parseInt(cs.fontWeight, 10) >= 600, italic: cs.fontStyle === 'italic', underline: /underline/.test(cs.textDecorationLine || cs.textDecoration),
      align: getComputedStyle(p).textAlign, bu: p.getAttribute('data-bu') || (p.querySelector(':scope > .bu') ? 'dot' : ''), lvl: parseInt(p.getAttribute('data-lvl'), 10) || 0,
      lh: getComputedStyle(p).lineHeight, anchor: tx ? getComputedStyle(tx).justifyContent : '', autofit: !!(tx && tx.hasAttribute('data-autofit'))
    };
  }
  // keys while editing text: Enter splits the paragraph (keeping bullet and level), Tab / Shift-Tab change the
  // level, Backspace at the start of a bulleted paragraph removes its bullet first
  function caretAtStart(p) {
    var s = getSelection(); if (!s.rangeCount) return false;
    var r = s.getRangeAt(0); if (!r.collapsed) return false;
    var pre = r.cloneRange(); pre.selectNodeContents(p); pre.setEnd(r.startContainer, r.startOffset);
    return !pre.toString().replace(/​/g, '').length;
  }
  function splitParagraph() {
    var s = getSelection(); if (!s.rangeCount) return false;
    var r = s.getRangeAt(0), p = paraOf(r.startContainer);
    if (!p || !editingEl.contains(p)) return false;
    r.deleteContents();
    var tail = r.cloneRange(); tail.setEndAfter(p.lastChild || p); tail.setStart(r.startContainer, r.startOffset);
    var frag = tail.extractContents();
    var np = p.cloneNode(false);
    np.appendChild(frag);
    if (!(np.textContent || '').length && !np.querySelector('br, img')) { np.innerHTML = ''; np.appendChild(document.createElement('br')); }
    if (!(p.textContent || '').length && !p.querySelector('br, img')) p.appendChild(document.createElement('br'));
    p.after(np);
    var nr = document.createRange(); nr.setStart(np, 0); nr.collapse(true);
    s.removeAllRanges(); s.addRange(nr);
    return true;
  }
  function insertLines(lines) {        // paste: first line into the paragraph, the rest as new paragraphs
    document.execCommand('insertText', false, lines[0]);
    for (var i = 1; i < lines.length; i++) { if (!splitParagraph()) break; document.execCommand('insertText', false, lines[i]); }
  }
  function onTextKey(e) {             // returns true when handled
    var k = e.key, mod = e.metaKey || e.ctrlKey;
    if (k === 'Tab') {
      e.preventDefault();
      var cell = editingEl.closest && editingEl.closest('td, th');
      if (cell) {           // in a table: next / previous cell
        var cells = Array.prototype.slice.call(cell.closest('table').querySelectorAll('td, th')), i = cells.indexOf(cell) + (e.shiftKey ? -1 : 1);
        if (cells[i]) { var top = topItem(cell); endTextEdit(); startTextEdit(top, { target: cells[i] }); var r = document.createRange(); r.selectNodeContents(cells[i]); r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        return true;
      }
      indentParas(e.shiftKey ? -1 : 1); return true;
    }
    if (k === 'Enter' && !e.shiftKey && !mod) {
      if (editingEl.querySelector('.p') && splitParagraph()) { e.preventDefault(); onTextInput(); return true; }
      return false;
    }
    if (k === 'Backspace' && !mod) {
      var p = paraOf(getSelection().anchorNode);
      if (p && (p.hasAttribute('data-bu') || p.querySelector(':scope > .bu')) && caretAtStart(p)) {
        e.preventDefault(); dropLegacyBullet(p); p.removeAttribute('data-bu'); afterParaChange([p]); return true;
      }
      return false;
    }
    if (mod && !e.shiftKey && !e.altKey) {
      var c = k.toLowerCase();
      if (c === 'b') { e.preventDefault(); toggleInline('bold'); return true; }
      if (c === 'i') { e.preventDefault(); toggleInline('italic'); return true; }
      if (c === 'u') { e.preventDefault(); toggleInline('underline'); return true; }
      if (c === 'e') { e.preventDefault(); setParaAlign('center'); return true; }
      if (c === 'l') { e.preventDefault(); setParaAlign('left'); return true; }
      if (c === 'r') { e.preventDefault(); setParaAlign('right'); return true; }
    }
    return false;
  }

  // ================================================================== arrange: group, align, rotate, flip, crop, connectors
  // ---- rotation and flips live in the element's transform: rotate(Ndeg) [scaleX(-1)] [scaleY(-1)]
  function rotOf(e) { var m = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(e.style.transform || ''); return m ? parseFloat(m[1]) : 0; }
  function flipOf(e) { var t = e.style.transform || ''; return { h: /scaleX\(\s*-1\s*\)/.test(t), v: /scaleY\(\s*-1\s*\)/.test(t) }; }
  function setTransform(e, rot, flip) {
    var parts = [];
    rot = Math.round(((rot % 360) + 360) % 360 * 10) / 10;
    if (rot) parts.push('rotate(' + rot + 'deg)');
    if (flip && flip.h) parts.push('scaleX(-1)');
    if (flip && flip.v) parts.push('scaleY(-1)');
    var other = (e.style.transform || '').replace(/rotate\([^)]*\)|scaleX\(\s*-1\s*\)|scaleY\(\s*-1\s*\)/g, '').trim();
    if (other) parts.push(other);
    if (parts.length) e.style.transform = parts.join(' '); else e.style.removeProperty('transform');
  }
  function rotateSel(deg) {
    var list = selList().filter(isPositioned);
    if (!list.length) return toast('Select an element first');
    snapshot();
    list.forEach(function (e) { setTransform(e, rotOf(e) + deg, flipOf(e)); touched.add(e); });
    flushTouched(); markDirty(); placeOverlay(); updateFields();
  }
  function flipSel(axis) {
    var list = selList().filter(isPositioned);
    if (!list.length) return toast('Select an element first');
    snapshot();
    list.forEach(function (e) { var f = flipOf(e); f[axis] = !f[axis]; setTransform(e, rotOf(e), f); touched.add(e); });
    flushTouched(); markDirty(); placeOverlay();
  }
  // the resize handles work in the element's own (rotated) frame: mouse deltas are turned into that frame,
  // and the box is re-placed so the edge opposite the handle stays where it was on screen
  function toLocal(dx, dy, deg) {
    var a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }
  function keepOpposite(b, nx, ny, nw, nh, deg) {
    if (!deg) return { x: nx, y: ny };
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    var dcx = (nx + nw / 2) - (b.x + b.w / 2), dcy = (ny + nh / 2) - (b.y + b.h / 2);     // centre shift in local units
    var wx = dcx * c - dcy * s, wy = dcx * s + dcy * c;                                 // the same shift on screen
    return { x: b.x + b.w / 2 + wx - nw / 2, y: b.y + b.h / 2 + wy - nh / 2 };
  }
  function startRotate(ev) {
    ev.preventDefault(); ev.stopPropagation();
    if (!sel || isMulti() || !isPositioned(sel)) return;
    var r = rectOf(sel), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    var start = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
    gesture = { kind: 'rotate', el: sel, cx: cx, cy: cy, start: start, rot0: rotOf(sel), moved: false };
  }
  function dragRotate(ev) {
    var g = gesture;
    if (!g.moved) { g.moved = true; snapshot(); }
    var a = Math.atan2(ev.clientY - g.cy, ev.clientX - g.cx) * 180 / Math.PI;
    var rot = g.rot0 + (a - g.start);
    if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
    rot = Math.round(rot * 10) / 10;
    if (Math.abs(rot) < 1.5 && !ev.shiftKey) rot = 0;
    setTransform(g.el, rot, flipOf(g.el)); touched.add(g.el);
    placeOverlay(); updateFields();
    ui.selLabel.textContent = 'rotation ' + rot + '°';
  }

  // ---- groups
  function groupSel() {
    var list = selList().filter(isPositioned);
    if (list.length < 2) return toast('Select two or more elements to group (Shift-click)');
    var fr = frameOf(curSection());
    if (list.some(function (e) { return e.parentElement !== fr; })) return toast('Only elements on the slide itself can be grouped');
    snapshot();
    var gb = groupBox(list), pos = function (e) { return Array.prototype.indexOf.call(fr.children, e); };
    list.sort(function (a, b) { return pos(a) - pos(b); });
    var g = el('div', { 'class': 'e g', 'data-id': String(nextId(fr)), style: 'left:' + px(gb.x) + ';top:' + px(gb.y) + ';width:' + px(gb.w) + ';height:' + px(gb.h) + ';' });
    fr.insertBefore(g, list[list.length - 1].nextSibling);
    list.forEach(function (e) {
      var b = normalize(e);
      e.style.left = px(b.x - gb.x); e.style.top = px(b.y - gb.y);
      g.appendChild(e);
    });
    touched.clear();
    syncFrame(fr);
    select(g);
    toast('Grouped — Option-click picks an element inside; ⇧⌘G ungroups');
  }
  function ungroupSel() {
    var groups = selList().filter(function (e) { return e.classList.contains('g') && e.children.length; });
    if (!groups.length) return toast('Select a group first');
    var fr = frameOf(curSection());
    snapshot();
    var out = [];
    groups.forEach(function (g) {
      if (g.parentElement !== fr) return;
      var gb = boxOf(g), rot = rotOf(g);
      var kids = Array.prototype.slice.call(g.children).filter(function (c) { return c.nodeType === 1; });
      kids.forEach(function (c) {
        if (!isPositioned(c)) { g.before(c); return; }
        var b = normalize(c);
        if (rot) {      // the child's centre turns with the group; it keeps the group's rotation on top of its own
          var cx = b.x + b.w / 2 - gb.w / 2, cy = b.y + b.h / 2 - gb.h / 2, a = rot * Math.PI / 180;
          var rx = cx * Math.cos(a) - cy * Math.sin(a), ry = cx * Math.sin(a) + cy * Math.cos(a);
          c.style.left = px(gb.x + gb.w / 2 + rx - b.w / 2); c.style.top = px(gb.y + gb.h / 2 + ry - b.h / 2);
          setTransform(c, rotOf(c) + rot, flipOf(c));
        } else { c.style.left = px(gb.x + b.x); c.style.top = px(gb.y + b.y); }
        g.before(c);
        out.push(c);
      });
      g.remove();
    });
    touched.clear();
    syncFrame(fr);
    setSel(out, null);
  }
  // rewrite a slide's source frame from its live frame (after restructuring several elements at once)
  function syncFrame(liveFrame) {
    var sfr = frameOf(srcSlide(Reveal.getIndices()));
    if (!sfr) return;
    while (sfr.firstChild) sfr.removeChild(sfr.firstChild);
    Array.prototype.slice.call(liveFrame.childNodes).forEach(function (n) {
      if (n.nodeType === 1) sfr.appendChild(srcDoc.importNode(cleanClone(n), true));
      else if (n.nodeType === 3 && n.textContent.trim()) sfr.appendChild(srcDoc.importNode(n, true));
    });
    markDirty();
    refreshThumbSoon();
  }

  // ---- align, distribute, same size (to each other, or to the slide when one element is selected)
  function alignSel(how) {
    var list = selList().filter(isPositioned);
    if (!list.length) return toast('Select an element first');
    var S = slideSize(), ref = list.length > 1 ? groupBox(list) : { x: 0, y: 0, w: S.w, h: S.h };
    snapshot();
    list.forEach(function (e) {
      var b = normalize(e);
      if (how === 'left') e.style.left = px(ref.x);
      if (how === 'center') e.style.left = px(ref.x + (ref.w - b.w) / 2);
      if (how === 'right') e.style.left = px(ref.x + ref.w - b.w);
      if (how === 'top') e.style.top = px(ref.y);
      if (how === 'middle') e.style.top = px(ref.y + (ref.h - b.h) / 2);
      if (how === 'bottom') e.style.top = px(ref.y + ref.h - b.h);
      touched.add(e);
    });
    flushTouched(); markDirty(); placeOverlay(); updateFields();
  }
  function distributeSel(axis) {
    var list = selList().filter(isPositioned);
    if (list.length < 3) return toast('Select three or more elements to distribute');
    var key = axis === 'h' ? 'x' : 'y', size = axis === 'h' ? 'w' : 'h';
    list.sort(function (a, b) { return boxOf(a)[key] - boxOf(b)[key]; });
    var first = boxOf(list[0]), last = boxOf(list[list.length - 1]);
    var total = list.reduce(function (a, e) { return a + boxOf(e)[size]; }, 0);
    var gap = ((last[key] + last[size]) - first[key] - total) / (list.length - 1);
    snapshot();
    var at = first[key];
    list.forEach(function (e) {
      var b = normalize(e);
      if (axis === 'h') e.style.left = px(at); else e.style.top = px(at);
      at += b[size] + gap;
      touched.add(e);
    });
    flushTouched(); markDirty(); placeOverlay(); updateFields();
  }
  function sameSize(which) {            // to the size of the element selected last
    var list = selList().filter(isPositioned);
    if (list.length < 2 || !sel) return toast('Select two or more elements (the last one picked sets the size)');
    var ref = boxOf(sel);
    snapshot();
    list.forEach(function (e) {
      if (e === sel) return;
      var b = normalize(e);
      applySize(e, which === 'h' ? b.w : ref.w, which === 'w' ? b.h : ref.h);
      touched.add(e);
    });
    flushTouched(); markDirty(); placeOverlay(); updateFields();
  }

  // ---- picture cropping: the box shows a window onto the picture; handles move the window, dragging pans
  var cropMode = null;      // the picture being cropped
  function isPic(e) { return !!(e && e.classList && e.classList.contains('pic') && e.querySelector(':scope > img')); }
  function picImg(e) { return e.querySelector(':scope > img'); }
  // the picture's full extent in slide px, from the % crop on the img
  function imgWorld(pic) {
    var b = boxOf(pic), img = picImg(pic), s = img.style;
    var pct = function (v, whole, d) { var m = /(-?[\d.]+)%/.exec(v || ''); return m ? parseFloat(m[1]) / 100 * whole : d; };
    if (!pic.classList.contains('crop')) return { x: b.x, y: b.y, w: b.w, h: b.h };
    return { x: b.x + pct(s.left, b.w, 0), y: b.y + pct(s.top, b.h, 0), w: pct(s.width, b.w, b.w), h: pct(s.height, b.h, b.h) };
  }
  function setImgWorld(pic, W) {       // express the picture extent W as % of the (possibly new) box
    var b = boxOf(pic), img = picImg(pic);
    pic.classList.add('crop');
    img.style.left = (Math.round((W.x - b.x) / b.w * 10000) / 100) + '%'; img.style.top = (Math.round((W.y - b.y) / b.h * 10000) / 100) + '%';
    img.style.width = (Math.round(W.w / b.w * 10000) / 100) + '%'; img.style.height = (Math.round(W.h / b.h * 10000) / 100) + '%';
    img.style.position = ''; img.style.objectFit = '';
  }
  function enterCrop() {
    if (!sel || isMulti() || !isPic(sel)) return toast('Select a picture first');
    if (editingEl) endTextEdit();
    cropMode = sel;
    document.documentElement.classList.add('dk-crop');
    placeOverlay();
    toast('Crop: drag the handles to trim, drag the picture to move it inside the frame · Enter or Esc when done', 5000);
  }
  function exitCrop() {
    if (!cropMode) return;
    var pic = cropMode;
    cropMode = null;
    document.documentElement.classList.remove('dk-crop');
    ui.cropGhost.style.display = 'none';
    var img = picImg(pic), b = boxOf(pic), W = imgWorld(pic);
    if (Math.abs(W.x - b.x) < 0.5 && Math.abs(W.y - b.y) < 0.5 && Math.abs(W.w - b.w) < 0.5 && Math.abs(W.h - b.h) < 0.5) {
      pic.classList.remove('crop'); img.style.left = img.style.top = ''; img.style.width = '100%'; img.style.height = '100%';
    }
    syncWhole(pic); markDirty(); placeOverlay(); updateFields(); refreshThumbSoon();
  }
  function resetCrop() {
    var pic = cropMode || (isPic(sel) ? sel : null);
    if (!pic) return toast('Select a picture first');
    snapshot();
    var W = imgWorld(pic), img = picImg(pic);
    pic.style.left = px(W.x); pic.style.top = px(W.y); pic.style.width = px(W.w); pic.style.height = px(W.h);
    pic.classList.remove('crop'); img.style.left = img.style.top = ''; img.style.width = '100%'; img.style.height = '100%';
    syncWhole(pic); markDirty(); placeOverlay(); updateFields(); refreshThumbSoon();
  }
  function placeCropGhost() {
    if (!cropMode) { ui.cropGhost.style.display = 'none'; return; }
    var W = imgWorld(cropMode), a = frameToScreen(W.x, W.y), s = scale(), img = picImg(cropMode);
    var g = ui.cropGhost.style;
    g.display = 'block'; g.left = a.x + 'px'; g.top = a.y + 'px'; g.width = (W.w * s) + 'px'; g.height = (W.h * s) + 'px';
    g.backgroundImage = 'url("' + (img.currentSrc || img.src) + '")';
    g.transform = cropMode.style.transform || '';
  }

  // ---- connectors: a line end that was snapped to a shape remembers it (data-from / data-to = "id@anchor") and
  //      follows the shape when it moves or resizes
  var ANCHORS = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], w: [0, 0.5], c: [0.5, 0.5], e: [1, 0.5], sw: [0, 1], s: [0.5, 1], se: [1, 1] };
  function anchorPos(target, name) {
    var b = boxOf(target), f = ANCHORS[name] || ANCHORS.c, x = b.x + b.w * f[0], y = b.y + b.h * f[1], rot = rotOf(target);
    if (rot) { var cx = b.x + b.w / 2, cy = b.y + b.h / 2, a = rot * Math.PI / 180, dx = x - cx, dy = y - cy; x = cx + dx * Math.cos(a) - dy * Math.sin(a); y = cy + dx * Math.sin(a) + dy * Math.cos(a); }
    return { x: x, y: y };
  }
  function elById(id) { return id ? frameOf(curSection()).querySelector(':scope > [data-id="' + id + '"]') : null; }
  function setLink(line, end, target, anchor) {
    var attr = end === 1 ? 'data-from' : 'data-to';
    if (target) line.setAttribute(attr, ensureId(target) + '@' + anchor); else line.removeAttribute(attr);
    shapesToSync.add(line);
  }
  function linksOf(line) {
    var p = function (v) { if (!v) return null; var m = /^(.+)@(\w+)$/.exec(v); return m ? { id: m[1], anchor: m[2] } : null; };
    return { from: p(line.getAttribute('data-from')), to: p(line.getAttribute('data-to')) };
  }
  // after elements moved or resized: lines attached to them follow
  function updateConnectors(moved) {
    var ids = {};
    moved.forEach(function (e) { if (e.hasAttribute('data-id')) ids[e.getAttribute('data-id')] = e; });
    if (!Object.keys(ids).length) return;
    var fr = frameOf(curSection());
    Array.prototype.forEach.call(fr.querySelectorAll(':scope > .shp[data-shape="line"]'), function (line) {
      var L = linksOf(line), A = lineAbs(line), changed = false;
      if (L.from && ids[L.from.id]) { var p1 = anchorPos(ids[L.from.id], L.from.anchor); A[0] = p1.x; A[1] = p1.y; changed = true; }
      if (L.to && ids[L.to.id]) { var p2 = anchorPos(ids[L.to.id], L.to.anchor); A[2] = p2.x; A[3] = p2.y; changed = true; }
      if (changed) { setLineAbs(line, A[0], A[1], A[2], A[3]); shapesToSync.add(line); }
    });
  }
  function dropLinksTo(removed) {
    var fr = frameOf(curSection()), ids = removed.map(function (e) { return e.getAttribute && e.getAttribute('data-id'); }).filter(Boolean);
    if (!ids.length || !fr) return;
    Array.prototype.forEach.call(fr.querySelectorAll(':scope > .shp[data-line]'), function (line) {
      var L = linksOf(line);
      if (L.from && ids.indexOf(L.from.id) >= 0) { line.removeAttribute('data-from'); syncAttrs(line, ['data-from']); }
      if (L.to && ids.indexOf(L.to.id) >= 0) { line.removeAttribute('data-to'); syncAttrs(line, ['data-to']); }
    });
  }

  // ================================================================== filmstrip (slide thumbnails)
  var thumbTimer = null;
  function refreshThumbSoon() { clearTimeout(thumbTimer); thumbTimer = setTimeout(function () { if (curSection()) refreshThumb(curSection()); }, 350); }
  function thumbScale() { return (ui.film.clientWidth - 46) / slideSize().w; }
  function thumbClone(sec) {          // a static copy of the slide for the filmstrip
    var c = sec.cloneNode(true), S = slideSize();
    c.className = (sec.className || '').replace(/\b(present|past|future|stack)\b/g, '') + ' dk-tslide';
    c.removeAttribute('hidden'); c.removeAttribute('aria-hidden'); c.style.display = 'block'; c.removeAttribute('data-fitted');
    c.style.width = S.w + 'px'; c.style.height = S.h + 'px'; c.style.top = '0'; c.style.left = '0';
    c.querySelectorAll('aside.notes, script').forEach(function (n) { n.remove(); });
    c.querySelectorAll('[contenteditable]').forEach(function (n) { n.removeAttribute('contenteditable'); });
    c.querySelectorAll('iframe').forEach(function (f) {
      var d = document.createElement('div'); d.className = 'dk-tweb'; d.textContent = 'web page';
      d.setAttribute('style', f.getAttribute('style') || 'width:100%;height:100%');
      f.replaceWith(d);
    });
    c.querySelectorAll('video').forEach(function (v) {
      if (v.getAttribute('poster')) { var im = document.createElement('img'); im.src = v.getAttribute('poster'); im.setAttribute('style', v.getAttribute('style') || ''); im.style.objectFit = 'cover'; v.replaceWith(im); }
      else { v.removeAttribute('autoplay'); v.pause && v.pause(); v.preload = 'metadata'; }
    });
    c.querySelectorAll('img[data-src]:not([src])').forEach(function (m) { m.setAttribute('src', m.getAttribute('data-src')); });
    c.querySelectorAll('.fragment').forEach(function (f) { f.classList.add('visible'); });
    c.querySelectorAll('[id]').forEach(function (n) { n.removeAttribute('id'); });
    return c;
  }
  function makeThumb(sec, label, stacked) {
    var t = el('div', { 'class': 'dk-thumb' + (stacked ? ' dk-stacked' : '') + (sec.getAttribute('data-visibility') === 'hidden' ? ' dk-hidden' : '') });
    t.appendChild(el('div', { 'class': 'dk-num', text: label }));
    var fr = el('div', { 'class': 'dk-tframe' });
    var S = slideSize(), k = thumbScale();
    fr.style.height = Math.round(S.h * k) + 'px';
    var sc = el('div', { 'class': 'reveal dk-tscale' });
    sc.style.transform = 'scale(' + k + ')';
    sc.style.width = S.w + 'px'; sc.style.height = S.h + 'px';
    var slides = el('div', { 'class': 'slides' });
    slides.appendChild(thumbClone(sec));
    sc.appendChild(slides);
    fr.appendChild(sc);
    t.appendChild(fr);
    t.appendChild(el('div', { 'class': 'dk-teye', title: 'Hidden when presenting', text: '⊘' }));
    t._sec = sec;
    return t;
  }
  function buildFilm() {
    if (!ui.film) return;
    var list = ui.filmList;
    list.innerHTML = '';
    var n = 0;
    sections(liveRoot()).forEach(function (u) {
      if (u.hasAttribute('data-dk-master-edit')) return;
      if (isStack(u)) {
        var box = el('div', { 'class': 'dk-stack' });
        sections(u).forEach(function (s, v) { n++; box.appendChild(makeThumb(s, String(n), v > 0)); });
        list.appendChild(box);
      } else { n++; list.appendChild(makeThumb(u, String(n), false)); }
    });
    markCurrentThumb();
  }
  function thumbFor(sec) { return Array.prototype.filter.call(ui.filmList.querySelectorAll('.dk-thumb'), function (t) { return t._sec === sec; })[0]; }
  function refreshThumb(sec) {
    var t = thumbFor(sec);
    if (!t) { buildFilm(); return; }
    var slides = t.querySelector('.slides');
    slides.innerHTML = '';
    slides.appendChild(thumbClone(sec));
    t.classList.toggle('dk-hidden', sec.getAttribute('data-visibility') === 'hidden');
  }
  function refreshAllThumbs() { if (ui.film) buildFilm(); }
  function markCurrentThumb() {
    var cur = curSection();
    ui.filmList.querySelectorAll('.dk-thumb').forEach(function (t) { t.classList.toggle('dk-current', t._sec === cur); });
    var t = thumbFor(cur);
    if (t && t.scrollIntoView) { var r = t.getBoundingClientRect(), f = ui.film.getBoundingClientRect(); if (r.top < f.top || r.bottom > f.bottom) t.scrollIntoView({ block: 'nearest' }); }
  }
  function goTo(sec) {
    var i = Reveal.getIndices(sec);
    if (i) Reveal.slide(i.h, i.v);
  }
  // click: go there · drag: reorder · right-click: menu
  function onFilmDown(ev) {
    var t = ev.target.closest('.dk-thumb');
    if (!t) return;
    if (ev.button === 2) return;
    ev.preventDefault();
    if (editingEl) endTextEdit();
    goTo(t._sec);
    var y0 = ev.clientY, moved = false, line = ui.filmLine;
    var thumbs = Array.prototype.slice.call(ui.filmList.querySelectorAll('.dk-thumb'));
    var stacked = t.classList.contains('dk-stacked') || (t.parentElement.classList.contains('dk-stack'));
    var targetAt = null;
    var move = function (e) {
      if (!moved && Math.abs(e.clientY - y0) < 6) return;
      moved = true;
      t.classList.add('dk-dragging');
      // candidates: top-level slots (between units) and, inside the dragged slide's own stack, slots between its siblings
      var best = null;
      var consider = function (y, info) { var d = Math.abs(e.clientY - y); if (!best || d < best.d) best = { d: d, y: y, info: info }; };
      Array.prototype.forEach.call(ui.filmList.children, function (unit, k) {
        var r = unit.getBoundingClientRect();
        consider(r.top - 3, { h: k }); consider(r.bottom + 3, { h: k + 1 });
        if (unit.classList.contains('dk-stack') && unit.contains(t)) {
          Array.prototype.forEach.call(unit.children, function (th, v) {
            var rr = th.getBoundingClientRect();
            consider(rr.top - 3, { h: k, v: v, inStack: true }); consider(rr.bottom + 3, { h: k, v: v + 1, inStack: true });
          });
        }
      });
      targetAt = best ? best.info : null;
      if (best) { var fl = ui.filmList.getBoundingClientRect(); line.style.display = 'block'; line.style.top = (best.y - ui.film.getBoundingClientRect().top + ui.film.scrollTop) + 'px'; line.style.left = (targetAt.inStack ? 26 : 6) + 'px'; }
    };
    var up = function () {
      document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseup', up, true);
      line.style.display = 'none'; t.classList.remove('dk-dragging');
      if (moved && targetAt) dropSlide(t._sec, targetAt);
    };
    document.addEventListener('mousemove', move, true); document.addEventListener('mouseup', up, true);
  }
  // move the slide behind `sec` (live) to a filmstrip slot
  function dropSlide(liveSec, at) {
    var idx = Reveal.getIndices(liveSec), src = srcSlide(idx), unit = unitOf(srcRoot(), idx.h), stacked = isStack(unit);
    slideOp(function () {
      var units = sections(srcRoot());
      if (at.inStack) {                         // within its own stack
        var kids = sections(unit), cur = kids.indexOf(src), to = at.v;
        if (to === cur || to === cur + 1) return null;
        var ref = kids[to] || null;
        if (ref) unit.insertBefore(src, ref); else unit.appendChild(src);
        return { h: idx.h, v: sections(unit).indexOf(src) };
      }
      var moving = stacked ? src : unit;        // a stacked slide leaves its stack; a plain slide (or whole stack) moves
      if (!stacked && (at.h === idx.h || at.h === idx.h + 1)) return null;
      var ref = units[at.h] || null;
      if (ref === moving) return null;
      if (ref) srcRoot().insertBefore(moving, ref); else srcRoot().appendChild(moving);
      return { h: sections(srcRoot()).indexOf(moving), v: 0 };
    });
  }
  function onFilmMenu(ev) {
    var t = ev.target.closest('.dk-thumb');
    if (!t) return;
    ev.preventDefault();
    goTo(t._sec);
    var sec = t._sec, hidden = sec.getAttribute('data-visibility') === 'hidden';
    var items = [
      ['New slide after this one', function () { newSlideWithLayout(defaultNextLayout()); }],
      ['Duplicate slide', duplicateSlide],
      ['Delete slide', deleteSlide],
      '-',
      [hidden ? 'Show when presenting' : 'Hide when presenting', toggleHidden],
      '-',
      ['Nest under previous slide', nestUnderPrevious],
      ['Move out of stack', unnest]
    ];
    if (isDeck()) items.splice(4, 0, ['Layout…', function () { ui.layoutSel.focus(); ui.sideTabs.slide.click(); }]);
    popupMenu(ev.clientX, ev.clientY, items);
  }
  function popupMenu(x, y, items) {
    closePopup();
    var m = el('div', { 'class': 're-ui re-menu-list dk-popup' });
    items.forEach(function (it) {
      if (it === '-') { m.appendChild(el('hr')); return; }
      m.appendChild(btn(it[0], it[0], function () { closePopup(); it[1](); }));
    });
    m.style.display = 'block'; m.style.position = 'fixed'; m.style.left = x + 'px'; m.style.top = y + 'px';
    document.body.appendChild(m);
    ui.popup = m;
    var r = m.getBoundingClientRect();
    if (r.bottom > innerHeight) m.style.top = Math.max(0, innerHeight - r.height - 4) + 'px';
    if (r.right > innerWidth) m.style.left = Math.max(0, innerWidth - r.width - 4) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', closePopupOnOutside, true); }, 0);
  }
  function closePopupOnOutside(e) { if (ui.popup && !ui.popup.contains(e.target)) closePopup(); }
  function closePopup() { if (ui.popup) { ui.popup.remove(); ui.popup = null; } document.removeEventListener('mousedown', closePopupOnOutside, true); }
  function toggleHidden() {
    slideOp(function (idx) {
      var s = srcSlide(idx);
      if (s.getAttribute('data-visibility') === 'hidden') s.removeAttribute('data-visibility'); else s.setAttribute('data-visibility', 'hidden');
      return idx;
    });
    toast(curSection().getAttribute('data-visibility') === 'hidden' ? 'Hidden: skipped when presenting (still here to edit)' : 'Shown when presenting');
  }

  // ================================================================== side panel: slide settings, builds, notes
  function buildSidePanel() {
    var side = el('div', { 'class': 're-ui dk-side' });
    var tabs = el('div', { 'class': 'dk-tabs' });
    ui.sideTabs = {};
    ui.panels = {};
    [['slide', 'Slide'], ['builds', 'Builds']].forEach(function (t) {
      var b = btn(t[1], t[1], function () { showPanel(t[0]); });
      ui.sideTabs[t[0]] = b; tabs.appendChild(b);
      ui.panels[t[0]] = el('div', { 'class': 'dk-panel' });
    });
    side.appendChild(tabs);
    side.appendChild(ui.panels.slide); side.appendChild(ui.panels.builds);
    buildSlidePanel();
    var notes = el('div', { 'class': 'dk-notesbox' });
    notes.appendChild(el('div', { 'class': 're-notes-title', text: 'Speaker notes' }));
    ui.notes = el('textarea', { placeholder: 'Notes for this slide (shown in the presenter view)' });
    ui.notes.addEventListener('input', function () { clearTimeout(notesTimer); notesTimer = setTimeout(writeNotes, 400); });
    ui.notes.addEventListener('blur', function () { if (notesTimer) writeNotes(); notesSnap = false; });
    notes.appendChild(ui.notes);
    side.appendChild(notes);
    ui.side = side;
    document.body.appendChild(side);
    showPanel('slide');
  }
  function showPanel(name) {
    Object.keys(ui.panels).forEach(function (k) { ui.panels[k].style.display = k === name ? 'block' : 'none'; ui.sideTabs[k].classList.toggle('re-active', k === name); });
    if (name === 'builds') updateBuildsPanel();
  }
  function row(label, ctl) {
    var r = el('div', { 'class': 'dk-row' });
    r.appendChild(el('label', { text: label }));
    r.appendChild(ctl);
    return r;
  }
  function buildSlidePanel() {
    var p = ui.panels.slide;
    p.innerHTML = '';
    // the selected element's place and size
    var g4 = el('div', { 'class': 're-group re-fields dk-geo' });
    ['X', 'Y', 'W', 'H'].forEach(function (n) { g4.appendChild(field(n)); });
    var rl = el('label', { 'class': 're-field', title: 'Rotation (degrees)' });
    rl.appendChild(document.createTextNode('⟳'));
    ui.fRot = el('input', { type: 'number', step: '1' });
    ui.fRot.addEventListener('change', function () { if (sel && isPositioned(sel)) { snapshot(); setTransform(sel, parseFloat(ui.fRot.value) || 0, flipOf(sel)); touched.add(sel); flushTouched(); markDirty(); placeOverlay(); } });
    rl.appendChild(ui.fRot);
    g4.appendChild(rl);
    p.appendChild(row('Selection', g4));
    // pictures: opacity, rounded corners, shadow, crop reset, natural size
    ui.picOpts = el('div', { 'class': 'dk-opts' });
    ui.picOpacity = el('input', { type: 'range', min: '10', max: '100', step: '5', title: 'Opacity' });
    ui.picOpacity.addEventListener('input', function () { styleSel('opacity', ui.picOpacity.value === '100' ? '' : String(ui.picOpacity.value / 100), true); });
    ui.picOpacity.addEventListener('change', function () { styleSnap = false; });
    ui.picOpts.appendChild(labeledSmall('Opacity', ui.picOpacity));
    ui.picRadius = el('input', { type: 'number', min: '0', max: '400', step: '2', 'class': 'dk-in dk-short', title: 'Corner radius (px)' });
    ui.picRadius.addEventListener('change', function () { styleSel('border-radius', +ui.picRadius.value ? ui.picRadius.value + 'px' : ''); });
    ui.picOpts.appendChild(labeledSmall('Corners', ui.picRadius));
    ui.picShadow = el('input', { type: 'checkbox' });
    ui.picShadow.addEventListener('change', function () { styleSel('box-shadow', ui.picShadow.checked ? '0 10px 30px rgba(0,0,0,.45)' : ''); });
    var shl = el('label', { 'class': 're-radio' }); shl.appendChild(ui.picShadow); shl.appendChild(el('span', { text: 'Shadow' })); ui.picOpts.appendChild(shl);
    var pb = el('div', { 'class': 'dk-inline' });
    pb.appendChild(btn('Natural size', 'Resize the picture to its own pixel size', naturalSize, 'dk-small'));
    pb.appendChild(btn('Reset crop', 'Show the whole picture again', resetCrop, 'dk-small'));
    ui.picOpts.appendChild(pb);
    p.appendChild(ui.picOpts);
    // videos: how they play
    ui.vidOpts = el('div', { 'class': 'dk-opts' });
    ui.vidCks = {};
    [['data-autoplay', 'Starts by itself when the slide shows'], ['loop', 'Loops'], ['muted', 'Muted'], ['controls', 'Show player controls']].forEach(function (o) {
      var c = el('input', { type: 'checkbox' }), l = el('label', { 'class': 're-radio' });
      c.addEventListener('change', function () { videoAttr(o[0], c.checked); });
      l.appendChild(c); l.appendChild(el('span', { text: o[1] })); ui.vidOpts.appendChild(l); ui.vidCks[o[0]] = c;
    });
    p.appendChild(ui.vidOpts);
    p.appendChild(el('hr', { 'class': 'dk-hr' }));
    if (isDeck()) {
      ui.layoutSel = el('select', { 'class': 're-select' });
      LAYOUTS.forEach(function (L) { ui.layoutSel.appendChild(el('option', { value: L.id, text: L.name })); });
      ui.layoutSel.addEventListener('change', function () { setSlideLayout(ui.layoutSel.value); ui.layoutSel.blur(); });
      p.appendChild(row('Layout', ui.layoutSel));
    }
    var bgWrap = el('div', { 'class': 'dk-bg' });
    ui.bgKind = el('select', { 'class': 're-select' });
    [['theme', isDeck() ? 'Theme background' : 'None'], ['color', 'Colour'], ['image', 'Picture']].forEach(function (o) { ui.bgKind.appendChild(el('option', { value: o[0], text: o[1] })); });
    ui.bgColor = el('input', { type: 'color', 'class': 're-color', title: 'Background colour' });
    ui.bgPick = btn('Choose…', 'Choose a picture file', function () { pickFile(function (f) { setSlideBackground('image', null, f); }, 'image/*'); });
    ui.bgFit = el('select', { 'class': 're-select', title: 'How the picture fills the slide' });
    [['cover', 'Fill'], ['contain', 'Fit'], ['100% 100%', 'Stretch']].forEach(function (o) { ui.bgFit.appendChild(el('option', { value: o[0], text: o[1] })); });
    ui.bgKind.addEventListener('change', function () {
      var k = ui.bgKind.value;
      if (k === 'theme') setSlideBackground('theme');
      else if (k === 'color') setSlideBackground('color', ui.bgColor.value);
      else pickFile(function (f) { setSlideBackground('image', null, f); }, 'image/*');
      updateSlidePanel();
    });
    ui.bgColor.addEventListener('input', function () { setSlideBackground('color', ui.bgColor.value, null, true); });
    ui.bgColor.addEventListener('change', function () { styleSnap = false; });
    ui.bgFit.addEventListener('change', function () { setSlideBackground('fit', ui.bgFit.value); });
    ui.bgScope = el('select', { 'class': 're-select', title: 'Which slides get this background' });
    [['this', 'This slide only'], ['all', 'Every slide']].forEach(function (o) { ui.bgScope.appendChild(el('option', { value: o[0], text: o[1] })); });
    ui.bgScope.addEventListener('change', function () { if (ui.bgScope.value === 'all') bgToTheme(); });
    bgWrap.appendChild(ui.bgKind); bgWrap.appendChild(ui.bgColor); bgWrap.appendChild(ui.bgPick); bgWrap.appendChild(ui.bgFit); bgWrap.appendChild(ui.bgScope);
    p.appendChild(row('Background', bgWrap));
    ui.bgAll = btn('Use on every slide', 'Make this the background of every slide (the theme background)', function () { bgToTheme(); });
    ui.bgAll.classList.add('dk-small');
    p.appendChild(row('', ui.bgAll));
    ui.transSel = el('select', { 'class': 're-select' });
    [['', 'Presentation default'], ['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide'], ['convex', 'Convex'], ['concave', 'Concave'], ['zoom', 'Zoom']].forEach(function (o) { ui.transSel.appendChild(el('option', { value: o[0], text: o[1] })); });
    ui.transSel.addEventListener('change', function () { setSlideAttr('data-transition', ui.transSel.value || null); ui.transSel.blur(); });
    p.appendChild(row('Transition', ui.transSel));
    var flags = el('div', { 'class': 'dk-flags' });
    ui.hiddenCk = el('input', { type: 'checkbox' });
    ui.hiddenCk.addEventListener('change', toggleHidden);
    var l1 = el('label', { 'class': 're-radio' }); l1.appendChild(ui.hiddenCk); l1.appendChild(el('span', { text: 'Hidden when presenting' })); flags.appendChild(l1);
    if (isDeck()) {
      ui.noMasterCk = el('input', { type: 'checkbox' });
      ui.noMasterCk.addEventListener('change', function () { setSlideAttr('data-dk-nomaster', ui.noMasterCk.checked ? '' : null); stampMaster(); });
      var l2 = el('label', { 'class': 're-radio' }); l2.appendChild(ui.noMasterCk); l2.appendChild(el('span', { text: 'Without footer / number / logo' })); flags.appendChild(l2);
    }
    p.appendChild(flags);
  }
  function setSlideAttr(name, value) {
    slideOp(function (idx) {
      var s = srcSlide(idx);
      if (value === null) s.removeAttribute(name); else s.setAttribute(name, value);
      return idx;
    });
  }
  function slideBg() {                 // what the current slide's frame says about its background
    var fr = frameOf(curSection()), st = fr.getAttribute('style') || '';
    var img = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(st), col = /background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/.exec(st);
    var size = /\/\s*(cover|contain|100% 100%)/.exec(st);
    if (img) return { kind: 'image', url: img[1], color: col ? col[1] : '#000000', fit: size ? size[1] : 'cover' };
    if (col) return { kind: 'color', color: col[1] };
    return { kind: 'theme' };
  }
  function setSlideBackground(kind, value, file, continuous) {
    var live = frameOf(curSection()), src = frameOf(srcSlide(Reveal.getIndices()));
    if (live === curSection()) return toast('This slide has no frame to paint — only decks with absolute layout have backgrounds here');
    var apply = function (css) {
      [live, src].forEach(function (f) { if (css) f.style.background = css; else { f.style.removeProperty('background'); f.style.removeProperty('background-color'); f.style.removeProperty('background-image'); } });
      syncStyle(live); markDirty(); refreshThumbSoon(); updateSlidePanel();
      if (css && ui.bgScope && ui.bgScope.value === 'all' && !continuous) bgToTheme();
    };
    var cur = slideBg();
    if (kind === 'theme') { snapshot(); apply(''); return; }
    if (kind === 'color') { if (!styleSnap && !continuous) snapshot(); else if (!styleSnap) { snapshot(); styleSnap = true; } apply(value); return; }
    if (kind === 'fit') { if (cur.kind !== 'image') return; snapshot(); apply(cur.color + " url('" + cur.url + "') center / " + value + ' no-repeat'); return; }
    if (kind === 'image' && file) {
      upload(file).then(function (url) { snapshot(); apply((cur.color || '#000000') + " url('" + url + "') center / " + (ui.bgFit.value || 'cover') + ' no-repeat'); })
        .catch(function (e) { toast('Could not use the picture: ' + e.message, 6000); });
    }
  }
  function bgToTheme() {
    var cur = slideBg();
    snapshot();
    if (!META) {      // no theme to carry it: paint the same background onto every slide's frame
      var css = frameOf(curSection()).style.background, all = sections(srcRoot()).reduce(function (a, u) { return a.concat(isStack(u) ? sections(u) : [u]); }, []);
      all.forEach(function (s) { var f = frameOf(s); if (f !== s) { if (css) f.style.background = css; else { f.style.removeProperty('background'); f.style.removeProperty('background-color'); f.style.removeProperty('background-image'); } } });
      rebuildLive(Reveal.getIndices());
      if (ui.bgScope) ui.bgScope.value = 'all';
      toast('Every slide now has this background');
      return;
    }
    if (cur.kind === 'image') { META.theme.bg = cur.url; META.theme.bgFit = { cover: 'cover', contain: 'contain', '100% 100%': 'stretch' }[cur.fit] || 'cover'; META.theme.page = toHex(cur.color) || cur.color; }
    else if (cur.kind === 'color') { META.theme.bg = ''; META.theme.page = toHex(cur.color) || cur.color; }
    else { META.theme.bg = ''; }
    // slides that only had this very background drop it (the theme now paints it)
    var secs = sections(srcRoot()).reduce(function (a, u) { return a.concat(isStack(u) ? sections(u) : [u]); }, []);
    secs.forEach(function (s) { var f = frameOf(s); if (f !== s) { f.style.removeProperty('background'); f.style.removeProperty('background-color'); f.style.removeProperty('background-image'); if (!f.getAttribute('style')) f.removeAttribute('style'); } });
    applyTheme();
    rebuildLive(Reveal.getIndices());
    if (ui.bgScope) ui.bgScope.value = 'all';
    toast('Every slide now has this background');
  }
  function updateSlidePanel() {
    var sec = curSection();
    if (!sec || !ui.bgKind) return;
    if (ui.layoutSel) ui.layoutSel.value = sec.getAttribute('data-dk-layout') || '';
    var bg = slideBg();
    ui.bgKind.value = bg.kind;
    ui.bgColor.style.display = bg.kind === 'color' || bg.kind === 'image' ? '' : 'none';
    ui.bgPick.style.display = bg.kind === 'image' ? '' : 'none';
    ui.bgFit.style.display = bg.kind === 'image' ? '' : 'none';
    if (bg.color) ui.bgColor.value = toHex(bg.color) || '#000000';
    if (bg.fit) ui.bgFit.value = bg.fit;
    ui.bgAll.style.display = bg.kind !== 'theme' ? '' : 'none';
    if (bg.kind === 'theme' && isDeck()) ui.bgScope.value = 'all'; else if (ui.bgScope.value === 'all' && bg.kind !== 'theme' && isDeck()) ui.bgScope.value = 'this';
    ui.transSel.value = sec.getAttribute('data-transition') || '';
    ui.hiddenCk.checked = sec.getAttribute('data-visibility') === 'hidden';
    if (ui.noMasterCk) ui.noMasterCk.checked = sec.hasAttribute('data-dk-nomaster');
  }

  // ---- builds: the click steps of this slide, in order
  var BUILD_KINDS = [['appear', 'Appear'], ['fade-in', 'Fade in'], ['fade-up', 'Fade up'], ['fade-down', 'Fade down'], ['fade-left', 'Fade from right'], ['fade-right', 'Fade from left'],
                     ['grow', 'Grow'], ['shrink', 'Shrink'], ['highlight-red', 'Highlight red'], ['highlight-green', 'Highlight green'], ['highlight-blue', 'Highlight blue'],
                     ['strike', 'Strike through'], ['semi-fade-out', 'Dim'], ['fade-out', 'Disappear'], ['fade-in-then-out', 'Appear then disappear']];
  var BUILD_CLASSES = BUILD_KINDS.map(function (k) { return k[0]; }).concat(['current-visible', 'fade-in-then-semi-out', 'highlight-current-red', 'highlight-current-green', 'highlight-current-blue']);
  function buildKind(e) { for (var i = 0; i < BUILD_CLASSES.length; i++) if (e.classList.contains(BUILD_CLASSES[i])) return BUILD_CLASSES[i]; return 'fade-in'; }
  function describe(e) {
    if (e.querySelector('video')) return 'Video';
    if (e.querySelector('iframe')) return 'Web page';
    if (e.querySelector('img') || e.tagName === 'IMG') return 'Picture';
    var t = (e.innerText || '').trim().replace(/\s+/g, ' ');
    if (t) return '“' + (t.length > 28 ? t.slice(0, 27) + '…' : t) + '”';
    if (isShp(e)) return { line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse' }[e.getAttribute('data-shape')] || 'Shape';
    return e.classList.contains('g') ? 'Group' : 'Element';
  }
  function buildItems() {              // live fragments of the current slide grouped by index, in order
    var fr = frameOf(curSection()), items = Array.prototype.slice.call(fr.querySelectorAll('.fragment')).filter(function (f) { return !f.classList.contains('media-trigger'); });
    items.sort(function (a, b) { return (parseInt(a.getAttribute('data-fragment-index'), 10) || 0) - (parseInt(b.getAttribute('data-fragment-index'), 10) || 0); });
    return items;
  }
  function renumberBuilds(items) {     // compact indices 1..n, elements that share an index keep sharing
    var k = 0, last = null;
    items.forEach(function (f) {
      var idx = f.getAttribute('data-fragment-index');
      if (idx !== last) { k++; last = idx; }
      f.setAttribute('data-fragment-index', String(k));
      var s = srcOf(f); if (s) s.setAttribute('data-fragment-index', String(k));
    });
  }
  function updateBuildsPanel() {
    var p = ui.panels.builds;
    if (!p || p.style.display === 'none') return;
    p.innerHTML = '';
    var items = buildItems();
    if (!items.length) { p.appendChild(el('p', { 'class': 're-dim', text: 'No builds on this slide. Select an element and press Build to make it appear on a click.' })); return; }
    p.appendChild(el('p', { 'class': 're-dim', text: 'Click steps, in order. "With previous" shows an element together with the one above it.' }));
    var prevIdx = null;
    items.forEach(function (f, i) {
      var idx = f.getAttribute('data-fragment-index');
      var r = el('div', { 'class': 'dk-build' + (selList().indexOf(f) >= 0 ? ' dk-current' : '') });
      var num = el('span', { 'class': 'dk-bnum', text: idx === prevIdx ? '' : idx });
      var name = btn(esc(describe(f)), 'Select this element', function () { select(f); updateBuildsPanel(); });
      name.classList.add('dk-bname');
      var kind = el('select', { 'class': 're-select dk-bkind' });
      BUILD_KINDS.forEach(function (k) { kind.appendChild(el('option', { value: k[0], text: k[1] })); });
      kind.value = buildKind(f);
      kind.addEventListener('change', function () { setBuildKind(f, kind.value); });
      var withPrev = el('input', { type: 'checkbox', title: 'With previous: appears together with the step above' });
      withPrev.checked = idx === prevIdx; withPrev.disabled = i === 0;
      withPrev.addEventListener('change', function () { setWithPrevious(f, withPrev.checked); });
      var up = btn('↑', 'Earlier', function () { moveBuild(f, -1); }), down = btn('↓', 'Later', function () { moveBuild(f, 1); });
      var rm = btn('×', 'Remove this build (the element stays, always visible)', function () { snapshot(); [f, srcOf(f)].forEach(function (x) { if (x) { x.classList.remove.apply(x.classList, ['fragment'].concat(BUILD_CLASSES)); x.removeAttribute('data-fragment-index'); } }); renumberBuilds(buildItems()); updateBuildsPanel(); placeOverlay(); updateFields(); });
      r.appendChild(num); r.appendChild(name); r.appendChild(kind);
      var wp = el('label', { 'class': 'dk-withprev', title: 'With previous' }); wp.appendChild(withPrev); wp.appendChild(el('span', { text: 'with prev.' }));
      r.appendChild(wp); r.appendChild(up); r.appendChild(down); r.appendChild(rm);
      p.appendChild(r);
      prevIdx = idx;
    });
  }
  function setBuildKind(f, kind) {
    snapshot();
    [f, srcOf(f)].forEach(function (x) { if (!x) return; BUILD_CLASSES.forEach(function (c) { x.classList.remove(c); }); x.classList.add('fragment', kind); });
    f.classList.add('visible');
    updateBuildsPanel();
  }
  function setWithPrevious(f, on) {
    var items = buildItems(), i = items.indexOf(f);
    if (i <= 0) return;
    snapshot();
    var prev = items[i - 1].getAttribute('data-fragment-index');
    if (on) { f.setAttribute('data-fragment-index', prev); var s = srcOf(f); if (s) s.setAttribute('data-fragment-index', prev); }
    else {   // give it (and everything after) its own step
      var k = parseInt(prev, 10) + 1;
      items.slice(i).forEach(function (g, j) {
        var same = j > 0 && g.getAttribute('data-fragment-index') === items[i + j - 1].getAttribute('data-fragment-index') && g !== f;
        if (!same) k = j === 0 ? k : k + 1;
        g.setAttribute('data-fragment-index', String(k)); var s2 = srcOf(g); if (s2) s2.setAttribute('data-fragment-index', String(k));
      });
    }
    renumberBuilds(buildItems()); updateBuildsPanel(); placeOverlay();
  }
  function moveBuild(f, d) {
    var items = buildItems(), i = items.indexOf(f), j = i + d;
    if (j < 0 || j >= items.length) return;
    snapshot();
    var a = f.getAttribute('data-fragment-index'), b = items[j].getAttribute('data-fragment-index');
    if (a === b) {        // leave the shared step: become its own step before / after
      var k = parseInt(a, 10) + (d > 0 ? 0.5 : -0.5);
      f.setAttribute('data-fragment-index', String(k)); var s = srcOf(f); if (s) s.setAttribute('data-fragment-index', String(k));
    } else {
      f.setAttribute('data-fragment-index', b); items[j].setAttribute('data-fragment-index', a);
      var s1 = srcOf(f), s2 = srcOf(items[j]); if (s1) s1.setAttribute('data-fragment-index', b); if (s2) s2.setAttribute('data-fragment-index', a);
    }
    var all = buildItems();
    all.sort(function (x, y) { return parseFloat(x.getAttribute('data-fragment-index')) - parseFloat(y.getAttribute('data-fragment-index')); });
    renumberBuilds(all); updateBuildsPanel(); placeOverlay();
  }

  function labeledSmall(text, ctl) { var l = el('label', { 'class': 'dk-field dk-fsmall' }); l.appendChild(el('span', { text: text })); l.appendChild(ctl); return l; }
  function styleSel(prop, value, continuous) {
    var list = selList().filter(isPositioned);
    if (!list.length) return;
    if (!continuous) { snapshot(); styleSnap = false; } else if (!styleSnap) { snapshot(); styleSnap = true; }
    list.forEach(function (e) { if (value) e.style.setProperty(prop, value); else e.style.removeProperty(prop); syncStyle(e); });
    markDirty(); placeOverlay();
  }
  function naturalSize() {
    var pic = isPic(sel) ? sel : null;
    if (!pic) return toast('Select a picture first');
    var img = picImg(pic);
    if (!img.naturalWidth) return toast('The picture has not loaded yet');
    snapshot();
    var W = imgWorld(pic), k = img.naturalWidth / W.w;     // keep the crop window, scale everything to 1:1 pixels
    var b = boxOf(pic);
    pic.style.width = px(b.w * k); pic.style.height = px(b.h * k);
    syncWhole(pic); markDirty(); placeOverlay(); updateFields();
  }
  function videoAttr(name, on) {
    var vids = selList().map(function (e) { return e.tagName === 'VIDEO' ? e : e.querySelector('video'); }).filter(Boolean);
    if (!vids.length) return;
    snapshot();
    vids.forEach(function (v) {
      if (on) v.setAttribute(name, ''); else v.removeAttribute(name);
      if (name === 'muted') v.muted = on;
      syncAttrs(v, [name]);
    });
    markDirty();
  }
  function updateMediaOpts() {
    if (!ui.picOpts) return;
    var one = sel && !isMulti() ? sel : null;
    var pic = one && isPic(one), vid = one && (one.tagName === 'VIDEO' || one.querySelector('video'));
    ui.picOpts.style.display = pic ? 'block' : 'none';
    ui.vidOpts.style.display = vid ? 'block' : 'none';
    if (pic) {
      ui.picOpacity.value = String(Math.round((parseFloat(one.style.opacity) || 1) * 100));
      ui.picRadius.value = String(parseInt(one.style.borderRadius, 10) || 0);
      ui.picShadow.checked = !!one.style.boxShadow;
    }
    if (vid) { var v = one.tagName === 'VIDEO' ? one : one.querySelector('video'); Object.keys(ui.vidCks).forEach(function (k) { ui.vidCks[k].checked = v.hasAttribute(k); }); }
  }

  // one-step animations: the selection appears or disappears on a click (or the right arrow)
  function buildAs(kind) {
    var list = selList().filter(function (e) { return srcOf(e); });
    if (!list.length) return toast('Select an element first');
    snapshot();
    var sec = srcOf(list[0]).closest('section'), max = 0;
    sec.querySelectorAll('.fragment[data-fragment-index]').forEach(function (f) { max = Math.max(max, parseInt(f.getAttribute('data-fragment-index'), 10) || 0); });
    var k = String(max + 1);
    list.forEach(function (e) {
      var pair = [e, srcOf(e)];
      pair.forEach(function (x) { BUILD_CLASSES.forEach(function (c) { x.classList.remove(c); }); x.classList.add('fragment', kind); if (!x.getAttribute('data-fragment-index') || !e.classList.contains('fragment')) x.setAttribute('data-fragment-index', k); });
      e.classList.add('visible');
    });
    renumberBuilds(buildItems());
    placeOverlay(); updateFields(); updateBuildsPanel();
    var what = list.length > 1 ? 'These ' + list.length + ' elements ' : 'It ';
    toast(what + ({ 'appear': 'appears', 'fade-in': 'fades in', 'fade-out': 'disappears', 'fade-in-then-out': 'appears, then disappears on the next click', 'grow': 'grows', 'highlight-red': 'is highlighted' }[kind] || 'builds') + ' on a click (or →) when presenting — order and kind in the Builds panel', 4500);
  }

  // ================================================================== the editor chrome
  var SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96];
  function layoutIcon(L) {
    var W = 32, H = 18, out = '<svg viewBox="0 0 32 18" aria-hidden="true"><rect x=".5" y=".5" width="31" height="17" rx="1.5" fill="none" stroke="currentColor" stroke-opacity=".5"/>';
    L.boxes.forEach(function (b) {
      out += '<rect x="' + (b.x * W).toFixed(1) + '" y="' + (b.y * H).toFixed(1) + '" width="' + (b.w * W).toFixed(1) + '" height="' + (b.h * H).toFixed(1) + '" rx=".6" fill="currentColor" fill-opacity="' + (b.kind === 'title' ? '.9' : b.kind === 'picture' ? '.25' : '.45') + '"/>';
    });
    return out + '</svg>';
  }
  function slideMenu() {
    var wrap = el('div', { 'class': 're-menu re-menu-left' });
    var b = btn('+ Slide ▾', 'New slide after this one — pick a layout (⇧⌘N: same layout as this slide)', function () { wrap.classList.toggle('re-open'); });
    wrap.appendChild(b);
    var list = el('div', { 'class': 're-menu-list dk-layouts' });
    if (isDeck()) {
      LAYOUTS.forEach(function (L) {
        var it = btn(layoutIcon(L) + '<span>' + esc(L.name) + '</span>', L.name, function () { wrap.classList.remove('re-open'); newSlideWithLayout(L.id); });
        it.classList.add('dk-layout');
        list.appendChild(it);
      });
      list.appendChild(el('hr'));
    }
    list.appendChild(btn('Duplicate this slide', 'Duplicate slide', function () { wrap.classList.remove('re-open'); duplicateSlide(); }));
    if (!isDeck()) list.insertBefore(btn('New empty slide', 'New slide after this one', function () { wrap.classList.remove('re-open'); newSlide(); }), list.firstChild);
    wrap.appendChild(list);
    document.addEventListener('mousedown', function (ev) { if (!wrap.contains(ev.target)) wrap.classList.remove('re-open'); }, true);
    return wrap;
  }
  function addVideo() { pickFile(function (f) { addMedia(f); }, 'video/*,audio/*'); }
  function addWebPage() {
    var what = prompt('Web page to embed: a web address (https://…), or the name of an HTML file in this presentation’s folder (for example media/plot.html).\n\nTo embed a file from elsewhere, press Cancel and use + Web page › choose a file.', 'https://');
    if (what === null) return;
    what = what.trim();
    if (!what || what === 'https://') return pickFile(function (f) { upload(f).then(function (url) { insertEmbed(url); }).catch(function (e) { toast(e.message, 5000); }); }, '.html,.htm,text/html');
    insertEmbed(what);
  }
  function insertEmbed(url) {
    var S = slideSize(), w = Math.round(S.w * 0.8), h = Math.round(S.h * 0.75), x = Math.round((S.w - w) / 2), y = Math.round((S.h - h) / 2 + 20);
    var n = insertItem('<div class="e embed" style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;"><iframe data-src="' + esc(url) + '" title="embedded page" allowfullscreen style="width:100%;height:100%;"></iframe></div>');
    if (n) toast('Web page added — it is live when presenting; here it is just a picture of itself', 4000);
  }
  function arrangeMenu() {
    return menu('Arrange', 'Group, align, distribute, order, flip', [
      ['Group', groupSel, '⌘G'], ['Ungroup', ungroupSel, '⇧⌘G'], '-',
      ['Align left', function () { alignSel('left'); }], ['Align centre', function () { alignSel('center'); }], ['Align right', function () { alignSel('right'); }],
      ['Align top', function () { alignSel('top'); }], ['Align middle', function () { alignSel('middle'); }], ['Align bottom', function () { alignSel('bottom'); }], '-',
      ['Distribute horizontally', function () { distributeSel('h'); }], ['Distribute vertically', function () { distributeSel('v'); }],
      ['Same width', function () { sameSize('w'); }], ['Same height', function () { sameSize('h'); }], ['Same size', function () { sameSize('both'); }], '-',
      ['Bring to front', function () { zorder(1, true); }, '⇧]'], ['Bring forward', function () { zorder(1, false); }, ']'],
      ['Send backward', function () { zorder(-1, false); }, '['], ['Send to back', function () { zorder(-1, true); }, '⇧['], '-',
      ['Rotate 90° right', function () { rotateSel(90); }], ['Rotate 90° left', function () { rotateSel(-90); }], ['No rotation', function () { rotateSel(-rotOf(sel || document.body)); }],
      ['Flip horizontal', function () { flipSel('h'); }], ['Flip vertical', function () { flipSel('v'); }], '-',
      ['Copy style', copyStyle, '⌥⌘C'], ['Paste style', pasteStyle, '⌥⌘V']
    ]);
  }
  function deckMenu() {
    var items = [
      ['New presentation…', newDeckDialog, '⌘N'],
      ['Open…', openOther, '⌘O'],
      ['Save', function () { save(false); }, '⌘S'],
      ['Save as PDF…', pdfDialog],
      ['This slide as PNG', function () { exportPng(false); }],
      ['All slides as PNGs', function () { exportPng(true); }],
      ['Single-file HTML (everything embedded)', exportSingle],
      ['Zip the presentation folder', exportZip],
      '-',
      ['Import a PowerPoint file…', importPptx],
      ['Find and replace…', findDialog, '⌘F'],
      '-',
      ['Presentation settings…', settingsDialog],
      ['Edit master (footer, number, logo)', enterMaster]
    ];
    if (!isDeck()) items.push(['Add deck theme & master to this presentation', adoptDeck], ['Renumber slide-number boxes…', renumberDialog], ['Navigation arrows…', arrowsDialog]);
    items.push('-', ['Keyboard shortcuts', toggleHelp, '?']);
    var m = menu('Deck', 'Presentation', items);
    m.classList.add('re-menu-left');
    return m;
  }
  function presentMenu() {
    var wrap = menu('Present', 'Show the presentation', [
      ['From this slide', function () { present(false, false); }, '⌘⏎'],
      ['From the beginning', function () { present(false, true); }, '⇧⌘⏎'],
      ['With presenter view (notes, timer, next slide)', function () { present(true, false); }],
      '-',
      ['Preview in a tab', function () { var i = Reveal.getIndices(); window.open('/' + encodeURI(FILE) + '#/' + i.h + (i.v ? '/' + i.v : ''), '_blank'); }]
    ]);
    wrap.firstChild.classList.add('dk-present');
    return wrap;
  }
  function buildUI() {
    var bar = el('div', { 'class': 're-ui re-bar dk-top' });
    var row1 = el('div', { 'class': 're-row' }), row2 = el('div', { 'class': 're-row dk-format' });
    bar.appendChild(row1); bar.appendChild(row2);

    var g1 = group();
    g1.appendChild(deckMenu());
    ui.where = el('span', { 'class': 're-where' });
    g1.appendChild(ui.where);
    row1.appendChild(g1);

    var g2 = group();
    g2.appendChild(slideMenu());
    g2.appendChild(btn('+ Text', 'Add a text box', addText));
    g2.appendChild(shapeMenu());
    g2.appendChild(btn('+ Picture', 'Add a picture (or drop / paste one onto the slide)', function () { pickFile(function (f) { addMedia(f); }, 'image/*'); }));
    g2.appendChild(btn('+ Video', 'Add a video or sound', addVideo));
    g2.appendChild(btn('+ Web page', 'Embed a web page or an HTML file (live when presenting)', addWebPage));
    var tm = menu('+ Table', 'Tables', [
      ['Insert table…', addTable], '-',
      ['Row above', function () { tableRow(-1); }], ['Row below', function () { tableRow(1); }],
      ['Column left', function () { tableCol(-1); }], ['Column right', function () { tableCol(1); }], '-',
      ['Delete row', tableDelRow], ['Delete column', tableDelCol], '-',
      ['Header row on / off', tableHeader]
    ]);
    tm.classList.add('re-menu-left');
    g2.appendChild(tm);
    g2.appendChild(btn('Σ', 'Insert an equation (LaTeX)', function () { equationDialog(null); }));
    g2.appendChild(btn('Link', 'Link the selection to a web address or a slide (⌘K)', linkDialog));
    row1.appendChild(g2);

    var g3 = group('re-need-sel');
    g3.appendChild(arrangeMenu());
    var bm = menu('Build', 'Make the selection appear or disappear on a click (or →) when presenting', [
      ['Appear on click', function () { buildAs('appear'); }],
      ['Fade in on click', function () { buildAs('fade-in'); }],
      ['Disappear on click', function () { buildAs('fade-out'); }],
      ['Appear, then disappear on the next click', function () { buildAs('fade-in-then-out'); }],
      ['Grow on click', function () { buildAs('grow'); }],
      ['Highlight on click', function () { buildAs('highlight-red'); }],
      '-',
      ['Remove build (always visible)', function () { if (sel && selList().every(function (e) { return e.classList.contains('fragment'); })) { toggleBuild(); updateBuildsPanel(); } else toast('The selection has no build'); }],
      ['Order and kinds… (Builds panel)', function () { if (ui.side.classList.contains('dk-off')) { ui.side.classList.remove('dk-off'); layoutChrome(); } showPanel('builds'); }]
    ]);
    ui.build = bm.firstChild;
    g3.appendChild(bm);
    ui.cropBtn = btn('Crop', 'Crop the selected picture (Enter / Esc when done)', function () { if (cropMode) exitCrop(); else enterCrop(); });
    g3.appendChild(ui.cropBtn);
    g3.appendChild(btn('Duplicate', 'Duplicate (⌘D)', duplicateSel));
    g3.appendChild(btn('Delete', 'Delete (⌫)', deleteSel));
    row1.appendChild(g3);

    var g6 = group('re-right');
    g6.appendChild(btn('↶', 'Undo (⌘Z)', doUndo));
    g6.appendChild(btn('↷', 'Redo (⇧⌘Z)', doRedo));
    ui.sideBtn = btn('Panel', 'Show / hide the side panel (slide settings, builds, notes)', function () { ui.side.classList.toggle('dk-off'); layoutChrome(); });
    g6.appendChild(ui.sideBtn);
    g6.appendChild(btn('?', 'Keyboard shortcuts', toggleHelp));
    g6.appendChild(presentMenu());
    ui.save = btn('Saved', 'Save (⌘S)', function () { save(false); }, 're-save');
    g6.appendChild(ui.save);
    row1.appendChild(g6);

    // ---- row 2: text
    var g5 = group('re-text dk-text');
    ui.fontSel = el('select', { 'class': 're-select dk-font', title: 'Font' });
    Object.keys(FONTS).forEach(function (k) { ui.fontSel.appendChild(el('option', { value: FONTS[k], text: k })); });
    ['Arial', 'Helvetica Neue', 'Verdana', 'Trebuchet MS', 'Gill Sans', 'Avenir Next', 'Futura', 'Palatino', 'Baskerville', 'Courier New', 'Monaco'].forEach(function (k) { ui.fontSel.appendChild(el('option', { value: "'" + k + "'", text: k })); });
    ui.fontSel.addEventListener('mousedown', function () { if (editingEl) saveRange(); });
    ui.fontSel.addEventListener('change', function () { restoreRange(); setFontFamily(ui.fontSel.value); ui.fontSel.blur(); });
    g5.appendChild(ui.fontSel);
    ui.sizeIn = el('input', { type: 'number', 'class': 'dk-size', title: 'Text size (px)', min: '4', max: '400', step: '1', list: 'dk-sizes' });
    var dl = el('datalist', { id: 'dk-sizes' }); SIZES.forEach(function (s) { dl.appendChild(el('option', { value: String(s) })); }); document.body.appendChild(dl);
    ui.sizeIn.addEventListener('mousedown', function () { if (editingEl) saveRange(); });
    ui.sizeIn.addEventListener('focus', function () { if (editingEl && !savedRange) saveRange(); });
    ui.sizeIn.addEventListener('change', function () { restoreRange(); var v = parseFloat(ui.sizeIn.value); if (isFinite(v)) setFontSize(v); });
    ui.sizeIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ui.sizeIn.blur(); } });
    g5.appendChild(ui.sizeIn);
    g5.appendChild(btn('A−', 'Smaller text', function () { scaleFont(1 / 1.1); }));
    g5.appendChild(btn('A+', 'Larger text', function () { scaleFont(1.1); }));
    ui.boldBtn = btn('<b>B</b>', 'Bold (⌘B)', function () { toggleInline('bold'); }); g5.appendChild(ui.boldBtn);
    ui.italBtn = btn('<i>I</i>', 'Italic (⌘I)', function () { toggleInline('italic'); }); g5.appendChild(ui.italBtn);
    ui.undBtn = btn('<u>U</u>', 'Underline (⌘U)', function () { toggleInline('underline'); }); g5.appendChild(ui.undBtn);
    ui.textColor = el('input', { type: 'color', title: 'Text colour (the selected words while editing, else the whole box)', 'class': 're-color', value: '#ffffff' });
    ui.textColor.addEventListener('mousedown', function () { saveRange(); });
    ui.textColor.addEventListener('input', function () { restoreRange(); setTextColor(ui.textColor.value); });
    g5.appendChild(ui.textColor);
    ui.bulBtn = btn('•≡', 'Bullets', function () { toggleBullets('dot'); }); g5.appendChild(ui.bulBtn);
    ui.numBtn = btn('1≡', 'Numbered list', function () { toggleBullets('num'); }); g5.appendChild(ui.numBtn);
    g5.appendChild(btn('⇤', 'Less indent (⇧Tab)', function () { indentParas(-1); }));
    g5.appendChild(btn('⇥', 'More indent (Tab)', function () { indentParas(1); }));
    ui.alL = btn('⟸', 'Align left (⌘L)', function () { setParaAlign('left'); }); g5.appendChild(ui.alL);
    ui.alC = btn('⟺', 'Centre (⌘E)', function () { setParaAlign('center'); }); g5.appendChild(ui.alC);
    ui.alR = btn('⟹', 'Align right (⌘R)', function () { setParaAlign('right'); }); g5.appendChild(ui.alR);
    ui.anchorSel = el('select', { 'class': 're-select', title: 'Where the text sits in its box' });
    [['flex-start', 'Top'], ['center', 'Middle'], ['flex-end', 'Bottom']].forEach(function (o) { ui.anchorSel.appendChild(el('option', { value: o[0], text: o[1] })); });
    ui.anchorSel.addEventListener('change', function () { setAnchor(ui.anchorSel.value); ui.anchorSel.blur(); });
    g5.appendChild(ui.anchorSel);
    ui.lhSel = el('select', { 'class': 're-select', title: 'Line spacing' });
    [['1', '1.0'], ['1.1', '1.1'], ['1.2', '1.2'], ['1.3', '1.3'], ['1.5', '1.5'], ['2', '2.0']].forEach(function (o) { ui.lhSel.appendChild(el('option', { value: o[0], text: '↕ ' + o[1] })); });
    ui.lhSel.addEventListener('change', function () { setLineSpacing(ui.lhSel.value); ui.lhSel.blur(); });
    g5.appendChild(ui.lhSel);
    ui.fitBtn = btn('Fit', 'Shrink text to fit the box (toggle)', toggleAutofit); g5.appendChild(ui.fitBtn);
    row2.appendChild(g5);

    var g7 = group('re-style');
    g7.appendChild(el('span', { 'class': 're-lab', text: 'Fill' }));
    ui.fill = colorCtl('Fill colour', 'fill'); g7.appendChild(ui.fill);
    ui.noFill = btn('∅', 'No fill', function () { applyStyle('fill', 'none'); }, 're-none'); g7.appendChild(ui.noFill);
    g7.appendChild(el('span', { 'class': 're-lab', text: 'Line' }));
    ui.stroke = colorCtl('Line colour', 'stroke'); g7.appendChild(ui.stroke);
    ui.noLine = btn('∅', 'No line', function () { applyStyle('stroke', 'none'); }, 're-none'); g7.appendChild(ui.noLine);
    ui.sw = selectCtl('Line width', [1, 1.5, 2, 3, 4, 6, 8, 12].map(function (v) { return [String(v), v + ' px']; }), 'sw'); g7.appendChild(ui.sw);
    ui.dash = selectCtl('Line style', [['solid', '———'], ['dash', '– – –'], ['dot', '· · · ·'], ['dashdot', '– · – ·']], 'dash'); g7.appendChild(ui.dash);
    ui.arrow = selectCtl('Arrowheads (lines)', [['none', 'no arrows'], ['end', '——▶'], ['start', '◀——'], ['both', '◀—▶']], 'arrow'); g7.appendChild(ui.arrow);
    row2.appendChild(g7);

    document.body.appendChild(bar);
    ui.bar = bar;

    // master-editing banner
    ui.masterBar = el('div', { 'class': 're-ui dk-masterbar' });
    ui.masterBar.appendChild(el('span', {}, '<b>Editing the master</b> — footer, slide number, logo: what you put here appears on every slide'));
    ui.masterBar.appendChild(btn('Cancel', 'Leave without changing the master', function () { exitMaster(false); }));
    ui.masterBar.appendChild(btn('Done', 'Apply to every slide', function () { exitMaster(true); }, 're-primary'));
    ui.masterBar.style.display = 'none';
    document.body.appendChild(ui.masterBar);

    // filmstrip
    ui.film = el('div', { 'class': 're-ui dk-film' });
    ui.filmList = el('div', { 'class': 'dk-filmlist' });
    ui.filmLine = el('div', { 'class': 'dk-filmline' });
    ui.film.appendChild(ui.filmList); ui.film.appendChild(ui.filmLine);
    ui.film.addEventListener('mousedown', onFilmDown);
    ui.film.addEventListener('contextmenu', onFilmMenu);
    ui.film.addEventListener('dblclick', function (ev) { var t = ev.target.closest('.dk-thumb'); if (t) { goTo(t._sec); } });
    document.body.appendChild(ui.film);

    buildSidePanel();

    // overlays (selection box, handles, guides…)
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
    ui.cropGhost = el('div', { 'class': 're-ui dk-cropghost' });
    document.body.appendChild(ui.cropGhost);
    ui.sel = el('div', { 'class': 're-ui re-sel' });
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (d) { ui.sel.appendChild(el('div', { 'class': 're-h re-h-' + d, 'data-dir': d })); });
    ui.rot = el('div', { 'class': 're-rot', title: 'Drag to rotate (Shift: 15° steps)' });
    ui.sel.appendChild(ui.rot);
    ui.selLabel = el('div', { 'class': 're-sel-label' });
    ui.sel.appendChild(ui.selLabel);
    document.body.appendChild(ui.sel);
    ui.hover = el('div', { 'class': 're-ui re-hover' });
    document.body.appendChild(ui.hover);
    ui.gv = el('div', { 'class': 're-ui re-guide re-gv' });
    ui.gh = el('div', { 'class': 're-ui re-guide re-gh' });
    document.body.appendChild(ui.gv); document.body.appendChild(ui.gh);
    ui.toast = el('div', { 'class': 're-ui re-toast' });
    document.body.appendChild(ui.toast);

    ui.help = el('div', { 'class': 're-ui re-help' }, [
      '<h3>Shortcuts</h3><table>',
      '<tr><td>Click · Shift-click · drag</td><td>select one · several · everything inside a rectangle (⌘A: all) — Option-click reaches into a group</td></tr>',
      '<tr><td>Drag · handles · ⟳</td><td>move · resize (Shift: free aspect / straight) · rotate (Shift: 15° steps) — ⌘ while dragging: no snapping</td></tr>',
      '<tr><td>Double-click</td><td>edit text (Esc to finish) · on a picture: replace it · on an empty picture placeholder: choose one</td></tr>',
      '<tr><td>While typing</td><td>Enter: new paragraph · Tab / ⇧Tab: list level · ⌘B ⌘I ⌘U · ⌘L ⌘E ⌘R align · Backspace at a bullet removes it · paste keeps the text only</td></tr>',
      '<tr><td>+ Shape</td><td>pick a shape, then drag on the slide (click: default size) · line ends snap to shapes and stay connected to them</td></tr>',
      '<tr><td>Arrows</td><td>nudge 1 px (Shift: 10 px) · with nothing selected: previous / next slide</td></tr>',
      '<tr><td>Build ▾</td><td>the selection appears, disappears, grows or is highlighted on a click (→ / Space / clicker) when presenting; the Builds panel sets order and "with previous"</td></tr>',
      '<tr><td>⌘D · ⌫ · ⌘G · ⇧⌘G</td><td>duplicate · delete · group · ungroup</td></tr>',
      '<tr><td>] [ · Shift</td><td>bring forward · send backward · to front / back</td></tr>',
      '<tr><td>⌘C ⌘X ⌘V</td><td>copy / cut / paste elements — also into another presentation open in deck or reveal-edit (pictures come along); paste text or an image from anywhere</td></tr>',
      '<tr><td>⇧⌘N</td><td>new slide (same layout as this one) · ⌘← ⌘→ move the slide · ⌘↑ ⌘↓ move it within its stack</td></tr>',
      '<tr><td>Enter</td><td>type into the selected shape or text box · Esc: deselect</td></tr>',
      '<tr><td>⌘F · ⌘K · ⌥⌘C ⌥⌘V</td><td>find and replace · link (words while typing, or an element) · copy / paste style</td></tr>',
      '<tr><td>Tables · Σ</td><td>+ Table inserts one; double-click a cell to type, Tab moves on; the + Table menu adds rows and columns · Σ inserts a LaTeX equation (double-click one to edit)</td></tr>',
      '<tr><td>⌘Z · ⇧⌘Z · ⌘S</td><td>undo · redo · save (previous versions go to _backups/)</td></tr>',
      '<tr><td>⌘⏎ · ⇧⌘⏎</td><td>present from this slide · from the beginning (F: full screen, S: presenter view, Esc: overview)</td></tr>',
      '<tr><td>Filmstrip</td><td>click to go to a slide · drag to reorder · right-click for the slide menu</td></tr>',
      '</table><p>Builds (click-to-appear) are all shown while editing; the Builds panel sets their order and kind.</p><p class="re-help-close">click anywhere to close</p>'
    ].join(''));
    ui.help.addEventListener('mousedown', function (e) { e.stopPropagation(); toggleHelp(); });
    document.body.appendChild(ui.help);
  }
  function updateTextControls() {
    var st = textState();
    var on = !!st;
    ['fontSel', 'sizeIn', 'boldBtn', 'italBtn', 'undBtn', 'textColor', 'bulBtn', 'numBtn', 'alL', 'alC', 'alR', 'anchorSel', 'lhSel', 'fitBtn'].forEach(function (k) { if (ui[k]) ui[k].disabled = !on; });
    if (!st) { ui.sizeIn.value = ''; ['boldBtn', 'italBtn', 'undBtn', 'bulBtn', 'numBtn', 'alL', 'alC', 'alR', 'fitBtn'].forEach(function (k) { ui[k].classList.remove('re-active'); }); return; }
    ui.sizeIn.value = st.size;
    var fam = st.family.toLowerCase();
    var opt = Array.prototype.filter.call(ui.fontSel.options, function (o) { return fam.indexOf(o.text.toLowerCase()) === 0 || fam.indexOf(o.text.toLowerCase().replace(/ /g, '')) === 0; })[0];
    if (opt) ui.fontSel.value = opt.value;
    if (st.color) ui.textColor.value = st.color;
    ui.boldBtn.classList.toggle('re-active', st.bold); ui.italBtn.classList.toggle('re-active', st.italic); ui.undBtn.classList.toggle('re-active', st.underline);
    ui.bulBtn.classList.toggle('re-active', st.bu === 'dot'); ui.numBtn.classList.toggle('re-active', st.bu === 'num');
    ui.alL.classList.toggle('re-active', st.align === 'left' || st.align === 'start'); ui.alC.classList.toggle('re-active', st.align === 'center'); ui.alR.classList.toggle('re-active', st.align === 'right' || st.align === 'end');
    if (st.anchor) ui.anchorSel.value = st.anchor;
    var lh = parseFloat(st.lh) / st.size; if (isFinite(lh)) { var best = null; Array.prototype.forEach.call(ui.lhSel.options, function (o) { if (!best || Math.abs(parseFloat(o.value) - lh) < Math.abs(parseFloat(best.value) - lh)) best = o; }); if (best) ui.lhSel.value = best.value; }
    ui.fitBtn.classList.toggle('re-active', st.autofit);
  }
  function layoutChrome() {
    var top = ui.bar.offsetHeight;
    var left = ui.film ? ui.film.offsetWidth : 0;
    var right = ui.side && !ui.side.classList.contains('dk-off') ? ui.side.offsetWidth : 0;
    var r = document.documentElement.style;
    r.setProperty('--dk-top', top + 'px'); r.setProperty('--dk-left', left + 'px'); r.setProperty('--dk-right', right + 'px');
    if (ui.film) ui.film.style.top = top + 'px';
    if (ui.side) ui.side.style.top = top + 'px';
    if (ui.masterBar) ui.masterBar.style.top = top + 'px';
    if (window.Reveal && Reveal.layout) Reveal.layout();
    placeOverlay();
  }
  function toggleHelp() { ui.help.classList.toggle('re-open'); }

  // ---- dialogs
  function dialog(title, bodyEl, buttons, opts) {
    var d = el('div', { 'class': 're-ui re-dialog-back' + (opts && opts.light ? ' re-dialog-light' : '') });
    var box = el('div', { 'class': 're-dialog' + (opts && opts.wide ? ' dk-wide' : '') });
    box.appendChild(el('h3', { text: title }));
    box.appendChild(bodyEl);
    var rowB = el('div', { 'class': 're-dialog-btns' });
    var close = function () { d.remove(); document.removeEventListener('keydown', onEsc, true); };
    var onEsc = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); if (opts && opts.onCancel) opts.onCancel(); } };
    buttons.forEach(function (b) { rowB.appendChild(btn(b[0], b[0], function () { var r = b[1] && b[1](); if (r !== false) close(); }, b[2])); });
    box.appendChild(rowB);
    d.appendChild(box);
    d.addEventListener('mousedown', function (e) { if (e.target === d) { close(); if (opts && opts.onCancel) opts.onCancel(); } });
    document.addEventListener('keydown', onEsc, true);
    document.body.appendChild(d);
    return { close: close, box: box };
  }
  function labeled(text, ctl) { var l = el('label', { 'class': 'dk-field' }); l.appendChild(el('span', { text: text })); l.appendChild(ctl); return l; }
  function newDeckDialog() {
    var body = el('div');
    var title = el('input', { type: 'text', value: 'My talk', 'class': 'dk-in' });
    var folder = el('input', { type: 'text', 'class': 'dk-in', placeholder: 'next to this presentation' });
    folder.value = (DECK_PATH || '').replace(/\/[^\/]*$/, '') || '';
    var theme = el('select', { 'class': 're-select' }); [['dark', 'Dark (white on black)'], ['light', 'Light (black on white)']].forEach(function (o) { theme.appendChild(el('option', { value: o[0], text: o[1] })); });
    var size = el('select', { 'class': 're-select' }); [['16:9', '16:9 (1280 × 720)'], ['4:3', '4:3 (1024 × 768)']].forEach(function (o) { size.appendChild(el('option', { value: o[0], text: o[1] })); });
    body.appendChild(labeled('Title', title)); body.appendChild(labeled('In folder', folder)); body.appendChild(labeled('Theme', theme)); body.appendChild(labeled('Slide size', size));
    body.appendChild(el('p', { 'class': 're-dim', text: 'A folder named after the title is created there, holding the presentation (an HTML file), its media and reveal.js. It opens in a new tab.' }));
    dialog('New presentation', body, [['Cancel'], ['Create', function () {
      var t = title.value.trim() || 'Presentation';
      fetch('/__new', { method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: t, folder: folder.value.trim() ? folder.value.trim().replace(/\/+$/, '') + '/' + t : '', theme: theme.value, size: size.value }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
        .then(function (j) { if (j.url) window.open(j.url, '_blank'); toast('Created ' + j.file, 5000); })
        .catch(function (e) { toast('Could not create it: ' + e.message, 7000); });
    }, 're-primary']]);
    setTimeout(function () { title.focus(); title.select(); }, 0);
  }
  function openOther() {
    var go = function (path) {
      fetch('/__open', { method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path || '' }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
        .then(function (j) { if (j.cancelled) return; if (j.url) window.open(j.url, '_blank'); })
        .catch(function (e) { toast('Could not open it: ' + e.message, 7000); });
    };
    if (CFG.platform === 'darwin') return go('');
    var p = prompt('Path of the presentation (its .html file or folder):', '');
    if (p) go(p);
  }
  function settingsDialog() {
    if (editingEl) endTextEdit();
    var body = el('div', { 'class': 'dk-settings' }), cfg = Reveal.getConfig();
    var M = META ? JSON.parse(JSON.stringify(META)) : null;
    var sect = function (t) { body.appendChild(el('h4', { text: t })); };
    var themeSel, bgLab, bgFile = null, bgClear = false, bgFit, accent, fontSel, tfontSel, footer, numbers, numbering;
    if (M) {
      sect('Theme');
      themeSel = el('select', { 'class': 're-select' }); [['dark', 'Dark — white on black'], ['light', 'Light — black on white']].forEach(function (o) { themeSel.appendChild(el('option', { value: o[0], text: o[1] })); });
      themeSel.value = M.theme.name || 'dark';
      body.appendChild(labeled('Colours', themeSel));
      var bgRow = el('div', { 'class': 'dk-inline' });
      bgLab = el('span', { 'class': 're-dim', text: M.theme.bg ? M.theme.bg.replace(/^media\//, '') : 'none' });
      var pick = btn('Choose picture…', 'A picture behind every slide', function () { pickFile(function (f) { bgFile = f; bgClear = false; bgLab.textContent = f.name; }, 'image/*'); });
      var clear = btn('None', 'No background picture', function () { bgClear = true; bgFile = null; bgLab.textContent = 'none'; });
      bgFit = el('select', { 'class': 're-select' }); [['cover', 'Fill the slide'], ['contain', 'Fit inside'], ['stretch', 'Stretch']].forEach(function (o) { bgFit.appendChild(el('option', { value: o[0], text: o[1] })); });
      bgFit.value = M.theme.bgFit || 'cover';
      bgRow.appendChild(bgLab); bgRow.appendChild(pick); bgRow.appendChild(clear); bgRow.appendChild(bgFit);
      body.appendChild(labeled('Background picture', bgRow));
      accent = el('input', { type: 'color', 'class': 're-color', value: M.theme.accent || '#ff6a2a' });
      body.appendChild(labeled('Title / accent colour', accent));
      fontSel = el('select', { 'class': 're-select' }); tfontSel = el('select', { 'class': 're-select' });
      Object.keys(FONTS).forEach(function (k) { fontSel.appendChild(el('option', { value: k, text: k })); tfontSel.appendChild(el('option', { value: k, text: k })); });
      fontSel.value = M.theme.font || 'Carlito'; tfontSel.value = M.theme.titleFont || 'Carlito';
      body.appendChild(labeled('Text font', fontSel)); body.appendChild(labeled('Title font', tfontSel));
      sect('Master');
      footer = el('input', { type: 'text', 'class': 'dk-in', value: M.footer || '', placeholder: 'e.g. A. Danagoulian · MIT NSE' });
      body.appendChild(labeled('Footer text', footer));
      numbers = el('input', { type: 'checkbox' }); numbers.checked = M.numbers !== false;
      var nl = el('label', { 'class': 're-radio' }); nl.appendChild(numbers); nl.appendChild(el('span', { text: 'Slide number on every slide' })); body.appendChild(nl);
      numbering = el('select', { 'class': 're-select' }); [['doc', 'In order (1, 2, 3 … stacked slides counted where they sit)'], ['after', 'Main slides first, stacked slides after'], ['sub', 'Stacked slides as 18.1, 18.2 …']].forEach(function (o) { numbering.appendChild(el('option', { value: o[0], text: o[1] })); });
      numbering.value = M.numbering || 'doc';
      body.appendChild(labeled('Numbering', numbering));
      body.appendChild(el('p', { 'class': 're-dim', text: 'Deck menu › Edit master to move these or add a logo.' }));
    }
    sect('Presenting');
    var controls = el('input', { type: 'checkbox' }); controls.checked = cfg.controls !== false;
    var cl = el('label', { 'class': 're-radio' }); cl.appendChild(controls); cl.appendChild(el('span', { text: 'Navigation arrows' })); body.appendChild(cl);
    var ctlLayout = el('select', { 'class': 're-select' }); [['bottom-right', 'in the corner'], ['edges', 'at the screen edges']].forEach(function (o) { ctlLayout.appendChild(el('option', { value: o[0], text: o[1] })); });
    ctlLayout.value = cfg.controlsLayout === 'edges' ? 'edges' : 'bottom-right';
    body.appendChild(labeled('Arrows', ctlLayout));
    var progress = el('input', { type: 'checkbox' }); progress.checked = !!cfg.progress;
    var pl = el('label', { 'class': 're-radio' }); pl.appendChild(progress); pl.appendChild(el('span', { text: 'Progress bar along the bottom' })); body.appendChild(pl);
    var trans = el('select', { 'class': 're-select' }); [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide'], ['convex', 'Convex'], ['concave', 'Concave'], ['zoom', 'Zoom']].forEach(function (o) { trans.appendChild(el('option', { value: o[0], text: o[1] })); });
    trans.value = cfg.transition || 'none';
    body.appendChild(labeled('Transition', trans));
    var loop = el('input', { type: 'checkbox' }); loop.checked = !!cfg.loop;
    var ll = el('label', { 'class': 're-radio' }); ll.appendChild(loop); ll.appendChild(el('span', { text: 'Loop back to the first slide after the last' })); body.appendChild(ll);
    var auto = el('input', { type: 'number', 'class': 'dk-in dk-short', min: '0', step: '1', value: String(Math.round((cfg.autoSlide || 0) / 1000)) });
    body.appendChild(labeled('Auto-advance every (seconds, 0 = off)', auto));
    sect('Editor');
    var autosave = el('input', { type: 'checkbox' }); autosave.checked = prefs.autosave;
    var al = el('label', { 'class': 're-radio' }); al.appendChild(autosave); al.appendChild(el('span', { text: 'Save automatically every minute while editing' })); body.appendChild(al);
    dialog('Presentation settings', body, [['Cancel'], ['Apply', function () {
      prefs.autosave = autosave.checked; savePrefs();
      var opts = { controls: controls.checked, controlsLayout: ctlLayout.value, progress: progress.checked, transition: trans.value, loop: loop.checked, autoSlide: (parseInt(auto.value, 10) || 0) * 1000 };
      writeInitOptions(opts);
      Reveal.configure(opts);
      if (!M) { markDirty(); return; }
      var done = function () {
        META.theme.name = themeSel.value;
        var base = THEMES[themeSel.value] || {};
        META.theme.page = base.bg; META.theme.text = base.text;
        META.theme.accent = accent.value; META.theme.font = fontSel.value; META.theme.titleFont = tfontSel.value; META.theme.bgFit = bgFit.value;
        if (bgClear) META.theme.bg = '';
        var masterChanged = (footer.value !== (META.footer || '')) || (numbers.checked !== (META.numbers !== false));
        META.footer = footer.value; META.numbers = numbers.checked; META.numbering = numbering.value;
        applyTheme();
        if (masterChanged) rebuildDefaultMaster();
        stampMaster();
        rebuildLive(Reveal.getIndices());
        toast('Settings applied — save to keep them');
      };
      if (bgFile) upload(bgFile).then(function (url) { META.theme.bg = url; done(); }).catch(function (e) { toast('Could not use the picture: ' + e.message, 6000); done(); });
      else done();
    }, 're-primary']], { wide: true });
  }
  // the footer / slide-number elements of the master, kept where the user put them when possible
  function rebuildDefaultMaster() {
    var S = slideSize(), fs = S.w >= 1200 ? 16 : 14, t = document.createElement('template');
    t.innerHTML = masterHtml();
    var keep = Array.prototype.filter.call(t.content.children, function (c) { return c.getAttribute('data-master') !== 'footer' && c.getAttribute('data-master') !== 'num'; });
    var oldF = t.content.querySelector('[data-master="footer"]'), oldN = t.content.querySelector('[data-master="num"]');
    var box = function (old, dx, w) { return old ? old.getAttribute('style') : 'left:' + px(dx) + ';top:' + px(S.h - 44) + ';width:' + px(w) + ';height:32px;'; };
    var tbox = function (kind, style, w, text, align, extra) {
      var m = /width:\s*([\d.]+)px/.exec(style), h = /height:\s*([\d.]+)px/.exec(style);
      return '<div class="e" data-layout data-master="' + kind + '"' + (extra || '') + ' style="' + style + '"><div class="tx" style="left:0;top:0;width:' + (m ? m[1] : w) + 'px;height:' + (h ? h[1] : 32) + 'px;padding:4px 8px;justify-content:center;"><div class="tb"><div class="p" style="text-align:' + align + ';font-size:' + fs + 'px;color:var(--dk-muted);"><span>' + esc(text) + '</span></div></div></div></div>';
    };
    var out = keep.map(function (c) { return c.outerHTML; });
    if (META.footer) out.push(oldF && oldF.querySelector('.p') ? (function () { oldF.querySelector('.p').innerHTML = '<span>' + esc(META.footer) + '</span>'; return oldF.outerHTML; })() : tbox('footer', box(null, S.w * 0.03, S.w * 0.6), S.w * 0.6, META.footer, 'left'));
    if (META.numbers !== false) out.push(oldN ? oldN.outerHTML : tbox('num', box(null, S.w - S.w * 0.03 - 80, 80), 80, '1', 'right', ' data-slidenum'));
    setMasterHtml(out.join(''));
  }
  function writeInitOptions(opts) {
    var lits = { controls: String(opts.controls), controlsLayout: "'" + opts.controlsLayout + "'", progress: String(opts.progress), transition: "'" + opts.transition + "'", loop: String(opts.loop), autoSlide: String(opts.autoSlide) };
    if (rawSlides) {
      var t = rawText, sp = spanIn(t);
      Object.keys(lits).forEach(function (k) { var t2 = setInitOption(t, k, lits[k], sp[0], sp[1], false); if (t2 !== null) { t = t2; sp = spanIn(t) || sp; } });
      replaceRaw(t);
    }
    var sc = Array.prototype.filter.call(srcDoc.querySelectorAll('script'), function (x) { return /Reveal\s*\.\s*initialize\s*\(/.test(x.textContent); })[0];
    if (sc) { var js = sc.textContent; Object.keys(lits).forEach(function (k) { var j2 = setInitOption(js, k, lits[k], -1, -1, false); if (j2 !== null) js = j2; }); sc.textContent = js; }
    markDirty();
  }
  // editor preferences (this computer, all presentations)
  var prefs = { autosave: false };
  try { var sp_ = JSON.parse(localStorage.getItem('deck-prefs') || 'null'); if (sp_) prefs = sp_; } catch (err) { /* ignore */ }
  function savePrefs() { try { localStorage.setItem('deck-prefs', JSON.stringify(prefs)); } catch (err) { /* ignore */ } }
  setInterval(function () { if (prefs.autosave && dirty && !editingEl && !gesture && !masterMode && !serverGone) save(false); }, 60000);
  window.addEventListener('beforeunload', function (e) { if (dirty && !serverGone) { e.preventDefault(); e.returnValue = ''; } });

  // ================================================================== tables
  // <div class="e" data-table style="…"><table class="tbl" style="width:100%;height:100%"><tr><td><div class="p">…</div></td>…
  function isTable(e) { return !!(e && e.hasAttribute && e.hasAttribute('data-table')); }
  function tableOf(e) { var t = e && e.closest ? e.closest('[data-table]') : null; return t && topItem(t) ? t : null; }
  function cellHtml(text, header) {
    var td = themeDefaults();
    return '<' + (header ? 'th' : 'td') + ' style="border:1px solid ' + td.line + ';' + (header ? 'background:' + td.fill + ';color:#fff;' : '') + '">' +
      '<div class="p" style="font-size:22px;line-height:1.25;text-align:left;' + (header ? 'font-weight:700;' : '') + '">' + (text ? '<span>' + esc(text) + '</span>' : '<br>') + '</div></' + (header ? 'th' : 'td') + '>';
  }
  function addTable() {
    var spec = prompt('Table size — rows × columns:', '3 × 3');
    if (spec === null) return;
    var m = /(\d+)\D+(\d+)/.exec(spec), rows = m ? Math.min(40, +m[1]) : 3, cols = m ? Math.min(20, +m[2]) : 3;
    var S = slideSize(), w = Math.round(S.w * 0.8), h = Math.round(Math.min(S.h * 0.7, rows * 44 + 10)), x = Math.round((S.w - w) / 2), y = Math.round((S.h - h) / 2);
    var html = '<div class="e" data-table style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;"><table class="tbl" style="width:100%;height:100%;color:' + themeDefaults().text + ';font-family:' + (isDeck() ? 'var(--dk-font)' : 'inherit') + ';">';
    for (var r = 0; r < rows; r++) { html += '<tr>'; for (var c = 0; c < cols; c++) html += cellHtml(r === 0 ? 'Heading' : '', r === 0); html += '</tr>'; }
    html += '</table></div>';
    var n = insertItem(html);
    if (n) toast('Table added — double-click a cell to type; Table ▾ adds rows and columns', 4000);
  }
  function curCell() {
    var c = editingEl && editingEl.closest ? editingEl.closest('td, th') : null;
    if (c) return c;
    return sel && isTable(sel) ? sel.querySelector('td, th') : null;
  }
  function tableOp(fn) {
    var cell = curCell();
    if (!cell) return toast('Click into a table cell first');
    var tbl = cell.closest('[data-table]'), tr = cell.closest('tr'), ci = Array.prototype.indexOf.call(tr.children, cell);
    if (editingEl) endTextEdit();
    snapshot();
    fn(tbl.querySelector('table'), tr, ci, cell);
    syncWhole(tbl); markDirty(); placeOverlay(); refreshThumbSoon();
  }
  function tableRow(where) {
    tableOp(function (table, tr, ci) {
      var nr = tr.cloneNode(true);
      Array.prototype.forEach.call(nr.children, function (c) { var p = c.querySelector('.p'); if (p) p.innerHTML = '<br>'; if (c.tagName === 'TH') { var td = document.createElement('td'); td.setAttribute('style', (c.getAttribute('style') || '').replace(/background:[^;]*;?/, '').replace(/color:[^;]*;?/, '')); td.innerHTML = c.innerHTML; td.querySelector('.p').style.fontWeight = ''; c.replaceWith(td); } });
      if (where < 0) tr.before(nr); else tr.after(nr);
    });
  }
  function tableCol(where) {
    tableOp(function (table, tr, ci) {
      Array.prototype.forEach.call(table.rows, function (row) {
        var ref = row.children[ci], nc = ref.cloneNode(true), p = nc.querySelector('.p'); if (p) p.innerHTML = '<br>';
        if (where < 0) ref.before(nc); else ref.after(nc);
      });
    });
  }
  function tableDelRow() { tableOp(function (table, tr) { if (table.rows.length > 1) tr.remove(); else toast('A table keeps at least one row'); }); }
  function tableDelCol() { tableOp(function (table, tr, ci) { if (tr.children.length > 1) Array.prototype.forEach.call(table.rows, function (row) { if (row.children[ci]) row.children[ci].remove(); }); else toast('A table keeps at least one column'); }); }
  function tableHeader() {
    tableOp(function (table) {
      var first = table.rows[0], isTh = first.children[0].tagName === 'TH', td = themeDefaults();
      Array.prototype.forEach.call(first.children, function (c) {
        var n = document.createElement(isTh ? 'td' : 'th');
        n.innerHTML = c.innerHTML;
        n.setAttribute('style', (c.getAttribute('style') || '').replace(/background:[^;]*;?/, '').replace(/color:[^;]*;?/, '') + (isTh ? '' : 'background:' + td.fill + ';color:#fff;'));
        var p = n.querySelector('.p'); if (p) p.style.fontWeight = isTh ? '' : '700';
        c.replaceWith(n);
      });
    });
  }
  function tableBorders(color) {   // the Line colour control, applied to a table
    tableOp(function (table) { table.querySelectorAll('td, th').forEach(function (c) { c.style.border = color === 'none' ? '0' : '1px solid ' + color; }); });
  }
  function tableFill(color) {      // the Fill colour control: the cell being edited, else the whole table
    var cell = editingEl && editingEl.closest && editingEl.closest('td, th');
    tableOp(function (table) {
      var cells = cell ? [cell] : Array.prototype.slice.call(table.querySelectorAll('td, th'));
      cells.forEach(function (c) { if (color === 'none') c.style.removeProperty('background'); else c.style.background = color; });
    });
  }

  // ================================================================== equations (KaTeX, bundled offline when first used)
  var katexReady = null;
  function ensureKatex() {
    if (katexReady) return katexReady;
    katexReady = fetch('/__vendor?set=katex', { method: 'POST', headers: { 'X-Edit-Token': TOKEN } }).then(function () {
      return new Promise(function (res, rej) {
        if (window.katex) return res();
        var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'lib/katex/katex.min.css'; l.id = 'deck-katex-css'; document.head.appendChild(l);
        var s = document.createElement('script'); s.src = 'lib/katex/katex.min.js'; s.id = 'deck-katex-js';
        s.onload = function () { res(); }; s.onerror = function () { rej(new Error('KaTeX did not load')); };
        document.head.appendChild(s);
      });
    }).then(function () {
      // the presentation itself needs the same two files plus a renderer
      if (!srcDoc.getElementById('deck-katex-css')) {
        var l = srcDoc.createElement('link'); l.rel = 'stylesheet'; l.href = 'lib/katex/katex.min.css'; l.id = 'deck-katex-css';
        var s = srcDoc.createElement('script'); s.src = 'lib/katex/katex.min.js'; s.id = 'deck-katex-js';
        var r = srcDoc.createElement('script'); r.id = 'deck-katex-render'; r.textContent = KATEX_RENDER;
        srcDoc.head.appendChild(l); srcDoc.head.appendChild(s); srcDoc.head.appendChild(r);
        if (rawSlides) {
          var h = rawText.search(/<\/head\s*>/i);
          var block = '<link rel="stylesheet" href="lib/katex/katex.min.css" id="deck-katex-css">\n<script src="lib/katex/katex.min.js" id="deck-katex-js"></script>\n<script id="deck-katex-render">' + KATEX_RENDER + '</script>\n';
          if (h >= 0) replaceRaw(rawText.slice(0, h) + block + rawText.slice(h));
        }
      }
    });
    return katexReady;
  }
  var KATEX_RENDER = "document.addEventListener('DOMContentLoaded', function () { if (!window.katex) return; document.querySelectorAll('.math[data-tex]').forEach(function (m) { try { katex.render(m.getAttribute('data-tex'), m, { throwOnError: false, displayMode: m.hasAttribute('data-display') }); } catch (e) {} }); });";
  function renderMath(m) {
    if (!window.katex) return;
    try { katex.render(m.getAttribute('data-tex'), m, { throwOnError: false, displayMode: m.hasAttribute('data-display') }); } catch (err) { m.textContent = m.getAttribute('data-tex'); }
  }
  function equationDialog(existing) {
    var body = el('div');
    var ta = el('textarea', { 'class': 'dk-in dk-tex', rows: '4', placeholder: 'LaTeX, e.g.  E = mc^2   or   \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}' });
    ta.value = existing ? existing.getAttribute('data-tex') : '';
    var disp = el('input', { type: 'checkbox' }); disp.checked = existing ? existing.hasAttribute('data-display') : !editingEl;
    var dl = el('label', { 'class': 're-radio' }); dl.appendChild(disp); dl.appendChild(el('span', { text: 'Displayed on its own line (larger)' }));
    var prev = el('div', { 'class': 'dk-texprev' });
    body.appendChild(ta); body.appendChild(dl); body.appendChild(el('p', { 'class': 're-dim', text: 'Preview' })); body.appendChild(prev);
    var upd = function () { if (!window.katex) return; try { katex.render(ta.value || '\\;', prev, { throwOnError: false, displayMode: disp.checked }); } catch (err) { prev.textContent = err.message; } };
    ta.addEventListener('input', upd); disp.addEventListener('change', upd);
    var wasEditing = editingEl; if (wasEditing) saveRange();
    ensureKatex().then(upd).catch(function (e) { prev.textContent = e.message; });
    dialog(existing ? 'Edit equation' : 'Insert equation', body, [['Cancel'], ['Insert', function () {
      var tex = ta.value.trim();
      if (!tex) return;
      ensureKatex().then(function () {
        if (existing) {
          snapshot();
          existing.setAttribute('data-tex', tex); if (disp.checked) existing.setAttribute('data-display', ''); else existing.removeAttribute('data-display');
          renderMath(existing);
          var top = topItem(existing); if (top) { syncWhole(top); } markDirty(); placeOverlay(); refreshThumbSoon();
          return;
        }
        var span = '<span class="math" contenteditable="false" data-tex="' + esc(tex) + '"' + (disp.checked ? ' data-display' : '') + '></span>';
        if (wasEditing && document.contains(wasEditing)) {
          if (!editingEl) { editingEl = wasEditing; }   // the dialog took focus; put the caret back
          wasEditing.focus(); restoreRange();
          document.execCommand('insertHTML', false, span);
          var ms = wasEditing.querySelectorAll('.math[data-tex]:empty'), last = ms[ms.length - 1];
          ms.forEach(renderMath);
          if (last) {           // caret right after the equation, on a zero-width space it can type over
            var z = document.createTextNode('\u200b'); last.after(z);
            var rg = document.createRange(); rg.setStart(z, 1); rg.collapse(true);
            var sl = getSelection(); sl.removeAllRanges(); sl.addRange(rg);
          }
          onTextInput(); afterParaChange(curParas());
        } else {
          var S = slideSize(), w = Math.round(S.w * 0.5), h = 80, x = Math.round((S.w - w) / 2), y = Math.round((S.h - h) / 2);
          var html = '<div class="e shp" data-shape="rect" data-fill="none" data-stroke="none" data-sw="2" data-dash="solid" data-tbox style="left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px;">' +
            '<svg class="geo"></svg><div class="tx" style="left:0;top:0;width:' + w + 'px;height:' + h + 'px;padding:4.8px 9.6px;justify-content:center;">' +
            '<div class="tb"><div class="p" style="text-align:center;line-height:1.3;font-size:32px;color:' + themeDefaults().text + ';' + (isDeck() ? 'font-family:var(--dk-font);' : '') + '">' + span + '</div></div></div></div>';
          var n = insertItem(html);
          if (n) { n.querySelectorAll('.math').forEach(renderMath); renderShape(n); autoHeight(n); syncWhole(n); placeOverlay(); }
        }
        toast('Equation inserted — double-click it to change it');
      }).catch(function (e) { toast('Equations need KaTeX, which could not be loaded: ' + e.message, 6000); });
    }, 're-primary']], { wide: true });
    setTimeout(function () { ta.focus(); }, 0);
  }
  // after the source is loaded or rebuilt: render any equations in the live slides
  function renderAllMath() {
    var ms = document.querySelectorAll('.reveal .slides .math[data-tex]');
    if (!ms.length) return;
    ensureKatex().then(function () { ms.forEach(renderMath); refreshAllThumbs(); }).catch(function () {});
  }

  // ================================================================== hyperlinks
  function linkDialog() {
    var inText = editingEl && hasTextSelection();
    var target = !inText && sel ? sel : null;
    if (!inText && !target) return toast('Select an element, or select words while typing, then add a link');
    var cur = inText ? (function () { var a = paraOf(getSelection().anchorNode); var l = getSelection().anchorNode.parentElement.closest('a'); return l ? l.getAttribute('href') : ''; })() : (target.getAttribute('data-link') || '');
    var body = el('div');
    var kind = el('select', { 'class': 're-select' }); [['url', 'Web address'], ['slide', 'A slide in this presentation']].forEach(function (o) { kind.appendChild(el('option', { value: o[0], text: o[1] })); });
    var url = el('input', { type: 'text', 'class': 'dk-in', placeholder: 'https://…' });
    var slideSel = el('select', { 'class': 're-select' });
    slideList().forEach(function (s, i) { var t = (s.sec.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50); slideSel.appendChild(el('option', { value: '#/' + s.h + (s.v ? '/' + s.v : ''), text: (i + 1) + '  ' + t })); });
    if (/^#\//.test(cur)) { kind.value = 'slide'; slideSel.value = cur; } else url.value = cur;
    var swap = function () { url.style.display = kind.value === 'url' ? '' : 'none'; slideSel.style.display = kind.value === 'slide' ? '' : 'none'; };
    kind.addEventListener('change', swap); swap();
    body.appendChild(labeled('Link to', kind)); body.appendChild(labeled('', url)); body.appendChild(labeled('', slideSel));
    if (inText) saveRange();
    var buttons = [['Cancel'], ['Set link', function () {
      var href = kind.value === 'url' ? url.value.trim() : slideSel.value;
      if (kind.value === 'url' && href && !/^[a-z]+:/i.test(href)) href = 'https://' + href;
      applyLink(href, inText, target);
    }, 're-primary']];
    if (cur) buttons.splice(1, 0, ['Remove link', function () { applyLink('', inText, target); }]);
    dialog('Link', body, buttons);
  }
  function applyLink(href, inText, target) {
    if (inText) {
      editingEl.focus(); restoreRange();
      var a = getSelection().anchorNode.parentElement.closest('a');
      if (a && editingEl.contains(a)) { if (href) a.setAttribute('href', href); else { var sp = document.createElement('span'); while (a.firstChild) sp.appendChild(a.firstChild); a.replaceWith(sp); } }
      else if (href) { document.execCommand('createLink', false, href); editingEl.querySelectorAll('a[href="' + href + '"]').forEach(function (x) { x.setAttribute('target', /^#/.test(href) ? '' : '_blank'); if (!x.getAttribute('target')) x.removeAttribute('target'); }); }
      afterParaChange(curParas());
    } else {
      snapshot();
      if (href) target.setAttribute('data-link', href); else target.removeAttribute('data-link');
      syncAttrs(target, ['data-link']); markDirty();
      ensureLinkScript();
    }
    toast(href ? 'Linked to ' + href : 'Link removed');
  }
  // elements with data-link become clickable when presenting (a tiny script added to the file once)
  var LINK_JS = "document.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('.reveal .slides [data-link]'); if (!t) return; var h = t.getAttribute('data-link'); if (!h) return; e.preventDefault(); if (h.charAt(0) === '#') { var p = h.replace(/^#\\//, '').split('/'); Reveal.slide(+p[0] || 0, +p[1] || 0); } else window.open(h, '_blank'); }); document.querySelectorAll('.reveal .slides [data-link]').forEach(function (t) { t.style.cursor = 'pointer'; });";
  function ensureLinkScript() {
    if (srcDoc.getElementById('deck-links')) return;
    var s = srcDoc.createElement('script'); s.id = 'deck-links'; s.textContent = LINK_JS;
    srcDoc.body.appendChild(s);
    if (rawSlides) { var i = rawText.toLowerCase().lastIndexOf('</body>'); if (i >= 0) replaceRaw(rawText.slice(0, i) + '<script id="deck-links">' + LINK_JS + '</script>\n' + rawText.slice(i)); }
  }

  // ================================================================== find & replace
  function textNodesOf(root) {
    var w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return n.parentElement.closest('aside.notes, script, style, .math') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } }), out = [];
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }
  function findDialog() {
    if (editingEl) endTextEdit();
    var body = el('div');
    var find = el('input', { type: 'text', 'class': 'dk-in', placeholder: 'Find' }), repl = el('input', { type: 'text', 'class': 'dk-in', placeholder: 'Replace with' });
    var cs = el('input', { type: 'checkbox' }); var cl = el('label', { 'class': 're-radio' }); cl.appendChild(cs); cl.appendChild(el('span', { text: 'Match case' }));
    var list = el('div', { 'class': 'dk-findlist' });
    body.appendChild(labeled('Find', find)); body.appendChild(labeled('Replace', repl)); body.appendChild(cl); body.appendChild(list);
    var hits = [];
    var scan = function () {
      list.innerHTML = ''; hits = [];
      var q = find.value; if (!q) return;
      var re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs.checked ? 'g' : 'gi');
      slideList().forEach(function (s, i) {
        textNodesOf(s.sec).forEach(function (n) {
          var m; re.lastIndex = 0;
          while ((m = re.exec(n.nodeValue))) {
            hits.push({ node: n, at: m.index, len: m[0].length, h: s.h, v: s.v, i: i });
            var ctx = n.nodeValue.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, ' ');
            var b = btn('<span class="re-dim">' + (i + 1) + '</span> ' + esc(ctx), 'Go to slide ' + (i + 1), (function (hh, vv) { return function () { Reveal.slide(hh, vv || 0); }; })(s.h, s.v));
            b.classList.add('dk-hit'); list.appendChild(b);
            if (!m[0].length) re.lastIndex++;
          }
        });
      });
      count.textContent = hits.length ? hits.length + ' found' : 'nothing found';
    };
    var count = el('span', { 'class': 're-dim', text: '' });
    body.insertBefore(count, list);
    find.addEventListener('input', scan); cs.addEventListener('change', scan);
    var replaceAll = function () {
      if (!hits.length) return false;
      snapshot();
      var done = 0;
      hits.slice().reverse().forEach(function (hit) {       // from the end, so earlier offsets stay valid
        var n = hit.node; if (!n.parentNode) return;
        n.nodeValue = n.nodeValue.slice(0, hit.at) + repl.value + n.nodeValue.slice(hit.at + hit.len); done++;
      });
      rebuildLive(Reveal.getIndices());
      toast('Replaced ' + done + ' occurrence' + (done === 1 ? '' : 's'));
      return true;
    };
    dialog('Find and replace', body, [['Close'], ['Replace all', function () { return replaceAll() || false; }, 're-primary']], { wide: true });
    setTimeout(function () { find.focus(); }, 0);
  }

  // ================================================================== copy style / paste style
  var styleClip = null;
  function copyStyle() {
    if (!sel) return toast('Select an element first');
    var st = { kind: styleKind(sel) };
    if (st.kind === 'line' || st.kind === 'shape') { var a = shpAttrs(sel); st.fill = a.fill; st.stroke = a.stroke; st.sw = a.sw; st.dash = a.dash; st.arrow = a.arrow; }
    else { var g = getStyle(sel); st.fill = g.fill; st.stroke = g.stroke; st.sw = g.sw; st.opacity = sel.style.opacity; st.radius = sel.style.borderRadius; st.shadow = sel.style.boxShadow; }
    var p = sel.querySelector('.p');
    if (p) { var cs = getComputedStyle(p.querySelector('span') || p), tx = p.closest('.tx'); st.text = { size: p.style.fontSize || cs.fontSize, family: p.style.fontFamily || cs.fontFamily, color: p.style.color || cs.color, weight: cs.fontWeight, style: cs.fontStyle, align: p.style.textAlign, lh: p.style.lineHeight, bu: p.getAttribute('data-bu'), anchor: tx ? tx.style.justifyContent : '' }; }
    styleClip = st;
    toast('Style copied — select other elements and Paste style (⌥⌘V)');
  }
  function pasteStyle() {
    if (!styleClip) return toast('Copy a style first (⌥⌘C)');
    var list = selList();
    if (!list.length) return toast('Select an element first');
    snapshot();
    list.forEach(function (e) {
      var k = styleKind(e), st = styleClip;
      if ((k === 'line' || k === 'shape') && (st.kind === 'line' || st.kind === 'shape')) {
        if (k !== 'line' && st.fill) e.setAttribute('data-fill', st.fill);
        e.setAttribute('data-stroke', st.stroke || 'none'); e.setAttribute('data-sw', String(st.sw || 0)); e.setAttribute('data-dash', st.dash || 'solid');
        if (k === 'line') e.setAttribute('data-arrow', st.arrow || 'none');
        renderShape(e); shapesToSync.add(e);
      } else if (k === 'box' || k === 'geo') {
        if (st.opacity !== undefined) { if (st.opacity) e.style.opacity = st.opacity; else e.style.removeProperty('opacity'); }
        if (st.radius !== undefined) { if (st.radius) e.style.borderRadius = st.radius; else e.style.removeProperty('border-radius'); }
        if (st.shadow !== undefined) { if (st.shadow) e.style.boxShadow = st.shadow; else e.style.removeProperty('box-shadow'); }
        syncStyle(e);
      }
      if (st.text) {
        e.querySelectorAll('.p').forEach(function (p) {
          var t = st.text;
          if (t.size) setFontSizeOn(p, parseFloat(t.size)); if (t.family) p.style.fontFamily = t.family; if (t.color) p.style.color = t.color;
          p.style.fontWeight = parseInt(t.weight, 10) >= 600 ? '700' : ''; p.style.fontStyle = t.style === 'italic' ? 'italic' : '';
          if (t.align) p.style.textAlign = t.align; if (t.lh) p.style.lineHeight = t.lh;
          if (t.bu) p.setAttribute('data-bu', t.bu); else p.removeAttribute('data-bu');
          p.querySelectorAll('[style]').forEach(function (n) { ['font-size', 'font-family', 'color', 'font-weight', 'font-style'].forEach(function (pr) { n.style.removeProperty(pr); }); if (!n.getAttribute('style')) n.removeAttribute('style'); });
        });
        var tx = e.querySelector('.tx'); if (tx && st.text.anchor) tx.style.justifyContent = st.text.anchor;
        syncWhole(e);
      }
    });
    flushShapes(); markDirty(); placeOverlay(); updateFields(); refreshThumbSoon();
  }

  // ================================================================== exports: PNG, single file, zip, import pptx
  function busyDialog(title, text) {
    var body = el('div', {}, '<div class="re-pdf-busy"><div class="re-spin"></div><span class="re-dim">' + esc(text) + '</span></div>');
    return dialog(title, body, [], {});
  }
  function resultDialog(title, html, file, showLabel) {
    var buttons = [['Close']];
    if (file && CFG.platform === 'darwin') buttons.push([showLabel || 'Show in Finder', function () { fetch('/__reveal-in-finder', { method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file }) }); return false; }]);
    dialog(title, el('div', {}, html), buttons);
  }
  function post(path, obj) {
    return fetch(path, { method: 'POST', headers: { 'X-Edit-Token': TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }
  function exportPng(all) {
    if (dirty) save(false);
    var list = all ? slideList().map(function (s, i) { return [s.h, s.v || 0, i + 1]; }) : (function () { var i = Reveal.getIndices(); return [[i.h, i.v || 0, Reveal.getSlides().indexOf(curSection()) + 1]]; })();
    var S = slideSize(), d = busyDialog('Making PNG' + (all ? 's' : ''), 'Taking a picture of ' + list.length + ' slide' + (list.length === 1 ? '' : 's') + ' at ' + (S.w * 2) + '×' + (S.h * 2) + ' px…');
    post('/__png', { slides: list, w: S.w, h: S.h, hires: true }).then(function (j) {
      d.close();
      if (!j.ok && j.reason === 'no-browser') return resultDialog('No PNG', '<p>This needs Google Chrome (or Edge, Brave, Chromium) installed.</p>');
      resultDialog('PNG ready', '<p>' + (j.folder ? j.files.length + ' pictures in <code>' + esc(j.folder) + '</code>' : 'Saved <code>' + esc(j.files[0]) + '</code>') + '</p>', j.folder || j.files[0]);
    }).catch(function (e) { d.close(); resultDialog('No PNG', '<p>' + esc(e.message) + '</p>'); });
  }
  function exportSingle() {
    if (dirty) save(false);
    var d = busyDialog('Making a single file', 'Embedding pictures, videos, fonts and scripts into one HTML file…');
    post('/__export/single').then(function (j) {
      d.close();
      resultDialog('Single file ready', '<p>Saved <code>' + esc(j.file) + '</code> (' + (j.size / 1e6).toFixed(1) + ' MB). It opens in any browser on its own — email it or put it on a web page.</p>' +
        (j.missing.length ? '<p class="re-dim">Not found, left as links: ' + esc(j.missing.join(', ')) + '</p>' : '') +
        '<p class="re-dim">Embedded web pages are inlined; videos make the file big.</p>', j.file);
    }).catch(function (e) { d.close(); resultDialog('No file', '<p>' + esc(e.message) + '</p>'); });
  }
  function exportZip() {
    if (dirty) save(false);
    post('/__zip').then(function (j) {
      resultDialog('Zip ready', '<p>Saved <code>' + esc(j.file) + '</code> (' + j.count + ' files, ' + (j.size / 1e6).toFixed(1) + ' MB) — the whole presentation folder without backups.</p>', j.file);
    }).catch(function (e) { resultDialog('No zip', '<p>' + esc(e.message) + '</p>'); });
  }
  function importPptx() {
    var go = function (path) {
      var d = busyDialog('Importing PowerPoint', 'Converting the slides, pictures and videos… a minute for a big file.');
      post('/__import-pptx', { path: path || '' }).then(function (j) {
        d.close();
        if (j.cancelled) return;
        if (!j.ok && j.reason === 'deps') return resultDialog('Two packages needed', '<p>Importing PowerPoint files needs <code>lxml</code> and <code>Pillow</code> for the Python that runs deck. In Terminal, once:</p><p><code>' + esc(j.hint) + '</code></p><p class="re-dim">Then try again.</p>');
        if (j.url) window.open(j.url, '_blank');
        resultDialog('Imported', '<p>Made <code>' + esc(j.file) + '</code> and opened it in a new tab.</p>' + (j.log ? '<p class="re-dim">' + esc(j.log) + '</p>' : ''), j.file);
      }).catch(function (e) { d.close(); resultDialog('Import failed', '<p>' + esc(e.message) + '</p>'); });
    };
    if (CFG.platform === 'darwin') return go('');
    var p = prompt('Path of the .pptx file:', ''); if (p) go(p);
  }

  // ------------------------------------------------------------------ events
  function inField(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && t.closest('.re-ui'); }
  function onKey(e) {
    var mod = e.metaKey || e.ctrlKey, k = e.key;
    var stop = function () { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
    if (mod && k.toLowerCase() === 's') { stop(); save(false); return; }
    if (inField(e.target)) {
      if ((k === 'Enter' && e.target.tagName === 'INPUT') || k === 'Escape') { e.preventDefault(); e.target.blur(); if (editingEl) editingEl.focus(); }
      e.stopPropagation();
      return;
    }
    if (editingEl) {
      if (k === 'Escape') { stop(); endTextEdit(); }
      else if (mod && !e.shiftKey && k.toLowerCase() === 'k') { stop(); linkDialog(); }
      else if (onTextKey(e)) { e.stopPropagation(); }
      else e.stopPropagation();
      return;
    }
    if (cropMode && (k === 'Enter' || k === 'Escape')) { stop(); exitCrop(); return; }
    if (ui.help.classList.contains('re-open') && k === 'Escape') { stop(); toggleHelp(); return; }
    if (mod && k.toLowerCase() === 'z') { stop(); if (e.shiftKey) doRedo(); else doUndo(); return; }
    if (mod && k.toLowerCase() === 'y') { stop(); doRedo(); return; }
    if (k === '?' && !mod) { stop(); toggleHelp(); return; }
    // ⌘← / ⌘→ (Ctrl on Windows/Linux): move the slide (with its stack) left / right — even with an element selected
    if (mod && !e.altKey && !e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { stop(); moveUnit(k === 'ArrowLeft' ? -1 : 1); return; }
    // ⌘↑ / ⌘↓: move the slide up / down within its stack
    if (mod && !e.altKey && !e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) { stop(); moveInStack(k === 'ArrowUp' ? -1 : 1); return; }
    if (mod && !e.altKey && k.toLowerCase() === 'a') { stop(); selectAll(); return; }
    if (mod && !e.altKey && k.toLowerCase() === 'g') { stop(); if (e.shiftKey) ungroupSel(); else groupSel(); return; }
    if (mod && e.shiftKey && !e.altKey && k.toLowerCase() === 'n') { stop(); newSlideWithLayout(defaultNextLayout()); return; }
    if (mod && k === 'Enter') { stop(); present(false, e.shiftKey); return; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'f') { stop(); findDialog(); return; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'k') { stop(); linkDialog(); return; }
    if (mod && e.altKey && k.toLowerCase() === 'c') { stop(); copyStyle(); return; }
    if (mod && e.altKey && k.toLowerCase() === 'v') { stop(); pasteStyle(); return; }
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
      var txt = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\r\n?/g, '\n');
      insertLines(txt.split('\n'));
      onTextInput();
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
      var ph = topItem(e.target);
      if (ph && ph.classList.contains('pic') && ph.hasAttribute('data-ph') && !ph.querySelector('img') && /^image\//.test(e.dataTransfer.files[0].type)) { fillPicturePlaceholder(ph, e.dataTransfer.files[0]); return; }
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { addMedia(f, at); });
    });
    window.addEventListener('resize', function () { setTimeout(layoutChrome, 0); });
    Reveal.on('slidechanged', onSlide);
    Reveal.on('resize', function () { setTimeout(placeOverlay, 0); });
    Reveal.on('overviewshown', deselect);
    if (window.ResizeObserver) new ResizeObserver(function () { layoutChrome(); }).observe(ui.bar);
    var selTimer = null;
    document.addEventListener('selectionchange', function () { if (!editingEl) return; clearTimeout(selTimer); selTimer = setTimeout(updateTextControls, 80); });
  }

  boot();
})();
