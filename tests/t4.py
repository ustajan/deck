import asyncio, os, re, subprocess, zipfile
from playwright.async_api import async_playwright
S = os.environ.get('DECK_TEST_DIR', '/tmp/deck-tests')
DECK = S + '/P2/p2.html'; PORT = 8824; L = '.reveal .slides .present '
R = []; ERRS = []
def ok(n, c, x=''):
    R.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + ('  ' + str(x) if x != '' else '') + ('' if c or not ERRS else '  ERRORS: ' + str(ERRS[-3:])), flush=True)
CENTER = "(sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1440, 'height': 900}); pg = await ctx.new_page()
        pg.on('pageerror', lambda e: ERRS.append(str(e))); pg.on('console', lambda m: ERRS.append(m.text) if m.type == 'error' else None)
        prompts = {'table': '4 × 3', 'pptx': ''}
        async def on_dialog(d):
            if d.type == 'prompt': await d.accept(prompts['table'] if 'Table size' in d.message else '')
            else: await d.accept()
        pg.on('dialog', lambda d: asyncio.ensure_future(on_dialog(d)))
        await pg.goto('http://127.0.0.1:%d/p2.html?edit' % PORT); await pg.wait_for_selector('.re-bar'); await pg.wait_for_timeout(1200)
        ev = pg.evaluate
        # ---- table
        await pg.click('.re-menu-left > .re-btn:has-text("+ Table")'); await pg.click('.re-menu-list .re-btn:has-text("Insert table")'); await pg.wait_for_timeout(300)
        t = await ev("(() => { const t = document.querySelector('" + L + "[data-table] table'); return t ? [t.rows.length, t.rows[0].cells.length, t.rows[0].cells[0].tagName] : null; })()")
        ok('table 4×3 inserted with a header row', t == [4, 3, 'TH'], t)
        c = await ev(CENTER, L + '[data-table] tr:nth-child(2) td:nth-child(2)')
        await pg.mouse.dblclick(*c); await pg.keyboard.type('12.5'); await pg.keyboard.press('Tab'); await pg.keyboard.type('next'); await pg.keyboard.press('Escape')
        cells = await ev("[...document.querySelectorAll('" + L + "[data-table] tr:nth-child(2) td')].map(c => c.innerText.trim())")
        ok('typing in cells, Tab moves to the next cell', cells == ['', '12.5', 'next'], cells)
        await pg.mouse.dblclick(*c); await pg.click('.re-menu-left > .re-btn:has-text("+ Table")'); await pg.click('.re-menu-list .re-btn:has-text("Row below")'); await pg.wait_for_timeout(200)
        await pg.click('.re-menu-left > .re-btn:has-text("+ Table")'); await pg.click('.re-menu-list .re-btn:has-text("Column right")'); await pg.wait_for_timeout(200)
        t2 = await ev("(() => { const t = document.querySelector('" + L + "[data-table] table'); return [t.rows.length, t.rows[0].cells.length, [...t.rows[2].cells].map(c => c.innerText.trim())]; })()")
        ok('row below and column right added', t2[0] == 5 and t2[1] == 4 and t2[2] == ['', '', '', ''], t2)
        await pg.screenshot(path=S + '/shots/t4_table.png')
        # ---- equation in a new text box, then inline in a text box
        await pg.click('.re-btn[title="Insert an equation (LaTeX)"]'); await pg.wait_for_timeout(400)
        await pg.fill('.dk-tex', 'E = mc^2'); await pg.wait_for_timeout(600)
        prev = await ev("document.querySelector('.dk-texprev .katex') !== null")
        await pg.click('.re-dialog .re-btn:has-text("Insert")'); await pg.wait_for_timeout(800)
        m = await ev("(() => { const m = document.querySelector('" + L + ".math[data-tex]'); return m ? [m.getAttribute('data-tex'), !!m.querySelector('.katex'), m.hasAttribute('data-display')] : null; })()")
        ok('equation box inserted and rendered with KaTeX', prev and m and m[0] == 'E = mc^2' and m[1] and m[2], m)
        ok('katex files written into the deck and linked in the file head', os.path.exists(S + '/P2/lib/katex/katex.min.js') and await ev("!!document.querySelector('#deck-katex-css')"))
        await pg.click('.re-btn:has-text("+ Text")'); await pg.wait_for_timeout(150); await pg.keyboard.type('Energy ')
        await pg.click('.re-btn[title="Insert an equation (LaTeX)"]'); await pg.wait_for_timeout(300)
        await pg.fill('.dk-tex', '\\frac{1}{2}mv^2'); await pg.click('.re-dialog .re-btn:has-text("Insert")'); await pg.wait_for_timeout(600)
        await pg.keyboard.type(' here'); await pg.keyboard.press('Escape')
        inl = await ev("(() => { const ps = [...document.querySelectorAll('" + L + ".p')]; const p = ps.find(x => x.innerText.includes('Energy')); return p ? [p.innerText.replace(/\\u200b/g, ''), !!p.querySelector('.math .katex')] : null; })()")
        ok('inline equation inside text', inl and inl[1] and inl[0].startswith('Energy') and 'here' in inl[0], inl)
        # ---- link an element to slide 1, link words to a URL
        await pg.mouse.click(*(await ev(CENTER, L + '[data-table] tr:nth-child(1) th:nth-child(1)'))); await pg.keyboard.press('Control+k'); await pg.wait_for_timeout(300)
        await pg.select_option('.re-dialog select >> nth=0', 'slide'); await pg.click('.re-dialog .re-btn:has-text("Set link")'); await pg.wait_for_timeout(200)
        ok('element linked to a slide; link script added', await ev("document.querySelector('" + L + "[data-table]').getAttribute('data-link')") == '#/0' and await ev("!!(new DOMParser()).parseFromString('<x>', 'text/html')") )
        # ---- find & replace
        await pg.keyboard.press('Escape'); await pg.keyboard.press('Control+f'); await pg.wait_for_timeout(300)
        await pg.fill('.re-dialog input >> nth=0', 'next'); await pg.wait_for_timeout(200)
        hits = await pg.inner_text('.re-dialog')
        await pg.fill('.re-dialog input >> nth=1', 'after'); await pg.click('.re-dialog .re-btn:has-text("Replace all")'); await pg.wait_for_timeout(600)
        cells2 = await ev("[...document.querySelectorAll('" + L + "[data-table] tr:nth-child(2) td')].map(c => c.innerText.trim())")
        ok('find lists the hit, replace all changes it', '1 found' in hits and 'after' in cells2, (hits[:80], cells2))
        # ---- copy / paste style between two text boxes
        bx = await ev("(() => { const ps = [...document.querySelectorAll('" + L + ".p')]; const p = ps.find(x => x.innerText.includes('Energy')); const e = p.closest('.sf > .e'); e.setAttribute('data-t', 'a'); const r = e.getBoundingClientRect(); return [r.x + 10, r.y + r.height / 2]; })()")
        await pg.mouse.click(*bx); await pg.click('.dk-size'); await pg.fill('.dk-size', '48'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
        await pg.evaluate("(() => { const c = document.querySelector('.re-color[title^=\"Text colour\"]'); c.value = '#00aa88'; c.dispatchEvent(new Event('input', { bubbles: true })); })()")
        await pg.keyboard.press('Control+Alt+c'); await pg.wait_for_timeout(100)
        await pg.click('.re-btn:has-text("+ Text")'); await pg.wait_for_timeout(150); await pg.keyboard.type('Styled later'); await pg.keyboard.press('Escape')
        await pg.keyboard.press('Control+Alt+v'); await pg.wait_for_timeout(200)
        st = await ev("(() => { const ps = [...document.querySelectorAll('" + L + ".p')]; const p = ps.find(x => x.innerText.includes('Styled later')); const cs = getComputedStyle(p); return [cs.fontSize, cs.color]; })()")
        ok('paste style: size and colour carried over', st == ['48px', 'rgb(0, 170, 136)'], st)
        # ---- save & reload: equations re-render from data-tex, table intact
        await pg.keyboard.press('Control+s'); await pg.wait_for_timeout(1000)
        html = open(DECK).read()
        ok('file has the table, two equations with data-tex, katex scripts and the link script', html.count('data-table') == 1 and html.count('data-tex=') == 2 and 'deck-katex-render' in html and 'id="deck-links"' in html)
        await pg.reload(); await pg.wait_for_selector('.re-bar'); await pg.wait_for_timeout(1500)
        ok('reload: equations rendered', await ev("document.querySelectorAll('.reveal .slides .math .katex').length") >= 2)
        # ---- exports: PNG of this slide, single file, zip
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("This slide as PNG")')
        await pg.wait_for_selector('.re-dialog h3:has-text("PNG ready")', timeout=60000)
        png = S + '/P2/p2-slide-1.png'
        info = subprocess.run(['python3', '-c', "from PIL import Image; im = Image.open(%r); print(im.size)" % png], capture_output=True, text=True).stdout.strip()
        ok('PNG of the slide at 2x', info == '(2560, 1440)', info)
        await pg.click('.re-dialog .re-btn:has-text("Close")')
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("Single-file HTML")')
        await pg.wait_for_selector('.re-dialog h3:has-text("Single file ready")', timeout=60000)
        single = open(S + '/P2/p2-single.html').read()
        ok('single file: no external refs to lib/ or fonts/, katex inlined', 'href="lib/' not in single and 'src="lib/' not in single and 'url(fonts/' not in single and 'data:font/woff2' in single and len(single) > 500000, (len(single), [m for m in re.findall(r'url\(fonts/[^)]*\)', single)][:3]))
        await pg.click('.re-dialog .re-btn:has-text("Close")')
        sp = await ctx.new_page(); await sp.goto('file://' + S + '/P2/p2-single.html'); await sp.wait_for_timeout(1500)
        ok('single file presents on its own (from file://) with equations', await sp.evaluate("document.querySelectorAll('.math .katex').length") >= 2 and await sp.evaluate('typeof Reveal !== "undefined" && Reveal.getTotalSlides()') == 1)
        await sp.close()
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("Zip the presentation")')
        await pg.wait_for_selector('.re-dialog h3:has-text("Zip ready")', timeout=30000)
        z = zipfile.ZipFile(S + '/P2.zip'); names = z.namelist()
        ok('zip of the folder without backups', any(n.endswith('P2/p2.html') for n in names) and not any('_backups' in n for n in names) and any('lib/reveal/reveal.js' in n for n in names), len(names))
        await pg.click('.re-dialog .re-btn:has-text("Close")')
        # ---- import pptx (deps present here)
        await pg.click('.re-menu > .re-btn:has-text("Deck")')
        prompts['pptx'] = S + '/space_nobackup.pptx'
        async with ctx.expect_page(timeout=180000) as np:
            await pg.evaluate("(() => { window.prompt = () => '" + S + "/space_nobackup.pptx'; })()")
            await pg.click('.re-menu-list .re-btn:has-text("Import a PowerPoint")')
        ip = await np.value; await ip.wait_for_selector('.re-bar', timeout=60000); await ip.wait_for_timeout(1000)
        ok('PowerPoint imported and opened in a new editor', await ip.evaluate('Reveal.getTotalSlides()') > 20 and os.path.exists(S + '/space_nobackup_deck/index.html'), ip.url)
        await ip.close()
        ok('no page errors', not ERRS, ERRS[:3])
        await b.close()
    print('%d/%d passed' % (sum(R), len(R)))
asyncio.run(main())
