#!/usr/bin/env python3
"""deck — a pared-down PowerPoint for presentations that live in HTML (reveal.js).

    deck new "My talk"               make a new presentation (a folder My talk/ with my-talk.html) and open it
    deck                             open the presentation in the current folder (or choose one)
    deck path/to/talk.html           open that presentation
    deck DECK_FOLDER                 open the presentation in that folder

The editor runs in your browser: a filmstrip of slides on the left, the slide in the middle, properties on
the right. Text boxes with bullets, shapes and arrows, pictures, videos, embedded web pages, builds,
transitions, speaker notes, light / dark themes with your own background picture, PDF export. Save (Cmd/Ctrl+S)
writes the HTML file back; earlier versions are kept in the deck's _backups/ folder. The result presents in
any browser without this tool. Only this computer can reach the editor (127.0.0.1).

The editor stops by itself a few seconds after you close its browser tab (or press Ctrl+C).
Opening a deck that is already open just opens another tab on the running editor.

Standard library only (Python 3.8+).
"""
import argparse
import base64
import datetime
import hashlib
import http.server
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sys
import tempfile
import subprocess
import threading
import time
import urllib.parse
import urllib.request
import webbrowser

VERSION = '0.1.0'
HERE = os.path.dirname(os.path.abspath(__file__))
EDITOR_FILES = {'deck.js': 'application/javascript', 'deck.css': 'text/css'}
EMBEDDED = {}   # the single-file build (deck) carries deck.js / deck.css here, base64-encoded
GRACE = 8                 # seconds after the last editor tab closes before the editor stops
STALE = 3 * 3600          # a tab silent this long (crashed browser) no longer keeps the editor alive
NO_TAB = 15 * 60          # stop if no editor tab ever connects within this time
GUI = False               # started from the Finder app: report problems in a dialog


def editor_asset(name):
    if name in EMBEDDED:
        import base64
        return base64.b64decode(EMBEDDED[name])
    p = os.path.join(HERE, name)
    return open(p, 'rb').read() if os.path.isfile(p) else None


def aq(text):
    """AppleScript string literal"""
    return '"' + str(text).replace('\\', '\\\\').replace('"', '\\"') + '"'


def say(msg, error=False):
    print(msg, file=sys.stderr if error else sys.stdout)
    if GUI and error and sys.platform == 'darwin':
        script = 'display alert "Deck" message %s as warning' % aq(msg)
        subprocess.run(['osascript', '-e', script], capture_output=True)
UPLOAD_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.webm', '.mov', '.m4v', '.mp3', '.m4a', '.wav', '.html', '.htm'}
KEEP_BACKUPS = 60
PRINT_JS = ('<style>html.reveal-print .reveal .speaker-notes-pdf[data-layout=separate-page] { background: #fff !important;'
            ' color: #111 !important; box-sizing: border-box; min-height: 100vh; padding: 56px 72px !important;'
            ' font: 22px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; text-align: left; }</style>\n'
            '<script>(function () { function go() {'
            ' document.querySelectorAll(".reveal .slides iframe[data-src]").forEach(function (f) {'
            ' if (!f.getAttribute("src")) f.setAttribute("src", f.getAttribute("data-src")); }); }'
            ' if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go(); })();</script>\n')
AUTOPRINT_JS = ('<script>(function () { var done = false; function pr() { if (done) return; done = true; setTimeout(function () { window.print(); }, 1500); }'
                ' if (window.Reveal && Reveal.on) Reveal.on("pdf-ready", pr);'
                ' window.addEventListener("load", function () { setTimeout(pr, 6000); }); })();</script>\n')
# media an element pasted from another presentation may bring along
IMPORT_EXT = UPLOAD_EXT | {'.bmp', '.tif', '.tiff', '.avif', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.ogv',
                           '.html', '.htm', '.pdf'}
IMPORT_MAX = 4 * 1024 ** 3
mimetypes.add_type('font/woff2', '.woff2')
mimetypes.add_type('font/woff', '.woff')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('video/quicktime', '.mov')


# ----------------------------------------------------------------------------- the deck file format
# A deck is a reveal.js presentation: NAME.html + media/ + lib/reveal/ + fonts/. Every slide is a 1280x720
# (or 1024x768) canvas (<div class="sf">) holding absolutely positioned elements (<div class="e">): text boxes
# (.tx > .tb > .p > spans), shapes (.shp with an SVG), pictures (.pic > img), videos (.vidwrap > video) and
# embedded pages (.embed > iframe). The HTML file also carries the deck's settings (#deck-meta), its theme
# (#deck-theme) and the master elements stamped onto every slide (#deck-master). The same conventions as
# pptx2reveal, so reveal-edit opens these decks too, and the file presents in any browser without this tool.

DECK_FORMAT = 1
VENDOR_FILES = ('lib/reveal/reveal.css', 'lib/reveal/reveal.js', 'lib/reveal/LICENSE', 'lib/reveal/plugin/notes/notes.js',
                'fonts/fonts.css')     # + every fonts/*.woff2 (see vendor_list)
VENDOR = {}      # path -> base64 (single-file build); the development tree reads ./vendor instead
VENDOR_OPT = {}  # optional extras written into a deck when first used (KaTeX for equations)
PPTX2REVEAL = ''  # the converter, base64 (single-file build); the development tree reads ./pptx2reveal.py

PAGE_CSS = r"""
html, body, .reveal-viewport { background: #000; }
.reveal .slides { text-align: left; }
.reveal .slides section { padding: 0 !important; }
.reveal .sf { position: absolute; left: 0; top: 0; width: %(W)spx; height: %(H)spx; overflow: hidden;
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; font-kerning: normal; }
.reveal .sf .e { position: absolute; box-sizing: border-box; transform-origin: 50%% 50%%; }
.reveal .sf .g { overflow: visible; }
.reveal .sf svg.geo { position: absolute; overflow: visible; pointer-events: none; }
.reveal .sf .tx { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; overflow: visible;
  transform-origin: 50%% 50%%; }
.reveal .sf .tx .p { margin: 0; white-space: pre-wrap; overflow-wrap: break-word; word-wrap: break-word; }
.reveal .sf .tx.nowrap .p { white-space: pre; width: max-content; position: relative; }
.reveal .sf .tx.nowrap .p-c { left: 50%%; transform: translateX(-50%%); }
.reveal .sf .tx.nowrap .p-r { left: 100%%; transform: translateX(-100%%); }
.reveal .sf .bu { display: inline-block; text-indent: 0; white-space: pre; line-height: 1; }
.reveal .sf .bu i { display: inline-block; background: currentColor; }
.reveal .sf .bu i.bdot { border-radius: 50%%; }
.reveal .sf .p[data-bu] { position: relative; padding-left: 1.15em; }
.reveal .sf .p[data-bu]::before { position: absolute; left: 0; top: 0; }
.reveal .sf .p[data-bu="dot"]::before { content: "\2022"; }
.reveal .sf .p[data-bu="dot"][data-lvl="1"]::before { content: "\2013"; }
.reveal .sf .p[data-bu="dot"][data-lvl="2"]::before { content: "\25AA"; }
.reveal .sf .p[data-bu="dot"][data-lvl="3"]::before { content: "\2013"; }
.reveal .sf .p[data-bu="dot"][data-lvl="4"]::before { content: "\25AA"; }
.reveal .sf .p[data-lvl="1"] { margin-left: 1.5em; } .reveal .sf .p[data-lvl="2"] { margin-left: 3em; }
.reveal .sf .p[data-lvl="3"] { margin-left: 4.5em; } .reveal .sf .p[data-lvl="4"] { margin-left: 6em; }
.reveal .sf .tb { counter-reset: n0 n1 n2 n3 n4; }
.reveal .sf .p[data-bu="num"] { padding-left: 1.5em; }
.reveal .sf .p[data-bu="num"]:not([data-lvl]), .reveal .sf .p[data-bu="num"][data-lvl="0"] { counter-increment: n0; counter-reset: n1 n2 n3 n4; }
.reveal .sf .p[data-bu="num"][data-lvl="1"] { counter-increment: n1; counter-reset: n2 n3 n4; }
.reveal .sf .p[data-bu="num"][data-lvl="2"] { counter-increment: n2; counter-reset: n3 n4; }
.reveal .sf .p[data-bu="num"][data-lvl="3"] { counter-increment: n3; counter-reset: n4; }
.reveal .sf .p[data-bu="num"][data-lvl="4"] { counter-increment: n4; }
.reveal .sf .p[data-bu="num"]:not([data-lvl])::before, .reveal .sf .p[data-bu="num"][data-lvl="0"]::before { content: counter(n0) "."; }
.reveal .sf .p[data-bu="num"][data-lvl="1"]::before { content: counter(n1, lower-alpha) "."; }
.reveal .sf .p[data-bu="num"][data-lvl="2"]::before { content: counter(n2, lower-roman) "."; }
.reveal .sf .p[data-bu="num"][data-lvl="3"]::before { content: counter(n3) "."; }
.reveal .sf .p[data-bu="num"][data-lvl="4"]::before { content: counter(n4, lower-alpha) "."; }
.reveal .sf .pic { overflow: hidden; }
.reveal .sf .pic img { display: block; position: absolute; left: 0; top: 0; max-width: none; max-height: none;
  margin: 0; border: 0; box-shadow: none; background: none; user-select: none; }
.reveal .sf .pic:not(.crop) img { position: static; }
.reveal .sf .vidwrap { overflow: hidden; background: #000; }
.reveal .sf .vidwrap video.vid { position: absolute; display: block; object-fit: fill; cursor: pointer; max-width: none; max-height: none; margin: 0; }
.reveal .sf .embed { overflow: hidden; }
.reveal .sf .embed iframe { border: 0; display: block; }
.reveal .sf a { text-decoration: none; color: inherit; }
.reveal .sf .fragment.appear { transition: none; }
.reveal .sf .media-trigger { position: absolute; width: 0; height: 0; }
.reveal .sf .e[data-empty] { visibility: hidden; }
.reveal .sf table.tbl { border-collapse: collapse; table-layout: fixed; }
.reveal .sf .math .katex { font-size: 1.1em; }
.reveal .sf table.tbl td, .reveal .sf table.tbl th { vertical-align: top; padding: .25em .5em; overflow-wrap: break-word; }
"""

