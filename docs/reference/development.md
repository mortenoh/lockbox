# Development

## Prerequisites

- **Python 3.13** and [uv](https://docs.astral.sh/uv/)
- **Node + [pnpm](https://pnpm.io)** for the frontend

## Make targets

```bash
make install         # uv sync --all-groups
make lint            # ruff format, ruff check --fix, mypy, pyright
make test            # pytest -q
make test-e2e        # Playwright browser end-to-end tests
make coverage        # coverage run + report + xml
make serve           # uv run lockbox serve --reload  ->  http://127.0.0.1:8000
make serve-token     # same, but requiring a bearer token (AUTH=token)
make build-frontend  # pnpm install --frozen-lockfile && pnpm build -> src/lockbox/static
make lint-frontend   # oxlint over frontend/
make docs            # serve this documentation with live reload
make docs-build      # build the documentation site into ./site
make clean           # remove caches, build output, coverage artefacts
```

`make build-frontend` and `make lint-frontend` shell into `frontend/` and drive pnpm, so
the whole workflow stays behind one set of make targets. The built frontend is committed,
so `build-frontend` is only needed after changing something under `frontend/src`.

`make lint` runs four tools, and all four must pass:

| Tool | Configuration |
| --- | --- |
| `ruff format` | double quotes, 120 columns, docstring code formatting on |
| `ruff check --fix` | `E`, `W`, `F`, `I`, `D` (pycodestyle, pyflakes, isort, pydocstyle) — Google docstring convention |
| `mypy` | `disallow_untyped_defs`, `warn_return_any`, `strict_equality` |
| `pyright` | `typeCheckingMode = "strict"` |

## Project layout

```text
.
├── src/lockbox/          # Python package (src layout, uv_build)
│   ├── api.py            # app factory, routes, asset hashing
│   ├── schemas.py        # NoteBase / EncryptedNote / PlainNote / ServerInfo
│   ├── store.py          # RecordStore[T], JSON file, last-write-wins
│   ├── cli.py            # typer CLI
│   ├── templates/sw.js   # service worker (Jinja template)
│   └── static/           # Vite build output — do not edit by hand
├── frontend/             # React 19 + TS + Vite + Tailwind v4 + shadcn/ui
│   ├── src/
│   │   ├── lib/          # crypto.ts, db.ts, sync.ts + *.test.ts — the interesting parts
│   │   ├── pages/        # Notes, KDF Lab, Sync Modes, At Rest, Security
│   │   ├── components/   # AppLayout (sidebar shell), note UI, shadcn primitives
│   │   └── hooks/        # use-notes, use-sync, use-auto-lock, …
│   └── e2e/              # Playwright browser tests
├── tests/                # pytest — backend (36)
├── docs/                 # this site
├── data/notes.json       # server-side encrypted store (gitignored)
├── data/notes.plain.json # server-side readable store (gitignored)
└── Makefile
```

## The five pages

The app is a sidebar shell with five pages, routed with `HashRouter` so each has its own
URL and a reload returns to it.

| Page | Source | What to use it for while developing |
| --- | --- | --- |
| **Notes** | `pages/NotesPage.tsx` | The working demo. Write notes offline, watch the outbox and the sync badges |
| **KDF Lab** | `pages/KdfLabPage.tsx` | Time Argon2id against PBKDF2 on this device, with tunable memory and iteration counts. Run it on the weakest target hardware before choosing parameters |
| **Sync Modes** | `pages/SyncModesPage.tsx` | Switch between plaintext and encrypted sync, and see both server stores printed raw, side by side |
| **At Rest** | `pages/StoragePage.tsx` | Raw dump of the `vault`, `notes` and `outbox` object stores with no decryption — the fastest way to check the project's headline claim |
| **Security** | `pages/SecurityPage.tsx` | Biometric enrolment, auto-lock, API token when the server requires one |

The shell (`components/AppLayout.tsx`) adds a collapsible sidebar, a lock button, a
light/dark theme toggle (`next-themes`), toast notifications (`sonner`) and a status
popover summarising what is held offline and whether storage persistence was granted.

!!! tip "Sync Modes is the page to open first"
    It is the quickest way to internalise the architecture: pick a mode, write a note on
    the Notes page, come back, refresh. One store fills with readable data, the other with
    base64url noise — and the At Rest page shows IndexedDB is ciphertext either way.

    While in plaintext mode, press Lock and watch the queue stall with a
    blocked-by-lock explanation. That is the designed constraint, not a bug.

## The frontend build

The frontend is a separate pnpm project that **builds directly into the Python package**,
so the assets ship with `pip install lockbox` and there is no separate static-file
deployment step.

```bash
make build-frontend    # or, equivalently, from frontend/:
cd frontend
pnpm install
pnpm build     # tsc -b && vite build  ->  ../src/lockbox/static/
pnpm lint      # oxlint  (make lint-frontend)
```

Argon2id comes from `hash-wasm`, whose WASM is embedded in the emitted JS bundle rather
than shipped as a separate `.wasm` asset. It is therefore precached with the app shell and
unlock works with no network at all.

The relevant Vite config:

```typescript
export default defineConfig({
    base: '/',
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': path.resolve(__dirname, './src') } },
    server: { proxy },
    build: {
        outDir: path.resolve(__dirname, '../src/lockbox/static'),
        emptyOutDir: true,
    },
})
```

!!! warning "`base: '/'`, not `'./'`"
    The service worker precaches **absolute** URLs. A relative base would emit relative
    asset paths, the precache list would not match what the browser requests, and offline
    loading would silently fail.

`emptyOutDir: true` means `src/lockbox/static/` is wiped on every build. Never put anything
there by hand.

### Two ways to run it

=== "Vite dev server (fast iteration)"

    ```bash
    make serve                    # terminal 1: the API on :8000
    cd frontend && pnpm dev       # terminal 2: Vite on :5173
    ```

    Vite proxies `/api` and `/sw.js` through to the Python process:

    ```typescript
    const target = process.env.VITE_LOCKBOX_TARGET ?? 'http://127.0.0.1:8000'
    const proxy = Object.fromEntries(
        ['/api', '/sw.js'].map((p) => [p, { target, changeOrigin: true }]),
    )
    ```

    HMR, instant feedback. **Service worker behaviour under Vite dev is not representative**
    — test offline against the built app.

=== "Built app (representative)"

    ```bash
    cd frontend && pnpm build
    make serve                    # http://127.0.0.1:8000
    ```

    This is the real thing: real precache manifest, real content hashes, real service
    worker. **Always verify offline behaviour this way.**

## Testing

```bash
make test       # pytest -q  (backend, 36)
make test-e2e   # Playwright against a real browser (48)
make coverage   # branch coverage, terminal + coverage.xml

cd frontend && pnpm test   # Vitest unit layer (42: crypto + sync + encoding)
```

!!! info "Two test layers: fast Vitest units and real-browser Playwright e2e"
    Playwright runs against real Web Crypto, IndexedDB, and the service worker — create
    vault, offline queue, both sync modes, multi-user isolation, recovery from a bricked
    client, and more. That is where most of the project’s difficulty lives, and those paths
    are no longer manual-only.

    The fast **unit** layer now exists too: a Vitest suite (**42** tests across
    `src/lib/crypto.test.ts`, `src/lib/sync.test.ts` and `src/lib/encoding.test.ts`) that
    runs in well under a second. The sync suite covers HTTP classification, outbox-vs-remote
    reconciliation, and the drain state machine (re-entrancy, FIFO-stop-on-transient,
    park-and-continue, auth handling, mode routing, locked-vault blocking, and
    drain-before-pull ordering). Run it with `cd frontend && pnpm test`.

## Continuous integration

Three GitHub Actions workflows run on every push to `main` and every pull request.

| Workflow | What it does |
| --- | --- |
| `.github/workflows/ci.yml` | Backend job: `ruff format --check`, `ruff check`, `mypy`, `pyright`, `pytest`. Frontend job: `oxlint`, `tsc --noEmit`, Vitest. E2e job: Playwright, which needs both toolchains because its `webServer` boots the backend via `uv run lockbox serve`. It mirrors `make lint`/`make test` in check mode — CI only verifies, it never formats or autofixes the tree it is judging. |
| `.github/workflows/frontend-bundle.yml` | Rebuilds the frontend and fails if the committed `src/lockbox/static` bundle does not byte-match the fresh build. |
| `.github/workflows/docs.yml` | Builds this MkDocs site and deploys it to GitHub Pages. |

!!! warning "The committed bundle is serving code — rebuild it or your change ships as a no-op"
    The built frontend is committed into `src/lockbox/static` and served from there, so
    editing anything under `frontend/src` does **nothing** until `make build-frontend`
    regenerates the bundle. `frontend-bundle.yml` exists to catch exactly that: the Vite
    build is deterministic, so CI rebuilds and diffs against the committed output, failing if
    they differ (or if the rebuild produced new hashed assets that were never committed). If
    it fails, run `make build-frontend` and commit the result.

!!! info "Docs publish automatically"
    `docs.yml` deploys to <https://mortenoh.github.io/lockbox/> on any change to `docs/` or
    `mkdocs.yml`. The `site/` directory stays gitignored — Pages is fed from the workflow
    artifact, never from a branch.

## Testing offline behaviour

Four techniques, roughly in increasing order of how much they prove.

### 1. DevTools → Application → Service Workers → Offline

Chrome DevTools, **Application** panel, **Service Workers** — tick **Offline**.

Also useful on that panel:

| Control | Use |
| --- | --- |
| **Update on reload** | Forces a new worker on every reload. Essential while iterating |
| **Bypass for network** | Ignore the worker entirely without unregistering it |
| **Unregister** | Full reset |
| **Cache Storage** | Inspect the `lockbox-<hash>` cache and confirm what was precached |

!!! tip "Verify the cache name changes"
    Change one byte of a frontend file, rebuild, reload. **Cache Storage** should show a
    new `lockbox-<hash>` entry and the old one should disappear on activation. If the hash
    does not change, cache-first will serve stale code forever — the exact bug the content
    hash exists to prevent. See [Service Worker](../design/service-worker.md#cache-versioning).

### 2. Network throttling

DevTools **Network** → throttling → **Offline**, or a custom slow profile. Better than the
service-worker toggle for testing the *sync* layer, because it exercises real `fetch`
failures and lets you watch retries and backoff. A slow-3G profile is the closest thing to
a realistic field connection.

### 3. Kill the server process

```bash
# Ctrl-C the `make serve` terminal, then keep using the app
```

**The truest test**, and the one used to verify this project. It is not a browser
simulation with its own quirks — the server genuinely is not there. The app should:

- keep loading from the service worker cache on reload,
- accept new notes, which appear immediately,
- show a growing pending count,
- drain automatically within ~30 seconds of the server coming back (or immediately on the
  `online` event).

The service worker toggle does not exercise this path as faithfully, because a browser
"offline" mode and a dead upstream fail in slightly different ways.

### 4. Inspect IndexedDB

DevTools **Application** → **Storage** → **IndexedDB** → `lockbox`.

| Store | What to check |
| --- | --- |
| `vault` | One record: `salt`, `wrapIv`, `wrappedDek`, `kdf`, `params`, `createdAt`. **No key, no passphrase** |
| `notes` | `ciphertext` is base64url noise. **No title or body text anywhere** |
| `outbox` | Queued entries with `op`, `noteId`, `payload` (ciphertext), `status`, `attempts`, `lastError` |

!!! tip "The demo, in one step"
    Write a note whose body is a memorable string, then search for that string in the
    IndexedDB viewer. Zero hits is the whole point of the project — and it holds in **both**
    sync modes, because the mode governs what leaves the device, never what rests on it.

    The **At Rest** page renders the same three stores in-app, so this can be checked
    without leaving the browser tab.

You can also drive it from the console:

```javascript
// Confirm persistence was granted
await navigator.storage.persisted()
await navigator.storage.estimate()
```

## Inspecting the server's data

`lockbox dump` prints **both** server stores, so the contrast between the two sync modes is
visible from the CLI in one command:

```bash
uv run lockbox dump
```

```text
=== Encrypted sync mode - server cannot read these ===
1 note(s) at data/notes.json:

{
  "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
  "iv": "kZ8Qw1nT9xLp2vBa",
  "ciphertext": "9mS1cQ...truncated...ZQ",
  "createdAt": 1763640000000,
  "updatedAt": 1763640120000
}

=== Plaintext sync mode (DHIS2-realistic) - readable, as it must be ===
1 note(s) at data/notes.plain.json:

{
  "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
  "title": "Facility visit",
  "body": "12 doses administered",
  "createdAt": 1763640000000,
  "updatedAt": 1763640120000
}
```

An empty store prints `(nothing at <path>)` rather than being omitted, so it is obvious
which mode has actually been exercised.

`--data-file` names the *encrypted* file; the plaintext path is derived from it by
inserting `.plain` before the suffix, so both stay in step.

!!! tip "The two greps that make the point"
    ```bash
    grep -c "12 doses" data/notes.json        # 0 — the server cannot read this
    grep -c "12 doses" data/notes.plain.json  # 1 — the server is supposed to read this
    ```

    And then the same search in the IndexedDB viewer, which returns zero hits in **both**
    cases. That is the actual claim: the device is encrypted, the server is governed by
    access control. See [Threat Model](../design/threat-model.md).

## CLI

```bash
uv run lockbox --help
```

| Command | Options | Notes |
| --- | --- | --- |
| `serve` | `--host` (default `127.0.0.1`), `--port` (`8000`), `--data-file` (`data/notes.json`), `--reload` | The plaintext store path is derived from `--data-file` |
| `dump` | `--data-file` | Prints **both** stores, encrypted first, then plaintext |
| `version` | — | |

!!! note "`--reload` uses the app factory"
    Uvicorn's reloader needs an import string rather than an app object, so with
    `--reload` it re-creates the app itself via `lockbox.api:create_app` with
    `factory=True`. A consequence: `--data-file` is not passed through in reload mode, so
    it falls back to the default.

!!! tip "Service workers require a secure context"
    `localhost` counts; a plain-HTTP LAN address does not. Testing on a phone over the LAN
    needs TLS — a tunnel such as `ngrok`, or a local certificate.

## Documentation

```bash
make docs        # live-reload server on http://127.0.0.1:8001
make docs-build  # static build into ./site
```

MkDocs with the Material theme. Mermaid diagrams work through
`pymdownx.superfences` with a `mermaid` custom fence — write them as a fenced block:

````markdown
```mermaid
flowchart LR
    A --> B
```
````

New pages must be added to the `nav:` section of `mkdocs.yml`, or MkDocs warns that they
are not in the navigation.
