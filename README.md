# Lockbox

**An offline-first PWA that encrypts data at rest in the browser — and is honest about
what that does and does not protect.**

A learning project exploring three things that interact awkwardly: progressive web apps,
offline-first sync, and client-side cryptography. Notes are encrypted before they touch
IndexedDB, queued while offline, and pushed to a server when connectivity returns.

The motivating scenario is [DHIS2](https://dhis2.org)-style field data entry: health
workers capture data offline on laptops and tablets, it syncs later, and a lost device
should not hand over readable records.

> **Not production software.** This exists to make a set of trade-offs legible. Where it
> falls short, it says so — in the docs, in the code comments, and below.

## Quickstart

Requires [uv](https://docs.astral.sh/uv/). No Node needed — the frontend is committed
pre-built.

```bash
make install
make serve        # http://127.0.0.1:8000
```

Create a user, pick a PIN, write a note. Then kill the server and reload the page: the app
still loads, still unlocks, and queues new notes until the server returns.

To rebuild the frontend (requires [pnpm](https://pnpm.io)):

```bash
make build-frontend
```

## The design decision worth arguing about

**Encryption here is local-only, and that is deliberate.**

Every user of the PWA sets their own PIN. If uploads were encrypted with a key derived
from it, each record would be readable by exactly one person — server-side validation,
aggregation and analytics would break, and DHIS2's own sharing rules, which are the actual
governing mechanism for this data, would become meaningless.

So the boundary is drawn at the device:

| Layer | Protected by |
|---|---|
| IndexedDB on the device | **This project** — AES-256-GCM under a PIN-derived key |
| Data in transit | TLS |
| Data on the server | The platform's access control |

The cost, stated plainly: plaintext uploads must decrypt first, so **syncing requires an
unlocked vault**. The alternative — `encrypted` mode, switchable in the app — keeps syncing
while locked but hands the backend bytes it cannot use. Both ship, so the trade-off is
visible rather than asserted.

## Threat model

✅ **A lost or stolen device, for local data.** An attacker with the browser profile finds
ciphertext, a salt, and a wrapped key. Nothing else.

⚠️ **Synced data is only as protected as the server credential.** In plaintext mode the
server holds readable records, so anyone with a valid API token can fetch them without the
PIN. The token is memory-only by default for exactly this reason.

⚠️ **A 4-digit PIN is ~10,000 guesses.** At roughly 130 ms per Argon2id evaluation, a thief
with the device exhausts that in under half an hour. The PIN protects the device's local
cache, not the dataset. Biometric unlock is materially stronger, because the authenticator
rate-limits in hardware — something a browser cannot do.

❌ **Not a compromised running session.** XSS can use the live in-memory key. Anything
reachable from JavaScript at runtime is reachable by injected JavaScript.

❌ **Not end-to-end encryption**, and not protection from the server operator. By design.

❌ **No PIN recovery.** Forgetting it makes local data permanently unreadable. Synced
records remain recoverable by signing in again and pulling.

## What it demonstrates

**Envelope encryption.** A random 256-bit AES-GCM *data encryption key* (DEK) encrypts each
note. The DEK is wrapped by a *key encryption key* derived from the PIN with **Argon2id**
(64 MiB, 3 passes) via `hash-wasm`. Only the salt, wrap IV and wrapped DEK are persisted —
all inert without the secret. The DEK lives in memory as a non-extractable `CryptoKey`.

A wrong PIN is detected for free: it yields a KEK that fails AES-GCM's authentication tag
during unwrap, so there is no stored password hash to attack. Changing the PIN — or
migrating a vault from PBKDF2 to Argon2id — re-wraps one 32-byte key rather than
re-encrypting every note.

**Biometric unlock (WebAuthn PRF).** The same DEK wrapped a second time under key material
from a platform authenticator. Either envelope opens it, and enrolling touches no notes.

**Offline-first sync.** IndexedDB is the source of truth. Writes append to an outbox drained
FIFO on reconnect. Uploads are `PUT`s keyed by a client-generated UUID, so retries are
idempotent. 4xx is permanent (parked for the user), 5xx and network errors retry with
backoff. Deletions propagate as dated tombstones.

**PWA.** A hand-rolled service worker — not Workbox, because the mechanics are the point.
App shell cache-first, `/api/*` never intercepted, and a cache name carrying a content hash
of the built assets so a change can't serve stale code forever.

## The five pages

| Page | What it shows |
|---|---|
| **Notes** | The working demo — write, queue, sync |
| **KDF Lab** | Argon2id vs PBKDF2 benchmarked live on your hardware |
| **Sync Modes** | Switch modes and inspect both server stores side by side |
| **At Rest** | Raw IndexedDB — the encryption claim, demonstrated |
| **Security** | Biometric enrolment, auto-lock, server token |

## Testing on a phone

Service workers and WebAuthn both require a **secure context**, so a plain-HTTP LAN address
silently breaks offline mode and Touch ID. [Tailscale](https://tailscale.com) gives you real
HTTPS with a Let's Encrypt certificate:

```bash
uv run lockbox serve --port 8321
tailscale serve --bg 8321          # tailnet only
```

For public exposure, add authentication **first** — see
[Remote Access](docs/reference/remote-access.md), which also covers the Funnel ACL grant and
a misleading CLI error worth knowing about.

## Stack

**Backend** — Python 3.13, FastAPI, Pydantic, Typer, uv, src layout
**Frontend** — React 19, TypeScript, Vite, Tailwind 4, shadcn/ui, hash-wasm
**Docs** — MkDocs Material

```
src/lockbox/       FastAPI app, schemas, record store, CLI
  templates/sw.js  service worker (server-templated cache version + asset list)
  static/          built frontend (generated, committed)
frontend/src/lib/  crypto.ts, db.ts, sync.ts, webauthn.ts — the interesting parts
docs/              MkDocs site
tests/             pytest suite (backend)
```

## Documentation

```bash
make docs         # http://127.0.0.1:8001
```

Includes a [beginner's guide to the Web Crypto API](docs/guide/web-crypto.md) that builds
from `getRandomValues` up to the envelope scheme used here, plus
[architecture](docs/design/architecture.md),
[encryption design](docs/design/encryption.md),
[offline sync](docs/design/offline-sync.md),
[threat model](docs/design/threat-model.md),
[DHIS2 context](docs/context/dhis2.md),
a survey of [alternatives](docs/context/trade-offs.md) (Argon2id, WebAuthn PRF, Dexie, RxDB,
SQLCipher, Workbox, Replicache/Zero), and a [roadmap](docs/context/roadmap.md).

## Known gaps

Listed because a project about honest trade-offs should be honest about itself.

- **No frontend tests.** All coverage is backend. The crypto, IndexedDB, multi-user
  isolation, outbox and service-worker layers have none — and that is where every bug found
  so far has lived. Top of the roadmap.
- **KDF parameters are probably too low** for fast hardware. The KDF Lab measured Argon2id
  at ~130 ms on an Apple Silicon laptop, below the 250–500 ms target. Benchmark on the
  weakest device you must support.
- **No automatic pull.** The outbox drains on its own, but changes made on another device
  need a manual *Pull from server*.
- **Authorship is self-declared** and forgeable. A real integration would derive it from an
  authenticated session server-side.
- **Metadata is not encrypted** — note ids, timestamps and sync state are readable. That is
  the price of the outbox draining while locked, and it is a real leak.

## Development

```bash
make lint          # ruff + mypy + pyright
make test          # pytest
make lint-frontend # oxlint
```

## Licence

BSD-3-Clause.