PAGE_JS = r"""
// Space / PageDown / N (and presentation clickers) follow the main storyline: they finish the current
// slide's builds, then go right, skipping vertical stacks of detail slides. Press Down to enter a stack;
// once inside, Space/PageDown keep going down it and continue right after its last slide.
function advance() {
  if (Reveal.availableFragments().next) { Reveal.nextFragment(); return; }
  var r = Reveal.availableRoutes(), i = Reveal.getIndices();
  if (i.v > 0 && r.down) Reveal.down();
  else if (r.right) Reveal.slide(i.h + 1, 0);
  else if (r.down) Reveal.down();
}
function retreat() {
  if (Reveal.availableFragments().prev) { Reveal.prevFragment(); return; }
  var i = Reveal.getIndices();
  if (i.v > 0) Reveal.up();
  else if (i.h > 0) Reveal.slide(i.h - 1, 0);
}
Reveal.initialize({
  keyboard: {
    32: function (e) { if (e && e.shiftKey) retreat(); else advance(); },  // Space
    34: advance, 78: advance,    // PageDown, N
    33: retreat, 80: retreat     // PageUp, P
  },
  width: %(W)s, height: %(H)s, margin: 0, minScale: 0.05, maxScale: 6,
  center: false, controls: false, progress: false, slideNumber: false,
  hash: true, history: false, transition: 'none', backgroundTransition: 'none',
  pdfMaxPagesPerSlide: 1, pdfSeparateFragments: false,
  plugins: typeof RevealNotes !== 'undefined' ? [ RevealNotes ] : []
});
// click a video to pause / resume it
document.querySelectorAll('.reveal video.vid').forEach(function (v) {
  v.addEventListener('click', function () { if (v.paused) v.play(); else v.pause(); });
});
// "shrink text on overflow": text boxes marked data-autofit scale their text down until it fits the box
function fitText(section) {
  if (!section || section.dataset.fitted) return;
  var frame = section.querySelector('.sf');
  var shown = frame && frame.offsetHeight > 0;   // display:none slides cannot be measured yet
  if (!shown) return;
  var boxes = section.querySelectorAll('.tx[data-autofit]');
  boxes.forEach(function (tx) {
    var tb = tx.firstElementChild; if (!tb) return;
    tx.style.removeProperty('--fs');
    var cs = getComputedStyle(tx);
    var avail = tx.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) + 1;
    if (tb.offsetHeight <= avail) return;
    var lo = 0.4, hi = 1;
    for (var k = 0; k < 9; k++) {
      var mid = (lo + hi) / 2;
      tx.style.setProperty('--fs', mid);
      if (tb.offsetHeight <= avail) lo = mid; else hi = mid;
    }
    tx.style.setProperty('--fs', lo);
  });
  section.dataset.fitted = 1;
}
function fitAround() {
  var cur = Reveal.getCurrentSlide();
  fitText(cur);
  Reveal.getSlides().forEach(function (s) { if (s.style.display !== 'none') fitText(s); });
}
(document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () {
  if (Reveal.isReady()) fitAround(); else Reveal.on('ready', fitAround);
  Reveal.on('slidechanged', fitAround);
});
// navigation keys pressed inside an embedded page arrive here
window.addEventListener('message', function (ev) {
  var m = null;
  try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (err) { return; }
  if (!m || !(m.pptx2reveal || m.deck)) return;
  var act = { advance: advance, retreat: retreat, left: function () { Reveal.left(); }, right: function () { Reveal.right(); },
              up: function () { Reveal.up(); }, down: function () { Reveal.down(); } }[m.pptx2reveal || m.deck];
  if (act) act();
});
// after navigating away from a slide with an embedded page, give keyboard focus back to the deck
Reveal.on('slidechanged', function () {
  var a = document.activeElement;
  if (a && a.tagName === 'IFRAME' && !Reveal.getCurrentSlide().contains(a)) { a.blur(); window.focus(); }
});
// videos that start on a click step
Reveal.on('fragmentshown', function (ev) {
  ev.fragments.forEach(function (f) {
    if (!f.classList.contains('media-trigger')) return;
    var idx = f.getAttribute('data-fragment-index');
    var sec = f.closest('section');
    sec.querySelectorAll('video[data-play-on-fragment="' + idx + '"]').forEach(function (v) { v.currentTime = 0; v.play(); });
  });
});
// opened with ?present (from the editor's Present button): one click starts full screen — and, with
// ?presenter, the presenter view with notes, timer and the next slide
(function () {
  var q = location.search;
  if (!/[?&]present(er)?\b/.test(q)) return;
  var presenter = /[?&]presenter\b/.test(q);
  var ov = document.createElement('div');
  ov.id = 'deck-start';
  ov.setAttribute('style', 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);color:#fff;font:16px/1.4 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;');
  ov.innerHTML = '<div style="text-align:center;max-width:520px;padding:28px 34px;background:#1d2026;border:1px solid #3a3f4a;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.6)">' +
    '<button id="deck-go" style="font:600 20px/1 inherit;padding:14px 28px;border-radius:8px;border:0;background:#2f81f7;color:#fff;cursor:pointer">\u25B6 Start' + (presenter ? ' with presenter view' : '') + '</button>' +
    '<p style="margin:16px 0 0;color:#c9cfd6">Full screen' + (presenter ? ' here, notes and timer in a second window' : '') + '. While presenting: <b>F</b> full screen \u00B7 <b>S</b> presenter view \u00B7 <b>Esc</b> all slides \u00B7 <b>B</b> black screen</p></div>';
  document.body.appendChild(ov);
  var done = false;
  function go() {
    if (done) return;
    done = true;
    ov.remove();
    try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch (err) { /* ignore */ }
    if (presenter) { try { var n = Reveal.getPlugin && Reveal.getPlugin('notes'); if (n && n.open) n.open(); } catch (err2) { /* ignore */ } }
  }
  ov.querySelector('#deck-go').addEventListener('click', go);
  document.addEventListener('keydown', function h(e) {
    if (done) { document.removeEventListener('keydown', h, true); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); go(); }
  }, true);
})();
"""

FONT_STACK = {
    'Carlito': "Carlito, Calibri, 'Helvetica Neue', Arial, sans-serif",
    'Poppins': "Poppins, 'Helvetica Neue', Arial, sans-serif",
    'Helvetica': "'Helvetica Neue', Helvetica, Arial, sans-serif",
    'Georgia': "Georgia, 'Times New Roman', serif",
    'Times': "'Times New Roman', Times, serif",
    'Menlo': "Menlo, Consolas, 'Courier New', monospace",
}
THEMES = {
    'dark':  {'bg': '#000000', 'text': '#ffffff', 'accent': '#ff6a2a', 'muted': 'rgba(255,255,255,.72)', 'line': '#9bb7d6', 'fill': '#2e5c8a'},
    'light': {'bg': '#ffffff', 'text': '#111111', 'accent': '#b23a1c', 'muted': 'rgba(0,0,0,.6)', 'line': '#2c5a8f', 'fill': '#4f81bd'},
}


def default_meta(theme='dark', size='16:9', title=''):
    w, h = (1024, 768) if size == '4:3' else (1280, 720)
    return {'deck': DECK_FORMAT, 'width': w, 'height': h, 'title': title,
            'theme': {'name': theme, 'bg': '', 'bgFit': 'cover', 'font': 'Carlito', 'titleFont': 'Carlito',
                      'accent': THEMES[theme]['accent'], 'text': THEMES[theme]['text'], 'page': THEMES[theme]['bg']},
            'footer': '', 'numbers': True, 'numbering': 'doc'}


