import { expect, test } from '@playwright/test'

import { addNote, clearServer, createUser, readIndexedDb, wipeDevice } from './helpers'

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
        const registered = await page.evaluate(async () => {
            const reg = await navigator.serviceWorker.ready
            // `ready` resolves as soon as there is an active worker, which may
            // still be 'activating'. Wait for it to finish before asserting.
            const worker = reg.active!
            if (worker.state !== 'activated') {
                await new Promise<void>((res) => {
                    worker.addEventListener('statechange', function onChange() {
                        if (worker.state === 'activated') {
                            worker.removeEventListener('statechange', onChange)
                            res()
                        }
                    })
                })
            }
            return { active: worker.state, scope: new URL(reg.scope).pathname }
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

        await expect(page.getByText('this device only')).toBeVisible()
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
