#!/usr/bin/env python3
"""reveal-edit — visual editor for reveal.js presentations.

    reveal-edit                      edit the presentation in the current folder (or pick one)
    reveal-edit DECK_FOLDER          edit the presentation in that folder
    reveal-edit path/to/talk.html    edit that file

Your browser opens the deck in edit mode: click to select, drag to move, handles to resize,
double-click text to edit it, + Shape / + Text / + Image to add things, Cmd+C / Cmd+V to copy elements
within a presentation or between presentations (pictures and videos come along). Save (Cmd/Ctrl+S) writes the
HTML file back; the previous version is kept in the deck's _backups/ folder. Only this computer can
reach the editor (127.0.0.1), and only the page it opened can save.

The editor stops by itself a few seconds after you close its browser tab (or press Ctrl+C).
Opening a deck that is already being edited just opens another tab on the running editor.

Standard library only (Python 3.8+).
"""
import argparse
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

VERSION = '2026.11.03'
HERE = os.path.dirname(os.path.abspath(__file__))
EDITOR_FILES = {'editor.js': 'application/javascript', 'editor.css': 'text/css'}
EMBEDDED = {}   # the single-file build (reveal-edit) carries editor.js / editor.css here, base64-encoded
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
        script = 'display alert "Reveal Edit" message %s as warning' % aq(msg)
        subprocess.run(['osascript', '-e', script], capture_output=True)
UPLOAD_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.webm', '.mov', '.m4v'}
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
        server_version = 'reveal-edit/1'
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
                return self.json(200, {'app': 'reveal-edit', 'deck': ed.deck, 'file': ed.file, 'pid': os.getpid()})
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
                return self.send(200, data, 'text/html; charset=utf-8', extra)
            return self.send_file(fp, ctype)

        def inject(self, data, rel):
            boot = ('<script>window.__REVEAL_EDIT = %s;</script>\n'
                    '<link rel="stylesheet" href="/__editor/editor.css">\n'
                    '<script src="/__editor/editor.js"></script>\n') % json.dumps(
                        {'token': ed.token, 'file': rel.replace(os.sep, '/')})
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
                return self.json(400, {'error': 'not a reveal-edit clipboard item'})
            if len(body) > 64 * 1024 * 1024:
                return self.json(413, {'error': 'too large'})
            obj['time'] = time.time()
            fp = os.path.join(registry_dir(), 'clipboard.dat')
            tmp = fp + '.%d.tmp' % os.getpid()
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(obj, fh)
            os.replace(tmp, fp)
            return self.json(200, {'ok': True})

        def clip_get(self):
            try:
                with open(os.path.join(registry_dir(), 'clipboard.dat'), encoding='utf-8') as fh:
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
            with ed.pdf_lock, tempfile.TemporaryDirectory(prefix='reveal-edit-pdf-') as tmp:
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
    return osascript('POSIX path of (choose file with prompt "Choose a reveal.js presentation (its HTML file)" '
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
                say('No reveal.js presentation in %s. Run: reveal-edit path/to/presentation.html' % base, error=True)
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


def registry_dir():
    base = os.path.expanduser('~/Library/Caches') if sys.platform == 'darwin' else \
        os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
    d = os.path.join(base, 'reveal-edit')
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
        if who.get('app') == 'reveal-edit' and who.get('deck') == os.path.realpath(deck) and who.get('file') == file:
            return info['port'], rec
    except Exception:
        pass
    return None, rec


def main():
    global GUI
    ap = argparse.ArgumentParser(prog='reveal-edit', description='Visual editor for reveal.js presentations.',
                                 epilog='The editor stops a few seconds after you close its browser tab.')
    ap.add_argument('target', nargs='?', help='presentation .html file or its folder (default: current folder)')
    ap.add_argument('file', nargs='?', help=argparse.SUPPRESS)          # old form: edit.py DECK_DIR FILE
    ap.add_argument('--port', type=int, default=8765, help='first port to try (default 8765)')
    ap.add_argument('--no-browser', action='store_true', help='do not open the browser, just print the address')
    ap.add_argument('--keep-running', action='store_true', help='keep running after the editor tab is closed')
    ap.add_argument('--gui', action='store_true', help=argparse.SUPPRESS)   # started from the Finder app
    ap.add_argument('--version', action='version', version='reveal-edit ' + VERSION)
    a = ap.parse_args()
    GUI = a.gui or not sys.stdin.isatty()
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


if __name__ == '__main__':
    main()
