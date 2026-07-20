# Lockbox

**Offline-first PWA with local encryption at rest.** A learning project, not a product.

Lockbox is a small notes app that exists to answer one question properly:

> If a health worker enters data offline on a laptop in the field, and that laptop is
> stolen, what does the thief get?

The answer for most offline-first web apps today is: *everything*. IndexedDB is a plain
file in the browser profile. Copy the profile, open the database, read the records. There
is no lock on it.

Lockbox is the smallest honest implementation of a better answer — the records in
IndexedDB are AES-256-GCM ciphertext, the key that decrypts them is derived from a
passphrase the user types each session with Argon2id, and it is never written to disk
anywhere.

## The correction that shapes everything else

An earlier version of this project encrypted the data *all the way to the server*, and
presented that as the goal. That framing was wrong for the target, and the project has been
corrected. It is worth stating the reasoning up front, because it is the central insight.

The target is [DHIS2](https://dhis2.org), a shared health-data platform. Every user of the
PWA chooses their **own** passphrase. If uploads were encrypted under a per-user key, then:

- each record would be readable by exactly one person — the person who wrote it,
- DHIS2's server-side validation, aggregation and analytics would all break, because none
  of them can run over ciphertext,
- and DHIS2's own sharing and access-control rules — which are the *actual governing
  mechanism* for this data — would become meaningless.

The data on the server is **supposed** to be readable by multiple authorised users. That is
not a weakness of the platform, it is the point of the platform.

!!! success "So encryption here is deliberately local-only"
    Lockbox encrypts **IndexedDB on the device**. That is its entire scope, and it is the
    part the web platform genuinely leaves unsolved.

    - **At rest on the device** → Lockbox's envelope encryption. Protects a lost or stolen laptop.
    - **In transit** → TLS. Not Lockbox's job.
    - **At rest on the server** → the platform's access control, and whatever server-side
      encryption it has. Not Lockbox's job, and not something a per-user client key could
      provide anyway.

### The cost, stated honestly

Uploading readable data means **decrypting at the moment of upload**, which means:

!!! warning "Plaintext sync requires an unlocked vault"
    In the default (plaintext) mode the sync engine must decrypt each queued record before
    sending it, so a locked vault stops sync dead. The UI surfaces this as a designed
    constraint rather than an error.

    In encrypted mode sync works while locked — the outbox holds self-contained ciphertext
    and nothing needs a key — but the data that arrives is useless to the platform. That
    trade-off is real and the app lets you switch between the two to see it.

## What it does

- Create a vault with a passphrase (Argon2id), unlock it to read notes.
- Support multiple users on one device — each with their own passphrase and key.
- Write notes while completely offline (kill the server process — it still works).
- Queue every write in an outbox and sync automatically when the server comes back: the
  outbox drains, then remote changes are pulled (drain-then-pull), on each trigger.
- Store nothing but ciphertext in IndexedDB, always.
- Sync in one of two selectable modes: **plaintext** (default, DHIS2-realistic) or
  **encrypted** (demonstration).
- Compare Argon2id and PBKDF2 on the actual device, with tunable parameters.
- Dump the raw contents of IndexedDB to prove no plaintext is present.

## The five pages

The app is a multi-page shell with a collapsible left sidebar. Each page isolates one idea.

| Page | What it is for |
| --- | --- |
| **Notes** | The working demo: create, edit, delete, offline, outbox, sync status |
| **KDF Lab** | Live Argon2id vs PBKDF2 benchmark with tunable memory and iterations |
| **Sync Modes** | Switch modes and view both server stores side by side |
| **At Rest** | Raw IndexedDB dump — vault, notes, outbox — with no decryption |
| **Security** | Biometric (WebAuthn PRF) enrolment, auto-lock, optional API token |

## What it deliberately does not do

!!! warning "Read the threat model before drawing conclusions"
    Local encryption protects a **lost or powered-off device**. It does **not** protect a
    running session: an XSS bug in the page can read the live in-memory key. It also makes
    no claim about server-side confidentiality — in the default mode the server holds
    readable data *by design*. Auth is optional shared-token only (not per-user), multiple
    users can share one browser profile with separate vaults, and there is no passphrase
    recovery. See [Threat Model](design/threat-model.md).

## Quickstart

Requires [uv](https://docs.astral.sh/uv/) and Python 3.13.

```bash
make install          # uv sync --all-groups
make serve            # http://127.0.0.1:8000
```

Then open <http://127.0.0.1:8000>, create a vault with a passphrase, and write a note.

To see what the server actually holds, in both modes at once:

```bash
uv run lockbox dump
```

```text
=== Encrypted sync mode - server cannot read these ===
1 note(s) at data/notes.json:

{
  "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
  "iv": "kZ8Qw1nT9xLp2vBa",
  "ciphertext": "9mS1c...truncated...Q",
  "createdAt": 1763640000000,
  "updatedAt": 1763640000000
}

=== Plaintext sync mode (DHIS2-realistic) - readable, as it must be ===
1 note(s) at data/notes.plain.json:

{
  "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
  "title": "Facility visit",
  "body": "12 doses administered",
  "createdAt": 1763640000000,
  "updatedAt": 1763640000000
}
```

The contrast is the whole point. The left-hand store is what end-to-end encryption would
give you and what DHIS2 could do nothing with. The right-hand store is what a real
integration produces — and IndexedDB on the device is ciphertext in both cases.

!!! tip "Service workers need a secure context"
    `localhost` counts as secure; a plain-HTTP LAN address does not. Test on localhost
    or put TLS in front of it.

## The stack

**Backend** — Python 3.13, FastAPI, Pydantic, Jinja2, Typer, `uv` + `uv_build`, src layout.

```text
src/lockbox/
├── api.py            # FastAPI app factory, both note APIs, asset hashing
├── schemas.py        # NoteBase / EncryptedNote / PlainNote / ServerInfo
├── store.py          # RecordStore[T], JSON-file, last-write-wins
├── cli.py            # typer: serve, dump, version
├── templates/
│   └── sw.js         # hand-rolled service worker (Jinja template)
└── static/           # built frontend, emitted here by Vite
    ├── index.html
    ├── assets/       # content-hashed JS/CSS bundles
    ├── icon.svg
    └── manifest.webmanifest
```

**Frontend** — React 19 + TypeScript + Vite + Tailwind v4 + shadcn/ui in `frontend/`,
built into `src/lockbox/static/`. Collapsible sidebar, light/dark theme, toast
notifications, and a status popover showing what is stored offline. The interesting parts
are three modules in `frontend/src/lib/`:

| Module | Responsibility |
| --- | --- |
| `crypto.ts` | Envelope encryption over Web Crypto: Argon2id/PBKDF2 KEK derivation, DEK wrap/unwrap, record encrypt/decrypt, KDF benchmarking |
| `db.ts` | IndexedDB: the `vault`, `notes` and `outbox` object stores |
| `sync.ts` | The outbox drain loop, the pull and outbox reconcile pass, the two sync modes, reachability probing, backoff, triggers |

## Where to go next

<div class="grid cards" markdown>

- **[Architecture](design/architecture.md)** — the layers, the two sync modes, and how a write flows through them.
- **[Encryption](design/encryption.md)** — envelope encryption, KEK/DEK, Argon2id parameters, KDF migration.
- **[Offline Sync](design/offline-sync.md)** — the outbox pattern, both modes, idempotency, error classification, backoff.
- **[Threat Model](design/threat-model.md)** — what this defends against, precisely, and where the boundary of responsibility sits.
- **[DHIS2 Context](context/dhis2.md)** — why per-user encrypted upload is incompatible with a shared-data platform.
- **[Trade-offs](context/trade-offs.md)** — every library and approach considered, with recommendations.

</div>