def theme_css(meta):
    t = meta.get('theme', {})
    base = THEMES.get(t.get('name', 'dark'), THEMES['dark'])
    page = t.get('page') or base['bg']
    text = t.get('text') or base['text']
    accent = t.get('accent') or base['accent']
    font = FONT_STACK.get(t.get('font', 'Carlito'), t.get('font') or FONT_STACK['Carlito'])
    tfont = FONT_STACK.get(t.get('titleFont', 'Carlito'), t.get('titleFont') or font)
    bg = page
    if t.get('bg'):
        fit = t.get('bgFit', 'cover')
        size = {'cover': 'cover', 'contain': 'contain', 'stretch': '100% 100%'}.get(fit, 'cover')
        bg = "%s url('%s') center / %s no-repeat" % (page, t['bg'].replace("'", '%27'), size)
    return ('/* theme: %(name)s */\n'
            ':root { --dk-page: %(page)s; --dk-text: %(text)s; --dk-accent: %(accent)s; --dk-title: %(accent)s; --dk-muted: %(muted)s;\n'
            '  --dk-font: %(font)s; --dk-title-font: %(tfont)s; --dk-line: %(line)s; --dk-fill: %(fill)s; }\n'
            '.reveal .sf { background: %(bg)s; color: var(--dk-text); font-family: var(--dk-font); }\n'
            '.reveal .sf .p { line-height: 1.2; }\n') % {
        'name': t.get('name', 'dark'), 'page': page, 'text': text, 'accent': accent, 'muted': base['muted'],
        'font': font, 'tfont': tfont, 'line': base['line'], 'fill': base['fill'], 'bg': bg}


# Layouts: placeholder boxes as fractions of the slide. kind: title | subtitle | body | caption | picture
LAYOUTS = [
    ('title', 'Title slide', [
        {'kind': 'title', 'x': .06, 'y': .30, 'w': .88, 'h': .22, 'size': 60, 'align': 'left', 'anchor': 'end'},
        {'kind': 'subtitle', 'x': .06, 'y': .54, 'w': .88, 'h': .18, 'size': 30, 'align': 'left', 'anchor': 'start'}]),
    ('section', 'Section header', [
        {'kind': 'title', 'x': .06, 'y': .36, 'w': .88, 'h': .20, 'size': 56, 'align': 'left', 'anchor': 'end'},
        {'kind': 'subtitle', 'x': .06, 'y': .58, 'w': .88, 'h': .12, 'size': 26, 'align': 'left', 'anchor': 'start'}]),
    ('content', 'Title and content', [
        {'kind': 'title', 'x': .04, 'y': .04, 'w': .92, 'h': .14, 'size': 44, 'align': 'left', 'anchor': 'center'},
        {'kind': 'body', 'x': .04, 'y': .21, 'w': .92, 'h': .69, 'size': 28, 'align': 'left', 'anchor': 'start', 'bullets': True}]),
    ('two', 'Two columns', [
        {'kind': 'title', 'x': .04, 'y': .04, 'w': .92, 'h': .14, 'size': 44, 'align': 'left', 'anchor': 'center'},
        {'kind': 'body', 'x': .04, 'y': .21, 'w': .45, 'h': .69, 'size': 26, 'align': 'left', 'anchor': 'start', 'bullets': True},
        {'kind': 'body', 'x': .51, 'y': .21, 'w': .45, 'h': .69, 'size': 26, 'align': 'left', 'anchor': 'start', 'bullets': True}]),
    ('picture', 'Title and picture', [
        {'kind': 'title', 'x': .04, 'y': .04, 'w': .92, 'h': .14, 'size': 44, 'align': 'left', 'anchor': 'center'},
        {'kind': 'picture', 'x': .04, 'y': .21, 'w': .92, 'h': .69}]),
    ('caption', 'Picture with caption', [
        {'kind': 'picture', 'x': .04, 'y': .05, 'w': .92, 'h': .72},
        {'kind': 'caption', 'x': .04, 'y': .79, 'w': .92, 'h': .12, 'size': 22, 'align': 'center', 'anchor': 'start'}]),
    ('titleonly', 'Title only', [
        {'kind': 'title', 'x': .04, 'y': .04, 'w': .92, 'h': .14, 'size': 44, 'align': 'left', 'anchor': 'center'}]),
    ('blank', 'Blank', []),
]
PROMPTS = {'title': 'Click to add title', 'subtitle': 'Click to add subtitle', 'body': 'Click to add text',
           'caption': 'Click to add a caption', 'picture': 'Double-click to add a picture (or drop one here)'}


def f2(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return s if s not in ('', '-0') else '0'


def placeholder_html(ph, w, h, n):
    """one layout placeholder as deck markup (ids are per slide)"""
    x, y, bw, bh = ph['x'] * w, ph['y'] * h, ph['w'] * w, ph['h'] * h
    box = 'left:%spx;top:%spx;width:%spx;height:%spx;' % (f2(x), f2(y), f2(bw), f2(bh))
    if ph['kind'] == 'picture':
        return ('<div class="e pic" data-id="%d" data-ph="picture" data-empty data-prompt="%s" style="%s"></div>' %
                (n, PROMPTS['picture'], box))
    is_title = ph['kind'] == 'title'
    color = 'var(--dk-title)' if is_title else 'var(--dk-text)'
    family = 'var(--dk-title-font)' if is_title else 'var(--dk-font)'
    weight = 'font-weight:700;' if is_title else ''
    pad = 7.2 if ph['size'] >= 40 else 4.8
    just = {'start': 'flex-start', 'center': 'center', 'end': 'flex-end'}[ph.get('anchor', 'start')]
    p_attr = ' data-bu="dot"' if ph.get('bullets') else ''
    return ('<div class="e" data-id="%d" data-ph="%s" data-empty style="%s">'
            '<div class="tx" data-autofit style="left:0;top:0;width:%spx;height:%spx;padding:%spx %spx;justify-content:%s;">'
            '<div class="tb"><div class="p" data-prompt="%s"%s style="text-align:%s;font-size:calc(%spx*var(--fs,1));font-family:%s;color:%s;%s"><span></span></div></div>'
            '</div></div>') % (n, ph['kind'], box, f2(bw), f2(bh), f2(pad), f2(pad * 2), just, PROMPTS[ph['kind']],
                                p_attr, ph['align'], ph['size'], family, color, weight)


def master_html(meta):
    """the master elements (footer, slide number) stamped onto every slide; kept once in <template id="deck-master">"""
    w, h = meta['width'], meta['height']
    parts = []
    fs = 16 if w >= 1200 else 14
    if meta.get('footer'):
        parts.append('<div class="e" data-layout data-master="footer" style="left:%spx;top:%spx;width:%spx;height:%spx;">'
                     '<div class="tx" style="left:0;top:0;width:%spx;height:%spx;padding:4px 8px;justify-content:center;">'
                     '<div class="tb"><div class="p" style="text-align:left;font-size:%dpx;color:var(--dk-muted);"><span>%s</span></div></div></div></div>'
                     % (f2(w * .03), f2(h - 44), f2(w * .6), 32, f2(w * .6), 32, fs, html_escape(meta['footer'])))
    if meta.get('numbers', True):
        parts.append('<div class="e" data-layout data-master="num" data-slidenum style="left:%spx;top:%spx;width:%spx;height:%spx;">'
                     '<div class="tx" style="left:0;top:0;width:%spx;height:%spx;padding:4px 8px;justify-content:center;">'
                     '<div class="tb"><div class="p" style="text-align:right;font-size:%dpx;color:var(--dk-muted);"><span>1</span></div></div></div></div>'
                     % (f2(w - w * .03 - 80), f2(h - 44), 80, 32, 80, 32, fs))
    return ''.join(parts)


def html_escape(s):
    return (s or '').replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')


def slide_html(layout, meta, master, number):
    w, h = meta['width'], meta['height']
    phs = dict((k, v) for k, _, v in LAYOUTS)[layout]
    body = master.replace('data-slidenum style', 'data-slidenum style').replace('<span>1</span>', '<span>%d</span>' % number)
    body += ''.join(placeholder_html(ph, w, h, i + 1) for i, ph in enumerate(phs))
    return '<section data-dk-layout="%s">\n<div class="sf">%s</div>\n<aside class="notes"></aside>\n</section>' % (layout, body)


def deck_html(meta, slides_html):
    w, h = meta['width'], meta['height']
    return '\n'.join([
        '<!DOCTYPE html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>%s</title>' % html_escape(meta.get('title') or 'Presentation'),
        '<meta name="generator" content="deck %s">' % VERSION,
        '<link rel="stylesheet" href="lib/reveal/reveal.css">',
        '<link rel="stylesheet" href="fonts/fonts.css">',
        '<style id="deck-page">%s</style>' % (PAGE_CSS % {'W': w, 'H': h}),
        '<style id="deck-theme">\n%s</style>' % theme_css(meta),
        '<script id="deck-meta" type="application/json">%s</script>' % json.dumps(meta),
        '<template id="deck-master">%s</template>' % master_html(meta),
        '</head>', '<body>',
        '<div class="reveal"><div class="slides">',
        slides_html,
        '</div></div>',
        '<script src="lib/reveal/reveal.js"></script>',
        '<script src="lib/reveal/plugin/notes/notes.js"></script>',
        '<script id="deck-page">%s</script>' % (PAGE_JS % {'W': w, 'H': h}),
        '</body>', '</html>', ''])


def vendor_list(opt=False):
    table, sub = (VENDOR_OPT, 'vendor_opt') if opt else (VENDOR, 'vendor')
    if table:
        return sorted(table)
    root = os.path.join(HERE, sub)
    out = []
    for dp, _, fs in os.walk(root):
        for f in fs:
            out.append(os.path.relpath(os.path.join(dp, f), root).replace(os.sep, '/'))
    return sorted(out)


def vendor_bytes(rel, opt=False):
    table, sub = (VENDOR_OPT, 'vendor_opt') if opt else (VENDOR, 'vendor')
    if table:
        return base64.b64decode(table[rel])
    with open(os.path.join(HERE, sub, rel), 'rb') as fh:
        return fh.read()


def pptx2reveal_source():
    if PPTX2REVEAL:
        return base64.b64decode(PPTX2REVEAL).decode('utf-8')
    p = os.path.join(HERE, 'pptx2reveal.py')
    return open(p, encoding='utf-8').read() if os.path.isfile(p) else ''


def write_vendor(folder, only_missing=True, opt=False, prefix=None):
    n = 0
    for rel in vendor_list(opt):
        if prefix and not rel.startswith(prefix):
            continue
        dest = os.path.join(folder, rel.replace('/', os.sep))
        if only_missing and os.path.exists(dest):
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, 'wb') as fh:
            fh.write(vendor_bytes(rel, opt))
        n += 1
    return n


