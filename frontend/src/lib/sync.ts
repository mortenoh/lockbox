/**
 * Sync engine: drains the local outbox to the server when it is reachable.
 *
 * ============================================================================
 * TWO SYNC MODES, AND WHY THE CHOICE MATTERS
 * ============================================================================
 *
 * PLAINTEXT (default, DHIS2-realistic)
 *   Decrypt at the moment of upload and send readable data.
 *
 *   This is the only mode that works against a real platform like DHIS2. The
 *   server has to validate, aggregate, run analytics, and share records between
 *   users - none of which is possible over ciphertext. Crucially, every user of
 *   this PWA picks their *own* passphrase, so if uploads were encrypted with it
 *   the records would be readable by exactly one person and the backend's own
 *   access rules would become meaningless.
 *
 *   Encryption here is therefore *local-only*: it protects IndexedDB on a
 *   device that gets stolen. Confidentiality in transit is TLS's job, and
 *   confidentiality on the server is the platform's job.
 *
 *   The cost: uploading requires decryption, so THE VAULT MUST BE UNLOCKED TO
 *   SYNC. That falls directly out of the design and is worth seeing.
 *
 * ENCRYPTED (demonstration)
 *   Upload the stored ciphertext untouched. The server keeps bytes it cannot
 *   read.
 *
 *   Sync works while locked, because nothing needs decrypting. But the data is
 *   useless to any backend that must do something with it, and unreadable to
 *   every other user. Included to make the trade-off concrete, not because it
 *   suits the target.
 *
 * ============================================================================
 * THE OUTBOX PATTERN
 * ============================================================================
 *
 * IndexedDB is the source of truth. A write lands locally and is acknowledged
 * to the user immediately; a queue entry records that the server has not heard
 * about it yet. Offline is the normal case, not an error path.
 *
 * Design decisions worth noting:
 *
 *  - Drained FIFO, stopping at the first transient failure, so writes reach the
 *    server in the order the user made them.
 *  - Uploads are PUTs keyed by a client-generated UUID, making a retry after a
 *    dropped connection an idempotent overwrite rather than a duplicate. This
 *    single choice removes most of the difficulty from retrying.
 *  - 4xx is treated as permanent (park it, tell the user), 5xx and network
 *    errors as transient (retry with exponential backoff). Retrying a 400
 *    forever is a classic way to build an infinite loop.
 *  - Triggers are deliberately redundant: `online`, tab focus, app boot, and a
 *    slow poll. The Background Sync API would let the *service worker* flush
 *    with the tab closed, but it is Chromium-only as of 2026 - no Safari, no
 *    Firefox - so it can only ever be an enhancement on top of these, never a
 *    replacement for them.
 *  - Reachability is probed against our own endpoint rather than trusting
 *    `navigator.onLine`, which reports link state only and cheerfully claims
 *    you are online behind a captive portal.
 */

import { decryptJson, encryptJson } from '@/lib/crypto'
import { apiFetch } from '@/lib/api'
import * as db from '@/lib/db'
import type { NoteContent, OutboxEntry } from '@/lib/db'

/** A readable record as the plaintext API returns it. */
interface PlainNoteWire {
    id: string
    title: string
    body: string
    author: string
    createdAt: number
    updatedAt: number
    /** Tombstone: the record was deleted elsewhere and must go here too. */
    deleted?: boolean
}

/** How the outbox uploads records. See the module comment. */
export type SyncMode = 'plaintext' | 'encrypted'

/** DHIS2-realistic behaviour is the default. */
export const DEFAULT_SYNC_MODE: SyncMode = 'plaintext'

const POLL_INTERVAL_MS = 30_000
/**
 * How often to fetch remote changes.
 *
 * Slower than the outbox poll on purpose. Draining is cheap and urgent - it is
 * the user's own unsent work. Pulling is a full fetch of the server's records
 * and only matters when *someone else* has written something, so a lower
 * frequency is the right trade.
 */
const PULL_INTERVAL_MS = 60_000
/**
 * Minimum gap between pulls triggered by the user returning to the tab.
 *
 * Coming back is a strong signal that fresh data is wanted, so the ordinary
 * one-minute floor is too slow to feel responsive. A few seconds is still
 * enough to stop rapid tab-switching from hammering the server.
 */
const PULL_ON_FOCUS_MIN_MS = 3_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 60_000

const MODE_STORAGE_KEY = 'lockbox.syncMode'

