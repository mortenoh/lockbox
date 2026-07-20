.PHONY: help install lint test test-e2e coverage serve serve-token build-frontend lint-frontend \
        tailnet tailnet-off funnel funnel-off tailnet-url docs docs-serve docs-build clean

# ==============================================================================
# Venv
# ==============================================================================

UV := $(shell command -v uv 2> /dev/null)
VENV_DIR?=.venv
PYTHON := $(VENV_DIR)/bin/python

# Port the app is served on. Tailscale proxies to it on 443.
PORT ?= 8000

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
	@echo "Remote access (needs Tailscale):"
	@echo "  tailnet      Share over HTTPS with your tailnet only"
	@echo "  tailnet-url  Print the MagicDNS URL"
	@echo "  tailnet-off  Stop sharing"
	@echo "  funnel       Publish to the PUBLIC internet (refuses without auth)"
	@echo "  funnel-off   Stop publishing"
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
	@$(UV) run lockbox serve --port $(PORT) --reload

# Prints a freshly generated token. Required before exposing the app publicly.
serve-token:
	@echo ">>> Serving on http://127.0.0.1:$(PORT) with token auth"
	@$(UV) run lockbox serve --port $(PORT) --auth token --reload

# ==============================================================================
# Remote access
# ==============================================================================
#
# Service workers and WebAuthn both need a secure context, so a plain-HTTP LAN
# address silently disables offline mode and biometric unlock. Tailscale issues
# a real Let's Encrypt certificate, which is why these targets exist at all.

tailnet:
	@echo ">>> Sharing with your tailnet over HTTPS"
	@tailscale serve --bg $(PORT)
	@echo ""
	@echo "Only devices signed into your tailnet can reach this."
	@echo "Tailscale authenticates them, so --auth none is fine here."

tailnet-url:
	@tailscale status --json \
	  | $(PYTHON) -c "import json,sys; print('https://' + json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))"

tailnet-off:
	@echo ">>> Stopping tailnet sharing"
	@tailscale serve --https=443 off

# Publishes to the whole internet. Warns when the API is unauthenticated but
# does not block: this is a demo, and how long it stays exposed is your call.
funnel:
	@if curl -sf -o /dev/null --max-time 5 http://127.0.0.1:$(PORT)/api/info 2>/dev/null; then \
		echo ""; \
		echo "  WARNING: /api/info answered without a token."; \
		echo "  Anyone who finds this URL can read, write and delete every note."; \
		echo "  Use 'make serve-token' if it will be up for more than a moment."; \
		echo ""; \
	fi
	@tailscale funnel --bg $(PORT)
	@echo ""
	@echo "PUBLIC. Stop it with 'make funnel-off'."

funnel-off:
	@echo ">>> Stopping Funnel"
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
