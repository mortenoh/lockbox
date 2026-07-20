# API reference

The HTTP surface is small on purpose. There are **two parallel note APIs**, one for each
sync mode, so the two strategies can be compared directly against the same client:

- **`/api/plain-notes`** stands in for a real DHIS2 backend. It receives readable data,
  which is the only thing that works when a server must validate, aggregate and share
  records between users. This is what the default sync mode uses.
- **`/api/notes`** receives opaque ciphertext. Useful for demonstrating what end-to-end
  encryption would cost, and unusable for DHIS2's actual purpose.

Both families expose the same verbs with the same idempotency semantics; only the body
shape differs.

!!! warning "Authentication is optional and shared, not per-user"
    Two modes, selected at startup (`--auth none|token`, or `make serve` / `make serve-token`):

    | Mode | Behaviour |
    | --- | --- |
    | **`none`** (default) | No credentials. Correct only for `127.0.0.1`. |
    | **`token`** | Every `/api/*` call needs `Authorization: Bearer <token>`. The app shell and `/sw.js` stay public. |

    Token mode stops a publicly reachable deployment being an open endpoint. It is **not**
    per-user auth: one shared secret, no expiry, and the client-declared `author` field is
    still forgeable by anyone who holds the token. A real DHIS2 integration delegates
    identity to the platform session. See [Remote Access](remote-access.md).

Interactive OpenAPI docs are available at `/docs` and `/redoc` while the server is running.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | The app shell (`index.html`) |
| `GET` | `/sw.js` | The service worker, rendered from a Jinja template |
| `GET` | `/api/info` | Server identity and both note counts; the reachability probe |
| `GET` | `/api/plain-notes` | All stored notes, readable |
| `PUT` | `/api/plain-notes/{note_id}` | Upsert one readable note (idempotent) |
| `DELETE` | `/api/plain-notes/{note_id}` | Tombstone one readable note (idempotent, 204) |
| `GET` | `/api/notes` | All stored notes, encrypted |
| `PUT` | `/api/notes/{note_id}` | Upsert one encrypted note (idempotent) |
| `DELETE` | `/api/notes/{note_id}` | Tombstone one encrypted note (idempotent, 204) |

Everything else under `/` is served from the built frontend by a `StaticFiles` mount with
`html=True`, so unknown paths fall back to the app shell — what a single-page app wants.
The mount is registered **last**, because Starlette matches in registration order and a
catch-all would otherwise swallow `/api` and `/sw.js`.

---

### `GET /`

Serves the built `index.html` from `src/lockbox/static/`. Not part of the OpenAPI schema.

---

### `GET /sw.js`

The service worker. Rendered from `src/lockbox/templates/sw.js` with two injected values:

| Variable | Value |
| --- | --- |
| `cache_version` | First 12 hex chars of a SHA-256 over every static asset's path and contents |
| `shell_assets` | JSON array of URLs to precache, enumerated from disk |

**Response headers**

```http
Content-Type: text/javascript
Cache-Control: no-cache
Service-Worker-Allowed: /
```

`Cache-Control: no-cache` is required — a cached worker script could never be replaced, so
the app could never update itself. Served from the root because a worker's scope is limited
to its own path and below. See [Service Worker](../design/service-worker.md).

Excluded from the OpenAPI schema (`include_in_schema=False`).

---

### `GET /api/info`

Server identity and note counts. The client uses this as its reachability probe — a real
round trip, because `navigator.onLine` cannot be trusted.

**Response** `200 OK` — `ServerInfo`

```json
{
  "name": "lockbox",
  "version": "0.1.0",
  "noteCount": 3,
  "plainNoteCount": 3
}
```

```python
@app.get("/api/info", response_model=ServerInfo)
async def info() -> ServerInfo:
    """Report server identity and note counts. Used as a reachability probe."""
    return ServerInfo(
        name="lockbox",
        version=__version__,
        note_count=store.count(),
        plain_note_count=plain_store.count(),
    )
```

`noteCount` is the encrypted store, `plainNoteCount` the readable one. Both come from
`store.count()`, which counts only live records — a tombstoned (deleted) note is excluded,
so the counts track what a user would actually see, not how many rows the JSON file holds.
They are independent — switching sync mode does not migrate anything, so a client that has
used both will have records in both.

!!! tip "Always fetched with `cache: 'no-store'`"
    A cached 200 would report a server that is not there as reachable. The service worker
    also refuses to intercept `/api/*` for the same reason.

---

## The plaintext API

The DHIS2-realistic path, and what the default sync mode uses.

### `GET /api/plain-notes`

