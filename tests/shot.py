import asyncio, sys
from playwright.async_api import async_playwright
url = sys.argv[1]; out = sys.argv[2]; js = sys.argv[3] if len(sys.argv) > 3 else ''
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1440, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        await pg.goto(url); await pg.wait_for_timeout(1500)
        if js: print(await pg.evaluate(js))
        await pg.screenshot(path=out)
        print('errors:', errs[:5])
        await b.close()
asyncio.run(main())