/** Everything the UI needs to describe sync status. */
export interface SyncState {
    online: boolean
    syncing: boolean
    pending: number
    failed: number
    lastSyncAt: number | null
    /** Bumped whenever a pull actually changed local data, so the UI reloads. */
    lastPullAt: number | null
    lastError: string | null
    mode: SyncMode
    /** True when plaintext mode is selected but the vault is locked. */
    blockedByLock: boolean
    /**
     * True when the server answered 401.
     *
     * Kept distinct from `online: false` on purpose. A rejected token and an
     * unreachable server look identical to a naive `response.ok` check, and
     * reporting "offline" for a 401 sends the user hunting for a network fault
     * that does not exist.
     */
    unauthorized: boolean
}

type Listener = (state: SyncState) => void

const listeners = new Set<Listener>()

function loadMode(): SyncMode {
    const stored = localStorage.getItem(MODE_STORAGE_KEY)
    return stored === 'encrypted' || stored === 'plaintext' ? stored : DEFAULT_SYNC_MODE
}

let state: SyncState = {
    online: navigator.onLine,
    syncing: false,
    pending: 0,
    failed: 0,
    lastSyncAt: null,
    lastPullAt: null,
    lastError: null,
    mode: loadMode(),
    blockedByLock: false,
    unauthorized: false,
}

let backoffUntil = 0
let draining = false
let started = false
let pulling = false
let lastPullAttempt = 0

/**
 * How the engine gets plaintext when it needs it.
 *
 * Injected rather than imported so this module never reaches into the vault on
 * its own - it can only decrypt when the app has explicitly handed it the
 * ability, which makes the "sync needs an unlocked vault" constraint impossible
 * to bypass accidentally.
 */
let unlockedDecryptor: (() => boolean) | null = null

/**
 * Which local user's queue is being drained.
 *
 * Records are encrypted per user, so only the signed-in user can upload their
 * own - another user's ciphertext is unreadable here and must wait for them.
 */
let activeOwnerId: string | null = null

/** Register a predicate reporting whether the vault is currently unlocked. */
export function setUnlockedCheck(isUnlocked: () => boolean): void {
    unlockedDecryptor = isUnlocked
}

/** Set (or clear, on lock) the user whose queue should be drained. */
export function setActiveOwner(ownerId: string | null): void {
    activeOwnerId = ownerId
}

// ============================================================================
// State plumbing
// ============================================================================

/** Subscribe to sync-state changes. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
    listeners.add(listener)
    listener(state)
    return () => void listeners.delete(listener)
}

/** Read the current state without subscribing. */
export function getState(): SyncState {
    return state
}

function setState(patch: Partial<SyncState>): void {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
}

/** Switch sync mode. Persisted so the choice survives a reload. */
export function setMode(mode: SyncMode): void {
    localStorage.setItem(MODE_STORAGE_KEY, mode)
    setState({ mode, lastError: null })
    void drain({ force: true })
}

/** Recount the queue so the UI badge stays accurate. */
async function refreshCounts(): Promise<void> {
    if (!activeOwnerId) {
        setState({ pending: 0, failed: 0 })
        return
    }
    const entries = await db.getOutbox(activeOwnerId)
    setState({
        pending: entries.filter((e) => e.status === 'pending').length,
        failed: entries.filter((e) => e.status === 'failed').length,
    })
}

/**
 * Probe the server.
 *
 * `navigator.onLine` is necessary but not sufficient, so an actual request
 * decides. `cache: 'no-store'` stops a cached 200 from faking reachability -
 * easy to get wrong, and it would make the app think it had synced.
 */
type Reachability = 'ok' | 'unauthorized' | 'unreachable'

async function probeServer(): Promise<Reachability> {
    if (!navigator.onLine) return 'unreachable'
    try {
        const response = await apiFetch('/api/info', { cache: 'no-store' })
        if (response.status === 401) return 'unauthorized'
        return response.ok ? 'ok' : 'unreachable'
    } catch {
        return 'unreachable'
    }
}

// ============================================================================
// Uploading
// ============================================================================

type SendResult = { result: 'ok' | 'transient' | 'permanent'; message?: string }

/** Classify a response the same way regardless of which endpoint produced it. */
function classify(response: Response): SendResult {
    if (response.ok) return { result: 'ok' }

    // The server has judged this payload invalid. It will judge every retry the
    // same way, so retrying is pointless - park it for the user instead.
    if (response.status >= 400 && response.status < 500) {
        return { result: 'permanent', message: `Server rejected it (HTTP ${response.status})` }
    }
    return { result: 'transient', message: `Server error (HTTP ${response.status})` }
}

/**
 * Upload one queue entry in whichever mode is active.
 *
 * In plaintext mode the ciphertext held in the outbox is decrypted here, at the
 * last possible moment, and only the readable result crosses the network.
 */
