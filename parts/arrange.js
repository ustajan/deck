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
    if (!g.moved) { if (Math.abs(ev.clientX - g.x0 || 0) + 0 < 0) return; g.moved = true; snapshot(); }
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
