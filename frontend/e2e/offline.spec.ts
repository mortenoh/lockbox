// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { expect, test } from '@playwright/test'

import {
    addNote,
    clearServer,
    createUser,
    readIndexedDb,
    waitForActivatedWorker,
    wipeDevice,
} from './helpers'

/**
 * Offline behaviour: the service worker, the outbox, and reconnection.
 *
 * `context.setOffline(true)` is used rather than killing the server, so the
 * service worker sees a genuine network failure while the test keeps control.
 */
test.describe('offline', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('the service worker registers and precaches the shell', async ({ page }) => {
        await page.goto('/')
        await waitForActivatedWorker(page)
        const registered = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready
            return { active: reg.active!.state, scope: new URL(reg.scope).pathname }
        })

        expect(registered.active).toBe('activated')
        // Scope must be '/' or the worker cannot control the whole app.
        expect(registered.scope).toBe('/')
    })

    test('the app loads offline from the cache', async ({ page, context }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await page.evaluate(() => navigator.serviceWorker.ready)

        await context.setOffline(true)
        await page.reload()

        // Served entirely from the service worker cache.
        await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible()
        await context.setOffline(false)
    })

    test('notes written offline are queued, not lost', async ({ page, context }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await context.setOffline(true)

        await addNote(page, 'Written offline', 'No connectivity')

        // exact: the composer's helper copy also contains the word "queued".
        await expect(page.getByText('queued', { exact: true })).toBeVisible()
        const { outbox, notes } = await readIndexedDb(page)
        expect(notes).toHaveLength(1)
        expect(outbox).toHaveLength(1)
        expect(outbox[0]).toMatchObject({ op: 'put', status: 'pending' })

        await context.setOffline(false)
    })

    test('the queue drains when connectivity returns', async ({ page, context }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await context.setOffline(true)
        await addNote(page, 'Queued note')

        await context.setOffline(false)
        await page.getByRole('button', { name: /Connection status/ }).click()
        await page.getByRole('button', { name: 'Sync now' }).click()

        await expect(page.getByText('on server')).toBeVisible({ timeout: 20_000 })
        const { outbox } = await readIndexedDb(page)
        expect(outbox).toHaveLength(0)
    })

    test('the outbox payload is self-contained ciphertext', async ({ page, context }) => {
        // Queue entries carry the whole encrypted record, so draining never has
        // to re-read the notes store or decrypt anything.
        await createUser(page, 'Ward 3 Clinic', '1111')
        await context.setOffline(true)
        await addNote(page, 'Payload check', 'body text')

        const { outbox } = await readIndexedDb(page)
        const payload = outbox[0].payload as Record<string, unknown>

        expect(payload).toHaveProperty('ciphertext')
        expect(payload).toHaveProperty('iv')
        expect(JSON.stringify(payload)).not.toContain('Payload check')
        expect(JSON.stringify(payload)).not.toContain('body text')

        await context.setOffline(false)
    })

    test('a note and its queue entry are written atomically', async ({ page, context }) => {
        // Previously two separate transactions, which could persist a note with
        // no queue entry - a change that would then never sync, silently.
        await createUser(page, 'Ward 3 Clinic', '1111')
        await context.setOffline(true)
        await addNote(page, 'Atomic note')

        const { notes, outbox } = await readIndexedDb(page)
        expect(notes).toHaveLength(1)
        expect(outbox).toHaveLength(1)
        expect(outbox[0].noteId).toBe(notes[0].id)
        expect(outbox[0].ownerId).toBe(notes[0].ownerId)

        await context.setOffline(false)
    })

    test('the status bar distinguishes offline from other states', async ({ page, context }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await context.setOffline(true)
        await page.getByRole('button', { name: /Connection status/ }).click()

        // Scoped to the popover: 'Offline' also appears on the trigger itself.
        await expect(
            page.getByRole('dialog').getByText('Offline', { exact: true }),
        ).toBeVisible()
        await context.setOffline(false)
    })
})

test.describe('offline routing', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a deep-linked page still loads offline', async ({ page, context }) => {
        // The payoff of HashRouter: the service worker only ever sees "/" for a
        // navigation, so the cached shell matches whatever route is in the hash.
        // A path-based router would need a server-side SPA fallback, which is
        // unreachable when offline.
        await createUser(page, 'Ward 3 Clinic', '1234')
        await page.locator('aside').getByRole('link', { name: /Security/ }).click()
        await page.evaluate(() => navigator.serviceWorker.ready)

        await context.setOffline(true)
        await page.reload()

        await expect(page).toHaveURL(/#\/security$/)
        await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible()

        await context.setOffline(false)
    })
})

test.describe('service worker updates', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a new worker activates instead of waiting', async ({ page }) => {
        // The bug this guards against: the worker deferred activation to a
        // SKIP_WAITING message that nothing ever sent, so a rebuilt worker sat
        // in "waiting" forever while the old one served a shell referencing
        // asset filenames that no longer existed. The page rendered blank, and
        // only a private window - with no old worker - looked fine.
        await page.goto('/')
        await waitForActivatedWorker(page)

        const state = await page.evaluate(async () => {
            const [reg] = await navigator.serviceWorker.getRegistrations()
            return {
                waiting: !!reg?.waiting,
                active: reg?.active?.state,
                controlled: !!navigator.serviceWorker.controller,
            }
        })

        expect(state.waiting).toBe(false)
        expect(state.active).toBe('activated')
        expect(state.controlled).toBe(true)
    })

    test('only the current cache survives', async ({ page }) => {
        // The activate handler evicts superseded caches, which only runs if the
        // worker actually activates.
        await page.goto('/')
        await waitForActivatedWorker(page)

        const names = await page.evaluate(() => caches.keys())
        expect(names).toHaveLength(1)
        expect(names[0]).toMatch(/^lockbox-[0-9a-f]{12}$/)
    })

    test('the cached shell references assets that exist', async ({ page }) => {
        // A shell pointing at rebuilt-away filenames is the blank page itself.
        await page.goto('/')
        await waitForActivatedWorker(page)

        const result = await page.evaluate(async () => {
            const html = await (await fetch('/', { cache: 'no-store' })).text()
            const match = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)
            if (!match) return { asset: null, status: 0 }
            return { asset: match[0], status: (await fetch(match[0])).status }
        })

        expect(result.asset).toBeTruthy()
        expect(result.status).toBe(200)
    })
})
