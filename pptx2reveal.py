#!/usr/bin/env python3
"""pptx2reveal — convert a .pptx deck into a position-faithful reveal.js presentation.

Every slide becomes a 1280x720 frame (1 px = 9525 EMU) with absolutely positioned
HTML/SVG elements: text with full placeholder/master style inheritance, pictures
(with crops, SVG blips, EMF-wrapped PDFs), preset and custom geometry, connectors
with arrowheads, groups, videos, speaker notes, and click-build animations mapped
to reveal.js fragments.

Usage:
  pptx2reveal.py deck.pptx OUTDIR [--embed-html SLIDE=FILE] [--embed-css CSS]
                 [--embed-scale S] [--reveal-dir DIR] [--fonts-dir DIR]
"""
import argparse, copy, html, io, json, math, os, posixpath, re, shutil, subprocess, sys, tempfile, zipfile
from lxml import etree

NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'mc': 'http://schemas.openxmlformats.org/markup-compatibility/2006',
    'p14': 'http://schemas.microsoft.com/office/powerpoint/2010/main',
    'a14': 'http://schemas.microsoft.com/office/drawing/2010/main',
    'asvg': 'http://schemas.microsoft.com/office/drawing/2016/SVG/main',
}
A = '{%s}' % NS['a']
P = '{%s}' % NS['p']
R = '{%s}' % NS['r']
EMU = 9525.0  # EMU per CSS px at 96 dpi


def px(v):
    return int(v) / EMU


def f2(x):
    s = ('%.2f' % x).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def lname(el):
    return etree.QName(el).localname


def esc(s):
    return html.escape(s, quote=True)


# ----------------------------------------------------------------------------- package

class Pkg:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = set(self.z.namelist())
        self._xml = {}
        self._rels = {}

    def read(self, part):
        return self.z.read(part)

    def xml(self, part):
        if part not in self._xml:
            self._xml[part] = etree.fromstring(self.z.read(part))
        return self._xml[part]

    def rels(self, part):
        if part in self._rels:
            return self._rels[part]
        d, b = posixpath.split(part)
        rp = posixpath.join(d, '_rels', b + '.rels')
        out = {}
        if rp in self.names:
            for r in etree.fromstring(self.z.read(rp)):
                tgt = r.get('Target')
                ext = r.get('TargetMode') == 'External'
                if not ext:
                    tgt = posixpath.normpath(posixpath.join(d, tgt)) if not tgt.startswith('/') else tgt.lstrip('/')
                out[r.get('Id')] = (r.get('Type').rsplit('/', 1)[-1], tgt, ext)
        self._rels[part] = out
        return out

    def rel_target(self, part, typ):
        for rid, (t, tgt, ext) in self.rels(part).items():
            if t == typ:
                return tgt
        return None


def resolve_mc(el):
    """Replace mc:AlternateContent children by the chosen branch (in place, recursively)."""
    supported = {'p14', 'a14', 'p15', 'a16', 'asvg', 'v', 'wps', 'p159'}
    for ac in list(el.iter('{%s}AlternateContent' % NS['mc'])):
        parent = ac.getparent()
        if parent is None:
            continue
        chosen = None
        for ch in ac:
            if lname(ch) == 'Choice':
                req = set((ch.get('Requires') or '').split())
                # prefer the fallback for OMML math (a14:m) since we cannot typeset it
                if req <= supported and 'a14' not in req:
                    chosen = ch
                    break
            elif lname(ch) == 'Fallback':
                chosen = ch
        idx = parent.index(ac)
        parent.remove(ac)
        if chosen is not None:
            for k, c in enumerate(list(chosen)):
                parent.insert(idx + k, c)


# ----------------------------------------------------------------------------- color

def _srgb_to_lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lin_to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def rgb_to_hsl(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, l
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == r:
        h = (g - b) / d + (6 if g < b else 0)
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h / 6, s, l


def hsl_to_rgb(h, s, l):
    if s == 0:
        return l, l, l

    def hue(p, q, t):
        t %= 1
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p
    q = l * (1 + s) if l < 0.5 else l + s - l * s
    p = 2 * l - q
    return hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)


PRESET_COLORS = {'black': '000000', 'white': 'FFFFFF', 'red': 'FF0000', 'green': '008000', 'blue': '0000FF',
                 'yellow': 'FFFF00', 'gray': '808080', 'grey': '808080', 'orange': 'FFA500', 'purple': '800080',
                 'cyan': '00FFFF', 'magenta': 'FF00FF', 'darkGray': 'A9A9A9', 'lightGray': 'D3D3D3',
                 'darkBlue': '00008B', 'darkRed': '8B0000', 'darkGreen': '006400'}

COLOR_TAGS = ('srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr')


class Color:
    __slots__ = ('r', 'g', 'b', 'a')

    def __init__(self, r, g, b, a=1.0):
        self.r, self.g, self.b, self.a = r, g, b, a

    def css(self, extra_alpha=1.0):
        R_, G_, B_ = (int(round(max(0, min(1, c)) * 255)) for c in (self.r, self.g, self.b))
        a = self.a * extra_alpha
        if a >= 0.999:
            return '#%02x%02x%02x' % (R_, G_, B_)
        return 'rgba(%d,%d,%d,%s)' % (R_, G_, B_, f2(max(0, a)))


class ColorCtx:
    def __init__(self, theme_colors, clrmap):
        self.theme = theme_colors
        self.map = clrmap

    def with_map(self, clrmap):
        return ColorCtx(self.theme, clrmap)

    def scheme(self, name):
        name = self.map.get(name, name)
        return self.theme.get(name, '000000')

    def parse(self, el, ph=None):
        """el: a color element (srgbClr, schemeClr...)"""
        t = lname(el)
        if t == 'srgbClr':
            h = el.get('val', '000000')
        elif t == 'schemeClr':
            v = el.get('val')
            if v == 'phClr':
                if ph is None:
                    base = Color(0, 0, 0)
                else:
                    base = Color(ph.r, ph.g, ph.b, ph.a)
                return self._mods(base, el)
            h = self.scheme(v)
        elif t == 'sysClr':
            h = el.get('lastClr') or ('000000' if el.get('val') == 'windowText' else 'FFFFFF')
        elif t == 'prstClr':
            h = PRESET_COLORS.get(el.get('val'), '000000')
        elif t == 'scrgbClr':
            c = Color(*(_lin_to_srgb(int(el.get(k, 0)) / 100000) for k in ('r', 'g', 'b')))
            return self._mods(c, el)
        elif t == 'hslClr':
            rgb = hsl_to_rgb(int(el.get('hue', 0)) / 21600000, int(el.get('sat', 0)) / 100000, int(el.get('lum', 0)) / 100000)
            return self._mods(Color(*rgb), el)
        else:
            return None
        base = Color(int(h[0:2], 16) / 255, int(h[2:4], 16) / 255, int(h[4:6], 16) / 255)
        return self._mods(base, el)

    @staticmethod
    def _mods(c, el):
        r, g, b, a = c.r, c.g, c.b, c.a
        for m in el:
            t = lname(m)
            v = int(m.get('val', 0)) / 100000 if m.get('val') is not None else 0
            if t in ('lumMod', 'lumOff', 'satMod', 'satOff', 'hueMod', 'hueOff', 'hue', 'sat', 'lum'):
                h, s, l = rgb_to_hsl(r, g, b)
                if t == 'lumMod':
                    l *= v
                elif t == 'lumOff':
                    l += v
                elif t == 'satMod':
                    s *= v
                elif t == 'satOff':
                    s += v
                elif t == 'hueMod':
                    h *= v
                elif t == 'hueOff':
                    h += int(m.get('val', 0)) / 21600000
                elif t == 'hue':
                    h = int(m.get('val', 0)) / 21600000
                elif t == 'sat':
                    s = v
                elif t == 'lum':
                    l = v
                r, g, b = hsl_to_rgb(h % 1, max(0, min(1, s)), max(0, min(1, l)))
            elif t == 'tint':
                r, g, b = (_lin_to_srgb(1 - (1 - _srgb_to_lin(c_)) * v) for c_ in (r, g, b))
            elif t == 'shade':
                r, g, b = (_lin_to_srgb(_srgb_to_lin(c_) * v) for c_ in (r, g, b))
            elif t == 'alpha':
                a = v
            elif t == 'alphaMod':
                a *= v
            elif t == 'alphaOff':
                a += v
            elif t == 'comp':
                h, s, l = rgb_to_hsl(r, g, b)
                r, g, b = hsl_to_rgb((h + 0.5) % 1, s, l)
            elif t == 'inv':
                r, g, b = 1 - r, 1 - g, 1 - b
            elif t == 'gray':
                y = 0.299 * r + 0.587 * g + 0.114 * b
                r = g = b = y
        return Color(max(0, min(1, r)), max(0, min(1, g)), max(0, min(1, b)), max(0, min(1, a)))

    def first(self, parent, ph=None):
        """first color child of a fill element (e.g. a:solidFill)"""
        if parent is None:
            return None
        for ch in parent:
            if lname(ch) in COLOR_TAGS:
                return self.parse(ch, ph)
        return None


# ----------------------------------------------------------------------------- fonts

WINGDINGS = {0xA7: '▪', 0xD8: '➢', 0xFC: '✔', 0x71: '❑', 0x76: '❖', 0x6E: '■',
             0x6C: '●', 0xE0: '→', 0xDF: '←', 0xE1: '↑', 0xE2: '↓', 0xE8: '➔',
             0xF0: '⇨', 0xEF: '⇦', 0x9F: '•', 0x77: '⬥', 0xA8: '◻', 0x6F: '□',
             0x70: '□', 0x73: '♦', 0x75: '◆', 0x4A: '☺', 0x4C: '☹', 0x4B: '☐',
             0xFB: '✖', 0xFD: '☒', 0xFE: '☑', 0x43: '☜', 0x46: '☞', 0xB2: '✧',
             0xAB: '★', 0xA1: '○', 0xA4: '◉', 0x3E: '✇', 0x22: '✂', 0x28: '☎'}
SYMBOL = {0x61: 'α', 0x62: 'β', 0x63: 'χ', 0x64: 'δ', 0x65: 'ε', 0x66: 'φ', 0x67: 'γ', 0x68: 'η', 0x69: 'ι',
          0x6A: 'ϕ', 0x6B: 'κ', 0x6C: 'λ', 0x6D: 'μ', 0x6E: 'ν', 0x6F: 'ο', 0x70: 'π', 0x71: 'θ', 0x72: 'ρ',
          0x73: 'σ', 0x74: 'τ', 0x75: 'υ', 0x76: 'ϖ', 0x77: 'ω', 0x78: 'ξ', 0x79: 'ψ', 0x7A: 'ζ',
          0x41: 'Α', 0x42: 'Β', 0x43: 'Χ', 0x44: 'Δ', 0x45: 'Ε', 0x46: 'Φ', 0x47: 'Γ', 0x48: 'Η', 0x49: 'Ι',
          0x4B: 'Κ', 0x4C: 'Λ', 0x4D: 'Μ', 0x4E: 'Ν', 0x4F: 'Ο', 0x50: 'Π', 0x51: 'Θ', 0x52: 'Ρ', 0x53: 'Σ',
          0x54: 'Τ', 0x55: 'Υ', 0x57: 'Ω', 0x58: 'Ξ', 0x59: 'Ψ', 0x5A: 'Ζ', 0xAE: '→', 0xAC: '←', 0xAD: '↑',
          0xAF: '↓', 0xAB: '↔', 0xB0: '°', 0xB1: '±', 0xB4: '×', 0xB8: '÷', 0xA3: '≤', 0xB3: '≥', 0xB9: '≠',
          0xBB: '≈', 0xB5: '∝', 0xB6: '∂', 0xB7: '•', 0xD6: '√', 0xA5: '∞', 0xE5: '∑', 0xF2: '∫', 0xC6: '∅',
          0xCE: '∈', 0xDE: '⇒', 0xDB: '⇔', 0xBA: '≡', 0xA2: '′', 0xB2: '″', 0xBC: '…', 0xD1: '∇', 0xC5: '⊕',
          0xC4: '⊗', 0xDA: '∨', 0xD9: '∧', 0x22: '∀', 0x24: '∃', 0x27: '∋'}


def map_symbol_text(text, face):
    face = (face or '').lower()
    table = WINGDINGS if face.startswith('wingdings') else SYMBOL if face == 'symbol' else None
    if table is None:
        return text
    out = []
    for ch in text:
        o = ord(ch)
        if 0xF000 <= o <= 0xF0FF:
            o -= 0xF000
        out.append(table.get(o, chr(o) if o >= 0x20 else ch))
    return ''.join(out)


FONT_STACKS = {
    'calibri': "Calibri, Carlito, 'Helvetica Neue', Arial, sans-serif",
    'calibri light': "'Calibri Light', Carlito, 'Helvetica Neue', Arial, sans-serif",
    'arial': "Arial, 'Liberation Sans', Helvetica, sans-serif",
    'helvetica': "Helvetica, 'Helvetica Neue', Arial, 'Liberation Sans', sans-serif",
    'helvetica neue': "'Helvetica Neue', Helvetica, Arial, sans-serif",
    'times new roman': "'Times New Roman', Times, 'Liberation Serif', serif",
    'times': "Times, 'Times New Roman', 'Liberation Serif', serif",
    'poppins': "Poppins, 'Helvetica Neue', Arial, sans-serif",
    'aptos': "Aptos, 'Segoe UI', 'Helvetica Neue', Carlito, Arial, sans-serif",
    'cambria': "Cambria, Caladea, Georgia, serif",
    'cambria math': "'Cambria Math', 'STIX Two Math', Cambria, serif",
    'courier new': "'Courier New', Courier, 'Liberation Mono', monospace",
    'consolas': "Consolas, Menlo, 'Courier New', monospace",
    'segoe ui': "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
    'wingdings': "'Segoe UI Symbol', 'Apple Symbols', 'DejaVu Sans', sans-serif",
    'symbol': "'Segoe UI Symbol', 'Apple Symbols', 'DejaVu Sans', serif",
}
# PowerPoint's "single" line spacing is ~1.2 x the font size regardless of the face's own metrics
LINE_METRIC = {'calibri': 1.2207, 'calibri light': 1.2207}

