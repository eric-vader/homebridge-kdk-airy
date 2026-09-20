# Development tasks. `make check` is what CI runs; `make dev` runs Homebridge with the web UI against test/hbConfig.
NPM ?= npm
NODE ?= node
HB_STORAGE := test/hbConfig
HOMEBRIDGE := node_modules/homebridge/bin/homebridge.js
# The web UI is installed here on first use, beside a link to this checkout, so one plugin path holds both.
DEV := .dev/node_modules
UI := $(DEV)/homebridge-config-ui-x

.PHONY: build clean lint test check watch bridge dev bump release approve

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

VERSION := $(shell node -p "require('./package.json').version")
BUMP ?= patch

# Bump the version (BUMP=patch, minor or major), commit, tag v<version> and push both.
bump: check
	git diff --quiet && git diff --cached --quiet
	npm version $(BUMP)
	git push --follow-tags

# Create the GitHub release for the current version; the "Publish to npm" workflow then stages it on npm.
# Notes are generated from the commits; NOTES="text" or NOTES_FILE=path puts your own notes above them.
release: check
	git diff --quiet && git diff --cached --quiet
	gh release create v$(VERSION) --title v$(VERSION) --generate-notes \
	  $(if $(NOTES),--notes "$(NOTES)") $(if $(NOTES_FILE),--notes-file "$(NOTES_FILE)")

# Approve the version staged by the workflow, with your npm login and 2FA. Lists the staged versions first.
# `npm stage` needs a newer npm than Node ships with, so the latest npm is run through npx.
approve:
	npx -y npm@latest stage list homebridge-kdk-airy
	@read -p "stage id to approve: " id && npx -y npm@latest stage approve $$id
