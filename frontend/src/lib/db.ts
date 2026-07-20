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
 * The schema reached 3 (v2 added multiple vaults per device; v3 keyed notes by
 * [ownerId, id], not id alone). It is held at 3 even though pre-v3 databases are
 * now reset rather than migrated: lowering it would throw VersionError on dev
 * machines that already opened a v3 database.
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

/** The decrypted contents of a note - what a NoteRecord's ciphertext holds. */
export interface NoteContent {
    title: string
    body: string
    /** Display name of whoever wrote it. Travels inside the ciphertext locally. */
    author: string
}

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

/** How long to wait for the database before giving up and saying so. */
const OPEN_TIMEOUT_MS = 5_000

let dbPromise: Promise<IDBDatabase> | null = null

/** Create the three object stores in their current (v3) shape. */
function createStores(db: IDBDatabase): void {
    db.createObjectStore(STORE_VAULT, { keyPath: 'id' })

    // Compound key, not 'id'. Two users pulling the same server record share
    // its id, so keying on id alone let one user's ciphertext overwrite the
    // other's.
    const notes = db.createObjectStore(STORE_NOTES, { keyPath: ['ownerId', 'id'] })
    notes.createIndex('ownerId', 'ownerId')

    const outbox = db.createObjectStore(STORE_OUTBOX, {
        keyPath: 'seq',
        autoIncrement: true,
    })
    outbox.createIndex('ownerId', 'ownerId')
}

/**
 * Open (and if needed create/reset) the database.
 *
 * There is no migration path. A fresh install creates the current shape
 * outright. Any schema bump drops existing stores and recreates that shape —
 * pre-release only, while no real users keep local data. The version number
 * stays at 3 so machines that already opened a v3 database do not hit
 * VersionError; lowering it would.
 */
function openDb(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION)

        // A hard deadline on opening.
        //
        // `onblocked` is documented to fire when another connection holds an
        // older version, but it is not guaranteed to fire promptly - or at all -
        // if a versionchange transaction stalls midway. Without a timeout the
        // promise simply never settles, and the app waits forever behind a
        // spinner. Any outcome the user can act on beats that.
        const deadline = setTimeout(() => {
            reject(
                new Error(
                    'Timed out opening the local database. This usually means another tab ' +
                        'still has it open on an older version - close every other tab of this ' +
                        'app and reload.',
                ),
            )
        }, OPEN_TIMEOUT_MS)

        const settle = <T>(fn: (value: T) => void) => {
            return (value: T) => {
                clearTimeout(deadline)
                fn(value)
            }
        }

        request.onupgradeneeded = (event) => {
            const db = request.result
            const oldVersion = event.oldVersion

            // Pre-release policy: any schema bump wipes local stores, then
            // createStores builds the current shape. That is only defensible
            // while no real users keep data here - the project shipped with
            // none. A fresh install (oldVersion < 1) has nothing to drop.
            // Before shipping to people who keep vaults, replace this with
            // real step migrations (and stop calling createStores on every bump).
            if (oldVersion >= 1) {
                for (const name of Array.from(db.objectStoreNames)) {
                    db.deleteObjectStore(name)
                }
            }

            createStores(db)
        }

        request.onsuccess = settle(() => {
            const db = request.result

            // Another tab wanting a newer version cannot upgrade while this
            // connection is open. Closing on request is what lets it proceed -
            // without this, one stale tab blocks every other tab indefinitely.
            db.onversionchange = () => {
                db.close()
                dbPromise = null
            }

            resolve(db)
        })

        request.onerror = settle(() => reject(request.error))

        // Fires when an upgrade cannot start because another connection is
        // still open on the old version. Previously unhandled, which meant the
        // promise simply never settled: every caller awaited forever and the UI
        // rendered nothing at all. A hang is worse than an error, because there
        // is nothing to show the user and nothing to act on.
        request.onblocked = settle(() => {
            reject(
                new Error(
                    'The database is open in another tab running an older version of this app. ' +
                        'Close the other tabs and reload.',
                ),
            )
        })
    })

    // A failed open must not be cached, or every later call reuses the same
    // rejected promise and the app can never recover without a reload.
    dbPromise.catch(() => {
        dbPromise = null
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

/**
 * Delete the whole database.
 *
 * The escape hatch of last resort, offered in the UI when the database cannot
 * be opened at all. Destructive - every local vault and any unsynced note goes
 * with it - but the alternative on offer is an app that never starts, and notes
 * that already reached the server can be recovered by signing in again and
 * pulling.
 *
 * Resolves rather than hanging if the delete is itself blocked, so the button
 * always does something.
 */
export async function destroyDatabase(): Promise<void> {
    dbPromise = null

    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(DB_NAME)
        const done = () => resolve()
        request.onsuccess = done
        request.onerror = done
        request.onblocked = done
        setTimeout(done, 3_000)
    })
}
