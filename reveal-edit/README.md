# reveal-edit — installer

A visual editor for any reveal.js presentation: click to select, drag to move and resize, double-click
text to edit, add text boxes, shapes, lines/arrows and images, rearrange slides and stacks, edit speaker
notes, renumber slides, turn reveal.js's navigation arrows on or off, save as PDF, select several elements at once, copy and paste elements between presentations (⌘C in one, ⌘V in the other —
pictures and videos come along). Saving writes the presentation's HTML file back (previous versions go to the
deck's `_backups/` folder).

## Install (once)

In Terminal:

    bash "/Users/aregjan/MIT Dropbox/Areg Danagoulian/Presentations/VC_2026/reveal-edit-installer/install.sh"

This puts the command in `~/bin/reveal-edit`, adds `~/bin` to your PATH if needed (in `~/.zshrc`), and
creates the app `~/Applications/Reveal Edit.app`. No admin rights, no packages — only Python 3.
Run it again any time to update. After installing you can delete this folder.

## Use

- Terminal: `reveal-edit` in a presentation's folder, or `reveal-edit path/to/talk.html`
  (a folder works too; with several presentations in it you get to choose; with none, a file picker opens).
- Finder: drop a presentation's `.html` file on **Reveal Edit**, or right-click it → Open With →
  Reveal Edit, or double-click the app to choose a file.

The browser opens the deck in edit mode. Close the tab when you are done — the editor stops by itself a
few seconds later. Opening a deck that is already being edited just opens another tab on it.
`reveal-edit --help` lists the options (`--keep-running`, `--no-browser`, `--port`).

## Uninstall

    rm ~/bin/reveal-edit
    rm -r ~/Applications/"Reveal Edit.app"

(and remove the `# added by the reveal-edit installer` lines from `~/.zshrc` if you like).