Every stored note in readable form, oldest first (by `createdAt`) — **tombstones included**.
This is a full-table pull, and the client needs deleted rows to converge, so the endpoint
passes `include_deleted=True`. A tombstone arrives as an ordinary record carrying
`"deleted": true`; the client applies it by removing its local copy.

**Response** `200 OK` — `PlainNoteList`

```json
{
  "notes": [
    {
      "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
      "title": "Facility visit",
      "body": "12 doses administered",
      "author": "amina",
      "createdAt": 1763640000000,
      "updatedAt": 1763640120000,
      "deleted": false
    }
  ]
}
```

```python
@app.get("/api/plain-notes", response_model=PlainNoteList)
async def list_plain_notes() -> PlainNoteList:
    """Return every stored note in readable form.

    Any authorised user gets the same readable data - which is the point.
    A per-user passphrase must never influence what lands here, or the
    records stop being shareable.
    """
    return PlainNoteList(notes=plain_store.list(include_deleted=True))
```

That docstring is the whole architectural argument compressed into three lines. See
[DHIS2 Context](../context/dhis2.md).

---

### `PUT /api/plain-notes/{note_id}`

Upsert one readable note, the way a DHIS2 data value would arrive. The path id must equal
the body id.

**Request body** — `PlainNote`

```json
{
  "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
  "title": "Facility visit",
  "body": "12 doses administered",
  "author": "amina",
  "createdAt": 1763640000000,
  "updatedAt": 1763640120000
}
```