# Wingdings bullets that read best drawn in CSS (glyph fallbacks vary too much across systems)
CSS_BULLETS = {0xA7: ('sq', 0.34), 0x6E: ('sq', 0.6), 0x6C: ('dot', 0.5), 0x9F: ('dot', 0.3)}


def font_stack(face):
    if not face:
        return FONT_STACKS['calibri']
    k = face.lower()
    if k in FONT_STACKS:
        return FONT_STACKS[k]
    return "'%s', Carlito, 'Helvetica Neue', Arial, sans-serif" % face.replace("'", '')


# ----------------------------------------------------------------------------- geometry

def arc_points(cx, cy, rx, ry, a0, sweep, n=None):
    """points along an ellipse from angle a0 (deg, clockwise, y down) sweeping `sweep` degrees."""
    n = n or max(4, int(abs(sweep) / 6))
    pts = []
    for k in range(1, n + 1):
        t = math.radians(a0 + sweep * k / n)
        pts.append((cx + rx * math.cos(t), cy + ry * math.sin(t)))
    return pts


def ooxml_arc(cur, wr, hr, st, sw):
    """DrawingML arcTo: current point lies on the ellipse at angle st. returns (svg cmd, endpoint)."""
    # convert the 'visual' angle used by DrawingML to the parametric ellipse angle
    def param(ang):
        a = math.radians(ang)
        return math.atan2(wr * math.sin(a), hr * math.cos(a)) if wr and hr else a
    t0 = param(st)
    t1 = param(st + sw)
    # keep sweep direction/size consistent with the visual sweep
    dt = t1 - t0
    if sw > 0 and dt < 0:
        dt += 2 * math.pi
    if sw < 0 and dt > 0:
        dt -= 2 * math.pi
    if abs(sw) >= 360:
        dt = math.copysign(2 * math.pi, sw)
    cx = cur[0] - wr * math.cos(t0)
    cy = cur[1] - hr * math.sin(t0)
    segs = []
    steps = max(1, int(math.ceil(abs(dt) / (math.pi / 2))))
    p = cur
    for k in range(1, steps + 1):
        t = t0 + dt * k / steps
        e = (cx + wr * math.cos(t), cy + hr * math.sin(t))
        large = 0
        sweepflag = 1 if dt > 0 else 0
        segs.append('A%s %s 0 %d %d %s %s' % (f2(wr), f2(hr), large, sweepflag, f2(e[0]), f2(e[1])))
        p = e
    return ' '.join(segs), p


def preset_paths(prst, w, h, av):
    """Return list of (d, fill_mode, stroke) for a preset geometry in px space, or None if unknown.
    fill_mode: 'norm' | 'none' | 'lighten' | 'darken'."""
    def adj(name, default):
        return av.get(name, default)
    ss = min(w, h)
    hc, vc = w / 2, h / 2
    P_ = lambda pts: 'M' + ' L'.join('%s,%s' % (f2(x), f2(y)) for x, y in pts) + ' Z'
    if prst in ('rect', 'flowChartProcess'):
        return [(P_([(0, 0), (w, 0), (w, h), (0, h)]), 'norm', True)]
    if prst in ('line', 'straightConnector1'):
        return [('M0,0 L%s,%s' % (f2(w), f2(h)), 'none', True)]
    if prst in ('bentConnector2',):
        return [('M0,0 L%s,0 L%s,%s' % (f2(w), f2(w), f2(h)), 'none', True)]
    if prst in ('bentConnector3',):
        x1 = w * adj('adj1', 50000) / 100000
        return [('M0,0 L%s,0 L%s,%s L%s,%s' % (f2(x1), f2(x1), f2(h), f2(w), f2(h)), 'none', True)]
    if prst in ('curvedConnector3',):
        x1 = w * adj('adj1', 50000) / 100000
        return [('M0,0 C%s,0 %s,%s %s,%s C%s,%s %s,%s %s,%s' % (f2(x1 / 2), f2(x1), f2(h / 4), f2(x1), f2(h / 2),
                                                                 f2(x1), f2(3 * h / 4), f2((x1 + w) / 2), f2(h), f2(w), f2(h)), 'none', True)]
    if prst == 'roundRect':
        r = ss * max(0, min(50000, adj('adj', 16667))) / 100000
        d = ('M%s,0 L%s,0 A%s,%s 0 0 1 %s,%s L%s,%s A%s,%s 0 0 1 %s,%s L%s,%s A%s,%s 0 0 1 %s,%s L0,%s A%s,%s 0 0 1 %s,0 Z' %
             (f2(r), f2(w - r), f2(r), f2(r), f2(w), f2(r), f2(w), f2(h - r), f2(r), f2(r), f2(w - r), f2(h),
              f2(r), f2(h), f2(r), f2(r), f2(0), f2(h - r), f2(r), f2(r), f2(r), f2(r)))
        return [(d, 'norm', True)]
    if prst in ('ellipse', 'flowChartConnector'):
        d = 'M0,%s A%s,%s 0 1 1 %s,%s A%s,%s 0 1 1 0,%s Z' % (f2(vc), f2(hc), f2(vc), f2(w), f2(vc), f2(hc), f2(vc), f2(vc))
        return [(d, 'norm', True)]
    if prst in ('triangle',):
        x = w * adj('adj', 50000) / 100000
        return [(P_([(x, 0), (w, h), (0, h)]), 'norm', True)]
    if prst == 'rtTriangle':
        return [(P_([(0, 0), (w, h), (0, h)]), 'norm', True)]
    if prst == 'diamond':
        return [(P_([(hc, 0), (w, vc), (hc, h), (0, vc)]), 'norm', True)]
    if prst in ('rightArrow', 'leftArrow'):
        a1 = max(0, min(100000, adj('adj1', 50000)))
        a2 = max(0, min(100000 * w / ss if ss else 0, adj('adj2', 50000)))
        dx1 = ss * a2 / 100000
        dy1 = h * a1 / 200000
        y1, y2 = vc - dy1, vc + dy1
        if prst == 'rightArrow':
            x1 = w - dx1
            pts = [(0, y1), (x1, y1), (x1, 0), (w, vc), (x1, h), (x1, y2), (0, y2)]
        else:
            x1 = dx1
            pts = [(0, vc), (x1, 0), (x1, y1), (w, y1), (w, y2), (x1, y2), (x1, h)]
        return [(P_(pts), 'norm', True)]
    if prst in ('upArrow', 'downArrow'):
        a1 = max(0, min(100000, adj('adj1', 50000)))
        a2 = max(0, min(100000 * h / ss if ss else 0, adj('adj2', 50000)))
        dy1 = ss * a2 / 100000
        dx1 = w * a1 / 200000
        x1, x2 = hc - dx1, hc + dx1
        if prst == 'downArrow':
            y1 = h - dy1
            pts = [(x1, 0), (x2, 0), (x2, y1), (w, y1), (hc, h), (0, y1), (x1, y1)]
        else:
            y1 = dy1
            pts = [(hc, 0), (w, y1), (x2, y1), (x2, h), (x1, h), (x1, y1), (0, y1)]
        return [(P_(pts), 'norm', True)]
    if prst == 'wedgeRectCallout':
        dxPos = w * adj('adj1', -20833) / 100000
        dyPos = h * adj('adj2', 62500) / 100000
        xPos, yPos = hc + dxPos, vc + dyPos
        dx, dy = dxPos * h, dyPos * w
        dq = abs(dx) - abs(dy)
        q = lambda c, y_, n: y_ if c > 0 else n
        x1 = w * q(dxPos, 7, 2) / 12
        x2 = w * q(dxPos, 10, 5) / 12
        y1 = h * q(dyPos, 7, 2) / 12
        y2 = h * q(dyPos, 10, 5) / 12
        xl = q(dq, 0, q(dxPos, 0, xPos))
        xt = q(dq, x1, q(dyPos, x1, xPos))
        xr = q(dq, q(dxPos, xPos, w), w)
        xb = q(dq, x1, q(dyPos, xPos, x1))
        yl = q(dq, q(dxPos, y1, yPos), y1)
        yt = q(dq, 0, q(dyPos, 0, yPos))
        yr = q(dq, q(dxPos, yPos, y1), y1)
        yb = q(dq, h, q(dyPos, yPos, h))
        pts = [(0, 0), (x1, 0), (xt, yt), (x2, 0), (w, 0), (w, y1), (xr, yr), (w, y2), (w, h), (x2, h), (xb, yb),
               (x1, h), (0, h), (0, y2), (xl, yl), (0, y1)]
        return [(P_(pts), 'norm', True)]
    if prst == 'can':
        a = max(0, min(50000 * h / ss if ss else 0, adj('adj', 25000)))
        y1 = ss * a / 200000
        y3 = h - y1
        rx = w / 2
        body = 'M0,%s A%s,%s 0 0 0 %s,%s L%s,%s A%s,%s 0 0 1 0,%s Z' % (
            f2(y1), f2(rx), f2(y1), f2(w), f2(y1), f2(w), f2(y3), f2(rx), f2(y1), f2(y3))
        top = 'M0,%s A%s,%s 0 0 1 %s,%s A%s,%s 0 0 1 0,%s Z' % (f2(y1), f2(rx), f2(y1), f2(w), f2(y1), f2(rx), f2(y1), f2(y1))
        outline = ('M%s,%s A%s,%s 0 0 1 0,%s A%s,%s 0 0 1 %s,%s L%s,%s A%s,%s 0 0 1 0,%s L0,%s' % (
            f2(w), f2(y1), f2(rx), f2(y1), f2(y1), f2(rx), f2(y1), f2(w), f2(y1), f2(w), f2(y3), f2(rx), f2(y1), f2(y3), f2(y1)))
        return [(body, 'norm', False), (top, 'lighten', False), (outline, 'none', True)]
    if prst == 'irregularSeal2':
        pts = [(11462, 4342), (14790, 0), (14525, 5777), (18007, 3172), (16380, 6532), (21600, 6645), (16985, 9402),
               (18270, 11290), (16380, 12310), (18877, 15632), (14640, 14350), (14942, 17370), (12180, 15935),
               (11612, 18842), (9872, 17370), (8700, 19712), (7527, 18125), (4917, 21600), (4805, 18240),
               (1285, 17825), (3330, 15370), (0, 12877), (3935, 11592), (1172, 8270), (5372, 7817), (4502, 3625),
               (8550, 6382), (9722, 1887)]
        return [(P_([(x * w / 21600, y * h / 21600) for x, y in pts]), 'norm', True)]
    if prst == 'irregularSeal1':
        pts = [(10800, 5800), (14522, 0), (14155, 5325), (18380, 4457), (16702, 7315), (21097, 8137), (17607, 10475),
               (21600, 13290), (16837, 12942), (18145, 18095), (14020, 14457), (13247, 19737), (10532, 14935),
               (8485, 21600), (7715, 15627), (4762, 17617), (5667, 13937), (135, 14587), (3722, 11775), (0, 8615),
               (4627, 7617), (370, 2295), (7312, 6320), (8352, 2295)]
        return [(P_([(x * w / 21600, y * h / 21600) for x, y in pts]), 'norm', True)]
    if prst == 'chevron':
        a = max(0, min(100000 * w / ss if ss else 0, adj('adj', 50000)))
        x1 = ss * a / 100000
        return [(P_([(0, 0), (w - x1, 0), (w, vc), (w - x1, h), (0, h), (x1, vc)]), 'norm', True)]
    if prst == 'homePlate':
        a = max(0, min(100000 * w / ss if ss else 0, adj('adj', 50000)))
        x1 = w - ss * a / 100000
        return [(P_([(0, 0), (x1, 0), (w, vc), (x1, h), (0, h)]), 'norm', True)]
    if prst == 'parallelogram':
        a = max(0, min(100000 * w / ss if ss else 0, adj('adj', 25000)))
        x2 = ss * a / 100000
        return [(P_([(0, h), (x2, 0), (w, 0), (w - x2, h)]), 'norm', True)]
    if prst == 'trapezoid':
        a = max(0, min(50000 * w / ss if ss else 0, adj('adj', 25000)))
        x2 = ss * a / 100000
        return [(P_([(0, h), (x2, 0), (w - x2, 0), (w, h)]), 'norm', True)]
    if prst in ('hexagon',):
        a = adj('adj', 25000)
        x1 = ss * a / 100000
        return [(P_([(0, vc), (x1, 0), (w - x1, 0), (w, vc), (w - x1, h), (x1, h)]), 'norm', True)]
    if prst == 'plus':
        a = adj('adj', 25000)
        x1 = ss * a / 100000
        x2, y2 = w - x1, h - x1
        return [(P_([(x1, 0), (x2, 0), (x2, x1), (w, x1), (w, y2), (x2, y2), (x2, h), (x1, h), (x1, y2), (0, y2), (0, x1), (x1, x1)]), 'norm', True)]
    return None


