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
