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
