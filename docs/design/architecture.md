# Architecture

Lockbox is three independent layers stacked on a deliberately dumb server. Each layer
solves one problem and knows as little as possible about the others.

```mermaid
flowchart TB
    subgraph browser["Browser"]
        UI["React UI<br/>4 pages, sidebar shell"]
        CRYPTO["crypto.ts<br/>envelope encryption"]
        DB["db.ts<br/>IndexedDB: vault / notes / outbox"]
        SYNC["sync.ts<br/>outbox drain, 2 modes"]
        SW["sw.js<br/>service worker"]
    end

    subgraph server["FastAPI server"]
        PAPI["/api/plain-notes<br/>readable"]
        EAPI["/api/notes<br/>ciphertext"]
        INFO["/api/info"]
        PSTORE["RecordStore[PlainNote]<br/>data/notes.plain.json"]
        ESTORE["RecordStore[EncryptedNote]<br/>data/notes.json"]
    end

    UI --> CRYPTO
    UI --> DB
    CRYPTO --> DB
    DB --> SYNC
    SYNC -->|"plaintext mode: decrypt then PUT"| PAPI
    SYNC -->|"encrypted mode: PUT ciphertext"| EAPI
    SYNC -->|"reachability probe"| INFO
    PAPI --> PSTORE
    EAPI --> ESTORE
    SW -.->|"precached shell"| UI
    SW -.->|"never intercepts /api/*"| PAPI
```

The critical property of that diagram: **ciphertext crosses every boundary inside the
browser**. IndexedDB and the outbox handle opaque blobs, always, in both modes. What
differs is only what happens at the network boundary.

!!! info "Where the plaintext boundary sits"
    | Mode | IndexedDB | Outbox | Wire | Server |
    | --- | --- | --- | --- | --- |
    | **plaintext** (default) | ciphertext | ciphertext | readable (over TLS) | readable |
    | **encrypted** (demo) | ciphertext | ciphertext | ciphertext | ciphertext |

    The default is plaintext because the target is DHIS2, and a shared-data platform
    cannot use records encrypted under a per-user passphrase. See
    [DHIS2 Context](../context/dhis2.md) for the full argument.

## The three layers

### 1. PWA shell — "the app exists without a network"

A hand-rolled service worker precaches the app shell (HTML, CSS, JS, icons, manifest) and
serves it cache-first. Navigations are network-first with a cached-shell fallback, so a
deployed update is picked up when online but the app still boots when it is not.

`/api/*` is never cached and never intercepted. See [Service Worker](service-worker.md).

The Argon2id WASM ships inside the main JS bundle, so it is precached with everything else
and the vault still opens with no network at all.

### 2. Offline sync — "writes survive without a network"

IndexedDB is the source of truth, not the server. Every local write is applied to the
`notes` store and appended to the `outbox` queue in the same logical operation. The sync
engine drains the outbox whenever the server is reachable, in whichever mode is selected.
See [Offline Sync](offline-sync.md).

### 3. Encryption at rest — "the local data is useless without the passphrase"

A random 256-bit AES-GCM data encryption key (DEK) encrypts each note. The DEK is wrapped
by a key encryption key (KEK) derived from the passphrase with Argon2id. Only the wrapped
DEK, its salt, the wrap IV and the KDF parameters are persisted. See
[Encryption](encryption.md).

## The app shell and its pages

Navigation is plain component state, not a router — four sibling pages with no deep-linking
requirement do not justify a routing dependency.

```mermaid
flowchart LR
    APP["App.tsx<br/>vault state, lock/unlock"] --> LAYOUT["AppLayout<br/>collapsible sidebar,<br/>theme toggle, status popover"]
    LAYOUT --> N["Notes<br/>the working demo"]
    LAYOUT --> K["KDF Lab<br/>Argon2id vs PBKDF2"]
    LAYOUT --> S["Sync Modes<br/>plaintext vs encrypted"]
    LAYOUT --> R["At Rest<br/>raw IndexedDB dump"]
```

