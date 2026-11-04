#!/usr/bin/env python3
"""deck.js = the editing engine (engine/editor.js, shared with reveal-edit) + the deck modules in parts/, with the engine patched where they meet."""
import os, re
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
s = open(os.path.join(root, 'engine', 'editor.js')).read()
P = lambda n: open(os.path.join(here, n)).read()

def rep(old, new, cnt=1):
    global s
    assert s.count(old) == cnt, (s.count(old), old[:90])
    s = s.replace(old, new)

def cut(start, end):          # remove [start, end) by unique markers
    global s
    i = s.index(start); j = s.index(end, i)
    s = s[:i] + s[j:]

# ---- header
rep("// reveal-edit — visual editor for reveal.js decks", "// deck — editor for presentations that live in HTML (reveal.js); built on reveal-edit's editing engine") if "// reveal-edit — visual editor for reveal.js decks" in s else None
rep("  var SNAP = 5;              // slide px", "  var SNAP = 5;              // slide px\n  var placingNow = false;")

# ---- boot / init
rep("""  function init() {
    origKeyboard = Reveal.getConfig().keyboard;
    Reveal.configure({ fragments: false });
    document.documentElement.classList.add('re-on');
    buildUI();
    checkStructure();
    bindEvents();
    layoutChrome();
    onSlide();
    toast('Edit mode — click to select, double-click text to edit, ? for shortcuts', 4000);
  }""", """  function init() {
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
    toast(META ? 'Click to select · double-click text to edit · + Slide for a new slide · ? for shortcuts' : 'Editing a presentation made elsewhere — Deck menu › Add deck theme & master for layouts and themes', 5000);
  }""")

# ---- master elements are not selectable on slides (only in master mode); pptx2reveal decorations stay selectable
rep("""    if (e.parentElement !== fr || skippable(e)) return null;
    return e;
  }""", """    if (e.parentElement !== fr || skippable(e)) return null;
    if (e.hasAttribute('data-master') && !masterMode) return null;
    return e;
  }""")

# ---- flushTouched: connected lines follow
rep("""  function flushTouched() {
    touched.forEach(function (e) {
      syncStyle(e);
      if (e.tagName.toLowerCase() === 'svg') syncAttrs(e, ['width', 'height', 'preserveAspectRatio']);
    });
    touched.clear();
    flushShapes();
  }""", """  function flushTouched() {
    updateConnectors(Array.from(touched));
    touched.forEach(function (e) {
      syncStyle(e);
      if (e.tagName.toLowerCase() === 'svg') syncAttrs(e, ['width', 'height', 'preserveAspectRatio']);
    });
    touched.clear();
    flushShapes();
  }""")

# ---- line ends remember the shape they snapped to
rep("""      [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]].forEach(function (f) {
        pts.push({ x: b.x + b.w * f[0], y: b.y + b.h * f[1] });
      });""", """      Object.keys(ANCHORS).forEach(function (name) {
        var q = anchorPos(o, name);
        pts.push({ x: q.x, y: q.y, el: o, anchor: name });
      });""")
rep("""    pts.forEach(function (q) { var d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= lim && (!best || d < best.d)) best = { x: q.x, y: q.y, d: d }; });""",
    """    pts.forEach(function (q) { var d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= lim && (!best || d < best.d)) best = { x: q.x, y: q.y, d: d, el: q.el || null, anchor: q.anchor || null }; });""")
rep("""    if (T.shape === 'line' && !(ev.metaKey || ev.ctrlKey)) { var s0 = snapPoint(p, anchors); if (s0) p = { x: s0.x, y: s0.y }; }
    disarmTool();
    var node = insertItem(shapeHTML(T.shape, T.arrow, p.x, p.y, 0, 0));
    if (!node) return;
    renderShape(node);
    gesture = { kind: 'draw', el: node, p0: p, shape: T.shape, x0: ev.clientX, y0: ev.clientY, moved: false, anchors: anchors };""",
"""    var s0 = null;
    if (T.shape === 'line' && !(ev.metaKey || ev.ctrlKey)) { s0 = snapPoint(p, anchors); if (s0) p = { x: s0.x, y: s0.y }; }
    disarmTool();
    var node = insertItem(shapeHTML(T.shape, T.arrow, p.x, p.y, 0, 0));
    if (!node) return;
    renderShape(node);
    if (s0 && s0.el) setLink(node, 1, s0.el, s0.anchor);
    gesture = { kind: 'draw', el: node, p0: p, shape: T.shape, x0: ev.clientX, y0: ev.clientY, moved: false, anchors: anchors };""")
