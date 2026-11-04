#!/usr/bin/env python3
"""Build the single-file `reveal-edit` command from edit.py + editor.js + editor.css."""
import base64, os, sys
here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[1]
src = open(os.path.join(here, 'edit.py')).read()
marker = 'EMBEDDED = {}   # the single-file build (reveal-edit) carries editor.js / editor.css here, base64-encoded'
assert marker in src
parts = []
for name in ('editor.js', 'editor.css'):
    b = base64.b64encode(open(os.path.join(here, name), 'rb').read()).decode()
    lines = '\n'.join("    '%s'" % b[i:i + 100] for i in range(0, len(b), 100))
    parts.append("    %r: (\n%s\n    )," % (name, lines))
src = src.replace(marker, 'EMBEDDED = {   # editor.js / editor.css, base64-encoded (single-file build)\n' + '\n'.join(parts) + '\n}')
with open(out, 'w') as fh:
    fh.write(src)
os.chmod(out, 0o755)
print('built %s (%d KB)' % (out, os.path.getsize(out) // 1024))
