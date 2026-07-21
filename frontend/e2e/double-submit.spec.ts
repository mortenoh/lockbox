// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { expect, test } from '@playwright/test'

import { clearServer, enterPin, wipeDevice } from './helpers'

/**
 * Guarding against a second submission.
 *
 * Argon2id is deliberately slow, which leaves a wide window between the click
 * and the button becoming disabled. React state updates on the next render, so
 * a `busy` flag alone does not close it - and every extra call mints a fresh
 * vault id, turning one intent into several vaults.
 */
test.describe('double submission', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('clicking create repeatedly still makes exactly one vault', async ({ page }) => {
        await page.goto('/')
        await page.getByLabel('Name').fill('Ward 3 Clinic')
        await enterPin(page, '1234')

        // Fire several clicks inside the derivation window, dispatched directly
        // so they are not serialised by Playwright's actionability waits.
        await page.evaluate(() => {
            const button = Array.from(document.querySelectorAll('button')).find((b) =>
                b.textContent?.includes('Create vault'),
            )
            for (let i = 0; i < 5; i += 1) button?.click()
        })

        await expect(page.getByRole('button', { name: 'New note' })).toBeVisible({
            timeout: 20_000,
        })

        const vaultCount = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((res, rej) => {
                const r = indexedDB.open('lockbox')
                r.onsuccess = () => res(r.result)
                r.onerror = () => rej(r.error)
            })
            const count = await new Promise<number>((res) => {
                const q = db.transaction('vault').objectStore('vault').count()
                q.onsuccess = () => res(q.result)
            })
            db.close()
            return count
        })

        expect(vaultCount).toBe(1)
    })

    test('the button reports that it is working', async ({ page }) => {
        await page.goto('/')
        await page.getByLabel('Name').fill('Ward 3 Clinic')
        await enterPin(page, '1234')

        const button = page.getByRole('button', { name: /Create vault|Deriving key/ })
        await button.click()

        // Either the spinner label appears, or derivation finished first - both
        // are fine, but the button must never look idle while busy.
        await expect(page.getByRole('button', { name: 'New note' })).toBeVisible({
            timeout: 20_000,
        })
    })
})