rep("""      if (sn) q = sn;
      showSnapDot(sn);
      if (g.end === 1) setLineAbs(g.el, q.x, q.y, fixed.x, fixed.y); else setLineAbs(g.el, fixed.x, fixed.y, q.x, q.y);""",
"""      if (sn) q = sn;
      showSnapDot(sn);
      setLink(g.el, g.end, sn && sn.el ? sn.el : null, sn && sn.anchor);
      if (g.end === 1) setLineAbs(g.el, q.x, q.y, fixed.x, fixed.y); else setLineAbs(g.el, fixed.x, fixed.y, q.x, q.y);""")
rep("""      if (sn2) q2 = sn2;
      showSnapDot(sn2);
      setLineAbs(g.el, g.p0.x, g.p0.y, q2.x, q2.y);""", """      if (sn2) q2 = sn2;
      showSnapDot(sn2);
      setLink(g.el, 2, sn2 && sn2.el ? sn2.el : null, sn2 && sn2.anchor);
      setLineAbs(g.el, g.p0.x, g.p0.y, q2.x, q2.y);""")

# ---- new text boxes and shape text follow the theme
rep("""    var conv = isConverted();
    var font = conv ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;color:#ffffff;" : '';""",
"""    var conv = isConverted();
    var font = isDeck() ? 'font-family:var(--dk-font);color:var(--dk-text);' : conv ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;color:#ffffff;" : '';""")
rep("""    var font = isConverted() ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;" : '';
    tx = el('div',""", """    var font = isDeck() ? 'font-family:var(--dk-font);' : isConverted() ? "font-family:Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif;" : '';
    tx = el('div',""")
rep("""text-align:center;line-height:1.2;font-size:24px;color:#ffffff;' + font + '"><br></div></div>';""",
    """text-align:center;line-height:1.2;font-size:24px;color:' + (isDeck() ? themeDefaults().text : '#ffffff') + ';' + font + '"><br></div></div>';""")

# ---- selection overlay: rotation, rotate handle, crop ghost
rep("""    var r = rectOf(sel);
    var s = ui.sel.style;
    s.display = 'block'; s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    var movable = isPositioned(sel);""", """    var r = rectOf(sel), rot = isPositioned(sel) ? rotOf(sel) : 0;
    if (rot) { var bb = boxOf(sel), q0 = frameToScreen(bb.x, bb.y), sc = scale(); r = { left: q0.x, top: q0.y, width: bb.w * sc, height: bb.h * sc }; }
    var s = ui.sel.style;
    s.display = 'block'; s.left = r.left + 'px'; s.top = r.top + 'px'; s.width = r.width + 'px'; s.height = r.height + 'px';
    s.transform = rot ? 'rotate(' + rot + 'deg)' : '';
    ui.rot.style.display = isPositioned(sel) && !line ? 'block' : 'none';
    ui.sel.classList.toggle('re-cropping', cropMode === sel);
    placeCropGhost();
    var movable = isPositioned(sel);""")
rep("""  function placeOverlay() {
    ui.ep[0].style.display = ui.ep[1].style.display = 'none';
    if (isMulti()) { placeMulti(); return; }""", """  function placeOverlay() {
    ui.ep[0].style.display = ui.ep[1].style.display = 'none';
    ui.sel.style.transform = '';
    if (isMulti()) { ui.rot.style.display = 'none'; placeMulti(); return; }""")
rep("""    ui.selLabel.textContent = movable ? Math.round(b.x) + ', ' + Math.round(b.y) + '  ' + Math.round(b.w) + '×' + Math.round(b.h) + build : 'not positioned' + build;
  }""", """    ui.selLabel.textContent = movable ? Math.round(b.x) + ', ' + Math.round(b.y) + '  ' + Math.round(b.w) + '×' + Math.round(b.h) + (rot ? ' · ' + rot + '°' : '') + build : 'not positioned' + build;
  }""")

# ---- mouse: rotate handle, crop panning, crop exit on click elsewhere
rep("""    if (t.closest && t.closest('.re-ui')) {
      if (t.classList.contains('re-h') && sel) startResize(ev, t.getAttribute('data-dir'));
      if (t.classList.contains('re-ep') && sel) startEndpoint(ev, +t.getAttribute('data-end'));
      return;
    }""", """    if (t.closest && t.closest('.re-ui')) {
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
    }""")
