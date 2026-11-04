#!/usr/bin/env python3
"""Build the single-file `deck` command: deck.py + deck.js + deck.css + the vendored reveal.js and fonts."""
import base64, os, sys
here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'dist', 'deck')
src = open(os.path.join(here, 'deck.py')).read()

def b64block(name, data):
    b = base64.b64encode(data).decode()
    return "    %r: (\n%s\n    )," % (name, '\n'.join("    '%s'" % b[i:i + 100] for i in range(0, len(b), 100)))

m1 = 'EMBEDDED = {}   # the single-file build (deck) carries deck.js / deck.css here, base64-encoded'
m2 = "VENDOR = {}      # path -> base64 (single-file build); the development tree reads ./vendor instead"
assert m1 in src and m2 in src
parts = [b64block(n, open(os.path.join(here, n), 'rb').read()) for n in ('deck.js', 'deck.css')]
src = src.replace(m1, 'EMBEDDED = {   # deck.js / deck.css, base64-encoded (single-file build)\n' + '\n'.join(parts) + '\n}')
vparts = []
vroot = os.path.join(here, 'vendor')
for dp, _, fs in os.walk(vroot):
    for f in sorted(fs):
        rel = os.path.relpath(os.path.join(dp, f), vroot).replace(os.sep, '/')
        vparts.append(b64block(rel, open(os.path.join(dp, f), 'rb').read()))
m3 = "VENDOR_OPT = {}  # optional extras written into a deck when first used (KaTeX for equations)"
m4 = "PPTX2REVEAL = ''  # the converter, base64 (single-file build); the development tree reads ./pptx2reveal.py"
assert m3 in src and m4 in src
oparts = []
oroot = os.path.join(here, 'vendor_opt')
for dp, _, fs in os.walk(oroot):
    for f in sorted(fs):
        rel = os.path.relpath(os.path.join(dp, f), oroot).replace(os.sep, '/')
        oparts.append(b64block(rel, open(os.path.join(dp, f), 'rb').read()))
src = src.replace(m3, 'VENDOR_OPT = {   # KaTeX, base64-encoded (single-file build)\n' + '\n'.join(sorted(oparts)) + '\n}')
conv = os.path.join(here, 'pptx2reveal.py')
if os.path.isfile(conv):
    b = base64.b64encode(open(conv, 'rb').read()).decode()
    src = src.replace(m4, "PPTX2REVEAL = (   # pptx2reveal.py, base64-encoded (single-file build)\n" + '\n'.join("    '%s'" % b[i:i + 100] for i in range(0, len(b), 100)) + '\n)')
src = src.replace(m2, 'VENDOR = {   # lib/reveal and fonts for new presentations, base64-encoded (single-file build)\n' + '\n'.join(sorted(vparts)) + '\n}')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w') as fh:
    fh.write(src)
os.chmod(out, 0o755)
print('built %s (%d KB)' % (out, os.path.getsize(out) // 1024))
