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
