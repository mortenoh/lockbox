# Roadmap

Honest, prioritised, and explicit about what is *not* built. Everything below is
unimplemented unless marked otherwise.

Effort is rough calendar effort for one developer already familiar with the codebase:
**S** ≈ hours, **M** ≈ a day or two, **L** ≈ a week or more.

## Recently completed

Two significant items have landed and are no longer roadmap material.

!!! success "Done: Argon2id key derivation"
    Argon2id via `hash-wasm` is now the **default KDF for all new vaults** — 64 MiB,
    `t = 3`, `p = 1`. The WASM ships inside the app bundle and is precached, so unlock works
    fully offline. The vault record stores `{kdf, params}`, `vaultKdf()` treats a record
    with no `kdf` field as PBKDF2 so pre-existing vaults still open, and
    `changePassphrase()` takes a `kdf` argument so migrating a PBKDF2 vault is the same
    O(1) re-wrap as a passphrase change.

    `benchmarkKdf()` and the **KDF Lab** page time both algorithms on the actual device.
    PBKDF2 at 600k iterations is retained only for legacy vaults and as the comparison arm.

    **Follow-up, and it is a real one:** the measured times on the dev machine are
    132–146 ms for Argon2id and 54–67 ms for PBKDF2 — both *below* the 250–500 ms
    interactive target, meaning the parameters should be raised. Doing that properly means
    benchmarking on a low-end Android tablet first. See
    [Encryption](../design/encryption.md#benchmark-on-the-device-not-on-the-guidance).

!!! success "Done: two sync modes, with plaintext as the default"
    `SyncMode = 'plaintext' | 'encrypted'` in `sync.ts`, default `'plaintext'`, persisted in
    `localStorage` and switchable at runtime. Two parallel backend APIs
    (`/api/plain-notes` and `/api/notes`) backed by a generic `RecordStore[T: NoteBase]`,
    with `/api/info` reporting both counts and `lockbox dump` printing both stores.

    This corrected the project's central framing: encryption is **local-only**, because a
    per-user passphrase cannot govern data a shared platform must validate, aggregate and
    share. See [DHIS2 Context](dhis2.md#the-per-user-passphrase-problem).

    The honest consequence — plaintext sync requires an unlocked vault — is implemented and
    surfaced as `blockedByLock` rather than hidden.

## Priority 1 — the gaps that undermine current claims

### Automated tests for the TypeScript layer

**Effort: M · The single biggest gap in the project, and now the only Priority 1 item that has not moved.**

The Python backend has **21 passing tests**. The crypto and sync layers — which is where all
the difficulty and all the security-relevant logic lives — have **no automated tests at
all**. Every claim on the [Encryption](../design/encryption.md) and
[Offline Sync](../design/offline-sync.md) pages currently rests on manual verification.

The Argon2id and sync-mode work made this worse, not better: there is more logic to get
wrong now, and none of it is covered.

What is needed:

- **Crypto unit tests** (Vitest, with `happy-dom`/`jsdom` plus a real Web Crypto): round-trip
  encrypt/decrypt; wrong passphrase rejected; passphrase change preserves note readability;
  **a PBKDF2 vault migrates to Argon2id and still opens**; **`vaultKdf()` defaults a
  legacy record to PBKDF2**; tampered ciphertext throws rather than returning garbage; IVs
  are unique across many encryptions; the session key is genuinely non-extractable.
- **Sync unit tests** with a mocked `fetch`: FIFO ordering preserved; a transient failure
  stops the drain; a permanent failure parks the entry and continues; backoff grows and is
  clamped at 60s; re-entry guard holds when triggers fire concurrently;
  **plaintext mode hits `/api/plain-notes` and encrypted mode hits `/api/notes`**;
  **a locked vault blocks a plaintext drain and does not block an encrypted one**.
- **Playwright e2e**, codifying what is currently manual: create vault → write offline with
  the server killed → restart → verify drain; verify IndexedDB contains no plaintext in
  *either* mode; verify `data/notes.plain.json` does contain plaintext and
  `data/notes.json` does not.

The last one is worth automating precisely because it is the project's headline claim, and
the claim is now more nuanced than it was.

### Content-Security-Policy hardening

**Effort: S · Directly mitigates the biggest documented weakness.**

XSS is the one attack that defeats the whole design ([Threat Model](../design/threat-model.md)),
and there is currently no CSP at all. Add a strict policy: no `unsafe-inline`, no
`unsafe-eval`, `default-src 'self'`, nonce-based scripts if any inline script survives the
Vite build. Consider Trusted Types. Cheap, and it moves the needle more than any
cryptographic change on this page.

Note the WASM: a strict policy needs `'wasm-unsafe-eval'` in `script-src` for Argon2id to
instantiate, which is a narrower grant than `'unsafe-eval'` and is the right one to use.

### Auto-lock on inactivity

**Effort: S**

The DEK currently stays in memory until the tab is closed or Lock is pressed. A laptop left
open in a clinic is unlocked indefinitely. Add a configurable idle timeout (default 5–15
minutes) that calls `lockVault()`, driven by input/visibility events.

This matters **more** now than it did. Plaintext sync requires an unlocked vault, so the
practical incentive is to leave it unlocked while the queue drains, which widens exactly
the window auto-lock is meant to close. The timeout needs to be generous enough that a sync
started at the end of a shift can complete, and the blocked-by-lock state needs to be
legible enough that a user understands why a re-lock stalled the queue.

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

**Effort: M–L**

Optional unlock via Touch ID / Windows Hello / passkey, using the WebAuthn PRF extension
to produce stable key material for a second KEK over the same DEK. Passphrase or recovery
code stays the recoverable root. Feature-detect and degrade silently — Windows Hello PRF
support is still weak. See [Trade-offs: unlock UX](trade-offs.md#unlock-ux).

Doubly worth it now: a fast biometric unlock takes most of the pain out of the
unlocked-vault requirement that plaintext sync imposes.

### Raise the KDF parameters after benchmarking on real hardware

**Effort: S**

The mechanism is done; the tuning is not. Argon2id at 64 MiB / t=3 measures 132–146 ms on
an Apple Silicon laptop, comfortably under the 250–500 ms target, so the cost should go up.
Run the KDF Lab on the weakest supported device — a low-end Android tablet — and pick from
those numbers. Because the parameters live in the vault record, existing vaults keep
opening at their old cost and can be re-wrapped at the new one via `changePassphrase()`.

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

**Effort: S**

The current rule is a plain 4xx/5xx split. Retry **408** and **429** (honouring
`Retry-After`), and treat **401/403** as "refresh credentials and retry" once there is
authentication. See [Offline Sync](../design/offline-sync.md#error-classification).

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

## Priority 3 — beyond the single-user demo

### A real backend with authentication

**Effort: L**

There is deliberately none today, and this now matters more than it used to: the plaintext
store holds readable health-shaped data, so "anyone who can reach the server reads
everything" is no longer merely a metadata leak. Real users, sessions, per-user
authorisation, rate limiting, and a database instead of a JSON file. It also changes the
error-classification story (401/403 become retryable-after-refresh).

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
| Argon2id KDF (default, params in vault, migration path) | — | M | ✅ **done** |
| Two sync modes, plaintext default, two backend APIs | — | M | ✅ **done** |
| TS crypto/sync unit tests + e2e | 1 | M | ❌ **biggest gap** — backend has 21 tests, TS layer has none |
| CSP hardening | 1 | S | ❌ |
| Auto-lock on inactivity | 1 | S | ❌ |
| Recovery codes | 1 | M | ❌ |
| WebAuthn PRF unlock | 2 | M–L | ❌ |
| Raise KDF parameters after real-device benchmarking | 2 | S | ⚠️ measured too fast on the dev machine |
| Background Sync (encrypted mode only) | 2 | S–M | ❌ |
| Conflict / failure UI | 2 | M | ⚠️ minimal |
| Refined error classification (408/429) | 2 | S | ⚠️ 4xx/5xx split only |
| Incremental pull | 2 | M | ❌ full-table pull |
| Metadata as AES-GCM AAD | 2 | S | ❌ |
| Backend with authentication | 3 | L | ❌ deliberately none |
| Blind indexing / encrypted search | 3 | L | ❌ |
| Multi-device key sharing | 3 | L | ❌ |
| Per-record DEKs | 3 | L | ❌ |
| Key rotation | 3 | M–L | ❌ |
| Multi-device conflict resolution | 3 | L | ⚠️ LWW only |
| Move to Dexie | 4 | M | ❌ raw IndexedDB |
| `vite-plugin-pwa` | 4 | S | ❌ hand-rolled |
| Storage pressure handling | 4 | S | ⚠️ reported, not warned |