rep("""    if (gesture.kind === 'draw' || gesture.kind === 'endpoint') { dragShape(ev); return; }
    if (gesture.kind === 'marquee') { dragMarquee(ev); return; }
    var g = gesture, s = scale();
    var dx = (ev.clientX - g.x0) / s, dy = (ev.clientY - g.y0) / s;""", """    if (gesture.kind === 'draw' || gesture.kind === 'endpoint') { dragShape(ev); return; }
    if (gesture.kind === 'marquee') { dragMarquee(ev); return; }
    if (gesture.kind === 'rotate') { dragRotate(ev); return; }
    var g = gesture, s = scale();
    var dx = (ev.clientX - g.x0) / s, dy = (ev.clientY - g.y0) / s;
    if (g.kind === 'pan') {
      if (!g.moved) { if (Math.abs(ev.clientX - g.x0) + Math.abs(ev.clientY - g.y0) < 3) return; g.moved = true; snapshot(); }
      setImgWorld(g.el, { x: g.W.x + dx, y: g.W.y + dy, w: g.W.w, h: g.W.h });
      placeCropGhost();
      return;
    }""")
rep("""      var d = g.dir, nx = b.x, ny = b.y, nw = b.w, nh = b.h;
      if (d.indexOf('e') >= 0) nw = b.w + dx;""", """      var d = g.dir, nx = b.x, ny = b.y, nw = b.w, nh = b.h, rot = rotOf(e);
      if (rot) { var loc = toLocal(dx, dy, rot); dx = loc.x; dy = loc.y; }
      if (d.indexOf('e') >= 0) nw = b.w + dx;""")
rep("""      nw = Math.max(nw, 2); nh = Math.max(nh, 2);
      e.style.left = px(nx); e.style.top = px(ny); touched.add(e);
      applySize(e, nw, nh);""", """      nw = Math.max(nw, 2); nh = Math.max(nh, 2);
      if (rot) { var fix = keepOpposite(b, nx, ny, nw, nh, rot); nx = fix.x; ny = fix.y; }
      e.style.left = px(nx); e.style.top = px(ny); touched.add(e);
      applySize(e, nw, nh);
      if (cropMode === e && g.W) { setImgWorld(e, g.W); placeCropGhost(); }""")
rep("""    gesture = { kind: 'resize', el: sel, dir: dir, x0: ev.clientX, y0: ev.clientY, b: boxOf(sel), moved: false,
                keep: /^(IMG|VIDEO)$/.test(sel.tagName) || sel.classList.contains('pic') || sel.classList.contains('vidwrap') };""",
"""    gesture = { kind: 'resize', el: sel, dir: dir, x0: ev.clientX, y0: ev.clientY, b: boxOf(sel), moved: false,
                keep: !(cropMode === sel) && (/^(IMG|VIDEO)$/.test(sel.tagName) || sel.classList.contains('pic') || sel.classList.contains('vidwrap')),
                W: cropMode === sel ? imgWorld(sel) : null };""")
rep("""    if (g.kind === 'marquee') { ui.marquee.style.display = 'none'; return; }
    if (g.moved) { flushTouched(); markDirty(); placeOverlay(); updateFields(); }""", """    if (g.kind === 'marquee') { ui.marquee.style.display = 'none'; return; }
    if (g.kind === 'pan') { if (g.moved) { syncWhole(g.el); markDirty(); } return; }
    if (g.kind === 'rotate') { if (g.moved) { flushTouched(); markDirty(); } placeOverlay(); updateFields(); return; }
    if (g.moved) { flushTouched(); markDirty(); placeOverlay(); updateFields(); }""")
rep("""    if (!g.moved) { if (Math.abs(ev.clientX - g.x0 || 0) + 0 < 0) return; g.moved = true; snapshot(); }""",
    """    if (!g.moved) { g.moved = true; snapshot(); }""") if False else None

# ---- double-click: empty picture placeholder -> choose a picture
rep("""    if (isShp(it) && !it.querySelector('.tb')) editShapeText(it);
    else if (textTarget(it, t)) startTextEdit(it, ev);""", """    if (it.classList.contains('pic') && it.hasAttribute('data-ph') && !it.querySelector('img')) pickFile(function (f) { fillPicturePlaceholder(it, f); }, 'image/*');
    else if (isShp(it) && !it.querySelector('.tb')) editShapeText(it);
    else if (textTarget(it, t)) startTextEdit(it, ev);""")

