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
    var fr = frameOf(curSection()), items = Array.prototype.slice.call(fr.querySelectorAll('.fragment')).filter(function (f) { return !f.classList.contains('media-trigger') && topItem(f) === f || (topItem(f) && topItem(f).contains(f) && !f.classList.contains('media-trigger')); });
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