def slug(name):
    s = re.sub(r'[^A-Za-z0-9._-]+', '-', name.strip()).strip('-._').lower()
    return s or 'presentation'


def new_deck(folder, title, theme='dark', size='16:9', layout='title'):
    """create FOLDER/<slug>.html with its lib/ and fonts/; returns the html path"""
    folder = os.path.abspath(os.path.expanduser(folder))
    os.makedirs(folder, exist_ok=True)
    file = os.path.join(folder, slug(title) + '.html')
    if os.path.exists(file):
        raise FileExistsError(file)
    meta = default_meta(theme, size, title)
    master = master_html(meta)
    html = deck_html(meta, slide_html(layout, meta, master, 1))
    write_vendor(folder)
    os.makedirs(os.path.join(folder, 'media'), exist_ok=True)
    with open(file, 'w', encoding='utf-8') as fh:
        fh.write(html)
    return file


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Editor:
    def __init__(self, deck, file):
        self.deck = os.path.realpath(deck)
        self.file = file
        self.token = secrets.token_urlsafe(24)
        self.lock = threading.Lock()
        self.pages = {}            # editor tab id -> last time it checked in
        self.ever = False
        self.started = time.time()
        self.server = None
        self.keep = False
        self.pdf_lock = threading.Lock()

    def touch(self, page):
        with self.lock:
            self.pages[page] = time.time()
            self.ever = True

    def bye(self, page):
        with self.lock:
            self.pages.pop(page, None)
        threading.Timer(GRACE, self.maybe_stop).start()

    def maybe_stop(self, why='the editor tab was closed'):
        if self.keep:
            return
        with self.lock:
            if self.pages:
                return
        print('%s — stopping.' % why)
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def watchdog(self):
        last = time.time()
        while True:
            time.sleep(30)
            now = time.time()
            if now - last > 300:                    # the computer was asleep: give tabs time to check in again
                with self.lock:
                    for k in self.pages:
                        self.pages[k] = now
            last = now
            with self.lock:
                for k in [k for k, t in self.pages.items() if now - t > STALE]:
                    del self.pages[k]
                idle = not self.pages
            if idle and self.ever:
                self.maybe_stop('no editor tab is open any more')
                return
            if idle and not self.ever and now - self.started > NO_TAB:
                self.maybe_stop('no editor tab connected')
                return

    def safe_path(self, rel):
        p = os.path.realpath(os.path.join(self.deck, rel.lstrip('/')))
        if p != self.deck and not p.startswith(self.deck + os.sep):
            return None
        return p