| Page | Source | What it demonstrates |
| --- | --- | --- |
| Notes | `pages/NotesPage.tsx` | Offline writes, the outbox, sync badges |
| KDF Lab | `pages/KdfLabPage.tsx` | `benchmarkKdf()` timing both algorithms on this device, with tunable memory and iteration counts |
| Sync Modes | `pages/SyncModesPage.tsx` | `setMode()` plus `fetchServerState()`, printing both server stores raw and side by side |
| At Rest | `pages/StoragePage.tsx` | `vault`, `notes` and `outbox` read straight from IndexedDB with no decryption |

The shell itself carries a lock button, a light/dark theme toggle, toast notifications
(`sonner`) and a status popover summarising what is held offline and whether persistence
was granted.

## Data flow for a write

This is the path a single "save note" click takes, offline, then what happens later when
connectivity returns. The upload branch is where the two modes diverge.

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant UI as React UI
    participant C as crypto.ts
    participant DB as IndexedDB
    participant S as sync.ts
    participant API as FastAPI

    U->>UI: Save note {title, body}
    UI->>C: encryptJson({title, body})
    Note over C: fresh random 12-byte IV,<br/>AES-256-GCM with session DEK
    C-->>UI: {iv, ciphertext}
    UI->>DB: putNote({id, iv, ciphertext, createdAt, updatedAt, synced:false})
    UI->>DB: enqueue("put", id, payload)
    Note over DB: payload is the complete<br/>encrypted record - self-contained
    UI-->>U: Note visible immediately (optimistic)

    rect rgba(120,144,220,0.12)
    Note over S,API: later, when connectivity returns
    S->>API: GET /api/info (reachability probe)
    API-->>S: 200 {name, version, noteCount, plainNoteCount}

    alt plaintext mode (default)
        S->>S: is the vault unlocked?
        Note over S: locked means blockedByLock, then stop -<br/>a designed constraint, not a failure
        S->>C: decryptJson(payload)
        C-->>S: {title, body}
        S->>API: PUT /api/plain-notes/{id} with readable title and body
        API-->>S: 200 PlainNote
    else encrypted mode (demonstration)
        Note over S: no key needed, works while locked
        S->>API: PUT /api/notes/{id} with ciphertext
        API-->>S: 200 EncryptedNote
    end

    S->>DB: dequeue(seq), then markNoteSynced(id)
    end
```

Three things in that diagram matter more than they look:

- **The write is acknowledged to the user before any network call.** The UI never waits
  on the server. Offline is the normal case, not the error case.
- **The outbox payload is the full encrypted record**, not a note id to be re-read later.
  The queue is therefore self-contained: replaying it never has to re-read the `notes`
  store, and in encrypted mode it never has to decrypt anything either.
- **Decryption happens at the last possible moment**, inside `sendEntry()`, and only in
  plaintext mode. That single line is what makes plaintext sync require an unlocked vault.

```typescript
if (mode === 'plaintext') {
    // Requires the DEK, hence the unlocked-vault precondition.
    const content = await decryptJson<NoteContent>(payload)
    body = {
        id: payload.id,
        title: content.title,
        body: content.body,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
    }
}
```

`sync.ts` never imports the vault directly. It is handed a predicate via
`setUnlockedCheck()`, so it can only decrypt when the app has explicitly given it the
ability — which makes the constraint impossible to bypass by accident.

## Data flow for an unlock

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant UI as React UI
    participant DB as IndexedDB
    participant C as crypto.ts

    UI->>DB: getVault()
    DB-->>UI: {salt, wrapIv, wrappedDek, kdf, params, createdAt}
    U->>UI: passphrase
    UI->>C: unlockVault(passphrase, vault)
    Note over C: vaultKdf() reads the recorded algorithm,<br/>Argon2id (64 MiB, t=3, p=1) by default
    C->>C: unwrapKey(wrappedDek, KEK)
    alt correct passphrase
        C-->>UI: true (DEK held in memory, non-extractable)
        UI->>DB: getNotes() -> decryptJson each
    else wrong passphrase
        Note over C: AES-GCM auth tag fails
        C-->>UI: false
    end
```

There is no stored password hash. The authentication tag on the wrapped DEK *is* the
passphrase check. A vault record with no `kdf` field predates Argon2id and is treated as
PBKDF2, so older vaults still open.

## The object stores

IndexedDB database `lockbox`, version 1, three object stores:

