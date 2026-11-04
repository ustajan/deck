import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto('http://127.0.0.1:8822/index.html?edit'); await pg.wait_for_selector('.re-bar'); await pg.wait_for_timeout(2000)
        ev = pg.evaluate
        await pg.click('.re-menu > .re-btn:has-text("Deck")'); await pg.wait_for_timeout(200)
        r = await ev("(() => { const m = document.querySelector('.re-menu.re-open .re-menu-list').getBoundingClientRect(); return [m.left, m.right]; })()")
        print('PASS deck menu inside the window' if r[0] >= 0 else 'FAIL deck menu offscreen', r)
        await pg.screenshot(path=S + '/shots/t5_menu.png', clip={'x': 0, 'y': 0, 'width': 500, 'height': 520})
        await pg.keyboard.press('Escape'); await pg.mouse.click(700, 880)
        scope = await ev("[...document.querySelectorAll('.dk-panel select')].find(x => [...x.options].some(o => o.value === 'all'))")
        vis = await ev("(() => { const s = [...document.querySelectorAll('.dk-panel select')].find(x => [...x.options].some(o => o.value === 'all')); return s && getComputedStyle(s).display !== 'none'; })()")
        print('PASS Every slide option visible on the converted deck' if vis else 'FAIL scope select hidden')
        await ev('Reveal.slide(2)'); await pg.wait_for_timeout(300)
        await ev("(() => { const s = [...document.querySelectorAll('.dk-panel select')].find(x => [...x.options].some(o => o.value === 'color')); s.value = 'color'; s.dispatchEvent(new Event('change')); })()")
        await ev("(() => { const c = document.querySelector('.dk-bg input[type=color]'); c.value = '#224466'; c.dispatchEvent(new Event('input')); c.dispatchEvent(new Event('change')); })()")
        await pg.wait_for_timeout(200)
        await ev("(() => { const s = [...document.querySelectorAll('.dk-panel select')].find(x => [...x.options].some(o => o.value === 'all')); s.value = 'all'; s.dispatchEvent(new Event('change')); })()")
        await pg.wait_for_timeout(800)
        same = await ev("Reveal.getSlides().every(s => /34, 68, 102|#224466/.test(s.querySelector('.sf').style.background))")
        print('PASS every slide got the colour' if same else 'FAIL', await ev("Reveal.getSlides()[5].querySelector('.sf').style.background"))
        print(errs)
        await b.close()
asyncio.run(main())
