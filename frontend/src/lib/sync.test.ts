// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OutboxEntry } from '@/lib/db'

// Mock network + storage before importing the module under test.
const apiFetch = vi.fn()
const clearToken = vi.fn()

vi.mock('@/lib/api', () => ({
    apiFetch: (...args: unknown[]) => apiFetch(...args),
    clearToken: () => clearToken(),
}))

const db = {
    getPending: vi.fn(),
    getOutbox: vi.fn(),
    getNotes: vi.fn(),
    dequeue: vi.fn(),
    dequeueForNote: vi.fn(),
    recordFailure: vi.fn(),
    markNoteSynced: vi.fn(),
    putNote: vi.fn(),
    deleteNote: vi.fn(),
}

vi.mock('@/lib/db', () => db)

vi.mock('@/lib/crypto', () => ({
    decryptJson: vi.fn(async () => ({ title: 't', body: 'b', author: 'a' })),
    encryptJson: vi.fn(async () => ({ iv: 'iv', ciphertext: 'ct' })),
}))

// localStorage / navigator for module init
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
})
vi.stubGlobal('navigator', { onLine: true })

const {
    __resetForTests,
    classify,
    decideRemoteApply,
    drain,
    getState,
    latestPending,
    pull,
    runSyncCycle,
    setActiveOwner,
    setMode,
    setUnlockedCheck,
} = await import('@/lib/sync')

function pendingEntry(partial: Partial<OutboxEntry> & Pick<OutboxEntry, 'seq' | 'noteId' | 'op'>): OutboxEntry {
    return {
        status: 'pending',
        attempts: 0,
        lastError: null,
        queuedAt: 1_000,
        ownerId: 'owner-1',
        payload:
            partial.op === 'put'
                ? {
                      id: partial.noteId,
                      iv: 'iv',
                      ciphertext: 'ct',
                      createdAt: 1_000,
                      updatedAt: 1_000,
                  }
                : null,
        ...partial,
    }
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers },
    })
}

beforeEach(() => {
    store.clear()
    apiFetch.mockReset()
    clearToken.mockReset()
    for (const fn of Object.values(db)) fn.mockReset()
    db.getPending.mockResolvedValue([])
    db.getOutbox.mockResolvedValue([])
    db.getNotes.mockResolvedValue([])
    db.dequeue.mockResolvedValue(undefined)
    db.dequeueForNote.mockResolvedValue(undefined)
    db.recordFailure.mockResolvedValue(undefined)
    db.markNoteSynced.mockResolvedValue(undefined)
    db.putNote.mockResolvedValue(undefined)
    db.deleteNote.mockResolvedValue(undefined)
    __resetForTests()
    setUnlockedCheck(() => true)
    // setMode triggers drain; do it with no active owner so that fire-and-forget
    // is a no-op and does not race the test's own drain.
    setMode('plaintext')
    setActiveOwner('owner-1')
    apiFetch.mockReset()
    clearToken.mockReset()
})

afterEach(() => {
    __resetForTests()
})

describe('classify', () => {
    it('treats 2xx as ok', () => {
        expect(classify(new Response(null, { status: 200 })).result).toBe('ok')
        expect(classify(new Response(null, { status: 204 })).result).toBe('ok')
    })

    it('treats 401 and 403 as auth, not permanent', () => {
        expect(classify(new Response(null, { status: 401 })).result).toBe('auth')
        expect(classify(new Response(null, { status: 403 })).result).toBe('auth')
    })

    it('treats 408 and 429 as transient and honours Retry-After seconds', () => {
        const r = classify(new Response(null, { status: 429, headers: { 'Retry-After': '12' } }))
        expect(r.result).toBe('transient')
        if (r.result === 'transient') expect(r.retryAfterMs).toBe(12_000)
    })

    it('treats other 4xx as permanent and 5xx as transient', () => {
        expect(classify(new Response(null, { status: 400 })).result).toBe('permanent')
        expect(classify(new Response(null, { status: 422 })).result).toBe('permanent')
        expect(classify(new Response(null, { status: 500 })).result).toBe('transient')
    })
})

