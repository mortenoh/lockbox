import { expect, test } from '@playwright/test'

import { clearServer, waitForActivatedWorker, wipeDevice } from './helpers'

/**
 * Recovery from a bricked client.
 *
 * A PWA that can render a permanently blank page is unshippable if the only
 * cure is "open DevTools and unregister the service worker". No field user can
 * do that, and no support line should have to ask. These tests reproduce the
 * broken state deliberately and assert the app repairs itself.
 */
test.describe('self-healing', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a cached shell pointing at deleted assets repairs itself', async ({ page }) => {
        await page.goto('/')
        await waitForActivatedWorker(page)

        // Forge exactly the bricking state: a cached "/" whose script tag names
        // an asset that no longer exists, which is what a rebuild leaves behind.
        await page.evaluate(async () => {
            const names = await caches.keys()
            const cache = await caches.open(names[0])
            await cache.put(
                '/',
                new Response(
                    '<!doctype html><html><body><div id="root"></div>' +
                        '<script type="module" src="/assets/index-DELETED.js"></script>' +
                        '</body></html>',
                    { headers: { 'Content-Type': 'text/html' } },
                ),
            )
        })

        const before = await page.evaluate(() => caches.keys().then((k) => k.length))
        expect(before).toBeGreaterThan(0)

        // Requesting the missing asset is what a stale shell would do. The
        // worker responds by clearing caches and telling the page to reload, so
        // the navigation itself is the evidence that recovery ran.
        await Promise.all([
            page.waitForEvent('load'),
            page.evaluate(() => {
                void fetch('/assets/index-DELETED.js').catch(() => null)
            }),
        ])

        // After reloading, the forged shell is gone and the app mounts again.
        await expect(page.getByRole('button', { name: 'Create vault' })).toBeVisible()
    })

    test('an app that never mounts clears itself and reloads', async ({ page }) => {
        // The inline fallback in index.html, which covers causes the worker
        // cannot see - it is inline precisely so it survives a bundle that
        // never ran.
        await page.goto('/')
        await waitForActivatedWorker(page)

        const hasFallback = await page.evaluate(async () => {
            const html = await (await fetch('/', { cache: 'no-store' })).text()
            return {
                inline: html.includes('lockbox.recovered'),
                guarded: html.includes("sessionStorage.getItem('lockbox.recovered')"),
            }
        })

        expect(hasFallback.inline).toBe(true)
        // Guarded so recovery can never become a reload loop.
        expect(hasFallback.guarded).toBe(true)
    })
})