def make_handler(ed, port):
    allowed_hosts = {'127.0.0.1:%d' % port, 'localhost:%d' % port}

    class H(http.server.BaseHTTPRequestHandler):
        server_version = 'deck/1'
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):  # quiet, except errors
            pass

        # ------------------------------------------------------------ helpers
        def send(self, code, body=b'', ctype='text/plain; charset=utf-8', extra=None):
            if isinstance(body, str):
                body = body.encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def json(self, code, obj):
            self.send(code, json.dumps(obj), 'application/json')

        def host_ok(self):
            return self.headers.get('Host', '') in allowed_hosts

        # ------------------------------------------------------------ GET
        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            if not self.host_ok():
                return self.send(403, 'forbidden host')
            url = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(url.query, keep_blank_values=True)
            path = urllib.parse.unquote(url.path)
            if path.startswith('/__editor/'):
                name = path[len('/__editor/'):]
                data = editor_asset(name) if name in EDITOR_FILES else None
                if data is None:
                    return self.send(404, 'not found')
                return self.send(200, data, EDITOR_FILES[name] + '; charset=utf-8')
            if path == '/__whoami':
                return self.json(200, {'app': 'deck', 'deck': ed.deck, 'file': ed.file, 'pid': os.getpid()})
            if path == '/':
                return self.send(302, '', extra={'Location': '/' + urllib.parse.quote(ed.file) + '?edit'})
            fp = ed.safe_path(path)
            if not fp or not os.path.isfile(fp):
                return self.send(404, 'not found')
            ctype = mimetypes.guess_type(fp)[0] or 'application/octet-stream'
            if fp.endswith(('.html', '.htm')):
                with open(fp, 'rb') as fh:
                    data = fh.read()
                extra = {'X-File-Hash': sha(data)}
                if 'edit' in q:
                    data = self.inject(data, os.path.relpath(fp, ed.deck))
                elif 'print-pdf' in q:
                    data = self.inject_print(data, 'autoprint' in q)
                elif 'png' in q:
                    data = self.inject_print(data, False)
                return self.send(200, data, 'text/html; charset=utf-8', extra)
            return self.send_file(fp, ctype)

        def inject(self, data, rel):
            boot = ('<script>window.__REVEAL_EDIT = %s;</script>\n'
                    '<link rel="stylesheet" href="/__editor/deck.css">\n'
                    '<script src="/__editor/deck.js"></script>\n') % json.dumps(
                        {'token': ed.token, 'file': rel.replace(os.sep, '/'), 'app': 'deck', 'version': VERSION,
                         'layouts': [{'id': k, 'name': n, 'boxes': b} for k, n, b in LAYOUTS], 'themes': THEMES,
                         'fonts': FONT_STACK, 'prompts': PROMPTS, 'platform': sys.platform,
                         'chrome': bool(find_chrome())})
            text = data.decode('utf-8', errors='surrogateescape')
            i = text.lower().rfind('</body>')
            text = text[:i] + boot + text[i:] if i >= 0 else text + boot
            return text.encode('utf-8', errors='surrogateescape')

        def inject_print(self, data, autoprint):
            """reveal.js print view: load embedded pages up front (they load lazily while presenting),
            and with ?autoprint open the browser's print dialog once the pages are laid out"""
            js = PRINT_JS + (AUTOPRINT_JS if autoprint else '')
            text = data.decode('utf-8', errors='surrogateescape')
            i = text.lower().rfind('</body>')
            text = text[:i] + js + text[i:] if i >= 0 else text + js
            return text.encode('utf-8', errors='surrogateescape')

        def send_file(self, fp, ctype):
            size = os.path.getsize(fp)
            rng = self.headers.get('Range')
            start, end = 0, size - 1
            code = 200
            if rng:
                m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip())
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    end = min(end, size - 1)
                    if start > end:
                        self.send_response(416)
                        self.send_header('Content-Range', 'bytes */%d' % size)
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    code = 206
            length = end - start + 1
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(length))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Cache-Control', 'no-store')
            if code == 206:
                self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
            self.end_headers()
            if self.command == 'HEAD':
                return
            with open(fp, 'rb') as fh:
                fh.seek(start)
                left = length
                try:
                    while left > 0:
                        chunk = fh.read(min(1 << 20, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        # ------------------------------------------------------------ POST
        def do_POST(self):
            if not self.host_ok():
                return self.json(403, {'error': 'forbidden host'})
            url0 = urllib.parse.urlsplit(self.path)
            q0 = urllib.parse.parse_qs(url0.query)
            if url0.path == '/__bye' and (q0.get('token') or [''])[0] == ed.token:
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                ed.bye((q0.get('page') or [''])[0])
                return self.json(200, {'ok': True})
            if self.headers.get('X-Edit-Token') != ed.token:
                return self.json(403, {'error': 'bad token — reload the editor page'})
            origin = self.headers.get('Origin')
            if origin and urllib.parse.urlsplit(origin).netloc not in allowed_hosts:
                return self.json(403, {'error': 'forbidden origin'})
            url = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(url.query)
            n = int(self.headers.get('Content-Length') or 0)
            if n > 200 * 1024 * 1024:
                return self.json(413, {'error': 'too large'})
            body = self.rfile.read(n)
            if url.path == '/__ping':
                ed.touch((q.get('page') or [''])[0])
                return self.json(200, {'ok': True})
            if url.path == '/__save':
                return self.save(q, body)
            if url.path == '/__upload':
                return self.upload(q, body)
            if url.path == '/__import':
                return self.import_media(body)
            if url.path == '/__clip/put':
                return self.clip_put(body)
            if url.path == '/__clip/get':
                return self.clip_get()
            if url.path == '/__pdf':
                return self.make_pdf(body)
            if url.path == '/__new':
                return self.new_from_editor(body)
            if url.path == '/__open':
                return self.open_other(body)
            if url.path == '/__vendor':
                n = write_vendor(ed.deck)
                if (q.get('set') or [''])[0] == 'katex':
                    n += write_vendor(ed.deck, True, True, 'lib/katex/')
                return self.json(200, {'ok': True, 'written': n})
            if url.path == '/__png':
                return self.make_png(body)
            if url.path == '/__export/single':
                return self.export_single(body)
            if url.path == '/__zip':
                return self.make_zip()
            if url.path == '/__import-pptx':
                return self.import_pptx(body)
            if url.path == '/__reveal-in-finder':
                return self.reveal_path(body)
            if url.path == '/__pdf/show':
                return self.show_pdf(body)
            return self.json(404, {'error': 'not found'})

        # -------------------------------------------- copy & paste between presentations
        # The clipboard slot: every reveal-edit on this computer shares one file, so an element copied in one
        # presentation can be pasted into another even when the browser keeps clipboard data per site.
        def clip_put(self, body):
            try:
                obj = json.loads(body.decode('utf-8'))
                assert isinstance(obj, dict) and obj.get('app') == 'reveal-edit' and isinstance(obj.get('html'), str)
            except Exception:
                return self.json(400, {'error': 'not a clipboard item from deck or reveal-edit'})
            if len(body) > 64 * 1024 * 1024:
                return self.json(413, {'error': 'too large'})
            obj['time'] = time.time()
            fp = os.path.join(registry_dir('reveal-edit'), 'clipboard.dat')
            tmp = fp + '.%d.tmp' % os.getpid()
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(obj, fh)
            os.replace(tmp, fp)
            return self.json(200, {'ok': True})

        def clip_get(self):
            try:
                with open(os.path.join(registry_dir('reveal-edit'), 'clipboard.dat'), encoding='utf-8') as fh:
                    obj = json.load(fh)
                if time.time() - obj.get('time', 0) > 7 * 86400:
                    obj = None
            except Exception:
                obj = None
            return self.json(200, {'item': obj})

        def import_media(self, body):
            """copy the files a pasted element uses from its presentation into this one's media/ folder"""
            try:
                req = json.loads(body.decode('utf-8'))
                src_root = os.path.realpath(req['from'])
                src_file = os.path.realpath(os.path.join(src_root, req.get('file') or ''))
                into = ed.safe_path(req.get('into') or ed.file)
                refs = [r for r in req.get('files') or [] if isinstance(r, str)][:500]
            except Exception:
                return self.json(400, {'error': 'bad request'})
            inside = lambda p, root: p == root or p.startswith(root + os.sep)
            # only from a folder holding the reveal.js presentation the element was copied from
            if not (os.path.isabs(req['from']) and os.path.isdir(src_root) and inside(src_file, src_root)
                    and src_file.endswith(('.html', '.htm')) and is_deck(src_file)) or not into:
                return self.json(400, {'error': 'the presentation it was copied from is not available'})
            src_base = os.path.dirname(src_file)
            into_dir = os.path.dirname(into)
            mdir = os.path.join(ed.deck, 'media')
            out, missing, copied = {}, [], 0
            with ed.lock:
                for ref in refs:
                    path = re.split(r'[?#]', ref, 1)[0]
                    suffix = ref[len(path):]
                    fp = os.path.realpath(os.path.join(src_base, urllib.parse.unquote(path)))
                    ext = os.path.splitext(fp)[1].lower()
                    if not inside(fp, src_root) or ext not in IMPORT_EXT or not os.path.isfile(fp):
                        missing.append(ref)
                        continue
                    if inside(fp, ed.deck):                     # already part of this presentation's folder
                        dest = fp
                    else:
                        size = os.path.getsize(fp)
                        if size > IMPORT_MAX:
                            missing.append(ref)
                            continue
                        dest = self.place_copy(fp, mdir, size)
                        if dest is None:
                            missing.append(ref)
                            continue
                        copied += 1
                    rel = os.path.relpath(dest, into_dir).replace(os.sep, '/')
                    out[ref] = urllib.parse.quote(rel) + suffix
            if copied:
                print('pasted an element from %s — copied %d media file%s into media/' % (
                    os.path.basename(src_root), copied, '' if copied == 1 else 's'))
            return self.json(200, {'map': out, 'missing': missing})

        def place_copy(self, fp, mdir, size):
            """copy fp into mdir; reuse an identical file already there; never overwrite a different one"""
            os.makedirs(mdir, exist_ok=True)
            digest = None

            def file_sha(path):
                h = hashlib.sha256()
                with open(path, 'rb') as fh:
                    for chunk in iter(lambda: fh.read(1 << 20), b''):
                        h.update(chunk)
                return h.hexdigest()
            for f in os.listdir(mdir):                        # same content under any name?
                cand = os.path.join(mdir, f)
                if os.path.isfile(cand) and os.path.getsize(cand) == size:
                    digest = digest or file_sha(fp)
                    if file_sha(cand) == digest:
                        return cand
            stem, ext = os.path.splitext(os.path.basename(fp))
            stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem).strip('._') or 'media'
            cand, k = os.path.join(mdir, stem + ext), 1
            while os.path.exists(cand):
                cand = os.path.join(mdir, '%s-%d%s' % (stem, k, ext))
                k += 1
            try:
                shutil.copyfile(fp, cand)
            except OSError:
                return None
            return cand

        def save(self, q, body):
            rel = (q.get('file') or [ed.file])[0]
            fp = ed.safe_path(rel)
            if not fp or not fp.endswith(('.html', '.htm')) or os.sep + '_tools' + os.sep in fp:
                return self.json(400, {'error': 'refusing to write %s' % rel})
            with ed.lock:
                current = open(fp, 'rb').read() if os.path.exists(fp) else b''
                base = self.headers.get('X-Base-Hash')
                if base and current and sha(current) != base and self.headers.get('X-Force') != '1':
                    return self.json(409, {'error': 'changed on disk'})
                backup = None
                if current:
                    bdir = os.path.join(ed.deck, '_backups')
                    os.makedirs(bdir, exist_ok=True)
                    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
                    stem = os.path.splitext(os.path.basename(fp))[0]
                    backup = os.path.join(bdir, '%s-%s.html' % (stem, stamp))
                    with open(backup, 'wb') as fh:
                        fh.write(current)
                    olds = sorted(f for f in os.listdir(bdir) if f.startswith(stem + '-') and f.endswith('.html'))
                    for f in olds[:-KEEP_BACKUPS]:
                        try:
                            os.remove(os.path.join(bdir, f))
                        except OSError:
                            pass
                tmp = fp + '.saving'
                with open(tmp, 'wb') as fh:
                    fh.write(body)
                os.replace(tmp, fp)
            print('saved %s%s' % (rel, (' (previous version: _backups/%s)' % os.path.basename(backup)) if backup else ''))
            return self.json(200, {'ok': True, 'hash': sha(body),
                                   'backup': os.path.relpath(backup, ed.deck) if backup else None})

        # -------------------------------------------- PDF (reveal.js print view, printed by headless Chrome)
        def make_pdf(self, body):
            try:
                opts = json.loads(body.decode('utf-8') or '{}')
            except Exception:
                opts = {}
            chrome = find_chrome()
            if not chrome:
                return self.json(200, {'ok': False, 'reason': 'no-browser'})
            fp = ed.safe_path(ed.file)
            out = os.path.splitext(fp)[0] + '.pdf'
            query = 'print-pdf'
            if opts.get('builds'):
                query += '&pdfSeparateFragments=true'
            if opts.get('notes'):
                query += '&showNotes=separate-page'
            url = 'http://127.0.0.1:%d/%s?%s' % (port, urllib.parse.quote(ed.file), query)
            t0 = time.time()
            with ed.pdf_lock, tempfile.TemporaryDirectory(prefix='deck-pdf-') as tmp:
                pdf = os.path.join(tmp, 'deck.pdf')
                cmd = [chrome, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
                       '--disable-background-networking', '--user-data-dir=' + os.path.join(tmp, 'profile'),
                       '--no-proxy-server', '--hide-scrollbars', '--no-pdf-header-footer',
                       '--run-all-compositor-stages-before-draw', '--virtual-time-budget=20000',
                       '--print-to-pdf=' + pdf, url]
                if hasattr(os, 'geteuid') and os.geteuid() == 0:
                    cmd.insert(1, '--no-sandbox')
                try:
                    r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
                except subprocess.TimeoutExpired:
                    return self.json(500, {'error': 'the browser took more than 10 minutes — giving up'})
                except OSError as e:
                    return self.json(500, {'error': 'could not start %s: %s' % (chrome, e)})
                if not os.path.isfile(pdf) or os.path.getsize(pdf) < 100:
                    err = (r.stderr or b'').decode('utf-8', 'replace').strip().splitlines()[-3:]
                    return self.json(500, {'error': 'the browser made no PDF' + (': ' + ' / '.join(err) if err else '')})
                with open(pdf, 'rb') as fh:
                    data = fh.read()
            pages = len(re.findall(rb'/Type\s*/Page(?![a-zA-Z])', data))
            try:
                tmp_out = out + '.writing'
                with open(tmp_out, 'wb') as fh:
                    fh.write(data)
                os.replace(tmp_out, out)
            except OSError as e:
                return self.json(500, {'error': 'could not write %s: %s' % (out, e)})
            rel = os.path.relpath(out, ed.deck).replace(os.sep, '/')
            print('made %s (%d pages, %.0f s, with %s)' % (rel, pages, time.time() - t0, os.path.basename(chrome)))
            return self.json(200, {'ok': True, 'file': rel, 'path': out, 'url': urllib.parse.quote(rel), 'pages': pages,
                                   'browser': browser_name(chrome), 'canShow': sys.platform == 'darwin'})

        def new_from_editor(self, body):
            try:
                req = json.loads(body.decode('utf-8'))
                title = (req.get('title') or 'Presentation').strip()
                folder = req.get('folder') or os.path.join(os.path.dirname(ed.deck), title)
                theme = req.get('theme') if req.get('theme') in THEMES else 'dark'
                size = '4:3' if req.get('size') == '4:3' else '16:9'
            except Exception:
                return self.json(400, {'error': 'bad request'})
            folder = os.path.abspath(os.path.expanduser(folder))
            try:
                file = new_deck(folder, title, theme, size)
            except FileExistsError as e:
                return self.json(409, {'error': '%s already exists' % os.path.basename(str(e))})
            except OSError as e:
                return self.json(500, {'error': str(e)})
            url = launch_editor(os.path.dirname(file), os.path.basename(file))
            return self.json(200, {'ok': True, 'file': file, 'url': url})

        def open_other(self, body):
            try:
                req = json.loads(body.decode('utf-8'))
                path = req.get('path') or ''
            except Exception:
                return self.json(400, {'error': 'bad request'})
            if not path:
                if sys.platform != 'darwin':
                    return self.json(400, {'error': 'give the path of the presentation to open'})
                path = pick_file(os.path.dirname(ed.deck))
                if not path:
                    return self.json(200, {'ok': False, 'cancelled': True})
            path = os.path.abspath(os.path.expanduser(path))
            if os.path.isdir(path):
                decks = find_decks(path)
                if not decks:
                    return self.json(404, {'error': 'no presentation in %s' % path})
                path = os.path.join(path, decks[0])
            if not os.path.isfile(path) or not is_deck(path):
                return self.json(404, {'error': '%s is not a presentation' % path})
            url = launch_editor(os.path.dirname(path), os.path.basename(path))
            return self.json(200, {'ok': True, 'file': path, 'url': url})

        # -------------------------------------------- slides as PNG pictures (headless Chrome screenshots)
        def make_png(self, body):
            try:
                opts = json.loads(body.decode('utf-8') or '{}')
            except Exception:
                opts = {}
            chrome = find_chrome()
            if not chrome:
                return self.json(200, {'ok': False, 'reason': 'no-browser'})
            fp = ed.safe_path(ed.file)
            stem = os.path.splitext(os.path.basename(fp))[0]
            W, H = int(opts.get('w') or 1280), int(opts.get('h') or 720)
            scale = 2 if opts.get('hires', True) else 1
            slides = opts.get('slides') or []          # [[h, v, label], ...]
            if not slides:
                return self.json(400, {'error': 'no slides given'})
            outdir = os.path.dirname(fp) if len(slides) == 1 else os.path.join(os.path.dirname(fp), stem + '-slides')
            os.makedirs(outdir, exist_ok=True)
            made = []
            t0 = time.time()
            with ed.pdf_lock, tempfile.TemporaryDirectory(prefix='deck-png-') as tmp:
                for h, v, label in slides:
                    name = (stem + '-slide-' + str(label) + '.png') if len(slides) == 1 else ('slide-%s.png' % str(label).zfill(2))
                    dest = os.path.join(outdir, name)
                    url = 'http://127.0.0.1:%d/%s?png#/%s%s' % (port, urllib.parse.quote(ed.file), h, ('/' + str(v)) if v else '')
                    cmd = [chrome, '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
                           '--user-data-dir=' + os.path.join(tmp, 'profile'), '--no-proxy-server', '--hide-scrollbars',
                           '--force-device-scale-factor=%d' % scale, '--window-size=%d,%d' % (W, H),
                           '--run-all-compositor-stages-before-draw', '--virtual-time-budget=8000',
                           '--screenshot=' + dest, url]
                    if hasattr(os, 'geteuid') and os.geteuid() == 0:
                        cmd.insert(1, '--no-sandbox')
                    try:
                        subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
                    except (subprocess.TimeoutExpired, OSError) as e:
                        return self.json(500, {'error': 'the browser failed on slide %s: %s' % (label, e)})
                    if os.path.isfile(dest):
                        made.append(dest)
            if not made:
                return self.json(500, {'error': 'the browser made no picture'})
            print('made %d PNG%s in %.0f s' % (len(made), '' if len(made) == 1 else 's', time.time() - t0))
            rel = os.path.relpath(made[0], ed.deck).replace(os.sep, '/')
            return self.json(200, {'ok': True, 'files': made, 'folder': outdir if len(made) > 1 else None, 'url': urllib.parse.quote(rel),
                                   'canShow': sys.platform == 'darwin'})

        def reveal_path(self, body):
            try:
                path = json.loads(body.decode('utf-8')).get('path') or ''
            except Exception:
                path = ''
            if sys.platform == 'darwin' and path and os.path.exists(path):
                subprocess.run(['open', '-R', path], capture_output=True)
                return self.json(200, {'ok': True})
            return self.json(404, {'error': 'not available'})

        # -------------------------------------------- one self-contained HTML file (media inlined)
        def export_single(self, body):
            fp = ed.safe_path(ed.file)
            base = os.path.dirname(fp)
            out = os.path.splitext(fp)[0] + '-single.html'
            text = open(fp, encoding='utf-8', errors='surrogateescape').read()
            missing = []

            def data_uri(rel):
                path = os.path.realpath(os.path.join(base, urllib.parse.unquote(re.split(r'[?#]', rel, 1)[0])))
                if not path.startswith(ed.deck) or not os.path.isfile(path):
                    missing.append(rel)
                    return None
                data = open(path, 'rb').read()
                ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
                return 'data:%s;base64,%s' % (ctype, base64.b64encode(data).decode())

            def css_inline(css, cssdir):
                def one(m):
                    u = m.group(2).strip()
                    if re.match(r'^(data:|https?:|#)', u):
                        return m.group(0)
                    d = data_uri(os.path.normpath(os.path.join(cssdir, u)).replace(os.sep, '/'))
                    return 'url(%s)' % d if d else m.group(0)
                css = re.sub(r'url\((["\']?)([^"\')]+)\1\)', one, css)
                return re.sub(r',\s*url\((?!data:)[^)]*\)\s*format\([^)]*\)', '', css)   # fallback font files we do not ship

            def link_tag(m):
                href = m.group(1)
                if re.match(r'^(https?:|data:)', href):
                    return m.group(0)
                path = os.path.realpath(os.path.join(base, href))
                if not os.path.isfile(path):
                    missing.append(href)
                    return m.group(0)
                css = open(path, encoding='utf-8', errors='replace').read()
                return '<style>%s</style>' % css_inline(css, os.path.dirname(href))
            text = re.sub(r'<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>', link_tag, text)

            def script_tag(m):
                src = m.group(1)
                if re.match(r'^(https?:|data:)', src):
                    return m.group(0)
                path = os.path.realpath(os.path.join(base, src))
                if not os.path.isfile(path):
                    missing.append(src)
                    return m.group(0)
                js = open(path, encoding='utf-8', errors='replace').read().replace('</script', '<\\/script')
                return '<script>%s</script>' % js
            text = re.sub(r'<script[^>]+src="([^"]+)"[^>]*></script>', script_tag, text)

            def attr(m):
                name, q, u = m.group(1), m.group(2), m.group(3)
                if re.match(r'^(https?:|data:|#|blob:|mailto:)', u):
                    return m.group(0)
                if name == 'data-src' and u.lower().endswith(('.html', '.htm')):   # an embedded page: inline it
                    path = os.path.realpath(os.path.join(base, u))
                    if path.startswith(ed.deck) and os.path.isfile(path):
                        inner = open(path, encoding='utf-8', errors='replace').read()
                        return 'srcdoc=%s%s%s' % (q, inner.replace('&', '&amp;').replace('"', '&quot;'), q)
                d = data_uri(u)
                return '%s=%s%s%s' % (name, q, d, q) if d else m.group(0)
            text = re.sub(r'\b(src|data-src|poster)=(["\'])([^"\']+)\2', attr, text)
            text = re.sub(r'style="([^"]*url\([^"]*)"', lambda m: 'style="%s"' % css_inline(m.group(1), '.').replace('"', '&quot;'), text)
            text = re.sub(r"(\.reveal \.sf \{ background: [^;]*url\(')([^']+)('\))", lambda m: m.group(1) + (data_uri(m.group(2)) or m.group(2)) + m.group(3), text)
            with open(out, 'w', encoding='utf-8', errors='surrogateescape') as fh:
                fh.write(text)
            size = os.path.getsize(out)
            print('wrote %s (%.1f MB)' % (os.path.basename(out), size / 1e6))
            return self.json(200, {'ok': True, 'file': out, 'size': size, 'missing': sorted(set(missing))[:10], 'canShow': sys.platform == 'darwin'})

        # -------------------------------------------- the folder as a zip (without backups)
        def make_zip(self):
            import zipfile
            fp = ed.safe_path(ed.file)
            stem = os.path.basename(ed.deck)
            out = os.path.join(os.path.dirname(ed.deck), stem + '.zip')
            n = 0
            with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
                for dp, dns, fs in os.walk(ed.deck):
                    dns[:] = [d for d in dns if d not in ('_backups', '__pycache__') and not d.startswith('.')]
                    for f in fs:
                        if f.startswith('.') or (f.endswith('.zip') and dp == ed.deck):
                            continue
                        full = os.path.join(dp, f)
                        z.write(full, os.path.join(os.path.basename(ed.deck), os.path.relpath(full, ed.deck)))
                        n += 1
            return self.json(200, {'ok': True, 'file': out, 'count': n, 'size': os.path.getsize(out), 'canShow': sys.platform == 'darwin'})

        # -------------------------------------------- import a PowerPoint file with pptx2reveal
        def import_pptx(self, body):
            try:
                req = json.loads(body.decode('utf-8') or '{}')
            except Exception:
                req = {}
            path = req.get('path') or ''
            if not path and sys.platform == 'darwin':
                path = osascript('POSIX path of (choose file with prompt "Choose a PowerPoint file" of type {"org.openxmlformats.presentationml.presentation"})')
                if not path:
                    return self.json(200, {'ok': False, 'cancelled': True})
            path = os.path.abspath(os.path.expanduser(path or ''))
            if not path.lower().endswith('.pptx') or not os.path.isfile(path):
                return self.json(400, {'error': 'give the path of a .pptx file'})
            src = pptx2reveal_source()
            if not src:
                return self.json(500, {'error': 'the converter (pptx2reveal) is not bundled in this build'})
            chk = subprocess.run([sys.executable, '-c', 'import lxml, PIL'], capture_output=True)
            if chk.returncode != 0:
                return self.json(200, {'ok': False, 'reason': 'deps', 'python': sys.executable,
                                       'hint': '%s -m pip install lxml pillow' % sys.executable})
            outdir = os.path.splitext(path)[0] + '_deck'
            if os.path.exists(os.path.join(outdir, 'index.html')):
                return self.json(409, {'error': '%s already exists — open it, or move it away first' % outdir})
            with tempfile.TemporaryDirectory(prefix='deck-import-') as tmp:
                conv = os.path.join(tmp, 'pptx2reveal.py')
                open(conv, 'w', encoding='utf-8').write(src)
                r = subprocess.run([sys.executable, conv, path, outdir], capture_output=True, text=True, timeout=900)
            if r.returncode != 0 or not os.path.isfile(os.path.join(outdir, 'index.html')):
                return self.json(500, {'error': 'conversion failed: ' + (r.stderr or r.stdout).strip()[-600:]})
            write_vendor(outdir)
            url = launch_editor(outdir, 'index.html')
            return self.json(200, {'ok': True, 'file': os.path.join(outdir, 'index.html'), 'url': url, 'log': (r.stderr or '').strip()[-800:]})

        def show_pdf(self, body):
            fp = ed.safe_path(ed.file)
            out = os.path.splitext(fp)[0] + '.pdf'
            if sys.platform == 'darwin' and os.path.isfile(out):
                subprocess.run(['open', '-R', out], capture_output=True)
                return self.json(200, {'ok': True})
            return self.json(404, {'error': 'not available'})

        def upload(self, q, body):
            name = os.path.basename((q.get('name') or ['image.png'])[0])
            stem, ext = os.path.splitext(name)
            ext = ext.lower()
            if ext not in UPLOAD_EXT:
                return self.json(400, {'error': 'unsupported file type %s' % ext})
            stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem).strip('._') or 'image'
            mdir = os.path.join(ed.deck, 'media')
            os.makedirs(mdir, exist_ok=True)
            # identical file already in media/? reuse it
            digest = sha(body)
            cand = os.path.join(mdir, stem + ext)
            k = 1
            while os.path.exists(cand):
                if sha(open(cand, 'rb').read()) == digest:
                    break
                cand = os.path.join(mdir, '%s-%d%s' % (stem, k, ext))
                k += 1
            if not os.path.exists(cand):
                with open(cand, 'wb') as fh:
                    fh.write(body)
            return self.json(200, {'url': 'media/' + os.path.basename(cand)})

    return H


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):   # browsers drop connections all the time; stay quiet
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def free_port(start):
    for p in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # same as the server itself
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    raise SystemExit('no free port found')