def cust_paths(custGeom, w, h):
    out = []
    pl = custGeom.find(A + 'pathLst')
    if pl is None:
        return out
    gd = {}
    for g in custGeom.iterfind(A + 'gdLst/' + A + 'gd'):
        m = re.match(r'val\s+(-?\d+)', g.get('fmla', ''))
        if m:
            gd[g.get('name')] = int(m.group(1))

    def val(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return float(gd.get(v, 0))
    for path in pl.iterfind(A + 'path'):
        pw = float(path.get('w', 0) or 0) or None
        ph_ = float(path.get('h', 0) or 0) or None
        sx = w / pw if pw else 1.0
        sy = h / ph_ if ph_ else 1.0
        d = []
        cur = (0.0, 0.0)
        start = (0.0, 0.0)
        for c in path:
            t = lname(c)
            pts = [(val(pt.get('x')) * sx, val(pt.get('y')) * sy) for pt in c.iterfind(A + 'pt')]
            if t == 'moveTo' and pts:
                cur = start = pts[0]
                d.append('M%s,%s' % (f2(cur[0]), f2(cur[1])))
            elif t == 'lnTo' and pts:
                cur = pts[0]
                d.append('L%s,%s' % (f2(cur[0]), f2(cur[1])))
            elif t == 'cubicBezTo' and len(pts) == 3:
                d.append('C' + ' '.join('%s,%s' % (f2(x), f2(y)) for x, y in pts))
                cur = pts[2]
            elif t == 'quadBezTo' and len(pts) == 2:
                d.append('Q' + ' '.join('%s,%s' % (f2(x), f2(y)) for x, y in pts))
                cur = pts[1]
            elif t == 'arcTo':
                wr = val(c.get('wR')) * sx
                hr = val(c.get('hR')) * sy
                st = val(c.get('stAng')) / 60000
                sw = val(c.get('swAng')) / 60000
                cmd, cur = ooxml_arc(cur, wr, hr, st, sw)
                d.append(cmd)
            elif t == 'close':
                d.append('Z')
                cur = start
        fill = path.get('fill', 'norm')
        stroke = path.get('stroke', '1') not in ('0', 'false')
        out.append((' '.join(d), fill, stroke))
    return out


# ----------------------------------------------------------------------------- converter

class Converter:
    def __init__(self, pptx, outdir, opts):
        self.pkg = Pkg(pptx)
        self.out = outdir
        self.opts = opts
        self.media_dir = os.path.join(outdir, 'media')
        os.makedirs(self.media_dir, exist_ok=True)
        self.media_map = {}
        self.warnings = []
        self.uid = 0
        pres_part = 'ppt/presentation.xml'
        self.pres = self.pkg.xml(pres_part)
        sz = self.pres.find(P + 'sldSz')
        self.W = px(sz.get('cx'))
        self.H = px(sz.get('cy'))
        self.slides = []
        rels = self.pkg.rels(pres_part)
        for s in self.pres.iterfind(P + 'sldIdLst/' + P + 'sldId'):
            self.slides.append(rels[s.get('{%s}id' % NS['r'])][1])
        self.default_text_style = self.pres.find(P + 'defaultTextStyle')

    # ---------------------------------------------------------------- helpers
    def warn(self, msg):
        self.warnings.append(msg)

    def nid(self, prefix='g'):
        self.uid += 1
        return '%s%d' % (prefix, self.uid)

    def load_theme(self, master_part):
        tpart = self.pkg.rel_target(master_part, 'theme')
        th = self.pkg.xml(tpart)
        cs = th.find('.//' + A + 'clrScheme')
        colors = {}
        for el in cs:
            for ch in el:
                if lname(ch) == 'srgbClr':
                    colors[lname(el)] = ch.get('val')
                elif lname(ch) == 'sysClr':
                    colors[lname(el)] = ch.get('lastClr') or 'FFFFFF'
        fs = th.find('.//' + A + 'fontScheme')
        fonts = {
            'mj-lt': fs.find(A + 'majorFont/' + A + 'latin').get('typeface'),
            'mn-lt': fs.find(A + 'minorFont/' + A + 'latin').get('typeface'),
        }
        for k, tag in (('mj-ea', 'majorFont/' + A + 'ea'), ('mn-ea', 'minorFont/' + A + 'ea')):
            e = fs.find(A + tag)
            fonts[k] = (e.get('typeface') if e is not None else '') or fonts[k[:2] + '-lt']
        fonts['mj-cs'] = fonts['mj-lt']
        fonts['mn-cs'] = fonts['mn-lt']
        fmt = th.find('.//' + A + 'fmtScheme')
        return {
            'colors': colors, 'fonts': fonts,
            'fill': list(fmt.find(A + 'fillStyleLst')) if fmt is not None else [],
            'bgfill': list(fmt.find(A + 'bgFillStyleLst')) if fmt is not None else [],
            'ln': list(fmt.find(A + 'lnStyleLst')) if fmt is not None else [],
            'effect': [e.find(A + 'effectLst') for e in fmt.find(A + 'effectStyleLst')] if fmt is not None else [],
        }

    def resolve_face(self, face):
        if face and face.startswith('+'):
            return self.theme['fonts'].get(face[1:], self.theme['fonts']['mn-lt'])
        return face

    # ---------------------------------------------------------------- media
    def media(self, part, display_w=None, crop=None):
        """copy a package part to media/, converting where needed. returns relative URL or None"""
        key = part
        if key in self.media_map:
            return self.media_map[key]
        if part not in self.pkg.names:
            self.warn('missing media %s' % part)
            return None
        base = posixpath.basename(part)
        stem, ext = os.path.splitext(base)
        ext = ext.lower()
        data = self.pkg.read(part)
        url = None
        if ext in ('.emf', '.wmf'):
            url = self.convert_metafile(data, stem, ext)
        elif ext in ('.tif', '.tiff', '.bmp', '.wdp', '.jxr'):
            try:
                from PIL import Image
                im = Image.open(io.BytesIO(data))
                outp = os.path.join(self.media_dir, stem + '.png')
                im.save(outp)
                url = 'media/' + stem + '.png'
            except Exception as e:
                self.warn('cannot convert %s: %s' % (part, e))
        elif ext in ('.png', '.jpg', '.jpeg') and display_w and len(data) > 3_000_000:
            url = self.maybe_downscale(data, base, ext, display_w, crop)
        if url is None and ext not in ('.emf', '.wmf'):
            name = base  # keep the part's own name (and case) so files can be matched to the package
            with open(os.path.join(self.media_dir, name), 'wb') as fh:
                fh.write(data)
            url = 'media/' + name
        self.media_map[key] = url
        return url

    def maybe_downscale(self, data, base, ext, display_w, crop):
        try:
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None
            im = Image.open(io.BytesIO(data))
            l, r = (crop or (0, 0, 0, 0))[0], (crop or (0, 0, 0, 0))[2]
            full_disp = display_w / max(0.05, 1 - l - r)
            target = int(full_disp * 3)  # 3x the 1280-px slide size (= 2x a 1920 display)
            if im.width <= target * 1.25:
                return None
            hgt = int(im.height * target / im.width)
            im = im.resize((target, hgt), Image.LANCZOS)
            outp = os.path.join(self.media_dir, base)
            if ext == '.png':
                im.save(outp, optimize=True)
            else:
                im.convert('RGB').save(outp, quality=90)
            self.warn('downscaled %s to %dx%d' % (base, target, hgt))
            return 'media/' + base
        except Exception as e:
            self.warn('downscale failed for %s: %s' % (base, e))
            return None

    def convert_metafile(self, data, stem, ext):
        """EMF/WMF -> browser format. Mac Office stores pasted PDFs inside EMF comments; those are
        extracted and converted to SVG (pdftocairo), else an earlier conversion in media/ is reused,
        else rasterized (macOS sips, poppler pdftoppm). Other metafiles go through LibreOffice."""
        i = data.find(b'%PDF')
        if i >= 0:
            j = data.rfind(b'%%EOF')
            pdf = data[i:j + 5] if j > i else data[i:]
            with tempfile.TemporaryDirectory() as td:
                pp = os.path.join(td, 'x.pdf')
                with open(pp, 'wb') as fh:
                    fh.write(pdf)
                if shutil.which('pdftocairo'):
                    outp = os.path.join(self.media_dir, stem + '.svg')
                    r = subprocess.run(['pdftocairo', '-svg', pp, outp], capture_output=True)
                    if r.returncode == 0 and os.path.exists(outp):
                        return 'media/' + stem + '.svg'
                for prev in ('.svg', '.png'):
                    if os.path.exists(os.path.join(self.media_dir, stem + prev)):
                        return 'media/' + stem + prev
                if shutil.which('sips'):
                    outp = os.path.join(self.media_dir, stem + '.png')
                    r = subprocess.run(['sips', '-s', 'format', 'png', '-s', 'dpiWidth', '300', '-s', 'dpiHeight', '300',
                                        pp, '--out', outp], capture_output=True)
                    if r.returncode == 0 and os.path.exists(outp):
                        return 'media/' + stem + '.png'
                if shutil.which('pdftoppm'):
                    r = subprocess.run(['pdftoppm', '-png', '-r', '300', '-singlefile', pp, os.path.join(self.media_dir, stem)], capture_output=True)
                    if r.returncode == 0:
                        return 'media/' + stem + '.png'
        for prev in ('.svg', '.png'):
            if os.path.exists(os.path.join(self.media_dir, stem + prev)):
                return 'media/' + stem + prev
        soffice = shutil.which('soffice') or shutil.which('libreoffice')
        if soffice:
            with tempfile.TemporaryDirectory() as td:
                src = os.path.join(td, stem + ext)
                with open(src, 'wb') as fh:
                    fh.write(data)
                subprocess.run([soffice, '--headless', '--convert-to', 'svg', '--outdir', td, src], capture_output=True, timeout=180)
                svg = os.path.join(td, stem + '.svg')
                if os.path.exists(svg):
                    shutil.copy(svg, os.path.join(self.media_dir, stem + '.svg'))
                    return 'media/' + stem + '.svg'
        self.warn('could not convert metafile %s' % stem)
        return None

    # ---------------------------------------------------------------- fills / lines
    def fill_of(self, spPr, style, cctx, part):
        """returns ('none'|'solid'|'grad'|'blip', payload) or None"""
        if spPr is not None:
            for ch in spPr:
                t = lname(ch)
                if t == 'noFill':
                    return ('none', None)
                if t == 'solidFill':
                    return ('solid', cctx.first(ch))
                if t == 'gradFill':
                    return ('grad', self.grad(ch, cctx, None))
                if t == 'blipFill':
                    return ('blip', ch)
                if t == 'pattFill':
                    return ('solid', cctx.first(ch.find(A + 'fgClr')))
                if t == 'grpFill':
                    return ('grp', None)
        if style is not None:
            fr = style.find(A + 'fillRef')
            if fr is not None:
                idx = int(fr.get('idx', 0))
                phc = cctx.first(fr)
                lst = self.theme['fill'] if idx < 1000 else self.theme['bgfill']
                k = idx - 1 if idx < 1000 else idx - 1001
                if idx == 0 or k >= len(lst) or k < 0:
                    return ('none', None)
                el = lst[k]
                t = lname(el)
                if t == 'solidFill':
                    return ('solid', cctx.first(el, phc))
                if t == 'gradFill':
                    return ('grad', self.grad(el, cctx, phc))
                if t == 'noFill':
                    return ('none', None)
        return None

    def grad(self, g, cctx, phc):
        stops = []
        for gs in g.iterfind(A + 'gsLst/' + A + 'gs'):
            c = cctx.first(gs, phc)
            if c is not None:
                stops.append((int(gs.get('pos', 0)) / 100000, c))
        stops.sort(key=lambda s: s[0])
        lin = g.find(A + 'lin')
        path = g.find(A + 'path')
        kind = 'lin'
        ang = 0.0
        if lin is not None:
            ang = int(lin.get('ang', 0)) / 60000
        elif path is not None:
            kind = 'radial'
        return {'stops': stops, 'kind': kind, 'ang': ang}

    def line_of(self, spPr, style, cctx):
        """resolve line props -> dict or None"""
        base = None
        phc = None
        if style is not None:
            lr = style.find(A + 'lnRef')
            if lr is not None:
                idx = int(lr.get('idx', 0))
                phc = cctx.first(lr)
                if 0 < idx <= len(self.theme['ln']):
                    base = self.theme['ln'][idx - 1]
        ln = spPr.find(A + 'ln') if spPr is not None else None
        if base is None and ln is None:
            return None
        props = {'w': 9525, 'color': None, 'dash': 'solid', 'head': None, 'tail': None, 'cap': 'flat', 'join': 'round', 'none': False}
        for src in (base, ln):
            if src is None:
                continue
            if src.get('w') is not None:
                props['w'] = int(src.get('w'))
            if src.get('cap'):
                props['cap'] = src.get('cap')
            for ch in src:
                t = lname(ch)
                if t == 'noFill':
                    props['none'] = True
                    props['color'] = None
                elif t == 'solidFill':
                    props['none'] = False
                    props['color'] = cctx.first(ch, phc)
                elif t == 'gradFill':
                    props['none'] = False
                    gr = self.grad(ch, cctx, phc)
                    props['color'] = gr['stops'][0][1] if gr['stops'] else None
                elif t == 'prstDash':
                    props['dash'] = ch.get('val', 'solid')
                elif t == 'headEnd':
                    props['head'] = None if ch.get('type', 'none') == 'none' else (ch.get('type'), ch.get('w', 'med'), ch.get('len', 'med'))
                elif t == 'tailEnd':
                    props['tail'] = None if ch.get('type', 'none') == 'none' else (ch.get('type'), ch.get('w', 'med'), ch.get('len', 'med'))
                elif t == 'round':
                    props['join'] = 'round'
                elif t == 'miter':
                    props['join'] = 'miter'
                elif t == 'bevel':
                    props['join'] = 'bevel'
        if props['none'] or props['color'] is None:
            return None
        return props

    def effects_css(self, spPr, style, cctx):
        eff = spPr.find(A + 'effectLst') if spPr is not None else None
        if eff is None and spPr is not None and spPr.find(A + 'effectDag') is not None:
            eff = None
        if eff is None and style is not None:
            er = style.find(A + 'effectRef')
            if er is not None:
                idx = int(er.get('idx', 0))
                if 0 < idx <= len(self.theme['effect']):
                    eff = self.theme['effect'][idx - 1]
                    phc = cctx.first(er)
                    return self._eff(eff, cctx, phc)
        if eff is None:
            return ''
        return self._eff(eff, cctx, None)

    def _eff(self, eff, cctx, phc):
        parts = []
        if eff is None:
            return ''
        for ch in eff:
            t = lname(ch)
            if t == 'outerShdw':
                c = cctx.first(ch, phc)
                if c is None:
                    continue
                dist = px(ch.get('dist', 0))
                ang = math.radians(int(ch.get('dir', 0)) / 60000)
                blur = px(ch.get('blurRad', 0))
                parts.append('drop-shadow(%spx %spx %spx %s)' % (f2(dist * math.cos(ang)), f2(dist * math.sin(ang)), f2(blur / 2), c.css()))
            elif t == 'glow':
                c = cctx.first(ch, phc)
                if c is None:
                    continue
                rad = px(ch.get('rad', 0))
                parts.append('drop-shadow(0 0 %spx %s)' % (f2(rad / 2), c.css()))
        return ('filter:' + ' '.join(parts) + ';') if parts else ''

    # ---------------------------------------------------------------- svg helpers
    def svg_paint(self, fill, defs, w, h):
        if fill is None or fill[0] in ('none', 'grp', None):
            return 'none'
        if fill[0] == 'solid':
            c = fill[1]
            if c is None:
                return 'none'
            if c.a < 0.999:
                return '%s" fill-opacity="%s' % (Color(c.r, c.g, c.b).css(), f2(c.a))
            return c.css()
        if fill[0] == 'grad':
            g = fill[1]
            if not g['stops']:
                return 'none'
            gid = self.nid('gr')
            st = ''.join('<stop offset="%s" stop-color="%s"%s/>' % (
                f2(p), Color(c.r, c.g, c.b).css(), (' stop-opacity="%s"' % f2(c.a)) if c.a < 0.999 else '') for p, c in g['stops'])
            if g['kind'] == 'lin':
                a = math.radians(g['ang'])
                dx, dy = math.cos(a), math.sin(a)
                # gradient vector through the box centre, in bounding-box units
                x1, y1, x2, y2 = 0.5 - dx / 2, 0.5 - dy / 2, 0.5 + dx / 2, 0.5 + dy / 2
                defs.append('<linearGradient id="%s" x1="%s" y1="%s" x2="%s" y2="%s">%s</linearGradient>' % (gid, f2(x1), f2(y1), f2(x2), f2(y2), st))
            else:
                defs.append('<radialGradient id="%s">%s</radialGradient>' % (gid, st))
            return 'url(#%s)' % gid
        if fill[0] == 'blip':
            return 'none'
        return 'none'

    def css_paint(self, fill):
        if fill is None or fill[0] in ('none', 'grp'):
            return ''
        if fill[0] == 'solid' and fill[1] is not None:
            return 'background:%s;' % fill[1].css()
        if fill[0] == 'grad' and fill[1]['stops']:
            g = fill[1]
            st = ','.join('%s %s%%' % (c.css(), f2(p * 100)) for p, c in g['stops'])
            if g['kind'] == 'lin':
                return 'background:linear-gradient(%sdeg,%s);' % (f2(g['ang'] + 90), st)
            return 'background:radial-gradient(%s);' % st
        return ''

    DASH = {'solid': None, 'dot': (1, 1), 'sysDot': (1, 1), 'dash': (4, 3), 'sysDash': (3, 1), 'lgDash': (8, 3),
            'dashDot': (4, 3, 1, 3), 'sysDashDot': (3, 1, 1, 1), 'lgDashDot': (8, 3, 1, 3),
            'lgDashDotDot': (8, 3, 1, 3, 1, 3), 'sysDashDotDot': (3, 1, 1, 1, 1, 1)}

    def stroke_attrs(self, ln):
        w = max(px(ln['w']), 0.75)
        c = ln['color']
        s = ' stroke="%s" stroke-width="%s"' % (Color(c.r, c.g, c.b).css(), f2(w))
        if c.a < 0.999:
            s += ' stroke-opacity="%s"' % f2(c.a)
        d = self.DASH.get(ln['dash'])
        if d:
            s += ' stroke-dasharray="%s"' % ' '.join(f2(v * w) for v in d)
        s += ' stroke-linecap="%s"' % {'rnd': 'round', 'sq': 'square'}.get(ln['cap'], 'butt')
        s += ' stroke-linejoin="%s"' % ln['join']
        return s

    def arrowhead(self, tip, frm, spec, ln):
        """polygon/polyline svg for an arrowhead at `tip` coming from `frm`; returns (svg, shorten_px)"""
        typ, ws, ls = spec
        lw = max(px(ln['w']), 0.75)
        base = max(lw, 2.646)  # arrowheads never shrink below the size used for a ~2pt line
        mult = {'sm': 2.0, 'med': 3.0, 'lg': 5.0}
        aw = mult.get(ws, 3) * base
        al = mult.get(ls, 3) * base
        dx, dy = tip[0] - frm[0], tip[1] - frm[1]
        d = math.hypot(dx, dy) or 1.0
        ux, uy = dx / d, dy / d
        nx, ny = -uy, ux
        c = ln['color']
        col = Color(c.r, c.g, c.b).css()
        op = (' fill-opacity="%s"' % f2(c.a)) if c.a < 0.999 else ''
        bx, by = tip[0] - ux * al, tip[1] - uy * al
        if typ in ('triangle', 'stealth'):
            pts = [tip, (bx + nx * aw / 2, by + ny * aw / 2)]
            if typ == 'stealth':
                pts.append((tip[0] - ux * al * 0.55, tip[1] - uy * al * 0.55))
            pts.append((bx - nx * aw / 2, by - ny * aw / 2))
            return ('<polygon points="%s" fill="%s"%s/>' % (' '.join('%s,%s' % (f2(x), f2(y)) for x, y in pts), col, op),
                    al * (0.55 if typ == 'stealth' else 0.85))
        if typ == 'arrow':
            pts = [(bx + nx * aw / 2, by + ny * aw / 2), tip, (bx - nx * aw / 2, by - ny * aw / 2)]
            return ('<polyline points="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linejoin="miter"%s/>' % (
                ' '.join('%s,%s' % (f2(x), f2(y)) for x, y in pts), col, f2(lw), op.replace('fill', 'stroke')), lw / 2)
        if typ == 'oval':
            return ('<ellipse cx="%s" cy="%s" rx="%s" ry="%s" fill="%s"%s transform="rotate(%s %s %s)"/>' % (
                f2(tip[0]), f2(tip[1]), f2(al / 2), f2(aw / 2), col, op, f2(math.degrees(math.atan2(uy, ux))), f2(tip[0]), f2(tip[1])), 0)
        if typ == 'diamond':
            cx, cy = tip
            pts = [(cx + ux * al / 2, cy + uy * al / 2), (cx + nx * aw / 2, cy + ny * aw / 2),
                   (cx - ux * al / 2, cy - uy * al / 2), (cx - nx * aw / 2, cy - ny * aw / 2)]
            return ('<polygon points="%s" fill="%s"%s/>' % (' '.join('%s,%s' % (f2(x), f2(y)) for x, y in pts), col, op), 0)
        return ('', 0)

    # ---------------------------------------------------------------- placeholders
    @staticmethod
    def ph_info(sp):
        ph = sp.find('.//' + P + 'nvPr/' + P + 'ph')
        if ph is None:
            return None
        return (ph.get('type', 'body' if ph.get('idx') else 'obj'), ph.get('idx'), ph.get('type'))

    def find_ph(self, tree, info):
        """find matching placeholder sp element in a layout/master spTree"""
        if tree is None or info is None:
            return None
        typ, idx, rawtype = info
        cands = []
        for sp in tree.iter(P + 'sp'):
            pi = self.ph_info(sp)
            if pi is None:
                continue
            cands.append((sp, pi))
        by_type_only = {'title', 'ctrTitle', 'dt', 'ftr', 'sldNum', 'hdr', 'subTitle'}
        if rawtype in by_type_only:
            for sp, pi in cands:
                if pi[2] == rawtype or (rawtype in ('title', 'ctrTitle') and pi[2] in ('title', 'ctrTitle')):
                    return sp
        if idx is not None:
            for sp, pi in cands:
                if pi[1] == idx:
                    return sp
        # fall back by type (body-like)
        want = rawtype or 'body'
        for sp, pi in cands:
            if (pi[2] or 'body') == want:
                return sp
        if want in ('obj', 'body', 'subTitle', None):
            for sp, pi in cands:
                if pi[2] in ('body', None) and pi[2] != 'title':
                    return sp
        return None

    def master_ph(self, info):
        typ, idx, rawtype = info
        t = rawtype or 'body'
        if t in ('ctrTitle', 'title'):
            t = 'title'
        elif t in ('subTitle', 'obj', 'body', 'chart', 'tbl', 'clipArt', 'dgm', 'media', 'pic'):
            t = 'body'
        for sp in self.master_tree.iter(P + 'sp'):
            pi = self.ph_info(sp)
            if pi and (pi[2] or 'body') == t:
                return sp
        return None

    def master_txstyle(self, info):
        txs = self.master.find(P + 'txStyles')
        if info is None:
            return None
        t = info[2] or 'body'
        if t in ('title', 'ctrTitle'):
            return txs.find(P + 'titleStyle')
        if t in ('body', 'subTitle', 'obj', 'pic', 'tbl', 'chart', 'dgm', 'media', 'clipArt'):
            return txs.find(P + 'bodyStyle')
        return txs.find(P + 'otherStyle')

    # ---------------------------------------------------------------- slide
    def convert(self):
        sections = []
        for n, part in enumerate(self.slides, 1):
            sections.append(self.convert_slide(n, part))
        return sections

    def convert_slide(self, n, part):
        sld = self.pkg.xml(part)
        resolve_mc(sld)
        layout_part = self.pkg.rel_target(part, 'slideLayout')
        master_part = self.pkg.rel_target(layout_part, 'slideMaster')
        self.layout = self.pkg.xml(layout_part)
        self.master = self.pkg.xml(master_part)
        self.layout_part, self.master_part = layout_part, master_part
        self.layout_tree = self.layout.find(P + 'cSld/' + P + 'spTree')
        self.master_tree = self.master.find(P + 'cSld/' + P + 'spTree')
        self.theme = self.load_theme(master_part)
        cmap = dict(self.master.find(P + 'clrMap').attrib)
        for src in (self.layout, sld):
            ov = src.find(P + 'clrMapOvr/' + A + 'overrideClrMapping')
            if ov is not None:
                cmap = dict(ov.attrib)
        self.cctx = ColorCtx(self.theme['colors'], cmap)
        self.slide_no = n
        self.part = part
        self.anim = self.parse_timing(sld)

        # background
        bg_css = self.background(sld, part) or self.background(self.layout, layout_part) or \
            self.background(self.master, master_part) or 'background:#fff;'
        body = []
        show_master = sld.get('showMasterSp', '1') != '0'
        if show_master and self.layout.get('showMasterSp', '1') != '0':
            body.append(self.render_tree(self.master_tree, master_part, decor=True))
        if show_master:
            body.append(self.render_tree(self.layout_tree, layout_part, decor=True))
        body.append(self.render_tree(sld.find(P + 'cSld/' + P + 'spTree'), part, decor=False))
        notes = self.notes(part)
        attrs = ' data-pptx-slide="%d"' % n
        if sld.get('show') == '0':
            attrs += ' data-visibility="hidden"'
        sec = '<section%s>\n<div class="sf" style="%s">\n%s\n</div>%s\n</section>' % (
            attrs, bg_css, '\n'.join(b for b in body if b), notes)
        return sec

    def background(self, root, part):
        bg = root.find(P + 'cSld/' + P + 'bg')
        if bg is None:
            return None
        bgPr = bg.find(P + 'bgPr')
        if bgPr is not None:
            f = self.fill_of(bgPr, None, self.cctx, part)
            if f and f[0] == 'blip':
                url = self.blip_url(f[1], part, self.W)
                if url:
                    return "background:#000 url('%s') center/100%% 100%% no-repeat;" % url
            if f:
                return self.css_paint(f) or 'background:#fff;'
        ref = bg.find(P + 'bgRef')
        if ref is not None:
            idx = int(ref.get('idx', 0))
            phc = self.cctx.first(ref)
            lst = self.theme['bgfill'] if idx >= 1001 else self.theme['fill']
            k = idx - 1001 if idx >= 1001 else idx - 1
            if 0 <= k < len(lst):
                el = lst[k]
                if lname(el) == 'solidFill':
                    return self.css_paint(('solid', self.cctx.first(el, phc)))
                if lname(el) == 'gradFill':
                    return self.css_paint(('grad', self.grad(el, self.cctx, phc)))
            if phc:
                return 'background:%s;' % phc.css()
        return None

    def blip_url(self, blipFill, part, display_w=None, crop=None):
        blip = blipFill.find(A + 'blip')
        if blip is None:
            return None
        rels = self.pkg.rels(part)
        svg = blip.find('.//{%s}svgBlip' % NS['asvg'])
        rid = None
        if svg is not None:
            rid = svg.get(R + 'embed')
        if rid is None:
            rid = blip.get(R + 'embed') or blip.get(R + 'link')
        if rid is None or rid not in rels:
            return None
        typ, tgt, ext = rels[rid]
        if ext:
            return tgt
        return self.media(tgt, display_w, crop)

    def notes(self, part):
        np_ = self.pkg.rel_target(part, 'notesSlide')
        if not np_:
            return ''
        nx = self.pkg.xml(np_)
        texts = []
        for sp in nx.iter(P + 'sp'):
            ph = sp.find('.//' + P + 'ph')
            if ph is None or ph.get('type') != 'body':
                continue
            for p in sp.iter(A + 'p'):
                t = ''.join(x.text or '' for x in p.iter(A + 't'))
                texts.append(t)
        txt = '\n'.join(texts).strip()
        if not txt:
            return ''
        return '\n<aside class="notes">%s</aside>' % ''.join('<p>%s</p>' % esc(t) for t in txt.split('\n'))

    # ---------------------------------------------------------------- animations
    def parse_timing(self, sld):
        """map spid -> list of {'idx', 'kind', 'para'} ; plus media autoplay info"""
        out = {'frag': {}, 'autoplay': set(), 'loop': set(), 'click_media': {}, 'steps': 0}
        timing = sld.find(P + 'timing')
        if timing is None:
            return out
        main = None
        for ctn in timing.iter(P + 'cTn'):
            if ctn.get('nodeType') == 'mainSeq':
                main = ctn
                break
        if main is not None:
            step = 0
            lst = main.find(P + 'childTnLst')
            for par in (lst if lst is not None else []):
                ctn = par.find(P + 'cTn')
                if ctn is None:
                    continue
                conds = ctn.findall(P + 'stCondLst/' + P + 'cond')
                on_click = any(c.get('delay') == 'indefinite' for c in conds)
                auto = any(c.get('evt') == 'onBegin' for c in conds)
                if on_click and not auto:
                    step += 1
                cur = step if (on_click and not auto) else 0
                for eff in ctn.iter(P + 'cTn'):
                    cls = eff.get('presetClass')
                    if not cls:
                        continue
                    # an afterEffect / withEffect inside a click group belongs to that click
                    for tgt in eff.iter(P + 'spTgt'):
                        spid = tgt.get('spid')
                        pr = tgt.find(P + 'txEl/' + P + 'pRg')
                        para = (int(pr.get('st')), int(pr.get('end'))) if pr is not None else None
                        if cls == 'mediacall':
                            cmd = eff.find('.//' + P + 'cmd')
                            if cmd is not None and cmd.get('cmd', '').startswith('play'):
                                if cur == 0:
                                    out['autoplay'].add(spid)
                                else:
                                    out['click_media'][spid] = cur
                            continue
                        if cur == 0:
                            continue  # automatic on slide start: element simply visible
                        kind = {'entr': 'in', 'exit': 'out'}.get(cls)
                        if kind is None:
                            continue
                        preset = eff.get('presetID')
                        out['frag'].setdefault(spid, [])
                        if not any(f['idx'] == cur and f['para'] == para for f in out['frag'][spid]):
                            out['frag'][spid].append({'idx': cur, 'kind': kind, 'para': para, 'preset': preset})
                        break
            out['steps'] = step
        for node in timing.iter(P + 'cMediaNode'):
            ctn = node.find(P + 'cTn')
            tgt = node.find('.//' + P + 'spTgt')
            if ctn is not None and tgt is not None and ctn.get('repeatCount') == 'indefinite':
                out['loop'].add(tgt.get('spid'))
        return out

    def frag_attrs(self, spid):
        if self.decor_mode:
            return ''
        fr = [f for f in self.anim['frag'].get(spid, []) if f['para'] is None]
        if not fr:
            return ''
        f = fr[0]
        cls = 'fragment'
        if f['kind'] == 'out':
            cls += ' fade-out'
        elif f['preset'] == '1':
            cls += ' appear'
        return ' class-add="%s" data-fragment-index="%d"' % (cls, f['idx'])

    # ---------------------------------------------------------------- tree rendering
    def render_tree(self, tree, part, decor):
        if tree is None:
            return ''
        self.decor_mode = decor
        out = []
        for el in tree:
            h = self.render_el(el, part, (0, 0, 1, 1, 0, 0), decor)
            if decor and h:   # master/layout decoration: marked so editors can reuse it on new slides
                h = re.sub(r'^<(div|video)\b', r'<\1 data-layout', h, count=1)
            out.append(h)
        return '\n'.join(o for o in out if o)

    @staticmethod
    def xfrm_of(spPr_or_grp):
        if spPr_or_grp is None:
            return None
        return spPr_or_grp.find(A + 'xfrm')

    def box(self, xfrm, tf):
        """apply parent child-transform tf=(chOffX, chOffY, sx, sy, baseX, baseY) -> local px box"""
        off = xfrm.find(A + 'off')
        ext = xfrm.find(A + 'ext')
        x = int(off.get('x', 0)) if off is not None else 0
        y = int(off.get('y', 0)) if off is not None else 0
        cx = int(ext.get('cx', 0)) if ext is not None else 0
        cy = int(ext.get('cy', 0)) if ext is not None else 0
        ox, oy, sx, sy, bx, by = tf
        return (px((x - ox) * sx), px((y - oy) * sy), px(cx * sx), px(cy * sy))

    def render_el(self, el, part, tf, decor):
        t = lname(el)
        try:
            if t == 'sp':
                return self.render_sp(el, part, tf, decor)
            if t == 'pic':
                return self.render_pic(el, part, tf, decor)
            if t == 'cxnSp':
                return self.render_sp(el, part, tf, decor, connector=True)
            if t == 'grpSp':
                return self.render_grp(el, part, tf, decor)
            if t == 'graphicFrame':
                self.warn('slide %d: graphicFrame (table/chart) not converted' % self.slide_no)
                return ''
        except Exception as e:  # keep going; report
            import traceback
            self.warn('slide %d: failed to render %s: %s\n%s' % (self.slide_no, t, e, traceback.format_exc()))
        return ''

    def transform_css(self, xfrm, flip_content=False):
        rot = int(xfrm.get('rot', 0)) / 60000 if xfrm is not None else 0
        parts = []
        if rot:
            parts.append('rotate(%sdeg)' % f2(rot))
        if flip_content and xfrm is not None:
            fh = xfrm.get('flipH') in ('1', 'true')
            fv = xfrm.get('flipV') in ('1', 'true')
            if fh or fv:
                parts.append('scale(%d,%d)' % (-1 if fh else 1, -1 if fv else 1))
        return ('transform:%s;' % ' '.join(parts)) if parts else ''

    def render_grp(self, el, part, tf, decor):
        gp = el.find(P + 'grpSpPr')
        xfrm = gp.find(A + 'xfrm')
        nv = el.find(P + 'nvGrpSpPr/' + P + 'cNvPr')
        spid = nv.get('id') if nv is not None else None
        if nv is not None and nv.get('hidden') in ('1', 'true'):
            return ''
        if xfrm is None:
            inner = [self.render_el(c, part, tf, decor) for c in el if lname(c) in ('sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame')]
            return '\n'.join(i for i in inner if i)
        x, y, w, h = self.box(xfrm, tf)
        choff = xfrm.find(A + 'chOff')
        chext = xfrm.find(A + 'chExt')
        ext = xfrm.find(A + 'ext')
        ox, oy, sx0, sy0 = tf[0], tf[1], tf[2], tf[3]
        cox = int(choff.get('x', 0)) if choff is not None else 0
        coy = int(choff.get('y', 0)) if choff is not None else 0
        cex = int(chext.get('cx', 0)) if chext is not None else 0
        cey = int(chext.get('cy', 0)) if chext is not None else 0
        ecx = int(ext.get('cx', 0)) if ext is not None else 0
        ecy = int(ext.get('cy', 0)) if ext is not None else 0
        sx = (ecx / cex if cex else 1.0) * sx0
        sy = (ecy / cey if cey else 1.0) * sy0
        child_tf = (cox, coy, sx, sy, 0, 0)
        inner = []
        for c in el:
            if lname(c) in ('sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame'):
                inner.append(self.render_el(c, part, child_tf, decor))
        fa = self.frag_attrs(spid) if spid else ''
        cls, fa = self._split_frag(fa)
        return '<div class="e g%s"%s style="left:%spx;top:%spx;width:%spx;height:%spx;%s">\n%s\n</div>' % (
            cls, fa, f2(x), f2(y), f2(w), f2(h), self.transform_css(xfrm, flip_content=False), '\n'.join(i for i in inner if i))

    @staticmethod
    def _split_frag(fa):
        if not fa:
            return '', ''
        m = re.match(r' class-add="([^"]*)"(.*)', fa)
        return ' ' + m.group(1), m.group(2)

    # -------------------------------------------------------- sp
    def render_sp(self, el, part, tf, decor, connector=False):
        nvtag = 'nvCxnSpPr' if connector else 'nvSpPr'
        nv = el.find(P + nvtag + '/' + P + 'cNvPr')
        if nv is not None and nv.get('hidden') in ('1', 'true'):
            return ''
        spid = nv.get('id') if nv is not None else None
        info = None if connector else self.ph_info(el)
        if info is not None and decor:
            return ''  # placeholders on layouts/masters are prompts, not content
        spPr = el.find(P + 'spPr')
        style = el.find(P + 'style')
        lay_sp = mas_sp = None
        if info is not None:
            lay_sp = self.find_ph(self.layout_tree, info)
            mas_sp = self.master_ph(info)
        xfrm = self.xfrm_of(spPr)
        if xfrm is None or xfrm.find(A + 'off') is None:
            for s in (lay_sp, mas_sp):
                if s is not None:
                    x2 = self.xfrm_of(s.find(P + 'spPr'))
                    if x2 is not None and x2.find(A + 'off') is not None:
                        xfrm = x2
                        break
        if xfrm is None:
            return ''
        x, y, w, h = self.box(xfrm, tf)
        cctx = self.cctx
        # geometry
        geom = spPr.find(A + 'prstGeom') if spPr is not None else None
        cust = spPr.find(A + 'custGeom') if spPr is not None else None
        if geom is None and cust is None:
            for s in (lay_sp, mas_sp):
                if s is not None and s.find(P + 'spPr/' + A + 'prstGeom') is not None:
                    geom = s.find(P + 'spPr/' + A + 'prstGeom')
                    break
        fill = self.fill_of(spPr, style, cctx, part)
        if fill is None and info is not None:
            for s in (lay_sp, mas_sp):
                if s is not None:
                    fill = self.fill_of(s.find(P + 'spPr'), s.find(P + 'style'), cctx, part)
                    if fill is not None:
                        break
        ln = self.line_of(spPr, style, cctx)
        fa = self.frag_attrs(spid) if spid else ''
        cls, fa = self._split_frag(fa)
        flipH = xfrm.get('flipH') in ('1', 'true')
        flipV = xfrm.get('flipV') in ('1', 'true')
        rot = int(xfrm.get('rot', 0)) / 60000
        eff = self.effects_css(spPr, style, cctx)
        pieces = []
        prst = geom.get('prst') if geom is not None else None
        av = {}
        if geom is not None:
            for gd in geom.iterfind(A + 'avLst/' + A + 'gd'):
                m = re.match(r'val\s+(-?\d+)', gd.get('fmla', ''))
                if m:
                    av[gd.get('name')] = int(m.group(1))
        has_paint = (fill is not None and fill[0] in ('solid', 'grad', 'blip')) or ln is not None
        if has_paint:
            paths = None
            if cust is not None:
                paths = cust_paths(cust, w, h)
            elif prst:
                paths = preset_paths(prst, w, h, av)
                if paths is None:
                    self.warn('slide %d: preset %s approximated as rect' % (self.slide_no, prst))
                    paths = preset_paths('rect', w, h, av)
            if paths:
                pieces.append(self.geom_svg(paths, fill, ln, w, h, flipH, flipV, part, is_line=prst in ('line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3') or connector))
        # text
        tx = None if connector else el.find(P + 'txBody')
        if tx is not None:
            pieces.append(self.render_text(tx, info, lay_sp, mas_sp, style, w, h, spid))
        if not any(pieces):
            return ''
        if tx is not None and tx.find('.//' + A + 'fld[@type="slidenum"]') is not None:
            fa += ' data-slidenum'   # lets editors renumber slides later
        return '<div class="e%s"%s data-id="%s" style="left:%spx;top:%spx;width:%spx;height:%spx;%s%s">%s</div>' % (
            cls, fa, spid or '', f2(x), f2(y), f2(w), f2(h),
            ('transform:rotate(%sdeg);' % f2(rot)) if rot else '', eff, ''.join(p for p in pieces if p))

    def geom_svg(self, paths, fill, ln, w, h, flipH, flipV, part, is_line=False):
        defs = []
        body = []
        pad = 0
        if ln is not None:
            pad = max(px(ln['w']), 1) * 6 + 4
        fill_paint = self.svg_paint(fill, defs, w, h)
        blip_img = None
        if fill is not None and fill[0] == 'blip':
            url = self.blip_url(fill[1], part, w)
            if url:
                cid = self.nid('cp')
                d0 = paths[0][0]
                defs.append('<clipPath id="%s"><path d="%s"/></clipPath>' % (cid, d0))
                blip_img = '<image href="%s" x="0" y="0" width="%s" height="%s" preserveAspectRatio="none" clip-path="url(#%s)"/>' % (esc(url), f2(w), f2(h), cid)
        for d, fmode, stroke in paths:
            if blip_img and fmode == 'norm':
                body.append(blip_img)
                blip_img = None
            fp = 'none'
            if fmode == 'norm' and not is_line:
                fp = fill_paint
            elif fmode in ('lighten', 'lightenLess') and fill is not None and fill[0] == 'solid' and fill[1] is not None:
                c = fill[1]
                fp = ColorCtx._mods(Color(c.r, c.g, c.b, c.a), etree.fromstring('<x xmlns:a="%s"><a:tint val="60000"/></x>' % NS['a'])).css()
            elif fmode in ('darken', 'darkenLess') and fill is not None and fill[0] == 'solid' and fill[1] is not None:
                c = fill[1]
                fp = ColorCtx._mods(Color(c.r, c.g, c.b, c.a), etree.fromstring('<x xmlns:a="%s"><a:shade val="60000"/></x>' % NS['a'])).css()
            sa = self.stroke_attrs(ln) if (ln is not None and stroke) else ' stroke="none"'
            body.append('<path d="%s" fill="%s"%s vector-effect="non-scaling-stroke"/>' % (d, fp, sa))
        # arrowheads (only for open paths: lines/connectors)
        if ln is not None and (ln['head'] or ln['tail']):
            d0 = paths[0][0]
            nums = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', d0)]
            pts = list(zip(nums[0::2], nums[1::2]))
            if len(pts) >= 2:
                newpts = list(pts)
                extra = []
                if ln['tail']:
                    svg, sh = self.arrowhead(pts[-1], pts[-2], ln['tail'], ln)
                    extra.append(svg)
                    newpts[-1] = self._shorten(pts[-1], pts[-2], sh)
                if ln['head']:
                    svg, sh = self.arrowhead(pts[0], pts[1], ln['head'], ln)
                    extra.append(svg)
                    newpts[0] = self._shorten(pts[0], pts[1], sh)
                if d0.startswith('M') and 'C' not in d0 and 'A' not in d0 and 'Z' not in d0:
                    nd = 'M' + ' L'.join('%s,%s' % (f2(a), f2(b)) for a, b in newpts)
                    body[-1] = body[-1].replace('d="%s"' % d0, 'd="%s"' % nd, 1)
                body.extend(extra)
        tr = ''
        if flipH or flipV:
            tr = ' transform="translate(%s %s) scale(%d %d)"' % (f2(w if flipH else 0), f2(h if flipV else 0), -1 if flipH else 1, -1 if flipV else 1)
        # pad the canvas so zero-width/height lines, wide strokes and arrowheads are never clipped
        # (browsers skip painting an <svg> whose box is empty, even with overflow:visible)
        pad = max(pad, 8)
        W_, H_ = w + 2 * pad, h + 2 * pad
        return ('<svg class="geo" width="%s" height="%s" viewBox="%s %s %s %s" style="left:%spx;top:%spx">%s<g%s>%s</g></svg>' % (
            f2(W_), f2(H_), f2(-pad), f2(-pad), f2(W_), f2(H_), f2(-pad), f2(-pad),
            ('<defs>%s</defs>' % ''.join(defs)) if defs else '', tr, ''.join(body)))

    @staticmethod
    def _shorten(tip, frm, d):
        dx, dy = tip[0] - frm[0], tip[1] - frm[1]
        L = math.hypot(dx, dy)
        if L == 0 or d <= 0:
            return tip
        d = min(d, L * 0.9)
        return (tip[0] - dx / L * d, tip[1] - dy / L * d)

    # -------------------------------------------------------- text
    def lst_chain(self, tx, info, lay_sp, mas_sp, style):
        chain = []
        own = tx.find(A + 'lstStyle')
        if own is not None:
            chain.append(own)
        if style is not None:
            fr = style.find(A + 'fontRef')
            if fr is not None:
                c = self.cctx.first(fr)
                pseudo = etree.Element(A + 'lstStyle')
                for lv in range(1, 10):
                    p_ = etree.SubElement(pseudo, A + 'lvl%dpPr' % lv)
                    d = etree.SubElement(p_, A + 'defRPr')
                    if c is not None:
                        sf = etree.SubElement(d, A + 'solidFill')
                        etree.SubElement(sf, A + 'srgbClr', val=c.css().lstrip('#')[:6] if c.css().startswith('#') else '000000')
                    etree.SubElement(d, A + 'latin', typeface='+mj-lt' if fr.get('idx') == 'major' else '+mn-lt')
                chain.append(pseudo)
        if info is not None:
            for s in (lay_sp, mas_sp):
                if s is not None:
                    ls = s.find(P + 'txBody/' + A + 'lstStyle')
                    if ls is not None:
                        chain.append(ls)
            ts = self.master_txstyle(info)
            if ts is not None:
                chain.append(ts)
        else:
            if self.default_text_style is not None:
                chain.append(self.default_text_style)
            txs = self.master.find(P + 'txStyles/' + P + 'otherStyle')
            if txs is not None:
                chain.append(txs)
        return chain

    def body_pr(self, tx, lay_sp, mas_sp):
        chain = [tx.find(A + 'bodyPr')]
        for s in (lay_sp, mas_sp):
            if s is not None:
                chain.append(s.find(P + 'txBody/' + A + 'bodyPr'))
        chain = [c for c in chain if c is not None]

        def attr(name, default):
            for c in chain:
                if c.get(name) is not None:
                    return c.get(name)
            return default
        autofit = None
        for c in chain:
            for t in ('normAutofit', 'spAutoFit', 'noAutofit'):
                e = c.find(A + t)
                if e is not None:
                    autofit = e
                    break
            if autofit is not None:
                break
        return {
            'l': px(attr('lIns', 91440)), 't': px(attr('tIns', 45720)), 'r': px(attr('rIns', 91440)), 'b': px(attr('bIns', 45720)),
            'anchor': attr('anchor', 't'), 'wrap': attr('wrap', 'square'), 'vert': attr('vert', 'horz'),
            'numCol': int(attr('numCol', 1)), 'anchorCtr': attr('anchorCtr', '0') in ('1', 'true'),
            'rot': int(attr('rot', 0)) / 60000, 'upright': attr('upright', '0') in ('1', 'true'),
            'autofit': autofit,
        }

    def render_text(self, tx, info, lay_sp, mas_sp, style, w, h, spid):
        paras = tx.findall(A + 'p')
        has_text = any((t.text or '').strip() for t in tx.iter(A + 't')) or tx.find('.//' + A + 'fld') is not None
        if not has_text:
            if info is not None:
                return ''
            if not paras:
                return ''
        bp = self.body_pr(tx, lay_sp, mas_sp)
        chain = self.lst_chain(tx, info, lay_sp, mas_sp, style)
        font_scale = 1.0
        ln_red = 0.0
        af = bp['autofit']
        if af is not None and lname(af) == 'normAutofit':
            font_scale = int(af.get('fontScale', 100000)) / 100000
            ln_red = int(af.get('lnSpcReduction', 0)) / 100000
        html_ps = []
        counters = {}
        first = True
        self._autofit = af is not None and lname(af) == 'normAutofit'
        for p in paras:
            html_ps.append(self.render_para(p, chain, font_scale, ln_red, first, counters, bp, spid))
            first = False
        while html_ps and html_ps[-1] is None:
            html_ps.pop()
        html_ps = [hp for hp in html_ps if hp is not None]
        if self._autofit:
            # sizes become scalable so the runtime can shrink text further if the browser's
            # metrics overflow the box (PowerPoint's own "shrink text on overflow")
            html_ps = [re.sub(r'font-size:([\d.]+)px', r'font-size:calc(\1px*var(--fs,1))', hp) for hp in html_ps]
        justify = {'t': 'flex-start', 'ctr': 'center', 'b': 'flex-end', 'just': 'flex-start', 'dist': 'flex-start'}.get(bp['anchor'], 'flex-start')
        vert = bp['vert']
        style_ = 'padding:%spx %spx %spx %spx;justify-content:%s;' % (f2(bp['t']), f2(bp['r']), f2(bp['b']), f2(bp['l']), justify)
        if bp['wrap'] == 'none':
            style_ += 'white-space:pre;'
        if bp['numCol'] > 1:
            style_ += 'column-count:%d;display:block;' % bp['numCol']
        if bp['anchorCtr']:
            style_ += 'align-items:center;'
        inner = '<div class="tb">%s</div>' % ''.join(html_ps)
        fit = ' data-autofit' if self._autofit else ''
        wrapcls = ' nowrap' if bp['wrap'] == 'none' else ''
        if vert in ('vert', 'eaVert', 'vert270', 'wordArtVert', 'mongolianVert', 'wordArtVertRtl'):
            ang = 270 if vert == 'vert270' else 90
            # lay the text out in a rotated box whose width is the shape height
            return ('<div class="tx%s"%s style="left:%spx;top:%spx;width:%spx;height:%spx;transform:rotate(%ddeg);%s">%s</div>' % (
                wrapcls, fit, f2((w - h) / 2), f2((h - w) / 2), f2(h), f2(w), ang, style_, inner))
        if bp['rot']:
            style_ += 'transform:rotate(%sdeg);' % f2(bp['rot'])
        return '<div class="tx%s"%s style="left:0;top:0;width:%spx;height:%spx;%s">%s</div>' % (wrapcls, fit, f2(w), f2(h), style_, inner)

    def ppr_chain(self, p, chain):
        ppr = p.find(A + 'pPr')
        lvl = int(ppr.get('lvl', 0)) if ppr is not None else 0
        out = [ppr] if ppr is not None else []
        tag = A + 'lvl%dpPr' % (lvl + 1)
        for ls in chain:
            e = ls.find(tag)
            if e is not None:
                out.append(e)
        return out, lvl

    @staticmethod
    def _attr(pchain, name, default=None):
        for e in pchain:
            if e.get(name) is not None:
                return e.get(name)
        return default

    @staticmethod
    def _child(pchain, *names):
        for e in pchain:
            for ch in e:
                if lname(ch) in names:
                    return ch
        return None

    def run_props(self, rpr, pchain_defs):
        """rpr: run rPr (or None); pchain_defs: list of defRPr elements, most specific first"""
        chain = ([rpr] if rpr is not None else []) + pchain_defs

        def attr(name):
            for e in chain:
                if e.get(name) is not None:
                    return e.get(name)
            return None

        def child(*names):
            for e in chain:
                for ch in e:
                    if lname(ch) in names:
                        return ch
            return None
        fillel = child('solidFill', 'gradFill', 'noFill')
        color = None
        if fillel is not None:
            if lname(fillel) == 'solidFill':
                color = self.cctx.first(fillel)
            elif lname(fillel) == 'gradFill':
                g = self.grad(fillel, self.cctx, None)
                color = g['stops'][0][1] if g['stops'] else None
            else:
                color = Color(0, 0, 0, 0)
        latin = child('latin')
        sym = child('sym')
        hl = child('highlight')
        effl = child('effectLst')
        return {
            'sz': int(attr('sz') or 1800) / 100,
            'b': attr('b') in ('1', 'true'),
            'i': attr('i') in ('1', 'true'),
            'u': (attr('u') or 'none') != 'none',
            'strike': (attr('strike') or 'noStrike') != 'noStrike',
            'baseline': int(attr('baseline') or 0) / 1000,
            'cap': attr('cap') or 'none',
            'spc': int(attr('spc') or 0) / 100,
            'color': color if color is not None else Color(0, 0, 0),
            'face': self.resolve_face(latin.get('typeface')) if latin is not None else self.theme['fonts']['mn-lt'],
            'sym': self.resolve_face(sym.get('typeface')) if sym is not None else None,
            'highlight': self.cctx.first(hl) if hl is not None else None,
            'effects': effl,
        }

    def run_css(self, rp, font_scale):
        size = rp['sz'] * 4 / 3 * font_scale
        css = []
        face = rp['face']
        css.append('font-family:%s' % font_stack(face))
        if rp['baseline']:
            css.append('font-size:%spx' % f2(size * 0.67))
            css.append('vertical-align:%spx' % f2(size * rp['baseline'] / 100))
        else:
            css.append('font-size:%spx' % f2(size))
        if rp['b']:
            css.append('font-weight:700')
        if rp['i']:
            css.append('font-style:italic')
        deco = []
        if rp['u']:
            deco.append('underline')
        if rp['strike']:
            deco.append('line-through')
        if deco:
            css.append('text-decoration:%s' % ' '.join(deco))
        if rp['cap'] == 'all':
            css.append('text-transform:uppercase')
        elif rp['cap'] == 'small':
            css.append('font-variant:small-caps')
        if rp['spc']:
            css.append('letter-spacing:%spx' % f2(rp['spc'] * 4 / 3))
        c = rp['color']
        css.append('color:%s' % c.css())
        if rp['highlight'] is not None:
            css.append('background:%s' % rp['highlight'].css())
        if rp['effects'] is not None:
            sh = []
            for e in rp['effects']:
                if lname(e) == 'outerShdw':
                    cc = self.cctx.first(e)
                    if cc is not None:
                        dist = px(e.get('dist', 0))
                        ang = math.radians(int(e.get('dir', 0)) / 60000)
                        sh.append('%spx %spx %spx %s' % (f2(dist * math.cos(ang)), f2(dist * math.sin(ang)), f2(px(e.get('blurRad', 0))), cc.css()))
                elif lname(e) == 'glow':
                    cc = self.cctx.first(e)
                    if cc is not None:
                        r_ = px(e.get('rad', 0))
                        sh.append('0 0 %spx %s' % (f2(r_), cc.css()))
                        sh.append('0 0 %spx %s' % (f2(r_ / 2), cc.css()))
            if sh:
                css.append('text-shadow:%s' % ','.join(sh))
        return ';'.join(css)

    def render_para(self, p, chain, font_scale, ln_red, first, counters, bp, spid):
        pchain, lvl = self.ppr_chain(p, chain)
        defs = [e.find(A + 'defRPr') for e in pchain[1:] if e.find(A + 'defRPr') is not None] if pchain and p.find(A + 'pPr') is not None else \
            [e.find(A + 'defRPr') for e in pchain if e.find(A + 'defRPr') is not None]
        runs = [c for c in p if lname(c) in ('r', 'br', 'fld')]
        end_rpr = p.find(A + 'endParaRPr')
        texts = []
        first_rp = None
        max_size = 0
        all_text = ''
        for r in runs:
            t = lname(r)
            if t == 'br':
                rp = self.run_props(r.find(A + 'rPr'), defs)
                texts.append('<br>')
                continue
            rp = self.run_props(r.find(A + 'rPr'), defs)
            if t == 'fld':
                ftype = r.get('type', '')
                txt = ''.join(x.text or '' for x in r.iter(A + 't'))
                if ftype == 'slidenum':
                    txt = str(self.slide_no)
            else:
                tt = r.find(A + 't')
                txt = (tt.text or '') if tt is not None else ''
            if not txt:
                continue
            face_for_map = rp['sym'] if (rp['sym'] and any(0xF000 <= ord(ch) <= 0xF0FF for ch in txt)) else rp['face']
            txt = map_symbol_text(txt, face_for_map)
            all_text += txt
            if first_rp is None:
                first_rp = rp
            max_size = max(max_size, rp['sz'])
            content = esc(txt)
            hl = r.find(A + 'rPr/' + A + 'hlinkClick')
            span = '<span style="%s">%s</span>' % (self.run_css(rp, font_scale), content)
            if hl is not None and hl.get(R + 'id'):
                rels = self.pkg.rels(self.part)
                rel = rels.get(hl.get(R + 'id'))
                if rel and rel[2]:
                    span = '<a href="%s" target="_blank" rel="noopener" style="color:inherit">%s</a>' % (esc(rel[1]), span)
            texts.append(span)
        if first_rp is None:
            first_rp = self.run_props(end_rpr, defs)
            max_size = first_rp['sz']
        # paragraph props
        algn = self._attr(pchain, 'algn', 'l')
        marL = px(self._attr(pchain, 'marL', 0))
        indent = px(self._attr(pchain, 'indent', 0))
        deftab = px(self._attr(pchain, 'defTabSz', 914400))
        size_px = max_size * 4 / 3 * font_scale
        face = (first_rp['face'] or '').lower()
        metric = LINE_METRIC.get(face, 1.2)
        lnspc = self._child(pchain, 'lnSpc')
        lh = None
        if lnspc is not None and len(lnspc):
            c0 = lnspc[0]
            if lname(c0) == 'spcPct':
                pct = int(c0.get('val', 100000)) / 100000 - ln_red
                lh = 'line-height:%s' % f2(max(0.5, pct) * metric)
            elif lname(c0) == 'spcPts':
                lh = 'line-height:%spx' % f2(int(c0.get('val', 0)) / 100 * 4 / 3)
        if lh is None:
            lh = 'line-height:%s' % f2(max(0.5, 1 - ln_red) * metric)

        def spacing(tag):
            e = self._child(pchain, tag)
            if e is None or not len(e):
                return 0
            c0 = e[0]
            if lname(c0) == 'spcPts':
                return int(c0.get('val', 0)) / 100 * 4 / 3
            if lname(c0) == 'spcPct':
                return int(c0.get('val', 0)) / 100000 * size_px * 1.2
            return 0
        sb = 0 if first else spacing('spcBef')
        sa = spacing('spcAft')
        # bullets
        bullet = ''
        bu = self._child(pchain, 'buNone', 'buChar', 'buAutoNum', 'buBlip')
        has_txt = bool(all_text.strip())
        if bu is not None and lname(bu) in ('buChar', 'buAutoNum') and has_txt:
            bfont_el = self._child(pchain, 'buFont', 'buFontTx')
            bface = None
            if bfont_el is not None and lname(bfont_el) == 'buFont':
                bface = self.resolve_face(bfont_el.get('typeface'))
            bclr_el = self._child(pchain, 'buClr', 'buClrTx')
            bcol = first_rp['color']
            if bclr_el is not None and lname(bclr_el) == 'buClr':
                bcol = self.cctx.first(bclr_el) or bcol
            bsz = self._child(pchain, 'buSzPct', 'buSzPts', 'buSzTx')
            bsize = first_rp['sz'] * 4 / 3 * font_scale
            if bsz is not None:
                if lname(bsz) == 'buSzPct':
                    bsize *= int(bsz.get('val', 100000)) / 100000
                elif lname(bsz) == 'buSzPts':
                    bsize = int(bsz.get('val', 0)) / 100 * 4 / 3 * font_scale
            css_bullet = None
            if lname(bu) == 'buChar':
                ch = bu.get('char', '•')
                if bface and bface.lower().startswith('wingdings') and ch:
                    o = ord(ch[0]) - (0xF000 if ord(ch[0]) >= 0xF000 else 0)
                    css_bullet = CSS_BULLETS.get(o)
                ch = map_symbol_text(ch, bface)
            else:
                scheme = bu.get('type', 'arabicPeriod')
                startAt = int(bu.get('startAt', 1))
                key = (lvl, scheme)
                counters[key] = counters.get(key, startAt - 1) + 1
                for k in list(counters):
                    if k[0] > lvl:
                        del counters[k]
                ch = self.autonum(scheme, counters[key])
            bstack = font_stack(bface if bface and not bface.lower().startswith(('wingdings', 'symbol')) else first_rp['face'])
            if bface and bface.lower().startswith(('wingdings', 'symbol')):
                bstack = "'Apple Symbols', 'Segoe UI Symbol', 'DejaVu Sans', " + font_stack(first_rp['face'])
            gap = -indent if indent < 0 else 0
            glyph = esc(ch)
            if css_bullet:
                kind, sz = css_bullet
                glyph = '<i class="b%s" style="width:%sem;height:%sem;vertical-align:%sem"></i>' % (
                    kind, f2(sz), f2(sz), f2(0.33 - sz / 2))
            bullet = '<span class="bu" style="font-family:%s;font-size:%spx;color:%s;%s">%s</span>' % (
                bstack, f2(bsize), bcol.css(), ('min-width:%spx;' % f2(gap)) if gap else 'margin-right:0.35em;', glyph)
        ta = {'l': 'left', 'ctr': 'center', 'r': 'right', 'just': 'justify', 'dist': 'justify', 'justLow': 'justify'}.get(algn, 'left')
        st = ['text-align:%s' % ta, lh, 'font-size:%spx' % f2(size_px), 'font-family:%s' % font_stack(first_rp['face']),
              'color:%s' % first_rp['color'].css(), 'tab-size:%spx' % f2(deftab)]
        if marL:
            st.append('padding-left:%spx' % f2(marL))
        if indent:
            st.append('text-indent:%spx' % f2(indent))
        if sb:
            st.append('margin-top:%spx' % f2(sb))
        if sa:
            st.append('margin-bottom:%spx' % f2(sa))
        body = ''.join(texts)
        if not body:
            body = '&#8203;'
        cls = 'p'
        if bp['wrap'] == 'none':
            cls += ' p-%s' % {'center': 'c', 'right': 'r'}.get(ta, 'l')
        return '<div class="%s" style="%s">%s%s</div>' % (cls, ';'.join(st), bullet, body)

    @staticmethod
    def autonum(scheme, n):
        def roman(num):
            vals = [(1000, 'm'), (900, 'cm'), (500, 'd'), (400, 'cd'), (100, 'c'), (90, 'xc'), (50, 'l'), (40, 'xl'), (10, 'x'), (9, 'ix'), (5, 'v'), (4, 'iv'), (1, 'i')]
            s = ''
            for v, r_ in vals:
                while num >= v:
                    s += r_
                    num -= v
            return s
        if scheme.startswith('alphaLc'):
            core = chr(ord('a') + (n - 1) % 26)
        elif scheme.startswith('alphaUc'):
            core = chr(ord('A') + (n - 1) % 26)
        elif scheme.startswith('romanLc'):
            core = roman(n)
        elif scheme.startswith('romanUc'):
            core = roman(n).upper()
        else:
            core = str(n)
        if scheme.endswith('ParenBoth'):
            return '(%s)' % core
        if scheme.endswith('ParenR'):
            return '%s)' % core
        if scheme.endswith('Plain'):
            return core
        return '%s.' % core

    # -------------------------------------------------------- pictures / video
    def render_pic(self, el, part, tf, decor):
        nv = el.find(P + 'nvPicPr/' + P + 'cNvPr')
        if nv is not None and nv.get('hidden') in ('1', 'true'):
            return ''
        spid = nv.get('id') if nv is not None else None
        spPr = el.find(P + 'spPr')
        xfrm = self.xfrm_of(spPr)
        if xfrm is None:
            return ''
        x, y, w, h = self.box(xfrm, tf)
        fa = self.frag_attrs(spid) if spid else ''
        cls, fa = self._split_frag(fa)
        rot = int(xfrm.get('rot', 0)) / 60000
        flipH = xfrm.get('flipH') in ('1', 'true')
        flipV = xfrm.get('flipV') in ('1', 'true')
        tr = []
        if rot:
            tr.append('rotate(%sdeg)' % f2(rot))
        if flipH or flipV:
            tr.append('scale(%d,%d)' % (-1 if flipH else 1, -1 if flipV else 1))
        trs = ('transform:%s;' % ' '.join(tr)) if tr else ''
        eff = self.effects_css(spPr, el.find(P + 'style'), self.cctx)
        bf = el.find(P + 'blipFill')
        nvpr = el.find(P + 'nvPicPr/' + P + 'nvPr')
        rels = self.pkg.rels(part)
        # embedded HTML replacement for a media shape (e.g. a screen recording -> live page)
        vid = None
        if nvpr is not None:
            media = nvpr.find('.//{%s}media' % NS['p14'])
            vf = nvpr.find(A + 'videoFile')
            rid = None
            if media is not None:
                rid = media.get(R + 'embed')
            if rid is None and vf is not None:
                rid = vf.get(R + 'link') or vf.get(R + 'embed')
            if rid is not None or vf is not None:
                vid = rels.get(rid) if rid else None
                if vid is None and vf is not None:
                    vid = rels.get(vf.get(R + 'link'))
        geo_css = ''
        geom = spPr.find(A + 'prstGeom') if spPr is not None else None
        if geom is not None and geom.get('prst') == 'ellipse':
            geo_css = 'border-radius:50%;'
        elif geom is not None and geom.get('prst') == 'roundRect':
            a = 16667
            gd = geom.find(A + 'avLst/' + A + 'gd')
            if gd is not None:
                m = re.match(r'val\s+(-?\d+)', gd.get('fmla', ''))
                if m:
                    a = int(m.group(1))
            geo_css = 'border-radius:%spx;' % f2(min(w, h) * a / 100000)
        ln = self.line_of(spPr, el.find(P + 'style'), self.cctx)
        border = ''
        if ln is not None:
            lw = max(px(ln['w']), 0.75)
            border = 'outline:%spx solid %s;outline-offset:-%spx;' % (f2(lw), ln['color'].css(), f2(lw / 2))
        embed = self.opts.get('embed', {}).get(self.slide_no)
        if vid is not None and embed and not decor:
            return self.embed_iframe(embed, x, y, w, h)
        if vid is not None:
            typ, tgt, ext = vid
            src = tgt if ext else self.media(tgt)
            poster = self.blip_url(bf, part, w) if bf is not None else None
            attrs = ' playsinline preload="auto"'
            if spid in self.anim['autoplay']:
                attrs += ' data-autoplay muted'
            if spid in self.anim['loop']:
                attrs += ' loop'
            if poster:
                attrs += ' poster="%s"' % esc(poster)
            idx = self.anim['click_media'].get(spid)
            if idx:
                attrs += ' data-play-on-fragment="%d"' % idx
            frag_marker = ('<span class="fragment media-trigger" data-fragment-index="%d"></span>' % idx) if idx else ''
            vcrop = (0, 0, 0, 0)
            sr = bf.find(A + 'srcRect') if bf is not None else None
            if sr is not None:
                vcrop = tuple(int(sr.get(k, 0)) / 100000 for k in ('l', 't', 'r', 'b'))
            l, t, r, b = vcrop
            iw = 100 / max(0.0001, 1 - l - r)
            ih = 100 / max(0.0001, 1 - t - b)
            # the wrapper carries position, rotation, crop window and outline; the video fills the crop
            return ('<div class="e vidwrap%s"%s data-id="%s" style="left:%spx;top:%spx;width:%spx;height:%spx;%s%s%s%s">'
                    '<video class="vid" data-src="%s"%s style="left:%s%%;top:%s%%;width:%s%%;height:%s%%"></video>%s</div>%s' % (
                        cls, fa, spid or '', f2(x), f2(y), f2(w), f2(h), trs, eff, geo_css, border,
                        esc(src or ''), attrs, f2(-l * iw), f2(-t * ih), f2(iw), f2(ih), '', frag_marker))
        if bf is None:
            return ''
        crop = (0, 0, 0, 0)
        sr = bf.find(A + 'srcRect')
        if sr is not None:
            crop = tuple(int(sr.get(k, 0)) / 100000 for k in ('l', 't', 'r', 'b'))
        url = self.blip_url(bf, part, w, crop)
        if not url:
            self.warn('slide %d: picture %s has no image' % (self.slide_no, spid))
            return ''
        l, t, r, b = crop
        iw = 100 / max(0.0001, 1 - l - r)
        ih = 100 / max(0.0001, 1 - t - b)
        filt = []
        blip = bf.find(A + 'blip')
        op = ''
        if blip is not None:
            for ch in blip:
                tn = lname(ch)
                if tn == 'alphaModFix':
                    op = 'opacity:%s;' % f2(int(ch.get('amt', 100000)) / 100000)
                elif tn == 'grayscl':
                    filt.append('grayscale(1)')
                elif tn == 'biLevel':
                    filt.append('grayscale(1) contrast(100)')
                elif tn == 'lum':
                    br = int(ch.get('bright', 0)) / 100000
                    ct = int(ch.get('contrast', 0)) / 100000
                    if br:
                        filt.append('brightness(%s)' % f2(1 + br))
                    if ct:
                        filt.append('contrast(%s)' % f2(1 + ct))
                elif tn == 'duotone':
                    filt.append('grayscale(1)')
        imgf = ('filter:%s;' % ' '.join(filt)) if filt else ''
        tile = bf.find(A + 'tile')
        if tile is not None:
            return '<div class="e pic%s"%s data-id="%s" style="left:%spx;top:%spx;width:%spx;height:%spx;%s%s%s%sbackground:url(\'%s\') repeat;%s"></div>' % (
                cls, fa, spid or '', f2(x), f2(y), f2(w), f2(h), trs, eff, geo_css, border, esc(url), op)
        crop_needed = any(abs(v) > 1e-6 for v in crop)
        if not crop_needed:
            return '<div class="e pic%s"%s data-id="%s" style="left:%spx;top:%spx;width:%spx;height:%spx;%s%s%s%s%s"><img data-src="%s" alt="%s" style="width:100%%;height:100%%;%s" draggable="false"></div>' % (
                cls, fa, spid or '', f2(x), f2(y), f2(w), f2(h), trs, eff, geo_css, border, op, esc(url),
                esc((nv.get('descr') or '')[:120]) if nv is not None else '', imgf)
        return '<div class="e pic crop%s"%s data-id="%s" style="left:%spx;top:%spx;width:%spx;height:%spx;%s%s%s%s%s"><img data-src="%s" alt="%s" style="left:%s%%;top:%s%%;width:%s%%;height:%s%%;%s" draggable="false"></div>' % (
            cls, fa, spid or '', f2(x), f2(y), f2(w), f2(h), trs, eff, geo_css, border, op, esc(url),
            esc((nv.get('descr') or '')[:120]) if nv is not None else '',
            f2(-l * iw), f2(-t * ih), f2(iw), f2(ih), imgf)

    def embed_iframe(self, embed, x, y, w, h):
        s = embed.get('scale', 1.0)
        src = embed['src']
        if embed.get('box'):
            x, y, w, h = embed['box']
        # data-src without data-preload: reveal loads the page when the slide is shown (fresh start
        # every visit) and unloads it again once the deck moves far away
        return ('<div class="e embed" style="left:%spx;top:%spx;width:%spx;height:%spx;">'
                '<iframe data-src="%s" title="interactive visualization" '
                'style="width:%spx;height:%spx;transform:scale(%s);transform-origin:0 0;"></iframe></div>' % (
                    f2(x), f2(y), f2(w), f2(h), esc(src), f2(w / s), f2(h / s), f2(s)))


# ----------------------------------------------------------------------------- page

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
.reveal .sf .pic { overflow: hidden; }
.reveal .sf .pic img { display: block; position: absolute; left: 0; top: 0; max-width: none; max-height: none;
  margin: 0; border: 0; box-shadow: none; background: none; user-select: none; }
.reveal .sf .pic:not(.crop) img { position: static; }
.reveal .sf .vidwrap { overflow: hidden; background: #000; }
.reveal .sf .vidwrap video.vid { position: absolute; display: block; object-fit: fill; cursor: pointer; max-width: none; max-height: none; margin: 0; }
.reveal .sf .bu i { display: inline-block; background: currentColor; }
.reveal .sf .bu i.bdot { border-radius: 50%%; }
.reveal .sf .embed { overflow: hidden; background: #060b14; }
.reveal .sf .embed iframe { border: 0; display: block; background: #060b14; }
.reveal .sf a { text-decoration: none; }
.reveal .sf .fragment.appear { transition: none; }
.reveal .sf .media-trigger { position: absolute; width: 0; height: 0; }
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
// click a video to pause / resume it (PowerPoint's interactive toggle)
document.querySelectorAll('.reveal video.vid').forEach(function (v) {
  v.addEventListener('click', function () { if (v.paused) v.play(); else v.pause(); });
});
// PowerPoint "shrink text on overflow": the deck keeps PowerPoint's stored font scale, and only if the
// browser's font metrics still overflow a box does it shrink that box's text a little further.
function fitText(section) {
  if (!section || section.dataset.fitted) return;
  var frame = section.querySelector('.sf');
  var shown = frame && frame.offsetHeight > 0;   // display:none slides cannot be measured yet
  if (!shown) return;
  var boxes = section.querySelectorAll('.tx[data-autofit]');
  boxes.forEach(function (tx) {
    var tb = tx.firstElementChild; if (!tb) return;
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
  if (!m || !m.pptx2reveal) return;
  var act = { advance: advance, retreat: retreat, left: function () { Reveal.left(); }, right: function () { Reveal.right(); },
              up: function () { Reveal.up(); }, down: function () { Reveal.down(); } }[m.pptx2reveal];
  if (act) act();
});
// after navigating away from a slide with an embedded page, give keyboard focus back to the deck
Reveal.on('slidechanged', function () {
  var a = document.activeElement;
  if (a && a.tagName === 'IFRAME' && !Reveal.getCurrentSlide().contains(a)) {
    a.blur();
    window.focus();
  }
});
// videos that PowerPoint starts on a click step
Reveal.on('fragmentshown', function (ev) {
  ev.fragments.forEach(function (f) {
    if (!f.classList.contains('media-trigger')) return;
    var idx = f.getAttribute('data-fragment-index');
    var sec = f.closest('section');
    sec.querySelectorAll('video[data-play-on-fragment="' + idx + '"]').forEach(function (v) { v.currentTime = 0; v.play(); });
  });
});
"""

EMBED_SNIPPET = r"""
<!-- added by pptx2reveal: when shown inside the reveal deck, forward navigation keys to the deck -->
<style id="pptx2reveal-embed">%(css)s</style>
<script>
(function () {
  if (window.parent === window) { var s = document.getElementById('pptx2reveal-embed'); if (s) s.remove(); return; }
  var NAV = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', PageDown: 'advance', PageUp: 'retreat' };
  document.addEventListener('keydown', function (e) {
    var t = e.target || {}, tag = t.tagName || '';
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || t.isContentEditable;
    var m = NAV[e.key];
    if (e.key === ' ' && tag !== 'BUTTON' && !typing) m = e.shiftKey ? 'retreat' : 'advance';
    if (!m) return;
    if (typing && !/^Page/.test(e.key)) return;
    e.preventDefault();
    window.parent.postMessage(JSON.stringify({ pptx2reveal: m }), '*');
  }, true);
})();
</script>
"""


def stack_sections(sections, stacks):
    """stacks: {top slide number: [slide numbers placed vertically under it]} -> reveal nested sections"""
    if not stacks:
        return sections
    moved = {n for members in stacks.values() for n in members}
    out = []
    for n, sec in enumerate(sections, 1):
        if n in moved:
            continue
        if n in stacks:
            inner = [sec] + [sections[m - 1] for m in stacks[n] if 1 <= m <= len(sections)]
            out.append('<section class="pptx-stack" data-stack-top="%d">\n%s\n</section>' % (n, '\n'.join(inner)))
        else:
            out.append(sec)
    return out


BUILD_STAMP = '.pptx2reveal-build'   # sha256 of the index.html this tool last wrote


def guard_edits(outdir, force):
    """Refuse to overwrite an index.html that was edited after the last build (by hand or in the editor)."""
    import hashlib, datetime
    idx = os.path.join(outdir, 'index.html')
    if not os.path.exists(idx):
        return
    cur = hashlib.sha256(open(idx, 'rb').read()).hexdigest()
    stamp = os.path.join(outdir, BUILD_STAMP)
    last = open(stamp).read().strip() if os.path.exists(stamp) else None
    if cur == last:
        return
    if not force:
        sys.exit('index.html has been edited since it was last generated (by hand or in the editor).\n'
                 'Rebuilding from the PowerPoint file would replace those edits.\n'
                 'Run again with --force to rebuild anyway; the edited file will be kept in _backups/.')
    bdir = os.path.join(outdir, '_backups')
    os.makedirs(bdir, exist_ok=True)
    keep = os.path.join(bdir, 'index-before-rebuild-%s.html' % datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    shutil.copy2(idx, keep)
    print('kept the edited index.html as %s' % os.path.relpath(keep, outdir))


def build(args):
    guard_edits(args.outdir, args.force)
    opts = {'embed': {}}
    embeds = []
    for spec in args.embed_html or []:
        n, path = spec.split('=', 1)
        embeds.append((int(n), path))
    os.makedirs(args.outdir, exist_ok=True)
    for n, path in embeds:
        name = os.path.basename(path)
        with open(path, encoding='utf-8') as fh:
            src = fh.read()
        snippet = EMBED_SNIPPET % {'css': args.embed_css or ''}
        if args.embed_local_css:
            # swap a Google Fonts link for locally bundled fonts so the page also works offline
            src = re.sub(r'<link[^>]+fonts\.googleapis\.com[^>]*>', '<link rel="stylesheet" href="%s">' % args.embed_local_css, src)
        if '</body>' in src:
            src = src.replace('</body>', snippet + '\n</body>', 1)
        else:
            src += snippet
        with open(os.path.join(args.outdir, name), 'w', encoding='utf-8') as fh:
            fh.write(src)
        box = tuple(float(v) for v in args.embed_box.split(',')) if args.embed_box else None
        opts['embed'][n] = {'src': name, 'scale': args.embed_scale, 'box': box}
    conv = Converter(args.pptx, args.outdir, opts)
    sections = conv.convert()
    stacks = {}
    for spec in args.stack or []:
        top, rng = spec.split('=', 1)
        members = []
        for part in rng.split(','):
            a, _, b = part.partition('-')
            members.extend(range(int(a), int(b or a) + 1))
        stacks[int(top)] = members
    sections = stack_sections(sections, stacks)
    title = os.path.splitext(os.path.basename(args.pptx))[0]
    core = 'docProps/core.xml'
    if core in conv.pkg.names:
        t = conv.pkg.xml(core).find('{http://purl.org/dc/elements/1.1/}title')
        if t is not None and (t.text or '').strip():
            title = t.text.strip()
    # the first slide's title is usually a better page title than stale document properties
    first = conv.pkg.xml(conv.slides[0])
    for sp in first.iter(P + 'sp'):
        ph = sp.find('.//' + P + 'ph')
        if ph is not None and ph.get('type') in ('title', 'ctrTitle'):
            txt = ' '.join(''.join(t.text or '' for t in p_.iter(A + 't')) for p_ in sp.iter(A + 'p')).strip()
            if txt:
                title = txt
                break
    # first slide title text as page title if nothing better
    W, H = int(round(conv.W)), int(round(conv.H))
    head_links = ['<link rel="stylesheet" href="lib/reveal/reveal.css">']
    if os.path.exists(os.path.join(args.outdir, 'fonts', 'fonts.css')):
        head_links.append('<link rel="stylesheet" href="fonts/fonts.css">')
    page = ['<!doctype html>', '<html lang="en">', '<head>', '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            '<title>%s</title>' % esc(title)] + head_links + [
        '<style>%s</style>' % (PAGE_CSS % {'W': W, 'H': H}), '</head>', '<body>',
        '<div class="reveal"><div class="slides">'] + sections + [
        '</div></div>',
        '<script src="lib/reveal/reveal.js"></script>',
        '<script src="lib/reveal/plugin/notes/notes.js"></script>',
        '<script>%s</script>' % (PAGE_JS % {'W': W, 'H': H}),
        '</body>', '</html>']
    out = '\n'.join(page)
    # class-add marker -> real class attribute merge
    out = re.sub(r'class="([^"]*)"(\s+)class-add="([^"]*)"', r'class="\1 \3"\2', out)
    with open(os.path.join(args.outdir, 'index.html'), 'w', encoding='utf-8') as fh:
        fh.write(out)
    import hashlib
    with open(os.path.join(args.outdir, BUILD_STAMP), 'w') as fh:
        fh.write(hashlib.sha256(out.encode('utf-8')).hexdigest() + '\n')
    for w_ in conv.warnings:
        print('warning:', w_, file=sys.stderr)
    print('wrote %s (%d slides, %d media files)' % (os.path.join(args.outdir, 'index.html'), len(conv.slides), len(os.listdir(conv.media_dir))))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('pptx')
    ap.add_argument('outdir')
    ap.add_argument('--embed-html', action='append', metavar='SLIDE=FILE',
                    help='replace the video/media shape on SLIDE with a live iframe of FILE')
    ap.add_argument('--embed-css', default='', help='extra CSS injected into the embedded page when framed')
    ap.add_argument('--embed-scale', type=float, default=1.0, help='zoom factor for the embedded page')
    ap.add_argument('--embed-box', help='x,y,w,h (slide px) for the iframe instead of the media shape box')
    ap.add_argument('--embed-local-css', help='stylesheet that replaces Google Fonts links in the embedded page')
    ap.add_argument('--force', action='store_true',
                    help='overwrite index.html even if it was edited after the last build (a copy goes to _backups/)')
    ap.add_argument('--stack', action='append', metavar='TOP=A-B[,C]',
                    help='place slides A..B vertically under slide TOP (reveal.js vertical stack); '
                         'Space/PageDown/clicker then skip the stack, Down arrow enters it')
    build(ap.parse_args())


if __name__ == '__main__':
    main()
