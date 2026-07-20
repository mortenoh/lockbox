import { expect, test } from '@playwright/test'

import {
    addNote,
    clearServer,
    createUser,
    expectUnlocked,
    readIndexedDb,
    wipeDevice,
} from './helpers'

/**
 * Pull must not resurrect work the local outbox still intends to delete, and
 * must drop superseded queue entries when a newer remote tombstone wins.
 *
 * A second device is simulated by writing straight to the API. `clearServer`
 * leaves tombstones by design, so helpers always filter to live rows.
 */
async function livePlainNotes(
    request: import('@playwright/test').APIRequestContext,
): Promise<{ id: string; updatedAt: number; title: string }[]> {
    const listed = await request.get('/api/plain-notes')
    const { notes } = (await listed.json()) as {
        notes: { id: string; updatedAt: number; title: string; deleted?: boolean }[]
    }
    return notes.filter((n) => !n.deleted)
}

test.describe('outbox reconcile on pull', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('pending local delete is not undone by a remote live copy', async ({ page, request }) => {
        await createUser(page, 'Device A', '1111')
        const title = `To delete ${Date.now()}`
        await addNote(page, title)
        await expect(page.getByText('on server')).toBeVisible({ timeout: 20_000 })

        await expect
            .poll(async () => (await livePlainNotes(request)).length)
            .toBe(1)
        const notes = await livePlainNotes(request)
        const noteId = notes[0].id
        const olderUpdatedAt = notes[0].updatedAt

        // Go offline so the delete stays in the outbox.
        await page.context().setOffline(true)
        await page.getByRole('button', { name: new RegExp(`Delete ${title}`) }).click()
        await expect(page.getByText(title)).toBeHidden()

        const offlineDb = await readIndexedDb(page)
        expect(offlineDb.outbox.some((e) => e.op === 'delete' && e.noteId === noteId)).toBe(true)

        // Server still has the live row (we never uploaded the delete). Re-assert it
        // with the same updatedAt so a naive LWW pull would re-create the note.
        await request.put(`/api/plain-notes/${noteId}`, {
            data: {
                id: noteId,
                title,
                body: 'should not come back',
                author: 'Device A',
                createdAt: olderUpdatedAt,
                updatedAt: olderUpdatedAt,
            },
        })

        await page.context().setOffline(false)
        await page.waitForTimeout(3_500)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

        // Drain uploads the delete; pull must not have re-created the note first.
        await expect(page.getByText(title)).toBeHidden({ timeout: 20_000 })
        await expectUnlocked(page)

        await expect
            .poll(async () => {
                const idb = await readIndexedDb(page)
                return idb.outbox.filter((e) => e.noteId === noteId).length
            })
            .toBe(0)
    })

    test('newer remote tombstone drops a pending put for the same id', async ({ page, request }) => {
        await createUser(page, 'Device A', '1111')
        const title = `Will be superseded ${Date.now()}`
        await addNote(page, title)
        await expect(page.getByText('on server')).toBeVisible({ timeout: 20_000 })

        await expect
            .poll(async () => (await livePlainNotes(request)).length)
            .toBe(1)
        const noteId = (await livePlainNotes(request))[0].id

        const idbBefore = await readIndexedDb(page)
        const ownerId = (idbBefore.vaults[0] as { id: string }).id
        const localNote = idbBefore.notes.find((n) => n.id === noteId)
        expect(localNote).toBeTruthy()

        // Offline local "edit": inject a pending put with a bumped updatedAt.
        await page.context().setOffline(true)
        await page.evaluate(
            async ({ id, oid, note }) => {
                const db = await new Promise<IDBDatabase>((res, rej) => {
                    const r = indexedDB.open('lockbox')
                    r.onsuccess = () => res(r.result)
                    r.onerror = () => rej(r.error)
                })
                const tx = db.transaction(['notes', 'outbox'], 'readwrite')
                const updatedAt = (note.updatedAt as number) + 1_000
                const updated = { ...note, updatedAt, synced: false, ownerId: oid }
                tx.objectStore('notes').put(updated)
                tx.objectStore('outbox').add({
                    op: 'put',
                    noteId: id,
                    ownerId: oid,
                    payload: {
                        id,
                        iv: note.iv,
                        ciphertext: note.ciphertext,
                        createdAt: note.createdAt,
                        updatedAt,
                    },
                    status: 'pending',
                    attempts: 0,
                    lastError: null,
                    queuedAt: Date.now(),
                })
                await new Promise<void>((res, rej) => {
                    tx.oncomplete = () => res()
                    tx.onerror = () => rej(tx.error)
                })
                db.close()
            },
            { id: noteId, oid: ownerId, note: localNote! },
        )

        // Remote wins with a much newer live write then delete, so the tombstone
        // timestamp is above the offline put (store.delete uses max(when, existing+1)).
        const remoteWhen = Date.now() + 60_000
        await request.put(`/api/plain-notes/${noteId}`, {
            data: {
                id: noteId,
                title: 'gone',
                body: '',
                author: 'Device B',
                createdAt: 1,
                updatedAt: remoteWhen,
            },
        })
        await request.delete(`/api/plain-notes/${noteId}`)

        await page.context().setOffline(false)
        await page.waitForTimeout(3_500)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

        await expect(page.getByText(title)).toBeHidden({ timeout: 20_000 })

        await expect
            .poll(async () => {
                const idb = await readIndexedDb(page)
                return idb.outbox.filter((e) => e.noteId === noteId).length
            })
            .toBe(0)
    })
})