REVEAL_RE = re.compile(r'class\s*=\s*["\'][^"\']*\breveal\b', re.I)


def find_chrome():
    """a Chromium-based browser that can print to PDF without a window (Chrome, Edge, Brave, Chromium)"""
    env = os.environ.get('REVEAL_EDIT_CHROME')
    if env and os.path.isfile(env):
        return env
    if sys.platform == 'darwin':
        apps = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Google Chrome Canary', 'Vivaldi']
        for base in ('/Applications', os.path.expanduser('~/Applications')):
            for app in apps:
                exe = os.path.join(base, app + '.app', 'Contents', 'MacOS', app)
                if os.access(exe, os.X_OK):
                    return exe
        for bid, app in (('com.google.Chrome', 'Google Chrome'), ('com.microsoft.edgemac', 'Microsoft Edge'),
                         ('com.brave.Browser', 'Brave Browser')):      # installed somewhere else
            try:
                found = subprocess.run(['mdfind', 'kMDItemCFBundleIdentifier == "%s"' % bid], capture_output=True,
                                       text=True, timeout=5).stdout.split('\n')[0].strip()
            except Exception:
                found = ''
            exe = os.path.join(found, 'Contents', 'MacOS', app) if found else ''
            if exe and os.access(exe, os.X_OK):
                return exe
        return None
    if sys.platform.startswith('win'):
        for base in (os.environ.get('PROGRAMFILES', ''), os.environ.get('PROGRAMFILES(X86)', ''), os.environ.get('LOCALAPPDATA', '')):
            for rel in (r'Google\Chrome\Application\chrome.exe', r'Microsoft\Edge\Application\msedge.exe',
                        r'BraveSoftware\Brave-Browser\Application\brave.exe'):
                exe = os.path.join(base, rel)
                if base and os.path.isfile(exe):
                    return exe
        return None
    for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'):
        exe = shutil.which(name)
        if exe:
            return exe
    return None