async function sendEntry(entry: OutboxEntry, mode: SyncMode): Promise<SendResult> {
    const base = mode === 'plaintext' ? '/api/plain-notes' : '/api/notes'
    const url = `${base}/${encodeURIComponent(entry.noteId)}`

    try {
        if (entry.op === 'delete') {
            return classify(await apiFetch(url, { method: 'DELETE' }))
        }

        const payload = entry.payload
        if (!payload) return { result: 'permanent', message: 'Queue entry has no payload' }

        let body: unknown = payload

        if (mode === 'plaintext') {
            // Requires the DEK, hence the unlocked-vault precondition.
            const content = await decryptJson<NoteContent>(payload)
            body = {
                id: payload.id,
                title: content.title,
                body: content.body,
                author: content.author,
                createdAt: payload.createdAt,
                updatedAt: payload.updatedAt,
            }
        }

        return classify(
            await apiFetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }),
        )
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Network unreachable'
        return { result: 'transient', message }
    }
}

/**
 * Drain the outbox.
 *
 * Re-entrancy guarded, because several triggers can fire at once - the `online`
 * event and a visibility change commonly arrive together, and two concurrent
 * drains would upload the same entries twice.
 */
export async function drain({ force = false }: { force?: boolean } = {}): Promise<void> {
    if (draining) return
    if (!force && Date.now() < backoffUntil) return

    if (!activeOwnerId) return

    draining = true
    try {
        // Counts first, before the reachability probe: the queue badge has to be
        // right while offline, which is exactly when it matters most.
        await refreshCounts()

        const mode = state.mode

        // Plaintext uploads must decrypt, so a locked vault stops sync dead.
        // Surfaced as state rather than an error - it is a designed constraint,
        // not a failure.
        const needsKey = mode === 'plaintext'
        const locked = needsKey && unlockedDecryptor?.() === false
        setState({ blockedByLock: locked })
        if (locked) return

        const reach = await probeServer()
        setState({
            online: reach !== 'unreachable',
            unauthorized: reach === 'unauthorized',
        })
        if (reach !== 'ok') {
            setState({ syncing: false })
            return
        }

        const pending = await db.getPending(activeOwnerId!)
        if (pending.length === 0) {
            backoffUntil = 0
            return
        }

        setState({ syncing: true, lastError: null })

        for (const entry of pending) {
            const { result, message } = await sendEntry(entry, mode)

            if (result === 'ok') {
                await db.dequeue(entry.seq)
                if (entry.op === 'put') await db.markNoteSynced(entry.ownerId, entry.noteId)
                continue
            }

            if (result === 'permanent') {
                await db.recordFailure(entry.seq, message ?? 'Rejected', true)
                continue
            }

            // Transient: stop here rather than skipping ahead, so later writes
            // cannot overtake this one on the server.
            await db.recordFailure(entry.seq, message ?? 'Unreachable', false)
            const delay = Math.min(BACKOFF_BASE_MS * 2 ** (entry.attempts + 1), BACKOFF_MAX_MS)
            backoffUntil = Date.now() + delay
            setState({ lastError: message ?? null })
            break
        }

        await refreshCounts()
        setState({ lastSyncAt: Date.now() })
    } finally {
        setState({ syncing: false })
        draining = false
    }
}

/**
 * Fetch what the server currently holds, without storing it.
 *
 * Used by the Sync Modes page to show the two backends side by side - the
 * clearest possible demonstration that one is readable and the other is not.
 */
export async function fetchServerState(): Promise<{
    plain: unknown[]
    encrypted: unknown[]
} | null> {
    if ((await probeServer()) !== 'ok') return null

    const [plain, encrypted] = await Promise.all([
        apiFetch('/api/plain-notes', { cache: 'no-store' }).then((r) => r.json()),
        apiFetch('/api/notes', { cache: 'no-store' }).then((r) => r.json()),
    ])

    return { plain: plain.notes ?? [], encrypted: encrypted.notes ?? [] }
}

/**
 * Fetch server records into local storage.
 *
 * This is the direction that makes the whole architecture make sense, so it is
 * worth being precise about what each mode does.
 *
 * PLAINTEXT MODE - the real one.
 *   Reads readable records from the server and **re-encrypts them with this
 *   device's DEK** before writing them to IndexedDB. That is the crucial step:
 *   the server copy is shared and readable (governed by the platform's access
 *   rules), while every local copy is encrypted under whatever passphrase that
 *   particular device chose. A second user on a second device pulls the same
 *   records and encrypts them under a completely different key.
 *
 *   This is why per-user passphrases and a shared backend can coexist at all.
 *
 * ENCRYPTED MODE - the demonstration.
 *   Copies ciphertext across verbatim. Records encrypted under a *different*
 *   device's DEK cannot be decrypted here, and surface in the UI as
 *   "unreadable". That failure is the point: it shows exactly why this mode
 *   cannot support multiple users.
 *
 * Last-write-wins on `updatedAt`. Adequate for one user per device; a genuinely
 * concurrent multi-writer design would need per-field merging or a CRDT.
 *
 * @returns how many local records were created or updated.
 */
