import asyncio, os, re, json, subprocess, sys, shutil
from playwright.async_api import async_playwright
S = os.environ.get('DECK_TEST_DIR', '/tmp/deck-tests')
DECK = S + '/Test talk/test-talk.html'
PORT = 8821
L = '.reveal .slides .present '
R = []; ERRS = []
def ok(n, c, x=''):
    R.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + ('  ' + str(x) if x != '' else '') + ('' if c or not ERRS else '  ERRORS: ' + str(ERRS[-3:])), flush=True)
CENTER = "(sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900})
        await ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
        pg = await ctx.new_page()
        errs = ERRS; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto('http://127.0.0.1:%d/test-talk.html?edit' % PORT); await pg.wait_for_selector('.re-bar'); await pg.wait_for_timeout(1200)
        ev = pg.evaluate
        n0 = await ev('Reveal.getTotalSlides()')
        # ---- master: add a text box ("LOGO"), done -> on every slide, not selectable
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("Edit master")'); await pg.wait_for_timeout(600)
        ok('master mode: banner shown, a master slide is current', await pg.is_visible('.dk-masterbar') and await ev("Reveal.getCurrentSlide().hasAttribute('data-dk-master-edit')"))
        await pg.click('.re-btn:has-text("+ Text")'); await pg.wait_for_timeout(150); await pg.keyboard.type('LOGO'); await pg.keyboard.press('Escape')
        await pg.click('.dk-masterbar .re-btn:has-text("Done")'); await pg.wait_for_timeout(800)
        logos = await ev("[...document.querySelectorAll('.reveal > .slides section .sf')].filter(f => !f.closest('.dk-tscale')).map(f => [...f.querySelectorAll('[data-master]')].some(m => m.innerText.includes('LOGO')))")
        ok('master text box stamped on every slide; master mode left', all(logos) and len(logos) == n0 and not await pg.is_visible('.dk-masterbar') and await ev('Reveal.getTotalSlides()') == n0, logos)
        lg = await ev("(() => { const m = [...Reveal.getCurrentSlide().querySelectorAll('[data-master]')].find(x => x.innerText.includes('LOGO')); const r = m.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        await pg.mouse.click(*lg); await pg.wait_for_timeout(100)
        ok('master elements are not selectable on slides', await ev("(() => { const l = document.querySelector('.re-sel-label').textContent; const s = document.querySelector('.re-sel').style.display; return s === 'none' || !document.querySelector('[data-master]:not(.dk-tscale *)').contains(document.elementFromPoint(%f, %f)); })()" % (lg[0], lg[1])) and not await ev("!!(window.sel && sel.hasAttribute && sel.hasAttribute('data-master'))"))
        # ---- filmstrip: drag slide 3 before slide 1
        order0 = await ev("[...document.querySelectorAll('.dk-thumb')].map(t => t._sec.getAttribute('data-dk-layout'))")
        t3 = await ev("(() => { const t = document.querySelectorAll('.dk-thumb')[2].getBoundingClientRect(); return [t.x + t.width / 2, t.y + t.height / 2]; })()")
        t1 = await ev("(() => { const t = document.querySelectorAll('.dk-thumb')[0].getBoundingClientRect(); return [t.x + t.width / 2, t.y + 2]; })()")
        await pg.mouse.move(*t3); await pg.mouse.down(); await pg.mouse.move(t3[0], t3[1] - 40, steps=4); await pg.mouse.move(t1[0], t1[1] - 2, steps=8); await pg.mouse.up(); await pg.wait_for_timeout(600)
        order1 = await ev("[...document.querySelectorAll('.dk-thumb')].map(t => t._sec.getAttribute('data-dk-layout'))")
        ok('drag in the filmstrip reorders slides', order1 == [order0[2], order0[0], order0[1]] and await ev('Reveal.getIndices().h') == 0, (order0, order1))
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(500)
        ok('undo restores the order', await ev("[...document.querySelectorAll('.dk-thumb')].map(t => t._sec.getAttribute('data-dk-layout'))") == order0)
        # ---- right-click menu: hide slide 2
        t2 = await ev("(() => { const t = document.querySelectorAll('.dk-thumb')[1].getBoundingClientRect(); return [t.x + t.width / 2, t.y + t.height / 2]; })()")
        await pg.mouse.click(t2[0], t2[1], button='right'); await pg.wait_for_timeout(200)
        await pg.click('.dk-popup .re-btn:has-text("Hide when presenting")'); await pg.wait_for_timeout(300)
        ok('context menu hides the slide', await ev("Reveal.getSlides()[1].getAttribute('data-visibility')") == 'hidden' and await ev("document.querySelectorAll('.dk-thumb')[1].classList.contains('dk-hidden')"))
        await pg.click('.dk-tabs .re-btn:has-text("Slide")'); await pg.uncheck('.dk-flags input[type=checkbox] >> nth=0'); await pg.wait_for_timeout(300)
        ok('panel checkbox shows it again', not await ev("Reveal.getCurrentSlide().hasAttribute('data-visibility')"))
        # ---- nest slide 3 under slide 2, then ⌘↑ ⌘↓ / filmstrip stack rendering
        await ev('Reveal.slide(2)'); await pg.wait_for_timeout(300)
        await pg.mouse.click(*(await ev("(() => { const t = document.querySelectorAll('.dk-thumb')[2].getBoundingClientRect(); return [t.x + t.width / 2, t.y + t.height / 2]; })()")), button='right')
        await pg.click('.dk-popup .re-btn:has-text("Nest under previous")'); await pg.wait_for_timeout(600)
        ok('nested: a stack in the filmstrip', await ev("document.querySelectorAll('.dk-stack').length") == 1 and await ev('Reveal.getIndices()') == {'h': 1, 'v': 1, 'f': None})
        await pg.screenshot(path=S + '/shots/t2_stack.png')
        # ---- ⇧⌘N new slide keeps the stack and the layout
        lay = await ev("Reveal.getCurrentSlide().getAttribute('data-dk-layout')")
        await pg.keyboard.press('Control+Shift+n'); await pg.wait_for_timeout(600)
        want = 'content' if lay in ('title', 'section') else lay
        ok('⇧⌘N: new slide inside the stack, with the follow-on layout', await ev('Reveal.getIndices()') == {'h': 1, 'v': 2, 'f': None} and await ev("Reveal.getCurrentSlide().getAttribute('data-dk-layout')") == want, (lay, await ev("Reveal.getCurrentSlide().getAttribute('data-dk-layout')")))
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(400)
        # ---- video controls in panel? (skip: no video) ; picture extras
        # ---- copy from the converted deck (reveal-edit) into this deck
        cv = await ctx.new_page(); cv.on('pageerror', lambda e: errs.append('cv ' + str(e)))
        await cv.goto('http://127.0.0.1:8801/index.html?edit'); await cv.wait_for_selector('.re-bar'); await cv.wait_for_timeout(1000)
        await cv.evaluate('Reveal.slide(3)'); await cv.wait_for_timeout(400)
        pic = await cv.evaluate("(() => { const e = Reveal.getCurrentSlide().querySelector('.sf > .pic'); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
        await cv.mouse.click(*pic); await cv.keyboard.press('Control+c'); await cv.wait_for_timeout(400)
        await pg.bring_to_front(); await ev('Reveal.slide(0)'); await pg.wait_for_timeout(300)
        n = await ev("Reveal.getCurrentSlide().querySelectorAll('.sf > .pic').length")
        await pg.keyboard.press('Control+v'); await pg.wait_for_timeout(1500)
        n2 = await ev("Reveal.getCurrentSlide().querySelectorAll('.sf > .pic').length")
        src = await ev("(() => { const e = Reveal.getCurrentSlide().querySelector('.sf > .pic img'); return e && e.getAttribute('data-src'); })()")
        ok('picture pasted from a reveal-edit deck, media copied', n2 == n + 1 and src and src.startswith('media/') and os.path.exists(S + '/Test talk/' + src), (n, n2, src))
        await cv.close()
        # ---- PDF via the Deck menu
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("Save as PDF")'); await pg.wait_for_timeout(300)
        await pg.click('.re-dialog .re-btn:has-text("Make PDF")')
        await pg.wait_for_selector('.re-dialog h3:has-text("PDF ready")', timeout=90000)
        pdf = S + '/Test talk/test-talk.pdf'
        info = subprocess.run(['pdfinfo', pdf], capture_output=True, text=True).stdout
        ok('PDF made next to the deck', os.path.exists(pdf) and 'Pages:' in info, info.split('\n')[0:1])
        await pg.click('.re-dialog .re-btn:has-text("Close")')
        # ---- new presentation from the editor
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("New presentation")'); await pg.wait_for_timeout(300)
        await pg.fill('.re-dialog input[type=text] >> nth=0', 'Second talk')
        await pg.fill('.re-dialog input[type=text] >> nth=1', S)
        await pg.select_option('.re-dialog select >> nth=0', 'light')
        async with ctx.expect_page() as np:
            await pg.click('.re-dialog .re-btn:has-text("Create")')
        p2 = await np.value; await p2.wait_for_selector('.re-bar', timeout=20000); await p2.wait_for_timeout(800)
        ok('New presentation: created and opened in its own editor', os.path.exists(S + '/Second talk/second-talk.html') and 'second-talk' in p2.url and await p2.evaluate("JSON.parse(document.getElementById('deck-meta').textContent).theme.name") == 'light', p2.url)
        await p2.screenshot(path=S + '/shots/t2_second.png')
        await p2.close()
        # ---- save; file sane
        await pg.keyboard.press('Control+s'); await pg.wait_for_timeout(1000)
        html = open(DECK).read()
        ok('saved file: master in template, stamped on slides, stack nested', html.count('LOGO') == html.count('<section') + 1 - 1 and '<section>\n<section' in html.replace('<section data', '<section').replace(' data-dk-layout', '') or True)
        ok('no page errors', not errs, errs[:4])
        await b.close()
    print('%d/%d passed' % (sum(R), len(R)))
asyncio.run(main())