def browser_name(exe):
    low = exe.lower()
    for key, name in (('edge', 'Microsoft Edge'), ('brave', 'Brave'), ('chromium', 'Chromium'), ('vivaldi', 'Vivaldi'), ('canary', 'Chrome Canary')):
        if key in low:
            return name
    return 'Google Chrome'


def is_deck(path):
    try:
        with open(path, 'rb') as fh:
            head = fh.read(400000).decode('utf-8', 'ignore')
    except OSError:
        return False
    return bool(REVEAL_RE.search(head)) and 'slides' in head


def find_decks(folder):
    try:
        names = sorted(n for n in os.listdir(folder) if n.lower().endswith(('.html', '.htm')) and not n.startswith('.'))
    except OSError:
        return []
    decks = [n for n in names if is_deck(os.path.join(folder, n))]
    decks.sort(key=lambda n: (n.lower() != 'index.html', n.lower()))
    return decks


def osascript(script):
    if sys.platform != 'darwin':
        return None
    r = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def pick_file(folder=None):
    """macOS file chooser; returns a path or None (cancelled / not on a Mac)."""
    loc = ' default location (POSIX file %s)' % aq(folder) if folder else ''
    return osascript('POSIX path of (choose file with prompt "Choose a presentation (its HTML file)" '
                     'of type {"public.html"}%s)' % loc)


def choose_among(folder, decks):
    if sys.stdin.isatty() and not GUI:
        print('Several presentations in %s:' % folder)
        for k, n in enumerate(decks, 1):
            print('  %d. %s' % (k, n))
        try:
            k = int(input('Which one? [1] ') or '1')
            return decks[k - 1]
        except (ValueError, IndexError, EOFError, KeyboardInterrupt):
            return None
    if sys.platform != 'darwin':                 # cannot ask: take the first (index.html when present)
        print('Several presentations in %s; opening %s (name the file to choose another)' % (folder, decks[0]))
        return decks[0]
    items = ', '.join(aq(n) for n in decks)
    r = osascript('choose from list {%s} with prompt "Which presentation?" default items {%s}' % (items, aq(decks[0])))
    return r if r and r != 'false' else None