| Store | Key | Contents | Encrypted? |
| --- | --- | --- | --- |
| `vault` | fixed key `"default"` | `{salt, wrapIv, wrappedDek, kdf, params, createdAt}` | Not secret — inert without the passphrase |
| `notes` | `id` (keyPath), index on `updatedAt` | `{id, iv, ciphertext, createdAt, updatedAt, synced}` | `ciphertext` only |
| `outbox` | `seq` (autoIncrement), index on `status` | `{seq, op, noteId, payload, status, attempts, lastError, queuedAt}` | `payload` carries ciphertext |

```typescript
request.onupgradeneeded = () => {
    const db = request.result

    if (!db.objectStoreNames.contains(STORE_VAULT)) {
        db.createObjectStore(STORE_VAULT)
    }
    if (!db.objectStoreNames.contains(STORE_NOTES)) {
        const notes = db.createObjectStore(STORE_NOTES, { keyPath: 'id' })
        notes.createIndex('updatedAt', 'updatedAt')
    }
    if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, {
            keyPath: 'seq',
            autoIncrement: true,
        })
        outbox.createIndex('status', 'status')
    }
}
```

The **At Rest** page renders exactly this, unmodified, so the claim can be checked rather
than taken on trust.

!!! note "What is deliberately left in the clear"
    Note ids, `createdAt`, `updatedAt` and `synced` are plaintext. The app has to index
    and order on them without unlocking — the note list renders (as locked placeholders)
    and, in encrypted mode, the outbox drains while the vault is closed. The cost is a
    metadata leak: an attacker with the device learns *that* a note existed at time T, and
    how many, but not what it said. This is the fundamental trade of field-level
    encryption; see
    [Trade-offs](../context/trade-offs.md#field-level-vs-whole-database-encryption).

## The server

The server is intentionally the least interesting component. It is two JSON-file stores
behind two parallel APIs, sharing one generic implementation:

```python
class RecordStore[T: NoteBase]:
    """Thread-safe, last-write-wins store of notes of a single shape.

    Generic over the record type so the same logic serves both the encrypted
    blob store and the plaintext (DHIS2-style) store.
    """

    def __init__(self, path: Path, model: type[T]) -> None:
        ...
```

```python
store = RecordStore(encrypted_file, EncryptedNote)          # data/notes.json
plain_store = RecordStore(plain_file, PlainNote)            # data/notes.plain.json
```

The plaintext file is derived as a sibling of the encrypted one
(`encrypted_file.with_suffix(".plain" + suffix)`), so a single `--data-file` option
configures both.

Upsert is last-write-wins on `updated_at`, identical for both shapes:

```python
def put(self, note: T) -> T:
    with self._lock:
        existing = self._notes.get(note.id)
        if existing is not None and existing.updated_at > note.updated_at:
            return existing
        self._notes[note.id] = note
        self._flush()
        return note
```

The encrypted store genuinely cannot decrypt anything — it never receives key material.
The plaintext store reads everything, which is the whole point of it. Neither has any
authentication; see [API Reference](../reference/api.md).

Writes are flushed atomically (`tmp.write_text(...)` then `tmp.replace(path)`) so a crash
mid-write cannot truncate the file.

## Request and response shapes

The wire models live in `src/lockbox/schemas.py`. `NoteBase` holds what both shapes share,
and the two concrete models add the part that differs:

```python
class NoteBase(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=128)
    created_at: int = Field(alias="createdAt", ge=0)
    updated_at: int = Field(alias="updatedAt", ge=0)


class EncryptedNote(NoteBase):
    iv: str = Field(min_length=1, max_length=64)
    ciphertext: str = Field(min_length=1, max_length=1_000_000)


class PlainNote(NoteBase):
    title: str = Field(min_length=1, max_length=1_000)
    body: str = Field(default="", max_length=100_000)
```

That the id and timestamps sit in the shared base is not an accident of refactoring: they
are exactly the fields that must be readable by the server in *either* mode, so it can
store, order and de-duplicate records.

Python snake_case internally, camelCase on the wire via Pydantic aliases. `iv` and
`ciphertext` are base64url. Timestamps are milliseconds since the epoch, from the *client*
clock — the server never generates one, because the client is the source of truth.

Full endpoint documentation is in the [API Reference](../reference/api.md).
