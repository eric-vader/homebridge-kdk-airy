# Development tasks. `make check` is what CI runs; `make dev` runs Homebridge with the web UI against test/hbConfig.
NPM ?= npm
NODE ?= node
HB_STORAGE := test/hbConfig
HOMEBRIDGE := node_modules/homebridge/bin/homebridge.js
# The web UI is installed here on first use, beside a link to this checkout, so one plugin path holds both.
DEV := .dev/node_modules
UI := $(DEV)/homebridge-config-ui-x

.PHONY: build clean lint test check watch bridge dev

build: node_modules
	$(NPM) run build

clean:
	$(NPM) run clean
	rm -rf .dev

lint: node_modules
	$(NPM) run lint

test: node_modules
	$(NPM) test

check: lint build test

node_modules: package-lock.json
	$(NPM) ci

# Recompile on every source change. Run beside `make bridge` or `make dev`, which restart Homebridge when dist/ changes.
watch: node_modules
	npx tsc --watch

# Homebridge alone with debug logging; config and cache live in test/hbConfig.
bridge: build
	$(NODE) --watch-path=dist $(HOMEBRIDGE) -U $(HB_STORAGE) -P . -D

# Homebridge plus the web UI at http://localhost:8582 (no login), so the plugin's settings page can be tried.
# The UI runs as its own process, as hb-service would run it, and stops with the bridge.
dev: build $(UI)
	$(NODE) $(UI)/dist/bin/standalone.js -U $(HB_STORAGE) -P $(DEV) -p 8582 & \
	trap 'kill $$!' EXIT INT TERM; \
	$(NODE) --watch-path=dist $(HOMEBRIDGE) -U $(HB_STORAGE) -P $(DEV) -D

$(UI):
	mkdir -p $(DEV)
	$(NPM) install --prefix .dev --no-save homebridge-config-ui-x@^5
	ln -sfn ../.. $(DEV)/homebridge-kdk-airy