The client sends `author` (see [`sendEntry`](../design/offline-sync.md#sending-one-entry));
it omits `deleted`, which defaults to `false`. Deletes go through `DELETE`, not a PUT with
`"deleted": true`.

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | Upserted. Body is the stored `PlainNote` — which may be the *existing* record if it had a newer `updatedAt` |
| `400` | Path id and body id do not match |
| `422` | Body failed schema validation — e.g. an empty `title`, which `min_length=1` rejects |

The client produces this body by decrypting the queued ciphertext at the moment of upload,
which is why plaintext sync requires an unlocked vault. See
[Offline Sync](../design/offline-sync.md#sending-one-entry).

!!! note "422 is newly reachable"
    Under `/api/notes` the server has no opinion about the content, because it cannot read
    it. Here it validates, which means a queued write can be permanently rejected for a
    reason the user could actually fix. The outbox classifies that as a permanent failure
    and parks it.

---

### `DELETE /api/plain-notes/{note_id}`

Tombstone one readable note. This does **not** remove the row: the store sets `deleted =
True` and stamps a fresh `updated_at`, so the deletion is a dated record that other devices
can pull and apply. A hard removal would be invisible to every other client, which would
keep its copy forever.

**Response** `204 No Content`, always — including for an id that does not exist.

```python
@app.delete("/api/plain-notes/{note_id}", status_code=204)
async def delete_plain_note(note_id: str) -> Response:
    """Tombstone one readable note. Idempotent."""
    plain_store.delete(note_id, int(time.time() * 1000))
    return Response(status_code=204)
```

The `int(time.time() * 1000)` is the tombstone's `when` in epoch milliseconds. See
[Idempotency](#idempotency-in-both-families) for why the store bumps `updated_at` rather
than simply recording that timestamp.

---

## The encrypted API

The demonstration path. Structurally identical, opaque bodies.

### `GET /api/notes`

Every stored note, still encrypted, oldest first (by `createdAt`) — **tombstones included**,
the same as the plaintext endpoint (`include_deleted=True`). A tombstone here carries the
same `iv`/`ciphertext` it had when live, plus `"deleted": true`.

**Response** `200 OK` — `NoteList`

```json
{
  "notes": [
    {
      "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
      "iv": "kZ8Qw1nT9xLp2vBa",
      "ciphertext": "9mS1cQ...truncated...ZQ",
      "createdAt": 1763640000000,
      "updatedAt": 1763640120000,
      "deleted": false
    }
  ]
}
```

This is a **full-table pull**, used by the client's `pull()`. Fine for a demo; an
incremental cursor is on the [Roadmap](../context/roadmap.md).

---

### `PUT /api/notes/{note_id}`

Upsert one encrypted note. The path id must equal the body id.

**Request body** — `EncryptedNote`

```json
{
  "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
  "iv": "kZ8Qw1nT9xLp2vBa",
  "ciphertext": "9mS1cQ...truncated...ZQ",
  "createdAt": 1763640000000,
  "updatedAt": 1763640120000
}
```

`deleted` may be omitted on input (it defaults to `false`); deletes go through `DELETE`.

**Responses**

| Status | Meaning |
| --- | --- |
| `200` | Upserted. Body is the stored `EncryptedNote` — which may be the *existing* record if it had a newer `updatedAt` |
| `400` | Path id and body id do not match |
| `422` | Body failed schema validation |

```python
@app.put("/api/notes/{note_id}", response_model=EncryptedNote)
async def put_note(note_id: str, note: EncryptedNote) -> EncryptedNote:
    """Upsert one encrypted note.

    PUT with a client-generated id makes this idempotent, which is what lets
    the client's outbox retry safely after a dropped connection.
    """
    if note_id != note.id:
        raise HTTPException(status_code=400, detail="Note id in path and body must match")
    return store.put(note)
```

---

### `DELETE /api/notes/{note_id}`

Tombstone one note. As with the plaintext endpoint the row is kept, marked `deleted = True`
with a fresh `updated_at`, so the deletion travels to other devices on their next pull.

**Response** `204 No Content`, always — including for an id that does not exist.

```python
@app.delete("/api/notes/{note_id}", status_code=204)
async def delete_note(note_id: str) -> Response:
    """Tombstone one note. Deleting an unknown id is not an error."""
    store.delete(note_id, int(time.time() * 1000))
    return Response(status_code=204)
```

---

## Idempotency, in both families

!!! note "Idempotency is the point"
    The id is generated by the client (`crypto.randomUUID()`), so replaying a queued
    upload after a dropped connection is an overwrite, never a duplicate. This is what
    makes the outbox safe. See [Offline Sync](../design/offline-sync.md#idempotency).

**Last-write-wins:** both stores keep whichever version has the newer `updatedAt`. A stale
retry therefore cannot clobber a newer record — the server returns the existing one
instead, with a `200`.

Returning 404 from `DELETE` for an unknown id would break the outbox: a delete that
succeeded but whose response was lost would be retried, get a 404, be classified as a
permanent 4xx failure, and be parked in front of the user as an error. It is not an error —
the note is gone, which is what was asked for.

### Deletes are tombstones, not row removals

A `DELETE` does not drop the record. `RecordStore.delete(note_id, when)` keeps the row,
sets `deleted = True`, and stamps a new `updated_at`:

```python
def delete(self, note_id: str, when: int) -> bool:
    with self._lock:
        existing = self._notes.get(note_id)
        if existing is None or existing.deleted:
            return False
        self._notes[note_id] = existing.model_copy(
            update={"deleted": True, "updated_at": max(when, existing.updated_at + 1)}
        )
        self._flush()
        return True
```

A dated tombstone is what lets deletion converge across devices. A hard removal would be
invisible to every other client — each would keep its copy indefinitely, and an older queued
PUT could even resurrect the record. Keeping the tombstone means the same last-write-wins
rule that settles edits also settles deletions: the list endpoints return the tombstone
(`include_deleted=True`), and each client's `pull()` sees `"deleted": true` and removes its
local copy.

The `updated_at` is set to `max(when, existing.updated_at + 1)`, not simply to `when`. The
`when` a `DELETE` handler passes is the *server's* clock, while every other timestamp in the
system is a *client* clock, and the two need not agree. Bumping to at least `existing + 1`
guarantees the tombstone is strictly newer than the record it deletes, so it wins the
last-write-wins comparison even if the server clock lags the client that wrote the note. Any
later PUT still has to beat that value to un-delete, which is the intended behaviour.

Because tombstones live in the store, `count()` (and therefore `/api/info`) excludes them,
while the pull endpoints include them — the counts reflect what a user sees, the pulls
reflect what a client must converge on.

## Schemas

### `NoteBase`

The shared base. These are exactly the fields the server needs in the clear in *either*
mode, so it can store, order and de-duplicate records.

```python
class NoteBase(BaseModel):
    """Fields every note shares regardless of whether the body is encrypted."""

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=128)
    created_at: int = Field(alias="createdAt", ge=0)
    updated_at: int = Field(alias="updatedAt", ge=0)
    # Tombstone marker: a delete keeps a dated row so other devices converge.
    deleted: bool = False
```

| Field | Wire name | Type | Description |
| --- | --- | --- | --- |
| `id` | `id` | string, 1–128 | Client-generated UUID. Doubles as the idempotency key |
| `created_at` | `createdAt` | int ≥ 0 | Client clock, epoch milliseconds |
| `updated_at` | `updatedAt` | int ≥ 0 | Client clock, epoch milliseconds. Drives last-write-wins |
| `deleted` | `deleted` | bool, default `false` | Tombstone marker. `true` on a deleted record; settled by the same last-write-wins rule. Always present on the wire; a `DELETE` is how it becomes `true` |

Python snake_case internally, camelCase on the wire via Pydantic aliases (`deleted` has no
alias — it is spelled the same either way). `populate_by_name=True` means both spellings are
accepted on input.

!!! warning "Timestamps come from the client, and the client's clock may be wrong"
    The server never generates a timestamp, because the client is the source of truth and
    a note may have been written days before it syncs. The cost is that conflict resolution
    depends on client clocks — acceptable for a single device, not for several. See
    [Offline Sync](../design/offline-sync.md#conflict-resolution).

### `PlainNote`

```python
class PlainNote(NoteBase):
    """A note in readable form - what DHIS2 would actually store.

    The client decrypts at the moment of sync and sends this. Confidentiality on
    the wire is TLS's job; confidentiality at rest on the server is the
    platform's job, under its own access-control rules.
    """

    title: str = Field(min_length=1, max_length=1_000)
    body: str = Field(default="", max_length=100_000)
    # Self-declared author, plaintext by necessity so other users see authorship.
    author: str = Field(default="unknown", min_length=1, max_length=100)
```

| Field | Wire name | Type | Description |
| --- | --- | --- | --- |
| `title` | `title` | string, 1–1,000 | Readable note title. Required and non-empty |
| `body` | `body` | string, 0–100,000 | Readable note body. Defaults to `""` |
| `author` | `author` | string, 1–100 | Who wrote it. Defaults to `"unknown"`. Plaintext by necessity — other users need to see authorship, which is exactly the kind of shared-context field that cannot survive per-user encryption. **Self-declared and forgeable** under shared-token auth (see the authentication note at the top); in a real deployment this would be the DHIS2 session user, not a client-supplied string |

### `EncryptedNote`

```python
class EncryptedNote(NoteBase):
    """A note the server stores but cannot read."""

    iv: str = Field(min_length=1, max_length=64)
    ciphertext: str = Field(min_length=1, max_length=1_000_000)
```

| Field | Wire name | Type | Description |
| --- | --- | --- | --- |
| `iv` | `iv` | string, 1–64 | Base64url 12-byte AES-GCM initialization vector, unique per encryption. **Not secret** |
| `ciphertext` | `ciphertext` | string, 1–1,000,000 | Base64url AES-256-GCM ciphertext, including the 16-byte auth tag. Plaintext is `{"title": ..., "body": ...}` |

The `ciphertext` cap of 1,000,000 base64url characters is roughly 730 KB of plaintext.

### `PlainNoteList` and `NoteList`

```python
class NoteList(BaseModel):
    """Response body for a full pull of the server's encrypted notes."""

    notes: list[EncryptedNote]


class PlainNoteList(BaseModel):
    """Response body for a full pull of the server's plaintext notes."""

    notes: list[PlainNote]
```

### `ServerInfo`

```python
class ServerInfo(BaseModel):
    """Small health/identity payload, handy for connectivity checks."""

    model_config = ConfigDict(serialize_by_alias=True)

    name: str
    version: str
    note_count: int = Field(serialization_alias="noteCount")
    plain_note_count: int = Field(serialization_alias="plainNoteCount")
```

## Storage format

`RecordStore[T: NoteBase]` is generic over the record shape, so one implementation backs
both APIs. The app factory creates two instances:

```python
encrypted_file = data_file or DEFAULT_DATA_FILE        # data/notes.json
# Sits beside the encrypted store, e.g. data/notes.plain.json.
plain_file = encrypted_file.with_suffix(".plain" + encrypted_file.suffix)

store = RecordStore(encrypted_file, EncryptedNote)
plain_store = RecordStore(plain_file, PlainNote)
```

A single `--data-file` option therefore configures both — the plaintext path is derived
from it.

`data/notes.json`:

```json
{
  "notes": [
    {
      "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
      "iv": "kZ8Qw1nT9xLp2vBa",
      "ciphertext": "9mS1cQ...",
      "createdAt": 1763640000000,
      "updatedAt": 1763640120000,
      "deleted": false
    }
  ]
}
```

`data/notes.plain.json`:

```json
{
  "notes": [
    {
      "id": "0f3a5c1e-8b21-4d7a-9f10-2c6e5b7a4d33",
      "title": "Facility visit",
      "body": "12 doses administered",
      "author": "amina",
      "createdAt": 1763640000000,
      "updatedAt": 1763640120000,
      "deleted": false
    }
  ]
}
```

Tombstoned rows stay in these files with `"deleted": true` — which is why `cat`-ing a store
can show more rows than `/api/info` counts.

JSON files are chosen precisely because they are trivial to `cat` and compare — the
contrast between those two blocks is the project's central point, visible in ten seconds.
Writes go through a temp file and an atomic `replace()`, so a crash cannot truncate a
store, and all access is guarded by a `threading.Lock`.

Rows that fail validation on load are skipped rather than crashing the server — a corrupted
record should not take the whole store down.

Use `uv run lockbox dump` to print both stores at once; see [Development](development.md).
