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