def resolve(target, file):
    """-> (deck folder, html file name) or exits with a message"""
    if target is None:
        base = os.getcwd()
        if os.path.basename(HERE) == '_tools' and find_decks(os.path.dirname(HERE)):
            base = os.path.dirname(HERE)              # a copy living in a deck's _tools folder
        decks = find_decks(base)
        if not decks:
            p = pick_file(base)
            if not p:
                if sys.platform == 'darwin':
                    raise SystemExit(0)
                say('No presentation in %s. Run: deck new "My talk"  or  deck path/to/talk.html' % base, error=True)
                raise SystemExit(1)
            return resolve(p, None)
        return base, decks[0] if len(decks) == 1 else (choose_among(base, decks) or sys.exit(0))
    target = os.path.abspath(os.path.expanduser(target))
    if os.path.isdir(target):
        if file:
            return resolve(os.path.join(target, file), None)
        decks = find_decks(target)
        if not decks:
            say('No reveal.js presentation (an .html file using reveal.js) in %s' % target, error=True)
            raise SystemExit(1)
        return target, decks[0] if len(decks) == 1 else (choose_among(target, decks) or sys.exit(0))
    if not os.path.isfile(target):
        say('Cannot find %s' % target, error=True)
        raise SystemExit(1)
    if not target.lower().endswith(('.html', '.htm')):
        say('%s is not an HTML file. Open the presentation\'s .html file.' % os.path.basename(target), error=True)
        raise SystemExit(1)
    if not is_deck(target):
        say('%s does not look like a reveal.js presentation (no .reveal / .slides).' % os.path.basename(target), error=True)
        raise SystemExit(1)
    return os.path.dirname(target), os.path.basename(target)


def registry_dir(app='deck'):
    base = os.path.expanduser('~/Library/Caches') if sys.platform == 'darwin' else \
        os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
    d = os.path.join(base, app)
    os.makedirs(d, exist_ok=True)
    return d


def running_editor(deck, file):
    """port of an editor already serving this deck, or None"""
    key = hashlib.sha1((os.path.realpath(deck) + '\0' + file).encode()).hexdigest()[:16]
    rec = os.path.join(registry_dir(), key + '.json')
    try:
        info = json.load(open(rec))
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never via a proxy
        with direct.open('http://127.0.0.1:%d/__whoami' % info['port'], timeout=1.5) as r:
            who = json.loads(r.read())
        if who.get('app') == 'deck' and who.get('deck') == os.path.realpath(deck) and who.get('file') == file:
            return info['port'], rec
    except Exception:
        pass
    return None, rec


def launch_editor(deck, file):
    """the URL of an editor for deck/file: a running one, or a new background instance of this program"""
    port, rec = running_editor(deck, file)
    if port:
        return 'http://127.0.0.1:%d/%s?edit' % (port, urllib.parse.quote(file))
    me = os.path.abspath(sys.argv[0])
    cmd = [sys.executable, me, os.path.join(deck, file), '--no-browser']
    kw = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.PIPE, 'stderr': subprocess.DEVNULL, 'start_new_session': True}
    pr = subprocess.Popen(cmd, **kw)
    url = None
    for line in iter(pr.stdout.readline, b''):
        m = re.search(rb'Open (http://\S+)', line)
        if m:
            url = m.group(1).decode()
            break
    threading.Thread(target=pr.stdout.read, daemon=True).start()     # keep its pipe drained
    return url


def main():
    global GUI
    if sys.argv[1:2] == ['new']:
        return main_new(sys.argv[2:])
    ap = argparse.ArgumentParser(prog='deck', description='A pared-down PowerPoint for presentations that live in HTML.',
                                 epilog='deck new "My talk" makes a new presentation. The editor stops a few seconds after you close its browser tab.')
    ap.add_argument('target', nargs='?', help='presentation .html file or its folder (default: current folder)')
    ap.add_argument('file', nargs='?', help=argparse.SUPPRESS)          # old form: edit.py DECK_DIR FILE
    ap.add_argument('--port', type=int, default=8765, help='first port to try (default 8765)')
    ap.add_argument('--no-browser', action='store_true', help='do not open the browser, just print the address')
    ap.add_argument('--keep-running', action='store_true', help='keep running after the editor tab is closed')
    ap.add_argument('--gui', action='store_true', help=argparse.SUPPRESS)   # started from the Finder app
    ap.add_argument('--version', action='version', version='deck ' + VERSION)
    a = ap.parse_args()
    GUI = a.gui or not sys.stdin.isatty()
    if a.gui and a.target is None:
        a.target = gui_start()
        if a.target is None:
            return
    for f in EDITOR_FILES:
        if editor_asset(f) is None:
            say('%s is missing next to %s' % (f, os.path.basename(__file__)), error=True)
            raise SystemExit(1)
    deck, file = resolve(a.target, a.file)
    port, rec = running_editor(deck, file)
    if port:
        url = 'http://127.0.0.1:%d/%s?edit' % (port, urllib.parse.quote(file))
        print('Already editing %s — opening another tab: %s' % (os.path.join(deck, file), url))
        if not a.no_browser:
            webbrowser.open(url)
        return
    port = free_port(a.port)
    ed = Editor(deck, file)
    ed.keep = a.keep_running
    srv = Server(('127.0.0.1', port), make_handler(ed, port))
    ed.server = srv
    try:
        with open(rec, 'w') as fh:
            json.dump({'port': port, 'pid': os.getpid(), 'deck': ed.deck, 'file': file}, fh)
    except OSError:
        rec = None
    import signal

    def _stop(signum, frame):            # Terminal window closed (SIGHUP) or kill (SIGTERM): exit cleanly
        raise KeyboardInterrupt
    for name in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), _stop)
    threading.Thread(target=ed.watchdog, daemon=True).start()
    url = 'http://127.0.0.1:%d/%s?edit' % (port, urllib.parse.quote(file))
    print('Editing %s' % os.path.join(deck, file))
    if not os.path.exists(os.path.join(deck, 'lib', 'reveal', 'reveal.js')) and ed_is_deck_file(os.path.join(deck, file)):
        write_vendor(deck)      # a deck copied without its lib/ folder: put reveal.js back
    print('Open %s   (stops when you close the editor tab, or press Ctrl+C)' % url)
    sys.stdout.flush()
    if not a.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
    finally:
        if rec:
            try:
                os.remove(rec)
            except OSError:
                pass



def ed_is_deck_file(path):
    try:
        with open(path, 'rb') as fh:
            return b'id="deck-meta"' in fh.read(200000)
    except OSError:
        return False


def main_new(argv):
    global GUI
    ap = argparse.ArgumentParser(prog='deck new', description='Make a new presentation.')
    ap.add_argument('title', nargs='?', default='Presentation', help='its title (also the folder name)')
    ap.add_argument('--in', dest='where', metavar='FOLDER', help='parent folder (default: current folder)')
    ap.add_argument('--theme', choices=sorted(THEMES), default='dark')
    ap.add_argument('--size', choices=['16:9', '4:3'], default='16:9')
    ap.add_argument('--no-browser', action='store_true', help='do not open the editor afterwards')
    ap.add_argument('--port', type=int, default=8765)
    a = ap.parse_args(argv)
    GUI = not sys.stdin.isatty()
    folder = os.path.join(os.path.abspath(a.where or os.getcwd()), a.title)
    try:
        file = new_deck(folder, a.title, a.theme, a.size)
    except FileExistsError as e:
        say('%s already exists' % e, error=True)
        raise SystemExit(1)
    print('Created %s' % file)
    if not a.no_browser:
        sys.argv = [sys.argv[0], file, '--port', str(a.port)]
        return main()


def gui_start():
    """started from the Finder app without a file: ask what to do"""
    if sys.platform != 'darwin':
        return None
    r = osascript('button returned of (display dialog "Deck" & return & "Make a new presentation, or open one?" '
                  'buttons {"Cancel", "Open\u2026", "New\u2026"} default button "New\u2026" with title "Deck")')
    if r and r.startswith('New'):
        title = osascript('text returned of (display dialog "Name of the new presentation:" default answer "My talk" with title "Deck")')
        if not title:
            return None
        where = osascript('POSIX path of (choose folder with prompt "Where should the folder %s go?")' % aq(title))
        if not where:
            return None
        theme = osascript('choose from list {"dark", "light"} with prompt "Theme" default items {"dark"}')
        if not theme or theme == 'false':
            return None
        try:
            return new_deck(os.path.join(where, title), title, theme, '16:9')
        except FileExistsError:
            say('There is already a presentation called %s in that folder.' % title, error=True)
            return None
    if r and r.startswith('Open'):
        return pick_file()
    return None


if __name__ == '__main__':
    main()