export async function pull(): Promise<number> {
    if (!activeOwnerId) return 0
    if ((await probeServer()) !== 'ok') return 0

    return state.mode === 'plaintext' ? pullPlaintext() : pullEncrypted()
}

/** Pull readable records and encrypt them for local storage. */
async function pullPlaintext(): Promise<number> {
    // Encrypting requires the DEK, the mirror image of the upload constraint.
    if (unlockedDecryptor?.() === false) {
        setState({ blockedByLock: true })
        return 0
    }

    const response = await apiFetch('/api/plain-notes', { cache: 'no-store' })
    if (!response.ok) return 0

    const { notes } = (await response.json()) as { notes: PlainNoteWire[] }
    const local = new Map((await db.getNotes(activeOwnerId!)).map((n) => [n.id, n]))
    let changed = 0

    for (const remote of notes) {
        const existing = local.get(remote.id)
        if (existing && existing.updatedAt >= remote.updatedAt) continue

        // A tombstone means someone deleted it elsewhere. Apply the deletion
        // rather than re-creating the record, or deletions would never converge.
        if (remote.deleted) {
            if (existing) {
                await db.deleteNote(activeOwnerId!, remote.id)
                changed += 1
            }
            continue
        }

        // Encrypted here, on arrival - the local copy is never plaintext at rest.
        // Authorship comes across intact, so a pulled note still shows who wrote it.
        const { iv, ciphertext } = await encryptJson({
            title: remote.title,
            body: remote.body,
            author: remote.author,
        })

        await db.putNote({
            id: remote.id,
            iv,
            ciphertext,
            createdAt: remote.createdAt,
            updatedAt: remote.updatedAt,
            synced: true,
            origin: 'pulled',
            ownerId: activeOwnerId!,
        })
        changed += 1
    }

    return changed
}

/** Copy ciphertext across as-is. Undecryptable unless the DEK matches. */
async function pullEncrypted(): Promise<number> {
    const response = await apiFetch('/api/notes', { cache: 'no-store' })
    if (!response.ok) return 0

    const { notes } = (await response.json()) as { notes: (db.NotePayload & { deleted?: boolean })[] }
    const local = new Map((await db.getNotes(activeOwnerId!)).map((n) => [n.id, n]))
    let changed = 0

    for (const remote of notes) {
        const existing = local.get(remote.id)
        if (existing && existing.updatedAt >= remote.updatedAt) continue

        if (remote.deleted) {
            if (existing) {
                await db.deleteNote(activeOwnerId!, remote.id)
                changed += 1
            }
            continue
        }

        await db.putNote({ ...remote, synced: true, origin: 'pulled', ownerId: activeOwnerId! })
        changed += 1
    }

    return changed
}

/**
 * Pull remote changes if enough time has passed.
 *
 * Guarded by its own timestamp rather than piggybacking on the drain interval,
 * so a burst of local writes cannot trigger a burst of full fetches.
 */
async function maybePull(minIntervalMs = PULL_INTERVAL_MS): Promise<void> {
    if (pulling) return
    if (Date.now() - lastPullAttempt < minIntervalMs) return

    pulling = true
    lastPullAttempt = Date.now()
    try {
        const changed = await pull()
        // Only announce a change when there was one - an idle poll should not
        // make the UI re-render every minute.
        if (changed > 0) setState({ lastPullAt: Date.now() })
    } catch {
        // Offline, locked, or unauthorised. All already visible in the state.
    } finally {
        pulling = false
    }
}

/** Fetch remote changes now, regardless of the interval. */
export const pullNow = () => maybePull(0)

/** Recount the queue after a local change. */
export const refresh = refreshCounts

/** Wire up the drain triggers. Safe to call more than once. */
export function start(): void {
    if (started) return
    started = true

    window.addEventListener('online', () => {
        backoffUntil = 0 // A fresh connection deserves an immediate attempt.
        setState({ online: true })
        void drain({ force: true })
        void maybePull(0)
    })

    window.addEventListener('offline', () => setState({ online: false }))

    // The workhorse on iOS/Safari, where Background Sync does not exist:
    // returning to the tab is the most reliable moment to flush.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            void drain()
            void maybePull(PULL_ON_FOCUS_MIN_MS)
        }
    })

    setInterval(() => void drain(), POLL_INTERVAL_MS)
    setInterval(() => void maybePull(), PULL_INTERVAL_MS)

    // Push local work first, then fetch. Draining before pulling means the
    // user's own edits win a last-write-wins race against a stale server copy.
    void drain({ force: true }).then(() => maybePull(0))
}
