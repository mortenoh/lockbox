/**
 * IndexedDB layer: the local source of truth.
 *
 * Three object stores:
 *
 *   vault  - one record per user of this device, holding that user's salt and
 *            wrapped DEK. All of it is safe to store in the clear; without the
 *            secret it is inert.
 *   notes  - encrypted note records, scoped to the user who owns them.
 *   outbox - the pending-write queue, also user-scoped. The sync engine drains
 *            only the active user's entries, because uploading in plaintext
 *            mode requires that user's key.
 *
 * Note what is deliberately NOT encrypted: note ids, timestamps, sync state and
 * the owning user id. The app needs to index and order on those without
 * unlocking, and they leak only "a note existed at this time", not its content.
 * Worth being explicit about, since it is the main honest limitation of
 * field-level encryption.
 */

import type { VaultRecord } from '@/lib/crypto'

const DB_NAME = 'lockbox'
/**
 * v2 introduced multiple vaults per device.
 * v3 made that isolation real: notes are keyed by [ownerId, id], not id alone.
 */
const DB_VERSION = 3

const STORE_VAULT = 'vault'
const STORE_NOTES = 'notes'
const STORE_OUTBOX = 'outbox'

/** Where a local record came from. Useful context the UI can label. */
export type NoteOrigin = 'local' | 'pulled'

/** An encrypted note as it rests in IndexedDB. */
export interface NoteRecord {
    id: string
    iv: string
    ciphertext: string
    createdAt: number
    updatedAt: number
    synced: boolean
    /** Which local user's key this record is encrypted under. */
    ownerId: string
    /** 'local' if written on this device, 'pulled' if fetched from the server. */
    origin?: NoteOrigin
}

/** The payload uploaded to the server (a NoteRecord minus local-only fields). */
export type NotePayload = Omit<NoteRecord, 'synced' | 'origin' | 'ownerId'>

export type OutboxOp = 'put' | 'delete'
export type OutboxStatus = 'pending' | 'failed'

/** One queued mutation awaiting upload. */
export interface OutboxEntry {
    seq: number
    op: OutboxOp
    noteId: string
    payload: NotePayload | null
    status: OutboxStatus
    attempts: number
    lastError: string | null
    queuedAt: number
    /** Only this user can upload it, since only they can decrypt it. */
    ownerId: string
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Open (and if needed create/upgrade) the database.
 *
 * The v1 -> v2 migration is worth reading: v1 stored a single vault under the
 * fixed key "default" with out-of-line keys. v2 keys vaults by an in-line `id`,
 * which means the store cannot simply be altered - it has to be read, dropped,
 * recreated with a keyPath, and repopulated. Existing notes are adopted by the
 * migrated vault so nobody loses data on upgrade.
 */
function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)

        request.onupgradeneeded = (event) => {
            const db = request.result
            const tx = request.transaction
            const oldVersion = event.oldVersion

            if (oldVersion < 1) {
                // Fresh install: create everything in its v2 shape.
                db.createObjectStore(STORE_VAULT, { keyPath: 'id' })

                // Compound key, not 'id'. Two users pulling the same server
                // record share its id, so keying on id alone let one user's
                // ciphertext overwrite the other's.
                const notes = db.createObjectStore(STORE_NOTES, { keyPath: ['ownerId', 'id'] })
                notes.createIndex('ownerId', 'ownerId')

                const outbox = db.createObjectStore(STORE_OUTBOX, {
                    keyPath: 'seq',
                    autoIncrement: true,
                })
                outbox.createIndex('ownerId', 'ownerId')
                return
            }

            if (oldVersion === 2 && tx) {
                // Rebuild the notes store with a compound key. keyPath cannot be
                // altered in place, so the records are read out, the store is
                // dropped and recreated, then repopulated.
                const legacyNotes: NoteRecord[] = []
                const cursorRequest = tx.objectStore(STORE_NOTES).openCursor()
                cursorRequest.onsuccess = (e) => {
                    const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
                    if (cursor) {
                        legacyNotes.push(cursor.value as NoteRecord)
                        cursor.continue()
                        return
                    }

                    db.deleteObjectStore(STORE_NOTES)
                    const rebuilt = db.createObjectStore(STORE_NOTES, {
                        keyPath: ['ownerId', 'id'],
                    })
                    rebuilt.createIndex('ownerId', 'ownerId')
                    for (const note of legacyNotes) {
                        if (note.ownerId) rebuilt.put(note)
                    }
                }
                return
            }

            if (oldVersion < 2 && tx) {
                const legacyId = crypto.randomUUID()

                // Read the single v1 vault before dropping its store.
                const legacyRequest = tx.objectStore(STORE_VAULT).get('default')
                legacyRequest.onsuccess = () => {
                    const legacy = legacyRequest.result as VaultRecord | undefined

                    db.deleteObjectStore(STORE_VAULT)
                    const vaults = db.createObjectStore(STORE_VAULT, { keyPath: 'id' })
                    if (legacy) {
                        vaults.put({
                            ...legacy,
                            id: legacyId,
                            owner: legacy.owner ?? 'Existing user',
                        })
                    }
                }

                // Adopt existing notes and queue entries into the migrated vault.
                const notes = tx.objectStore(STORE_NOTES)
                if (!notes.indexNames.contains('ownerId')) notes.createIndex('ownerId', 'ownerId')
                notes.openCursor().onsuccess = (e) => {
                    const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
                    if (!cursor) return
                    cursor.update({ ...cursor.value, ownerId: cursor.value.ownerId ?? legacyId })
                    cursor.continue()
                }

                const outbox = tx.objectStore(STORE_OUTBOX)
                if (!outbox.indexNames.contains('ownerId')) {
                    outbox.createIndex('ownerId', 'ownerId')
                }
                outbox.openCursor().onsuccess = (e) => {
                    const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
                    if (!cursor) return
                    cursor.update({ ...cursor.value, ownerId: cursor.value.ownerId ?? legacyId })
                    cursor.continue()
                }
            }
        }

        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })

    return dbPromise
}

