# Roadmap

Honest, prioritised, and explicit about what is *not* built. Everything below is
unimplemented unless marked otherwise.

Effort is rough calendar effort for one developer already familiar with the codebase:
**S** ≈ hours, **M** ≈ a day or two, **L** ≈ a week or more.

## Recently completed

Listed because several Priority 1 and 2 items have moved, and a stale roadmap is
worse than none.

| Item | Notes |
| --- | --- |
| **Automated tests for the TypeScript layer** | 48 Playwright tests against a real browser rather than jsdom with a fake IndexedDB. Several are named regressions for bugs that shipped. |
| **Vitest unit layer for sync + crypto** | 42 fast unit tests (`crypto.test.ts`, `sync.test.ts`, `encoding.test.ts`) covering the drain state machine, HTTP classification, outbox reconcile, and the crypto round-trip helpers. |
| **CI and docs publishing** | Three GitHub Actions workflows: lint/type/test/e2e (`ci.yml`), a committed-bundle freshness guard (`frontend-bundle.yml`), and MkDocs to GitHub Pages (`docs.yml`). |
| **Drain-then-pull sync cycle** | Every automatic trigger runs `runSyncCycle`: drain the outbox, then pull. Pull reconciles against the outbox, closing the race where a pull could overwrite unsent local work. |
| **Refined HTTP error classification** | 401/403 handled as auth (drain stops, token cleared, entries stay pending); 408/429 treated as transient, honouring `Retry-After`. |
| **Argon2id as the default KDF** | Replaced PBKDF2, which is retained for legacy vaults and as the comparison arm in the KDF Lab. |
| **KDF parameters raised, then calibrated** | 64 → 128 MiB as the ceiling, chosen from six measured candidates; vault creation now calibrates down a ladder (to OWASP's 19 MiB floor) on slow or low-RAM devices. |
| **WebAuthn PRF unlock** | The same DEK wrapped a second time under authenticator-derived key material. Verified on real hardware only — see below. |
| **Auto-lock on inactivity** | Timestamp-based, so a sleeping device notices on wake. |
| **Multiple users per device** | Vaults keyed per user, notes keyed `[ownerId, id]`. |
| **Deletions converge** | Dated tombstones, applied on pull. |
| **Automatic pull** | Remote changes arrive without a manual press. |
| **Routing** | `HashRouter`, so a reload returns to the page you were on. |
| **Token authentication** | Two modes, `none` and `token`, with the API gated by middleware. |
| **Self-healing from a bricked client** | Layered recovery so a blank page can never require DevTools. |

## Priority 1 — the gaps that undermine current claims

### Fast unit tests for crypto and sync

**Done — a Vitest suite now runs in well under a second.**

The **Vitest** layer exists: **42** tests across `frontend/src/lib/crypto.test.ts`,
`sync.test.ts` and `encoding.test.ts`, alongside the 48 Playwright e2e tests and the
**36** backend pytest tests.

- **Crypto** (`crypto.test.ts`): round-trip encrypt/decrypt with a fresh IV per call, wrong
  passphrase rejected, passphrase change preserves note readability, a PBKDF2 vault migrates
  to Argon2id and still opens, `vaultKdf()` defaults a legacy record to PBKDF2, tampered
  ciphertext throws, and the calibration ladder (`pickArgon2idParams` / `calibrateKdfParams`).
- **Sync** (`sync.test.ts`): HTTP classification (401/403 auth, 408/429 transient honouring
  `Retry-After`); `decideRemoteApply` reconciliation; and the drain state machine —
  re-entrancy, stop-on-first-transient (FIFO), park-and-continue on a permanent 422,
  mid-drain auth handling, mode routing to `/api/notes` vs `/api/plain-notes`, locked-vault
  blocking of the plaintext drain, pull reconcile, and drain-before-pull ordering.

Two items from the original wishlist remain genuinely uncovered by the unit layer: the
backoff growth-and-clamp-at-60s curve, and an explicit assertion that the session key is
non-extractable. Neither is high value — both are exercised indirectly elsewhere.

### Content-Security-Policy hardening

**Effort: S · Directly mitigates the biggest documented weakness.**

XSS is the one attack that defeats the whole design ([Threat Model](../design/threat-model.md)),
and there is currently no CSP at all. Add a strict policy: no `unsafe-inline`, no
`unsafe-eval`, `default-src 'self'`, nonce-based scripts if any inline script survives the
Vite build. Consider Trusted Types. Cheap, and it moves the needle more than any
cryptographic change on this page.

Note the WASM: a strict policy needs `'wasm-unsafe-eval'` in `script-src` for Argon2id to
instantiate, which is a narrower grant than `'unsafe-eval'` and is the right one to use.

### Recovery codes

**Effort: M**

Today a forgotten passphrase means permanently unreadable local data, with no mitigation
whatsoever. Generate a high-entropy recovery code at vault creation, derive a second KEK
from it, wrap the *same* DEK under it, and store the second envelope. Display it once for
the user to write down.

In plaintext mode the blast radius is bounded — already-synced records still exist readable
on the server, so the loss is the unsynced queue. For a device that has been in the field
all day, that is still a day's work.

This is the envelope pattern paying for itself, and it is the same mechanism the Argon2id
migration already uses.

## Priority 2 — meaningful capability

### WebAuthn PRF unlock

**Done — verified on real hardware only.**

Optional unlock via Touch ID / Windows Hello / passkey is implemented, using the WebAuthn
PRF extension to derive stable key material for a second KEK that wraps the same DEK — a
second envelope stored as the vault's `prf` field. The passphrase stays the recoverable
root. The path feature-detects and degrades silently where PRF is unavailable (Windows
Hello support remains weak), which is also why it is exercised on real hardware rather than
in CI. See [Trade-offs: unlock UX](trade-offs.md#unlock-ux).

### Re-benchmark KDF parameters on the weakest target device

**Done — superseded by on-device calibration.**

Vault creation now runs `calibrateKdfParams()`: a timed probe picks the strongest tier of
a parameter ladder (128 MiB / t=3 ceiling down to OWASP's 19 MiB / t=2 floor, in
`frontend/src/lib/config.ts`) that the device can derive within a 1 s unlock budget, with
a `navigator.deviceMemory` cap and allocation-failure fallback for 1-2 GB phones.
Parameters live in the vault record, so existing vaults keep their cost and can be
re-wrapped via `changePassphrase()`.

### Background Sync API as progressive enhancement

**Effort: S–M**

Register a `sync` tag on enqueue and flush from the service worker so the queue drains with
the tab closed. **Chromium-only** — no Safari, no Firefox — so the existing foreground
triggers must remain complete on their own and this can only ever be a bonus.

!!! note "It can only ever help the encrypted mode"
    A service worker has no access to the page's in-memory DEK, so it cannot decrypt, so it
    cannot produce a plaintext upload. Background flushing and the DHIS2-realistic path are
    mutually exclusive by construction. That narrows the value of this item considerably
    and is a good argument for keeping it below the tests and the CSP.

### Conflict and failure UI

**Effort: M**

`status: "failed"` entries are parked and counted, and `discardEntry()` exists, but the
user-facing surface is minimal. Needs a real queue inspector: what failed, why, when, with
retry / edit / discard actions. A silently parked write is a lost write.

Plaintext mode raises the stakes: the server now validates *content*, so a record can be
rejected with a 422 for reasons the user could actually fix, which makes an editable
failure queue considerably more useful than it was under opaque ciphertext.

### Refine error classification

**Done.**

`classify()` replaces the plain 4xx/5xx split. **408** and **429** are transient and honour
`Retry-After`; other 4xx remain permanent and 5xx transient. **401/403** are classified as
auth: the drain stops, the stored token is cleared, and the affected entries stay pending
rather than being parked, so they retry once credentials are refreshed. See
[Offline Sync](../design/offline-sync.md#error-classification).

### Incremental pull

**Effort: M**

`pull()` fetches the entire note list every time. Add a cursor
(`GET /api/notes?since=<cursor>`) plus tombstones for deletes. Necessary before the dataset
is anything other than tiny.

### Authenticate the metadata

**Effort: S**

`updatedAt`, `createdAt` and `id` sit outside the ciphertext and are therefore
unauthenticated — in encrypted mode a malicious server can reorder or replay records
undetectably. Pass them as AES-GCM **additional authenticated data** so tampering breaks
decryption. Small change, closes a real hole. It requires a ciphertext format version
field, since existing records were not encrypted with AAD.

Applies to the encrypted mode and to local storage integrity only; in plaintext mode the
server holds readable records and integrity there is the platform's concern.

### Design pass via Claude Design
**Effort: M · Sequenced after reviewer feedback, deliberately.**

Every UI defect found so far — a keypad that jumped mid-entry, a
double-submittable button, a native `window.confirm`, an access-token field for
authentication that was not enabled — was found by looking at the running app,
not by the test suite. That is not a gap the suite can close: whether an element
belongs on a page is not a question it asks.

[claude.ai/design](https://claude.ai/design) hosts design-system projects that
can be annotated directly, with the `DesignSync` tool and `/design-sync` skill
keeping a local component library in sync. Mechanically:

1. Build preview HTML per component into a local bundle directory.
2. `finalize_plan` locks the exact paths to be written — the user reviews that
   list before anything uploads.
3. `write_files` reads from disk and uploads; contents never pass through the
   model's context.
4. Cards appear in the Design System pane for annotation.
5. Changes come back **one component at a time**, never as a wholesale replace.

It points at a local directory. No repository, no archive, no upload step.

!!! note "Better fit for the component library than the pages"
    This is built around a component library, which maps cleanly onto the 14
    files in `frontend/src/components/ui/`. The five app pages are compositions
    with live state behind them, so they would sync only as static snapshots and
    the annotate-then-change loop would be weaker for them.

    The `/design-sync` skill also may need installing before any of this works.

**Why after review, not before:** reviewers are likely to push on structure, and
polishing a layout that then gets rebuilt wastes the effort twice.

### Base UI migration — considered and declined
**Effort: M · Recommendation: do not do this. Recorded so it is not re-litigated.**

shadcn/ui made Base UI its default in July 2026. The project remains on Radix,
and that is a deliberate choice rather than neglect:

- shadcn's own changelog is explicit — *"Radix is not being deprecated… You do
  not need to migrate… We still run it in production today and we're not
  migrating."*
- `radix-ui` is actively maintained, publishing 1.6.4 the same month.
- Of the 14 components here, **six have no primitive dependency at all**. Only
  `alert-dialog`, `button`, `badge`, `dropdown-menu`, `label`, `popover`,
  `separator` and `tooltip` would change.
- There is no codemod. The official path is an agent skill, migrating one
  component and its usages at a time.

The break is real where it applies: `asChild` becomes `render`, overlays
decompose into `Portal → Positioner → Popup`, and animation data attributes
differ. Non-zero risk for no user-visible gain.

One point in this project's favour if it is ever revisited: the style preset is
`radix-nova`, which has a direct `base-nova` counterpart, so migrating would not
also drag the visual design onto a different preset. Projects on `new-york` have
no such equivalent.

Worth doing on a *new* project, where `bunx shadcn init` now selects Base UI
anyway.

## Priority 3 — beyond the single-user demo

### Per-user backend authentication

**Effort: L**

A shared bearer token (`--auth token`) is enough to stop a public URL being open, and is
implemented. What is still missing is **per-user** identity: sessions, org-unit scoping,
rate limiting, and a database instead of a JSON file. The plaintext store holds readable
health-shaped data, so a stolen shared token still reads everything. The client already
classifies 401/403 as auth (stop, clear token, keep entries pending); real per-user auth is
what gives that path teeth, turning it into a genuine refresh-credentials-and-retry loop.

For a genuine DHIS2 integration this item is mostly moot — DHIS2 already provides all of
it, and the right move is to use it rather than reimplement it. See
[DHIS2 Context](dhis2.md#what-a-real-dhis2-integration-would-look-like).

### Encrypted-field search via blind indexing

**Effort: L**

Store `HMAC-SHA256(indexKey, normalize(value))` alongside each record to enable exact-match
lookup without decryption. Supports equality only — no prefix, range or fuzzy — and being
deterministic it leaks which records share a value, so truncate the index to create
deliberate collisions on low-cardinality fields. See
[Trade-offs](trade-offs.md#the-middle-ground-blind-indexing).

### Multi-device key sharing

**Effort: L**

Getting the same DEK onto a second device without the server ever seeing it. Options: a QR
code carrying the DEK wrapped under an ephemeral key, or an ECDH handshake between devices.
Every design here has sharp edges; the envelope at least makes the *mechanism* (wrap the
same DEK under another KEK) straightforward.

Lower priority than it once looked. With local-only encryption, a second device does not
need the first device's key — it encrypts its own local store under its own passphrase and
syncs plaintext like everything else. Multi-device key sharing is a requirement of the
encrypted mode, which is the demonstration path.

### Per-record DEKs

**Effort: L**

One DEK per record, each wrapped under the master DEK. Enables selective sharing and
per-record revocation, and bounds the damage from any single key compromise. Adds a wrapped
key to every record and a second unwrap to every read.

### Key rotation

**Effort: M–L**

Rotating the *DEK* — unlike rotating the passphrase or the KDF — genuinely requires
re-encrypting every note. Needs to be resumable and crash-safe, since a field device will
lose power halfway through. Ties into per-record DEKs, which make it incremental rather
than all-or-nothing.

### Real multi-device conflict resolution

**Effort: L**

Last-write-wins on client `updatedAt` is only defensible because this is single-user,
single-device. With two devices it silently discards edits based on clock skew. Options in
increasing order of cost: server-assigned monotonic versions or hybrid logical clocks;
per-field LWW; surfacing conflicts to the user; a CRDT. See
[Offline Sync](../design/offline-sync.md#conflict-resolution).

Single-device pull-vs-outbox races are already handled: the pull reconcile pass
(`decideRemoteApply`) drops a queued put superseded by a remote tombstone and refuses to
resurrect a note whose local delete is still pending, so a pull never overwrites unsent
local work. Cross-device LWW remains exactly as described above — reconcile settles one
device's own queue against the server, not two devices' edits against each other.

Note the asymmetry the sync modes introduce: in plaintext mode the server *can* merge, run
validation rules and apply domain logic — which is exactly what DHIS2 does, and a large
part of why the mode exists. In encrypted mode it cannot, and all resolution must be
client-side.

## Priority 4 — engineering hygiene

### Move to Dexie if the schema grows

**Effort: M**

Raw IndexedDB is fine for three object stores. Past that, hand-rolled `onupgradeneeded`
migrations get unpleasant fast. Dexie's schema versioning, query API and live queries are
worth ~25 KB. `idb` (~1.2 KB) is the smaller intermediate step and would delete
`promisify()` and `withStore()` outright. See
[Trade-offs: storage](trade-offs.md#local-storage-layer).

### Adopt `vite-plugin-pwa`

**Effort: S**

The hand-rolled service worker was built to be read, and it has served that purpose. For
anything real, `vite-plugin-pwa` generates a revisioned precache manifest and wires in
Workbox's tested strategies. Keep `sw.js` in the repo as documentation.

### Per-asset precache revisions

**Effort: S** — subsumed by the above. The current whole-bundle hash re-downloads the
entire shell when one byte changes. Irrelevant at this size; wrong at a larger one.

### Storage pressure handling

**Effort: S**

`navigator.storage.persist()` is requested and the **At Rest** page reports whether it was
granted, but nothing warns when it was refused. Report remaining quota via
`navigator.storage.estimate()`, and warn loudly when there are unsynced notes and
persistence was denied — that combination is how a day's fieldwork disappears.

## Summary

| Item | Priority | Effort | Status |
| --- | --- | --- | --- |
| Argon2id KDF (default, params in vault, migration path) | — | M | **done** |
| Two sync modes, plaintext default, two backend APIs | — | M | **done** |
| Playwright e2e (browser, 48) | — | M | **done** |
| Auto-lock on inactivity | — | S | **done** |
| WebAuthn PRF unlock | — | M–L | **done** (real hardware only in CI terms) |
| Multiple users per device | — | M | **done** |
| Shared bearer token (`none` / `token`) | — | S | **done** (not per-user) |
| KDF params raised 64 → 128 MiB | — | S | **done**, with per-device calibration down a ladder |
| Vitest unit tests for crypto + sync | 1 | M | **done** (42 tests) |
| CSP hardening | 1 | S | no |
| Recovery codes | 1 | M | no |
| Re-benchmark KDF on weakest field device | 2 | S | partial: laptop done |
| Background Sync (encrypted mode only) | 2 | S–M | no |
| Conflict / failure UI | 2 | M | partial: minimal |
| Refined error classification (408/429/401) | 2 | S | **done** |
| Incremental pull | 2 | M | no: full-table pull |
| Metadata as AES-GCM AAD | 2 | S | no |
| Per-user backend authentication | 3 | L | no: shared token only |
| Blind indexing / encrypted search | 3 | L | no |
| Multi-device key sharing | 3 | L | no |
| Per-record DEKs | 3 | L | no |
| Key rotation | 3 | M–L | no |
| Multi-device conflict resolution | 3 | L | partial: LWW only |
| Move to Dexie | 4 | M | no: raw IndexedDB |
| `vite-plugin-pwa` | 4 | S | no: hand-rolled |
| Storage pressure handling | 4 | S | partial: reported, not warned |