describe('decideRemoteApply / latestPending', () => {
    it('picks the highest seq as latest intent', () => {
        const entries = [
            pendingEntry({ seq: 1, noteId: 'n1', op: 'put' }),
            pendingEntry({ seq: 3, noteId: 'n1', op: 'delete' }),
            pendingEntry({ seq: 2, noteId: 'n1', op: 'put', payload: {
                id: 'n1', iv: 'i', ciphertext: 'c', createdAt: 1, updatedAt: 2,
            }}),
        ]
        expect(latestPending(entries)?.seq).toBe(3)
        expect(latestPending([])).toBeNull()
    })

    it('skips a live remote when a local delete is still pending', () => {
        const latest = pendingEntry({ seq: 1, noteId: 'n1', op: 'delete' })
        expect(decideRemoteApply(latest, { updatedAt: 9_999, deleted: false }, null)).toBe('skip')
    })

    it('applies a remote tombstone and dequeues a pending delete', () => {
        const latest = pendingEntry({ seq: 1, noteId: 'n1', op: 'delete' })
        expect(decideRemoteApply(latest, { updatedAt: 5_000, deleted: true }, 1_000)).toBe(
            'apply-and-dequeue',
        )
    })

    it('skips remote when a pending put is newer or equal', () => {
        const latest = pendingEntry({
            seq: 1,
            noteId: 'n1',
            op: 'put',
            payload: { id: 'n1', iv: 'i', ciphertext: 'c', createdAt: 1, updatedAt: 2000 },
        })
        expect(decideRemoteApply(latest, { updatedAt: 2000 }, 1000)).toBe('skip')
        expect(decideRemoteApply(latest, { updatedAt: 1500 }, 1000)).toBe('skip')
    })

    it('takes a newer remote and dequeues an older pending put', () => {
        const latest = pendingEntry({
            seq: 1,
            noteId: 'n1',
            op: 'put',
            payload: { id: 'n1', iv: 'i', ciphertext: 'c', createdAt: 1, updatedAt: 1000 },
        })
        expect(decideRemoteApply(latest, { updatedAt: 2000 }, 1000)).toBe('apply-and-dequeue')
        expect(decideRemoteApply(latest, { updatedAt: 2000, deleted: true }, 1000)).toBe(
            'apply-and-dequeue',
        )
    })

    it('falls back to note LWW when the outbox is empty', () => {
        expect(decideRemoteApply(null, { updatedAt: 1000 }, 2000)).toBe('skip')
        expect(decideRemoteApply(null, { updatedAt: 3000 }, 2000)).toBe('apply')
        expect(decideRemoteApply(null, { updatedAt: 1000 }, null)).toBe('apply')
    })
})

describe('drain', () => {
    it('is re-entrant: a second call while the first is in flight is a no-op', async () => {
        let resolveInfo!: (value: Response) => void
        const infoGate = new Promise<Response>((resolve) => {
            resolveInfo = resolve
        })
        apiFetch.mockImplementationOnce(() => infoGate)

        const entry = pendingEntry({ seq: 1, noteId: 'n1', op: 'put' })
        db.getPending.mockResolvedValue([entry])

        const first = drain({ force: true })
        // Still blocked on probe - second drain must return immediately.
        await drain({ force: true })
        resolveInfo(jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 }))
        // After probe, put may run - complete it.
        apiFetch.mockResolvedValue(jsonResponse({ id: 'n1' }))
        await first

        // Only one probe was issued before we released the gate; the re-entrant
        // call did not start a second drain.
        expect(apiFetch.mock.calls.filter((c) => c[0] === '/api/info').length).toBe(1)
    })

    it('stops on the first transient failure and leaves later entries pending', async () => {
        const a = pendingEntry({ seq: 1, noteId: 'a', op: 'put' })
        const b = pendingEntry({ seq: 2, noteId: 'b', op: 'put' })
        db.getPending.mockResolvedValue([a, b])

        apiFetch
            .mockResolvedValueOnce(jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 }))
            .mockResolvedValueOnce(new Response(null, { status: 500 }))

        await drain({ force: true })

        expect(db.recordFailure).toHaveBeenCalledWith(1, expect.any(String), false)
        expect(db.dequeue).not.toHaveBeenCalled()
        // Second entry never attempted - only info + one put.
        expect(apiFetch.mock.calls.map((c) => c[0])).toEqual([
            '/api/info',
            '/api/plain-notes/a',
        ])
    })

    it('parks a permanent 422 and continues to the next entry', async () => {
        const a = pendingEntry({ seq: 1, noteId: 'a', op: 'put' })
        const b = pendingEntry({ seq: 2, noteId: 'b', op: 'put' })
        db.getPending.mockResolvedValue([a, b])

        apiFetch
            .mockResolvedValueOnce(jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 }))
            .mockResolvedValueOnce(new Response(null, { status: 422 }))
            .mockResolvedValueOnce(jsonResponse({ id: 'b' }))

        await drain({ force: true })

        expect(db.recordFailure).toHaveBeenCalledWith(1, expect.any(String), true)
        expect(db.dequeue).toHaveBeenCalledWith(2)
    })

    it('treats mid-drain 401 as auth: clears token, does not park permanent', async () => {
        const a = pendingEntry({ seq: 1, noteId: 'a', op: 'put' })
        db.getPending.mockResolvedValue([a])

        apiFetch
            .mockResolvedValueOnce(jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 }))
            .mockResolvedValueOnce(new Response(null, { status: 401 }))

        await drain({ force: true })

        expect(clearToken).toHaveBeenCalled()
        expect(getState().unauthorized).toBe(true)
        expect(db.recordFailure).not.toHaveBeenCalled()
        expect(db.dequeue).not.toHaveBeenCalled()
    })

    it('blocks plaintext drain when the vault is locked', async () => {
        setUnlockedCheck(() => false)
        db.getPending.mockResolvedValue([pendingEntry({ seq: 1, noteId: 'a', op: 'put' })])

        await drain({ force: true })

        expect(getState().blockedByLock).toBe(true)
        expect(apiFetch).not.toHaveBeenCalled()
    })

    it('routes encrypted mode uploads to /api/notes', async () => {
        setActiveOwner(null)
        setMode('encrypted')
        setActiveOwner('owner-1')
        apiFetch.mockReset()

        const entry = pendingEntry({ seq: 1, noteId: 'e1', op: 'put' })
        db.getPending.mockResolvedValue([entry])

        apiFetch
            .mockResolvedValueOnce(jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 }))
            .mockResolvedValueOnce(jsonResponse({ id: 'e1' }))

        await drain({ force: true })

        expect(apiFetch.mock.calls.map((c) => c[0])).toContain('/api/notes/e1')
    })
})