# ---- text editing: placeholders, paragraph keys
rep("""    select(it);
    editBefore = { html: srcRoot().innerHTML, idx: Reveal.getIndices() };
    editingEl = target;""", """    select(it);
    editBefore = { html: srcRoot().innerHTML, idx: Reveal.getIndices() };
    var ph = it.closest('[data-ph]'); if (ph) { ph.removeAttribute('data-empty'); if (!(target.textContent || '').length && !target.querySelector('.p br')) { var p0 = target.querySelector('.p'); if (p0 && !p0.textContent) p0.innerHTML = '<br>'; } }
    editingEl = target;""")
rep("""    var src = srcOf(t);
    if (src && src.innerHTML !== t.innerHTML) {
      undoStack.push(editBefore); redoStack.length = 0;
      src.innerHTML = t.innerHTML;
      markDirty();
      refit(t.closest('.tx'));
    }
    Reveal.configure({ keyboard: origKeyboard });""", """    var src = srcOf(t);
    if (src && src.innerHTML !== t.innerHTML) {
      undoStack.push(editBefore); redoStack.length = 0;
      src.innerHTML = t.innerHTML;
      markDirty();
      refit(t.closest('.tx'));
    }
    updateEmpty(t.closest('[data-ph]'));
    Reveal.configure({ keyboard: origKeyboard });""")
rep("""    if (editingEl) {
      if (k === 'Escape') { stop(); endTextEdit(); }
      else e.stopPropagation();
      return;
    }""", """    if (editingEl) {
      if (k === 'Escape') { stop(); endTextEdit(); }
      else if (onTextKey(e)) { e.stopPropagation(); }
      else e.stopPropagation();
      return;
    }
    if (cropMode && (k === 'Enter' || k === 'Escape')) { stop(); exitCrop(); return; }""")
rep("""    if (editingEl) {          // paste plain text only, so foreign formatting doesn't leak in
      e.preventDefault();
      var txt = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, txt);
      return;
    }""", """    if (editingEl) {          // paste plain text only, so foreign formatting doesn't leak in
      e.preventDefault();
      var txt = (e.clipboardData || window.clipboardData).getData('text/plain').replace(/\\r\\n?/g, '\\n');
      insertLines(txt.split('\\n'));
      onTextInput();
      return;
    }""")

# ---- keys: groups, new slide, present, stacks
rep("""    if (mod && !e.altKey && k.toLowerCase() === 'a') { stop(); selectAll(); return; }""", """    if (mod && !e.altKey && k.toLowerCase() === 'a') { stop(); selectAll(); return; }
    if (mod && !e.altKey && k.toLowerCase() === 'g') { stop(); if (e.shiftKey) ungroupSel(); else groupSel(); return; }
    if (mod && e.shiftKey && !e.altKey && k.toLowerCase() === 'n') { stop(); newSlideWithLayout(defaultNextLayout()); return; }
    if (mod && k === 'Enter') { stop(); present(false, e.shiftKey); return; }""")

# ---- deleting: connected lines let go
rep("""    var list = selList(), srcs = list.map(srcOf);    // find every source before removing any (paths come from the live tree)
    snapshot();""", """    var list = selList(), srcs = list.map(srcOf);    // find every source before removing any (paths come from the live tree)
    snapshot();
    dropLinksTo(list);""")

# ---- Tab cycles over slide content, not master elements
rep("""  function cycle(d) {
    var list = items();""", """  function cycle(d) {
    var list = items().filter(function (e) { return !e.hasAttribute('data-master') || masterMode; });""")

# ---- fields: rotation, crop button, text controls
rep("""    document.documentElement.classList.toggle('re-has-sel', !!sel);
    ui.build.classList.toggle('re-active', !!sel && sel.classList.contains('fragment'));
    updateStyleControls();
  }""", """    document.documentElement.classList.toggle('re-has-sel', !!sel);
    ui.build.classList.toggle('re-active', !!sel && sel.classList.contains('fragment'));
    if (ui.fRot) { ui.fRot.disabled = !on; ui.fRot.value = on ? Math.round(rotOf(sel)) : ''; }
    if (ui.cropBtn) { ui.cropBtn.disabled = !(sel && isPic(sel)); ui.cropBtn.classList.toggle('re-active', !!cropMode); }
    updateStyleControls();
    updateTextControls();
    updateMediaOpts();
  }""")
