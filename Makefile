.PHONY: help install lint test test-e2e coverage serve serve-token build-frontend lint-frontend \
        tailscale-serve tailscale-serve-off tailscale-funnel tailscale-funnel-off tailscale-url docs docs-serve docs-build clean

# ==============================================================================
# Venv
# ==============================================================================

UV := $(shell command -v uv 2> /dev/null)
VENV_DIR?=.venv
PYTHON := $(VENV_DIR)/bin/python

# Port the app is served on. Tailscale proxies to it on 443.
PORT ?= 8000

# Auth mode for the server: 'none' or 'token'. Overridden per target below -
# publishing to the internet defaults to requiring a token.
AUTH ?= none

# ==============================================================================
# Targets
# ==============================================================================

help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  install      Install dependencies"
	@echo "  lint         Run formatter, linter and type checkers"
	@echo "  test         Run backend tests"
	@echo "  test-e2e     Run browser end-to-end tests (Playwright)"
	@echo "  coverage     Run tests with coverage reporting"
	@echo "  serve        Run the dev server on http://127.0.0.1:$(PORT)"
	@echo "  serve-token  Run the dev server requiring a bearer token"
	@echo "  build-frontend  Build the React app into src/lockbox/static"
	@echo "  lint-frontend   Lint the frontend with oxlint"
	@echo ""
	@echo "Remote access (needs Tailscale). Each runs the app AND the proxy:"
	@echo "  tailscale-serve       Reachable by your tailnet only"
	@echo "  tailscale-funnel      Reachable by the PUBLIC internet (token auth)"
	@echo "  tailscale-url         Print the MagicDNS URL"
	@echo "  tailscale-serve-off   Stop sharing"
	@echo "  tailscale-funnel-off  Stop publishing"
	@echo ""
	@echo "  serve and funnel are alternatives, not layers - funnel does not"
	@echo "  need serve first, and either one replaces the other."
	@echo "  Set PORT=8321 or AUTH=none|token on any of the above."
	@echo ""
	@echo "  docs-serve   Serve documentation locally with live reload"
	@echo "  docs-build   Build documentation site"
	@echo "  docs         Alias for docs-serve"
	@echo "  clean        Clean up temporary files"

install:
	@echo ">>> Installing dependencies"
	@$(UV) sync --all-extras

lint:
	@echo ">>> Running formatter and linter"
	@$(UV) run ruff format .
	@$(UV) run ruff check . --fix
	@echo ">>> Running type checkers"
	@$(UV) run mypy --explicit-package-bases src tests
	@$(UV) run pyright

test:
	@echo ">>> Running tests"
	@$(UV) run pytest -q

# Starts its own server on a throwaway data file, so it never touches ./data.
test-e2e:
	@echo ">>> Running end-to-end tests"
	@cd frontend && pnpm exec playwright test

coverage:
	@echo ">>> Running tests with coverage"
	@$(UV) run coverage run -m pytest -q
	@$(UV) run coverage report
	@$(UV) run coverage xml

serve:
	@echo ">>> Serving on http://127.0.0.1:$(PORT)"
	@$(UV) run lockbox serve --port $(PORT) --auth $(AUTH) --reload

# Prints a freshly generated token on startup.
serve-token: AUTH = token
serve-token: serve

# ==============================================================================
# Remote access
# ==============================================================================
#
# Service workers and WebAuthn both need a secure context, so a plain-HTTP LAN
# address silently disables offline mode and biometric unlock. Tailscale issues
# a real Let's Encrypt certificate, which is why these targets exist at all.

# `tailscale serve` and `tailscale funnel` are two settings of ONE proxy, not
# layers: funnel does not require serve first, and enabling either replaces the
# other. (`tailscale funnel reset` clears a serve config too, which is the
# clearest evidence they share one config store.) The targets are named after
# the CLI verbs so the mapping is obvious.
#
# One command, one terminal. Tailscale's proxy is a background daemon setting
# rather than a process, so it is configured first and the server then runs in
# the foreground - Ctrl-C stops the thing you actually started. The proxy config
# survives, harmlessly pointing at a closed port, until '*-off' clears it.
tailscale-serve:
	@tailscale serve --bg $(PORT) >/dev/null
	@echo ">>> Shared with your tailnet:"
	@echo "    $$($(MAKE) -s tailscale-url)"
	@echo ""
	@echo "    Only devices signed into your tailnet can reach this. Tailscale"
	@echo "    authenticates them, so AUTH=none is fine here."
	@echo "    Stop sharing afterwards with 'make tailscale-serve-off'."
	@echo ""
	@$(UV) run lockbox serve --port $(PORT) --auth $(AUTH) --reload

tailscale-url:
	@tailscale status --json \
	  | $(PYTHON) -c "import json,sys; print('https://' + json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))"

tailscale-serve-off:
	@echo ">>> Stopping tailnet sharing"
	@tailscale serve --https=443 off

# Public internet, so this defaults to requiring a token. Override with
# AUTH=none if you really want an open endpoint - you will be warned, not
# stopped.
tailscale-funnel: AUTH = token
tailscale-funnel:
	@tailscale funnel --bg $(PORT) >/dev/null
	@echo ">>> PUBLIC on the internet:"
	@echo "    $$($(MAKE) -s tailscale-url)"
	@echo ""
	@if [ "$(AUTH)" = "none" ]; then \
		echo "    WARNING: running with AUTH=none. Anyone who finds this URL can"; \
		echo "    read, write and delete every note."; \
	else \
		echo "    The API requires the token printed below."; \
	fi
	@echo "    Stop publishing afterwards with 'make tailscale-funnel-off'."
	@echo ""
	@$(UV) run lockbox serve --port $(PORT) --auth $(AUTH) --reload

tailscale-funnel-off:
	@echo ">>> Stopping Funnel"
	@echo "    Note: this clears any 'tailscale serve' config too - they are"
	@echo "    the same underlying proxy."
	@tailscale funnel reset

# The built frontend is committed, so this is only needed after changing
# anything under frontend/src.
build-frontend:
	@echo ">>> Building frontend into src/lockbox/static"
	@cd frontend && pnpm install --frozen-lockfile && pnpm build

lint-frontend:
	@echo ">>> Linting frontend"
	@cd frontend && pnpm lint

# NO_MKDOCS_2_WARNING silences the Material for MkDocs promotional banner.
docs-serve:
	@echo ">>> Serving documentation at http://127.0.0.1:8001"
	@NO_MKDOCS_2_WARNING=1 $(UV) run mkdocs serve --dev-addr 127.0.0.1:8001

docs-build:
	@echo ">>> Building documentation site"
	@NO_MKDOCS_2_WARNING=1 $(UV) run mkdocs build

docs: docs-serve

clean:
	@echo ">>> Cleaning up"
	@find . -type f -name "*.pyc" -delete
	@find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	@find . -type d -name ".mypy_cache" -exec rm -rf {} + 2>/dev/null || true
	@rm -rf .coverage htmlcov coverage.xml
	@rm -rf .pyright
	@rm -rf dist build *.egg-info
	@rm -rf site

# ==============================================================================
# Default
# ==============================================================================

.DEFAULT_GOAL := help
