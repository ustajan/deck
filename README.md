# deck

A pared-down PowerPoint for presentations that live in HTML.

`deck` makes and edits presentations that are plain HTML files built on [reveal.js](https://revealjs.com):
they open in any browser, with or without the tool. Slides with layouts, text with bullets, shapes and
arrows that stay connected, pictures with cropping, videos, embedded web pages, tables, LaTeX equations,
builds, transitions, speaker notes, light / dark themes with your own background picture, a master for
footer / slide number / logo, PDF / PNG / single-file export, PowerPoint import. It also opens presentations
made with `pptx2reveal` or edited with `reveal-edit` (both are in this repository).

Everything is one Python file that needs only the standard library (3.8+); the editor runs in your
browser on `127.0.0.1`. PDF and PNG export use Google Chrome (or Edge / Brave / Chromium) if installed.
PowerPoint import needs `lxml` and `Pillow`.

## Use

    deck new "My talk"          # a folder My talk/ with my-talk.html, media/, lib/, fonts/ — opened in the editor
    deck path/to/talk.html      # open a presentation (file or folder)
    deck                        # the presentation in the current folder
    deck --help

On macOS the installer also makes `Deck.app`: double-click it for new / open, or drop a presentation on it.
The editor stops by itself a few seconds after its browser tab is closed. Press **?** in the editor for the
shortcuts; see [reveal-edit/README.md](reveal-edit/README.md) for the companion editor.

## Build

The command is assembled from the sources, so after any change:

    make build            # → dist/deck  (= python3 parts/assemble.py && python3 build_single.py dist/deck)
    make install          # → ~/bin/deck and, on macOS, ~/Applications/Deck.app
    make test             # browser tests; needs  pip install playwright && playwright install chromium

What the build does:

1. `parts/assemble.py` takes the editing engine `engine/editor.js` (the same code as reveal-edit: selection,
   shapes, clipboard, slide operations, saving) and splices in the deck modules from `parts/` —
   `model.js` (settings, theme, master, layouts), `text.js` (paragraphs, bullets, fonts), `arrange.js`
   (groups, align, rotate, crop, connectors), `panels.js` (filmstrip, side panel, builds), `ui.js` (toolbar,
   dialogs), `phase2.js` (tables, equations, links, find, exports) — patching the engine where they meet.
   The result is `deck.js`.
2. `build_single.py` embeds `deck.js`, `deck.css`, the vendored `reveal.js` + fonts (`vendor/`), KaTeX
   (`vendor_opt/`, copied into a presentation when its first equation is added) and `pptx2reveal.py`
   into `deck.py` as base64 — giving the single file `dist/deck`.

To work on the editor without rebuilding the single file, run `python3 deck.py path/to/talk.html` from the
repository: it serves `deck.js` / `deck.css` from disk (run `python3 parts/assemble.py` after editing a
part), and reads `vendor/` and `pptx2reveal.py` from the tree.

## Layout

    deck.py           server, command line, new-presentation scaffold (page CSS/JS, themes, layouts, master)
    deck.css          editor chrome
    engine/           editor.js / editor.css — the editing engine shared with reveal-edit
    parts/            the deck modules and assemble.py
    vendor/           reveal.js 5.2.1 (+ notes plugin) and the Carlito / Poppins web fonts written into new decks
    vendor_opt/       KaTeX, written into a deck on first use
    pptx2reveal.py    PowerPoint → reveal.js converter (used by Deck › Import a PowerPoint file)
    build_single.py   the single-file build
    install.sh        installs dist/deck as ~/bin/deck and builds Deck.app (macOS)
    reveal-edit/      the companion editor for arbitrary reveal.js decks (its own README, build and installer)
    tests/            Playwright tests (run.sh starts test editors and runs them)

## The file format

A presentation is `NAME.html` + `media/` + `lib/reveal/` + `fonts/`. Each slide is a `<section>` holding a
1280×720 (or 1024×768) frame `<div class="sf">` of absolutely positioned elements — text boxes
(`.tx > .tb > .p`, with `data-bu` / `data-lvl` for bullets and levels), shapes (`.shp` with an SVG regenerated
from `data-*` attributes), pictures (`.pic > img`, `.crop` with percentage offsets), videos, embedded pages,
tables (`[data-table] > table.tbl`) and equations (`.math[data-tex]`). The head carries the settings
(`#deck-meta`, JSON), the theme CSS (`#deck-theme`) and the master elements (`#deck-master`), which are
stamped onto every slide when saving. Builds are reveal.js fragments. Every object stays expressible in
PowerPoint terms, with a `.pptx` export in mind.