rep("""      document.documentElement.classList.add('re-has-sel');
      ui.build.classList.toggle('re-active', multi.every(function (e) { return e.classList.contains('fragment'); }));
      updateStyleControls();
      return;""", """      document.documentElement.classList.add('re-has-sel');
      ui.build.classList.toggle('re-active', multi.every(function (e) { return e.classList.contains('fragment'); }));
      if (ui.fRot) { ui.fRot.disabled = true; ui.fRot.value = ''; }
      if (ui.cropBtn) ui.cropBtn.disabled = true;
      updateStyleControls();
      updateTextControls();
      updateMediaOpts();
      return;""")

# ---- dirty / rebuild / slide change hooks
rep("""  function markDirty() {
    dirty = true;
    ui.save.classList.add('re-dirty');
    ui.save.textContent = 'Save •';
  }""", """  function markDirty() {
    dirty = true;
    ui.save.classList.add('re-dirty');
    ui.save.textContent = 'Save •';
    refreshThumbSoon();
  }""")
rep("""    if (typeof window.fitAround === 'function') { try { window.fitAround(); } catch (err) { /* ignore */ } }
    onSlide();
  }""", """    if (typeof window.fitAround === 'function') { try { window.fitAround(); } catch (err) { /* ignore */ } }
    buildFilm();
    onSlide();
  }""")
rep("""    ui.where.textContent = 'slide ' + n + '/' + Reveal.getTotalSlides() + (i.v ? '  (stack ' + (i.v + 1) + ')' : '') + (tag ? '  · PowerPoint #' + tag : '');
    loadNotes();
  }""", """    ui.where.textContent = masterMode ? 'master' : 'slide ' + n + '/' + Reveal.getTotalSlides() + (i.v ? '  (stack ' + (i.v + 1) + ')' : '') + (tag ? '  · PowerPoint #' + tag : '');
    if (cropMode) exitCrop();
    loadNotes();
    markCurrentThumb();
    updateSlidePanel();
    updateBuildsPanel();
    updateTextControls();
  }""")

# ---- save: stamp the master (numbers) first
rep("""  function save(force) {
    if (editingEl) endTextEdit();
    if (notesTimer) writeNotes();""", """  function save(force) {
    if (editingEl) endTextEdit();
    if (masterMode) exitMaster(true);
    if (notesTimer) writeNotes();
    if (META) stampMaster();""")

# ---- drop onto an empty picture placeholder fills it
rep("""      var at = slidePoint(e);
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { addMedia(f, at); });""", """      var at = slidePoint(e);
      var ph = topItem(e.target);
      if (ph && ph.classList.contains('pic') && ph.hasAttribute('data-ph') && !ph.querySelector('img') && /^image\\//.test(e.dataTransfer.files[0].type)) { fillPicturePlaceholder(ph, e.dataTransfer.files[0]); return; }
      Array.prototype.forEach.call(e.dataTransfer.files, function (f) { addMedia(f, at); });""")
rep("""    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
    if (window.ResizeObserver) new ResizeObserver(function () { layoutChrome(); }).observe(ui.bar);""",
"""    if (window.ResizeObserver) new ResizeObserver(function () { layoutChrome(); }).observe(ui.bar);
    var selTimer = null;
    document.addEventListener('selectionchange', function () { if (!editingEl) return; clearTimeout(selTimer); selTimer = setTimeout(updateTextControls, 80); });""")

# ---- Enter in a toolbar field must not reach the text being edited; clicking the slide takes focus out of fields
rep("""      if ((k === 'Enter' && e.target.tagName === 'INPUT') || k === 'Escape') { e.target.blur(); if (k === 'Escape') e.preventDefault(); }""",
    """      if ((k === 'Enter' && e.target.tagName === 'INPUT') || k === 'Escape') { e.preventDefault(); e.target.blur(); if (editingEl) editingEl.focus(); }""")
rep("""    if (!t.closest || !t.closest('.reveal') || t.closest('.reveal .controls, .reveal .progress') || Reveal.isOverview()) return;""",
    """    if (!t.closest || !t.closest('.reveal') || t.closest('.reveal .controls, .reveal .progress') || Reveal.isOverview()) return;
    if (document.activeElement && inField(document.activeElement)) document.activeElement.blur();""")

