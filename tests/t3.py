import asyncio, os, subprocess
from playwright.async_api import async_playwright
S = os.environ.get('DECK_TEST_DIR', '/tmp/deck-tests')
R = []; ERRS = []
def ok(n, c, x=''):
    R.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n + ('  ' + str(x) if x != '' else '') + ('' if c or not ERRS else '  ERRORS: ' + str(ERRS[-3:])), flush=True)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1440, 'height': 900}); pg = await ctx.new_page()
        pg.on('pageerror', lambda e: ERRS.append(str(e))); pg.on('console', lambda m: ERRS.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto('http://127.0.0.1:8822/index.html?edit'); await pg.wait_for_selector('.re-bar'); await pg.wait_for_timeout(2500)
        ev = pg.evaluate
        ok('converted deck opens: 35 slides in the filmstrip, stack shown', await ev("document.querySelectorAll('.dk-thumb').length") == 35 and await ev("document.querySelectorAll('.dk-stack').length") >= 1)
        ok('no layout select for a foreign deck; background says "As it is"', not await ev("!!document.querySelector('.dk-panel select option[value=\"title\"]')") and 'As it is' in await pg.inner_text('.dk-panel'))
        await pg.screenshot(path=S + '/shots/t3_foreign.png')
        # untouched save is byte-identical
        await ev('Reveal.slide(5)'); await pg.wait_for_timeout(400)
        await pg.keyboard.press('Control+s'); await pg.wait_for_timeout(1200)
        same = open(S + '/F/index.html', 'rb').read() == open(S + '/F-original.html', 'rb').read()
        ok('saving without edits leaves the file byte-identical', same)
        # edit a slide, add a text box, save: only that slide changes
        await pg.click('.re-btn:has-text("+ Text")'); await pg.wait_for_timeout(150); await pg.keyboard.type('Added with deck'); await pg.keyboard.press('Escape')
        await pg.keyboard.press('Control+s'); await pg.wait_for_timeout(1200)
        a = open(S + '/F-original.html').read().split('<section'); c = open(S + '/F/index.html').read().split('<section')
        diff = [i for i in range(min(len(a), len(c))) if a[i] != c[i]]
        ok('after an edit only one slide differs in the file', len(a) == len(c) and len(diff) == 1, diff)
        # adopt: theme + master added without repainting slides; then settings apply
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.click('.re-menu-list .re-btn:has-text("Add deck theme")'); await pg.wait_for_timeout(800)
        bg = await ev("getComputedStyle(Reveal.getCurrentSlide().querySelector('.sf')).backgroundImage")
        ok('adopted: meta + theme present, slide backgrounds untouched', await ev("!!document.getElementById('deck-meta')") and 'image1.png' in bg and await ev("!!document.querySelector('.dk-panel select option[value=\"title\"]')"), bg[:60])
        await pg.keyboard.press('Control+s'); await pg.wait_for_timeout(1200)
        html = open(S + '/F/index.html').read()
        ok('saved with theme block, meta and master template in head', '<style id="deck-theme">' in html and 'id="deck-meta"' in html and '<template id="deck-master">' in html and html.count('<section') == 38)
        await pg.reload(); await pg.wait_for_selector('.re-bar'); await pg.wait_for_timeout(2000)
        ok('reopens with layouts available and 35 slides', await ev("document.querySelectorAll('.dk-thumb').length") == 35 and await ev("!!document.querySelector('.dk-panel select option[value=\"title\"]')"))
        # a new slide with a layout in the converted deck, inheriting its look? (theme bg is black here)
        await pg.click('.re-menu-left > .re-btn:has-text("+ Slide")'); await pg.click('.dk-layout:has-text("Title and content")'); await pg.wait_for_timeout(600)
        ok('new layout slide in the converted deck', await ev('Reveal.getTotalSlides()') == 36 and await ev("Reveal.getCurrentSlide().getAttribute('data-dk-layout')") == 'content')
        await pg.screenshot(path=S + '/shots/t3_newslide.png')
        ok('no page errors', not ERRS, ERRS[:3])
        await b.close()
    print('%d/%d passed' % (sum(R), len(R)))
asyncio.run(main())