/** Promise wrapper around a single IDBRequest. */
function promisify<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
    })
}

/** Run `fn` inside a transaction and resolve once the transaction commits. */
async function withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
    const db = await openDb()
    const tx = db.transaction(storeName, mode)
    const result = await fn(tx.objectStore(storeName))

    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })

    return result
}

// ---------------------------------------------------------------------------
// Vaults
// ---------------------------------------------------------------------------

/** Every user registered on this device, oldest first. */
export async function listVaults(): Promise<VaultRecord[]> {
    const vaults = await withStore(STORE_VAULT, 'readonly', (store) =>
        promisify<VaultRecord[]>(store.getAll()),
    )
    return vaults.sort((a, b) => a.createdAt - b.createdAt)
}

/** Read one user's vault material. */
export async function getVault(id: string): Promise<VaultRecord | null> {
    const vault = await withStore(STORE_VAULT, 'readonly', (store) =>
        promisify<VaultRecord | undefined>(store.get(id)),
    )
    return vault ?? null
}

/** Persist vault material (creation or secret change). */
export async function putVault(vault: VaultRecord): Promise<void> {
    await withStore(STORE_VAULT, 'readwrite', (store) => promisify(store.put(vault)))
}

/** Remove one user and everything encrypted under their key. */
export async function deleteVault(id: string): Promise<void> {
    const db = await openDb()
    const tx = db.transaction([STORE_VAULT, STORE_NOTES, STORE_OUTBOX], 'readwrite')

    tx.objectStore(STORE_VAULT).delete(id)
    for (const name of [STORE_NOTES, STORE_OUTBOX]) {
        const index = tx.objectStore(name).index('ownerId')
        index.openCursor(IDBKeyRange.only(id)).onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
            if (!cursor) return
            cursor.delete()
            cursor.continue()
        }
    }

    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/** Return one user's notes, newest first. Still encrypted. */
