import { expect, test } from '@playwright/test'

import { wipeDevice } from './helpers'

/**
 * A blocked IndexedDB upgrade.
 *
 * This reproduces the failure that survived clearing the service worker, the
 * Cache Storage and the HTTP cache - because none of them were involved. An
 * upgrade cannot start while another connection is open on the old version, and
 * `onblocked` was unhandled, so the open promise never settled and the sign-in
 * screen rendered nothing at all. Permanently.
 */
test.describe('blocked database upgrade', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a hung open surfaces an error rather than a blank page', async ({ page }) => {
        await page.goto('/')

        // Hold the database open at a *higher* version so the app's own open
        // request is blocked, which is the same shape as an old tab blocking a
        // new one.
        await page.evaluate(async () => {
            await new Promise<void>((resolve) => {
                const req = indexedDB.open('lockbox', 99)
                req.onsuccess = () => resolve()
                req.onerror = () => resolve()
                req.onblocked = () => resolve()
            })
        })

        await page.reload()

        // The screen must say something. Anything but blank.
        const body = page.locator('body')
        await expect(body).not.toBeEmpty()
        await expect(
            page.getByText(/Cannot open local storage|Opening local storage/),
        ).toBeVisible({ timeout: 15_000 })
    })

    test('an open connection yields when another tab needs to upgrade', async ({ page }) => {
        // onversionchange closing the connection is what stops one stale tab
        // blocking every other tab indefinitely.
        await page.goto('/')
        await page.evaluate(() => navigator.serviceWorker.ready)

        const yielded = await page.evaluate(async () => {
            // The app has a connection open. Ask for a higher version: if the
            // existing connection yields, this completes rather than blocking.
            return await new Promise<string>((resolve) => {
                const req = indexedDB.open('lockbox', 50)
                req.onsuccess = () => {
                    req.result.close()
                    resolve('upgraded')
                }
                req.onblocked = () => resolve('blocked')
                req.onerror = () => resolve('error')
                setTimeout(() => resolve('timeout'), 8000)
            })
        })

        expect(yielded).toBe('upgraded')
    })
})
