# deck — build, install, test
.PHONY: build install test clean
build:            ## assemble deck.js from engine/ + parts/, then the single-file command dist/deck
	python3 parts/assemble.py
	python3 build_single.py dist/deck
install: build    ## ~/bin/deck and (on macOS) ~/Applications/Deck.app
	cp dist/deck dist/deck.tmp && mkdir -p dist/pkg && mv dist/deck.tmp dist/pkg/deck && cp install.sh dist/pkg/ && bash dist/pkg/install.sh
test: build       ## browser tests (needs: pip install playwright && playwright install chromium)
	bash tests/run.sh
clean:
	rm -rf dist deck.js __pycache__