export async function getNotes(ownerId: string): Promise<NoteRecord[]> {
    const notes = await withStore(STORE_NOTES, 'readonly', (store) =>
        promisify<NoteRecord[]>(store.index('ownerId').getAll(IDBKeyRange.only(ownerId))),
    )
    return notes.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Every note on the device regardless of owner. For the At Rest inspector. */
export async function getAllNotes(): Promise<NoteRecord[]> {
    const notes = await withStore(STORE_NOTES, 'readonly', (store) =>
        promisify<NoteRecord[]>(store.getAll()),
    )
    return notes.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * Write a note and its outbox entry in ONE transaction.
 *
 * These were previously two separate transactions, which left a window where a
 * crash, quota error or closed tab could persist the note without the queue
 * entry - a change that would then never sync, silently. IndexedDB gives
 * multi-store atomicity for free, so there is no reason not to use it.
 */
export async function putNoteAndEnqueue(
    note: NoteRecord,
    op: OutboxOp,
    payload: NotePayload | null,
): Promise<void> {
    const db = await openDb()
    const tx = db.transaction([STORE_NOTES, STORE_OUTBOX], 'readwrite')

    tx.objectStore(STORE_NOTES).put(note)
    tx.objectStore(STORE_OUTBOX).add({
        op,
        noteId: note.id,
        ownerId: note.ownerId,
        payload,
        status: 'pending',
        attempts: 0,
        lastError: null,
        queuedAt: Date.now(),
    })

    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

/** Delete a note and queue the deletion in ONE transaction. */
export async function deleteNoteAndEnqueue(ownerId: string, id: string): Promise<void> {
    const db = await openDb()
    const tx = db.transaction([STORE_NOTES, STORE_OUTBOX], 'readwrite')

    tx.objectStore(STORE_NOTES).delete([ownerId, id])
    tx.objectStore(STORE_OUTBOX).add({
        op: 'delete' as OutboxOp,
        noteId: id,
        ownerId,
        payload: null,
        status: 'pending',
        attempts: 0,
        lastError: null,
        queuedAt: Date.now(),
    })

    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
    })
}

/** Insert or replace a note record. The key is [ownerId, id]. */
export async function putNote(note: NoteRecord): Promise<void> {
    await withStore(STORE_NOTES, 'readwrite', (store) => promisify(store.put(note)))
}

/**
 * Delete one user's copy of a note.
 *
 * `ownerId` is required, not optional: deleting by id alone would remove every
 * user's copy of a shared server record.
 */
export async function deleteNote(ownerId: string, id: string): Promise<void> {
    await withStore(STORE_NOTES, 'readwrite', (store) => promisify(store.delete([ownerId, id])))
}

/** Mark one user's copy of a note as synced. */
export async function markNoteSynced(ownerId: string, id: string): Promise<void> {
    await withStore(STORE_NOTES, 'readwrite', async (store) => {
        const note = await promisify<NoteRecord | undefined>(store.get([ownerId, id]))
        if (!note) return
        note.synced = true
        await promisify(store.put(note))
    })
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/**
 * Append a pending mutation.
 *
 * The payload for a put is the full encrypted record, so the queue is
 * self-contained: replaying it never has to re-read (or, in encrypted mode,
 * decrypt) anything.
 */
export async function enqueue(
    op: OutboxOp,
    noteId: string,
    ownerId: string,
    payload: NotePayload | null,
): Promise<void> {
    await withStore(STORE_OUTBOX, 'readwrite', (store) =>
        promisify(
            store.add({
                op,
                noteId,
                ownerId,
                payload,
                status: 'pending',
                attempts: 0,
                lastError: null,
                queuedAt: Date.now(),
            }),
        ),
    )
}

/** Return one user's queue entries, oldest first. */
export async function getOutbox(ownerId: string): Promise<OutboxEntry[]> {
    const all = await withStore(STORE_OUTBOX, 'readonly', (store) =>
        promisify<OutboxEntry[]>(store.index('ownerId').getAll(IDBKeyRange.only(ownerId))),
    )
    return all.sort((a, b) => a.seq - b.seq)
}

/** Every queue entry regardless of owner. For the At Rest inspector. */
export async function getAllOutbox(): Promise<OutboxEntry[]> {
    const all = await withStore(STORE_OUTBOX, 'readonly', (store) =>
        promisify<OutboxEntry[]>(store.getAll()),
    )
    return all.sort((a, b) => a.seq - b.seq)
}

/** Entries still worth attempting, for one user. */
export async function getPending(ownerId: string): Promise<OutboxEntry[]> {
    return (await getOutbox(ownerId)).filter((entry) => entry.status === 'pending')
}

/** Remove a queue entry after it has been accepted by the server. */
export async function dequeue(seq: number): Promise<void> {
    await withStore(STORE_OUTBOX, 'readwrite', (store) => promisify(store.delete(seq)))
}

/**
 * Record a failed attempt.
 *
 * `permanent` distinguishes a 4xx (the server will never accept this, so park
 * it and tell the user) from a transient network/5xx failure (retry later).
 */
export async function recordFailure(
    seq: number,
    message: string,
    permanent: boolean,
): Promise<void> {
    await withStore(STORE_OUTBOX, 'readwrite', async (store) => {
        const entry = await promisify<OutboxEntry | undefined>(store.get(seq))
        if (!entry) return
        entry.attempts += 1
        entry.lastError = message
        entry.status = permanent ? 'failed' : 'pending'
        await promisify(store.put(entry))
    })
}

/** Drop a parked entry the user has acknowledged. */
export const discardEntry = dequeue

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Wipe everything on the device, every user included. */
export async function wipe(): Promise<void> {
    const db = await openDb()
    const tx = db.transaction([STORE_VAULT, STORE_NOTES, STORE_OUTBOX], 'readwrite')
    tx.objectStore(STORE_VAULT).clear()
    tx.objectStore(STORE_NOTES).clear()
    tx.objectStore(STORE_OUTBOX).clear()

    await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
    })
}

/**
 * Ask the browser not to evict our data under storage pressure.
 *
 * IndexedDB is best-effort by default: a browser clearing "temporary" storage
 * would take unsynced notes with it. This is a request, not a guarantee.
 */
export async function requestPersistence(): Promise<boolean> {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted()) return true
    return navigator.storage.persist()
}