describe('pull reconcile', () => {
    it('skips a remote live row when a local delete is pending', async () => {
        db.getOutbox.mockResolvedValue([pendingEntry({ seq: 1, noteId: 'n1', op: 'delete' })])
        db.getNotes.mockResolvedValue([])
        apiFetch
            .mockResolvedValueOnce(jsonResponse({ name: 'lockbox', version: '0', noteCount: 1, plainNoteCount: 1 }))
            .mockResolvedValueOnce(
                jsonResponse({
                    notes: [
                        {
                            id: 'n1',
                            title: 'resurrect',
                            body: 'nope',
                            author: 'other',
                            createdAt: 1,
                            updatedAt: 9_999,
                        },
                    ],
                }),
            )

        const changed = await pull()

        expect(changed).toBe(0)
        expect(db.putNote).not.toHaveBeenCalled()
        expect(db.dequeueForNote).not.toHaveBeenCalled()
    })

    it('applies a newer remote tombstone and dequeues a conflicting put', async () => {
        db.getOutbox.mockResolvedValue([
            pendingEntry({
                seq: 1,
                noteId: 'n1',
                op: 'put',
                payload: { id: 'n1', iv: 'i', ciphertext: 'c', createdAt: 1, updatedAt: 1000 },
            }),
        ])
        db.getNotes.mockResolvedValue([
            {
                id: 'n1',
                iv: 'i',
                ciphertext: 'c',
                createdAt: 1,
                updatedAt: 1000,
                synced: false,
                origin: 'local',
                ownerId: 'owner-1',
            },
        ])
        apiFetch
            .mockResolvedValueOnce(jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 }))
            .mockResolvedValueOnce(
                jsonResponse({
                    notes: [
                        {
                            id: 'n1',
                            title: 'gone',
                            body: '',
                            author: 'other',
                            createdAt: 1,
                            updatedAt: 5000,
                            deleted: true,
                        },
                    ],
                }),
            )

        const changed = await pull()

        expect(changed).toBe(1)
        expect(db.deleteNote).toHaveBeenCalledWith('owner-1', 'n1')
        expect(db.dequeueForNote).toHaveBeenCalledWith('owner-1', 'n1')
    })
})

describe('runSyncCycle', () => {
    it('drains before pulling so local work is uploaded first', async () => {
        const order: string[] = []
        const entry = pendingEntry({ seq: 1, noteId: 'local', op: 'put' })
        db.getPending.mockResolvedValue([entry])
        db.getOutbox.mockResolvedValue([])
        db.getNotes.mockResolvedValue([])

        apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
            order.push(`${init?.method ?? 'GET'} ${url}`)
            if (url === '/api/info') {
                return jsonResponse({ name: 'lockbox', version: '0', noteCount: 0, plainNoteCount: 0 })
            }
            if (String(url).includes('/api/plain-notes/local')) {
                return jsonResponse({ id: 'local' })
            }
            if (url === '/api/plain-notes') {
                return jsonResponse({ notes: [] })
            }
            return jsonResponse({})
        })

        await runSyncCycle({ forceDrain: true, minPullIntervalMs: 0 })

        const putIndex = order.findIndex((c) => c.startsWith('PUT'))
        const listIndex = order.findIndex((c) => c === 'GET /api/plain-notes')
        expect(putIndex).toBeGreaterThanOrEqual(0)
        expect(listIndex).toBeGreaterThan(putIndex)
    })
})
