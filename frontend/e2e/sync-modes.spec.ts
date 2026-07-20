import { expect, test } from '@playwright/test'

import { addNote, createUser, goToPage, wipeDevice } from './helpers'

/**
 * The two sync modes, and the boundary between them.
 *
 * This is the project's central architectural claim: local storage is always
 * ciphertext, and what crosses the network depends on the mode. Asserting it
 * against the real server is more convincing than any prose.
 */
test.describe('sync modes', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await wipeDevice(page)
    })

    test('plaintext mode is the default', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await goToPage(page, 'Sync Modes')

        await expect(page.getByText('Plaintext sync').first()).toBeVisible()
        await expect(page.getByText('active')).toBeVisible()
    })

    test('plaintext mode sends readable data to the server', async ({ page, request }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        const title = `Readable ${Date.now()}`
        await addNote(page, title, 'Confirmed 14 cases')
        await expect(page.getByText('on server')).toBeVisible({ timeout: 20_000 })

        // The DHIS2-realistic path: the platform must be able to read this.
        const response = await request.get('/api/plain-notes')
        const body = await response.text()
        expect(body).toContain(title)
        expect(body).toContain('Ward 3 Clinic') // authorship travels too
    })

    test('local storage stays encrypted even in plaintext mode', async ({ page }) => {
        // Decryption happens at upload time only. At rest, always ciphertext.
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'Local stays secret', 'body')

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

        expect(raw).not.toContain('Local stays secret')
    })

    test('encrypted mode keeps the server unable to read anything', async ({ page, request }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await goToPage(page, 'Sync Modes')
        await page.getByRole('button', { name: 'Switch to this mode' }).click()

        await goToPage(page, 'Notes')
        const title = `Opaque ${Date.now()}`
        await addNote(page, title)
        await expect(page.getByText('on server')).toBeVisible({ timeout: 20_000 })

        const response = await request.get('/api/notes')
        const body = await response.text()
        expect(body).not.toContain(title)
        expect(body).toContain('ciphertext')
    })
})
