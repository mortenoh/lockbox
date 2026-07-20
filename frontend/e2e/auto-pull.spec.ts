// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { expect, test } from '@playwright/test'

import { addNote, clearServer, createUser, wipeDevice } from './helpers'

/**
 * Automatic fetching of remote changes.
 *
 * Before this, the outbox drained on its own but nothing ever came *back* -
 * a note written on another device stayed invisible until the user pressed
 * "Pull from server" by hand.
 */
test.describe('auto-pull', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a remote note arrives without pressing anything', async ({ page, request }) => {
        await createUser(page, 'Device A', '1111')

        // Stand in for a second device by writing straight to the server.
        const id = `remote-${Date.now()}`
        const remoteTitle = `Written elsewhere ${Date.now()}`
        await request.put(`/api/plain-notes/${id}`, {
            data: {
                id,
                title: remoteTitle,
                body: 'From another device',
                author: 'Device B',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        })

        // Returning to the tab is a pull trigger, but it has a 3s floor so that
        // rapid tab-switching cannot hammer the server. The startup pull has
        // just run, so wait past that floor before simulating the return -
        // otherwise the throttle correctly skips it and the test is testing
        // nothing.
        await page.waitForTimeout(3_500)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

        await expect(page.getByText(remoteTitle)).toBeVisible({ timeout: 20_000 })
        await expect(page.getByText('Device B')).toBeVisible()
    })

    test('pulled notes are re-encrypted under this device key', async ({ page, request }) => {
        // The server copy is readable, every local copy is not. That difference
        // is the whole architecture.
        await createUser(page, 'Device A', '1111')

        const id = `remote-${Date.now()}`
        const secret = `Secret body ${Date.now()}`
        await request.put(`/api/plain-notes/${id}`, {
            data: {
                id,
                title: 'Remote note',
                body: secret,
                author: 'Device B',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        })

        await page.waitForTimeout(3_500)
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await expect(page.getByText(secret)).toBeVisible({ timeout: 20_000 })

        const raw = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((res, rej) => {
                const r = indexedDB.open('lockbox')
                r.onsuccess = () => res(r.result)
                r.onerror = () => rej(r.error)
            })
            const notes = await new Promise<unknown[]>((res) => {
                const q = db.transaction('notes').objectStore('notes').getAll()
                q.onsuccess = () => res(q.result)
            })
            db.close()
            return JSON.stringify(notes)
        })

        expect(raw).not.toContain(secret)
    })

    test('local edits are pushed before remote changes are fetched', async ({ page }) => {
        // Drain-then-pull ordering: otherwise a stale server copy could win the
        // last-write-wins comparison against the user's own unsent edit.
        await createUser(page, 'Device A', '1111')
        await addNote(page, 'Local note')

        await expect(page.getByText('on server')).toBeVisible({ timeout: 20_000 })
        await expect(page.getByText('Local note')).toBeVisible()
    })
})
