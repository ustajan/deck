#!/bin/bash
# Installs deck — a pared-down PowerPoint for presentations that live in HTML — for your user account:
#   ~/bin/deck                  the command        (deck new "My talk" · deck talk.html · deck)
#   ~/Applications/Deck.app     the Finder app     (double-click: new or open · drop a presentation on it)
# Run once from Terminal:   bash install.sh
# Running it again updates both. Nothing outside your home folder is touched; no admin rights needed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BIN="${DECK_BIN:-$HOME/bin}"
APPDIR="${DECK_APPS:-$HOME/Applications}"
CMD="$BIN/deck"

say() { printf '%s\n' "$*"; }

[ -f "$HERE/deck" ] || { say "deck is missing next to install.sh"; exit 1; }

# 1. Python 3.8+ (standard library only — no packages needed)
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  say "python3 was not found. Install it (for example: xcode-select --install) and run this again."
  exit 1
fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' 2>/dev/null; then
  say "deck needs Python 3.8 or newer; $PY is older (or not working)."
  exit 1
fi

# 2. The command, run by the python3 found above (so it also works when started from the Finder app)
mkdir -p "$BIN"
case "$PY" in *" "*) SHEBANG="#!/usr/bin/env python3" ;; *) SHEBANG="#!$PY" ;; esac
TMP="$CMD.tmp.$$"
{ printf '%s\n' "$SHEBANG"; tail -n +2 "$HERE/deck"; } > "$TMP"
chmod 755 "$TMP"
mv -f "$TMP" "$CMD"
"$CMD" --version >/dev/null
say "✓ Installed the command:  $CMD   ($("$CMD" --version), using $PY)"

# 3. Make sure the folder is on PATH
case ":$PATH:" in
  *":$BIN:"*) say "✓ $BIN is already on your PATH" ;;
  *)
    case "$(basename "${SHELL:-/bin/zsh}")" in
      bash) RC="$HOME/.bash_profile" ;;
      *)    RC="$HOME/.zshrc" ;;
    esac
    if [ "$BIN" = "$HOME/bin" ]; then LINE='export PATH="$HOME/bin:$PATH"'; else LINE="export PATH=\"$BIN:\$PATH\""; fi
    if ! grep -qsF "$LINE" "$RC"; then
      printf '\n# added by the deck installer\n%s\n' "$LINE" >> "$RC"
    fi
    say "✓ Added $BIN to your PATH in $RC — open a new Terminal window to use 'deck'"
    ;;
esac

# 4. The Finder app (macOS only)
if command -v osacompile >/dev/null 2>&1; then
  APP="$APPDIR/Deck.app"
  mkdir -p "$APPDIR"
  AS="${TMPDIR:-/tmp}/deck-app.$$.applescript"
  ESC_CMD="$(printf '%s' "$CMD" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  cat > "$AS" <<APPLESCRIPT
-- Deck: a pared-down PowerPoint for presentations that live in HTML.
-- Double-click: make a new presentation or open one. Drop a presentation's .html file (or its folder) on the app to open it.
on open theItems
	repeat with anItem in theItems
		my runDeck(POSIX path of anItem)
	end repeat
end open

on run
	my runDeck("")
end run

on runDeck(p)
	set cmd to "$ESC_CMD"
	set logFile to (POSIX path of (path to library folder from user domain)) & "Logs/deck.log"
	if p is "" then
		do shell script quoted form of cmd & " --gui >> " & quoted form of logFile & " 2>&1 &"
	else
		do shell script quoted form of cmd & " --gui " & quoted form of p & " >> " & quoted form of logFile & " 2>&1 &"
	end if
end runDeck
APPLESCRIPT
  rm -rf "$APP"
  osacompile -o "$APP" "$AS"
  rm -f "$AS"
  PL="$APP/Contents/Info.plist"
  PB=/usr/libexec/PlistBuddy
  if [ -x "$PB" ]; then
    # offer the app in Finder's "Open With" for HTML files
    "$PB" -c "Delete :CFBundleDocumentTypes" "$PL" >/dev/null 2>&1 || true
    "$PB" -c "Add :CFBundleDocumentTypes array" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0 dict" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string 'HTML presentation'" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Editor" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string public.html" "$PL"
    "$PB" -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:1 string public.folder" "$PL"
    "$PB" -c "Set :CFBundleIdentifier local.deck.app" "$PL" >/dev/null 2>&1 || \
      "$PB" -c "Add :CFBundleIdentifier string local.deck.app" "$PL"
  fi
  # the Info.plist changed, so re-sign the app (ad hoc) or macOS may refuse to open it
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
  LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  [ -x "$LSREG" ] && "$LSREG" -f "$APP" >/dev/null 2>&1 || true
  say "✓ Installed the app:      $APP"
else
  say "· Skipped the Finder app (it needs macOS)"
fi

say ""
say "Use it:"
say "  deck new \"My talk\"         a new presentation (a folder My talk/ with my-talk.html), opened in the editor"
say "  deck path/to/talk.html      open a presentation (also a pptx2reveal / reveal-edit deck)"
say "  deck                        the presentation in the current folder"
say "  Finder: double-click Deck (new or open), or drop a presentation's .html file on it"
say "The editor stops by itself a few seconds after you close its browser tab."