# ---- phase 2: tables edit per cell; equations open on double-click; keys
rep("""  function textTarget(it, t) {
    var tb = it.querySelector('.tb') || (it.classList.contains('tb') ? it : null);""", """  function textTarget(it, t) {
    if (isTable(it)) { var cell = t && t.closest && t.closest('td, th'); return cell && it.contains(cell) ? cell : it.querySelector('td, th'); }
    var tb = it.querySelector('.tb') || (it.classList.contains('tb') ? it : null);""")
rep("""    if (it.classList.contains('pic') && it.hasAttribute('data-ph') && !it.querySelector('img')) pickFile(function (f) { fillPicturePlaceholder(it, f); }, 'image/*');""",
    """    var mth = t.closest && t.closest('.math[data-tex]');
    if (mth && it.contains(mth)) { if (editingEl) endTextEdit(); select(it); equationDialog(mth); return; }
    if (it.classList.contains('pic') && it.hasAttribute('data-ph') && !it.querySelector('img')) pickFile(function (f) { fillPicturePlaceholder(it, f); }, 'image/*');""")
rep("""    if (mod && k === 'Enter') { stop(); present(false, e.shiftKey); return; }""", """    if (mod && k === 'Enter') { stop(); present(false, e.shiftKey); return; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'f') { stop(); findDialog(); return; }
    if (mod && !e.shiftKey && k.toLowerCase() === 'k') { stop(); linkDialog(); return; }
    if (mod && e.altKey && k.toLowerCase() === 'c') { stop(); copyStyle(); return; }
    if (mod && e.altKey && k.toLowerCase() === 'v') { stop(); pasteStyle(); return; }""")
# ⌘K and equations also while editing text
rep("""      if (k === 'Escape') { stop(); endTextEdit(); }
      else if (onTextKey(e)) { e.stopPropagation(); }""", """      if (k === 'Escape') { stop(); endTextEdit(); }
      else if (mod && !e.shiftKey && k.toLowerCase() === 'k') { stop(); linkDialog(); }
      else if (onTextKey(e)) { e.stopPropagation(); }""")
# Fill / Line on a table paint its cells
rep("""    var fits = function (e) { var k = styleKind(e); return !(prop === 'arrow' && k !== 'line') && !(prop === 'fill' && k === 'line'); };""",
    """    if (sel && isTable(sel) && (prop === 'fill' || prop === 'stroke')) { if (prop === 'fill') tableFill(value); else tableBorders(value); return; }
    var fits = function (e) { var k = styleKind(e); return !(prop === 'arrow' && k !== 'line') && !(prop === 'fill' && k === 'line'); };""")
# equations render after load / rebuild
rep("""    buildFilm();
    onSlide();
    setTimeout(layoutChrome, 50);""", """    buildFilm();
    onSlide();
    setTimeout(layoutChrome, 50);
    renderAllMath();""")
rep("""    buildFilm();
    onSlide();
  }""", """    buildFilm();
    onSlide();
    renderAllMath();
  }""")

# ---- the old chrome goes; the new modules come in
cut("  function buildUI() {", "  var savedRange = null;")
cut("  function toggleHelp() { ui.help.classList.toggle('re-open'); }", "  var toastTimer = null;")
rep("""  // ------------------------------------------------------------------ events
  function inField(t)""", "\n".join(P(n) for n in ('model.js', 'text.js', 'arrange.js', 'panels.js', 'ui.js', 'phase2.js')) + """
  // ------------------------------------------------------------------ events
  function inField(t)""")
# the old help text lines and the old shortcuts table are gone with buildUI; textBoxes stays (used by text.js)
s = s.replace("""    if (!g.moved) { if (Math.abs(ev.clientX - g.x0 || 0) + 0 < 0) return; g.moved = true; snapshot(); }""", """    if (!g.moved) { g.moved = true; snapshot(); }""")
s = s.replace("""    var fr = frameOf(curSection()), items = Array.prototype.slice.call(fr.querySelectorAll('.fragment')).filter(function (f) { return !f.classList.contains('media-trigger') && topItem(f) === f || (topItem(f) && topItem(f).contains(f) && !f.classList.contains('media-trigger')); });""",
              """    var fr = frameOf(curSection()), items = Array.prototype.slice.call(fr.querySelectorAll('.fragment')).filter(function (f) { return !f.classList.contains('media-trigger'); });""")
open(os.path.join(root, 'deck.js'), 'w').write(s)
print('assembled deck.js: %d lines' % s.count('\n'))
