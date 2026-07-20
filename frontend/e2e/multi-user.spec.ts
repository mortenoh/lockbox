import { expect, test } from '@playwright/test'

import { addNote, clearServer, createUser, enterPin, readIndexedDb, wipeDevice } from './helpers'

/**
 * Several users sharing one device.
 *
 * This file exists because of a bug that destroyed data silently: the notes
 * store was keyed on `id` alone with `ownerId` as a mere index, so two users
 * holding copies of the same server record overwrote each other. Nothing
 * errored. The fix was a compound [ownerId, id] key, and these tests are what
 * stop it regressing.
 */
test.describe('multiple users on one device', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a second user can be added and listed', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await page.getByRole('button', { name: 'Sign out and switch user' }).click()

        await page.getByRole('button', { name: /Add user/ }).click()
        await page.getByLabel('Name').fill('District Office')
        await enterPin(page, '2222')
        await page.getByRole('button', { name: 'Create vault' }).click()

        await page.getByRole('button', { name: 'Sign out and switch user' }).click()
        await expect(page.getByText('Ward 3 Clinic')).toBeVisible()
        await expect(page.getByText('District Office')).toBeVisible()
    })

    test('each user sees only their own notes', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'Clinic note')
        await page.getByRole('button', { name: 'Sign out and switch user' }).click()

        await page.getByRole('button', { name: /Add user/ }).click()
        await page.getByLabel('Name').fill('District Office')
        await enterPin(page, '2222')
        await page.getByRole('button', { name: 'Create vault' }).click()

        // District Office must not see the clinic's note - not even as an
        // undecryptable placeholder.
        await expect(page.getByText('Clinic note')).toBeHidden()
        await expect(page.getByText('No notes yet')).toBeVisible()
    })

    test("one user's PIN cannot open another's vault", async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await page.getByRole('button', { name: 'Sign out and switch user' }).click()

        await page.getByRole('button', { name: /Add user/ }).click()
        await page.getByLabel('Name').fill('District Office')
        await enterPin(page, '2222')
        await page.getByRole('button', { name: 'Create vault' }).click()
        await page.getByRole('button', { name: 'Sign out and switch user' }).click()

        // Filter by text content, not accessible name: the row button's name
        // starts with the avatar initials, and the sibling Remove button is
        // icon-only so it carries the name but no text.
        await page.locator('button').filter({ hasText: 'Ward 3 Clinic' }).click()
        await enterPin(page, '2222') // the other user's PIN
        await page.getByRole('button', { name: 'Unlock', exact: true }).click()

        await expect(page.getByText('Wrong PIN.')).toBeVisible()
    })

    test('notes are keyed per user, so copies cannot collide', async ({ page }) => {
        // The exact shape of the shipped bug: two users, one shared server note
        // id. With a plain 'id' keyPath the second write replaced the first.
        await createUser(page, 'Ward 3 Clinic', '1111')

        const result = await page.evaluate(async () => {
            const db = await new Promise<IDBDatabase>((res, rej) => {
                const r = indexedDB.open('lockbox')
                r.onsuccess = () => res(r.result)
                r.onerror = () => rej(r.error)
            })

            const shared = 'shared-server-id'
            await new Promise<void>((res, rej) => {
                const tx = db.transaction('notes', 'readwrite')
                const store = tx.objectStore('notes')
                const base = { id: shared, createdAt: 1, updatedAt: 1, synced: true }
                store.put({ ...base, ownerId: 'alice', iv: 'A', ciphertext: 'ALICE' })
                store.put({ ...base, ownerId: 'bob', iv: 'B', ciphertext: 'BOB' })
                tx.oncomplete = () => res()
                tx.onerror = () => rej(tx.error)
            })

            const all = await new Promise<Record<string, unknown>[]>((res) => {
                const q = db.transaction('notes').objectStore('notes').getAll()
                q.onsuccess = () => res(q.result)
            })
            const keyPath = db.transaction('notes').objectStore('notes').keyPath
            db.close()

            return {
                keyPath,
                shared: all
                    .filter((n) => n.id === shared)
                    .map((n) => `${n.ownerId as string}:${n.ciphertext as string}`)
                    .sort(),
            }
        })

        expect(result.keyPath).toEqual(['ownerId', 'id'])
        expect(result.shared).toEqual(['alice:ALICE', 'bob:BOB'])
    })

    test('removing a user deletes only their records', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'Clinic note')
        await page.getByRole('button', { name: 'Sign out and switch user' }).click()

        await page.getByRole('button', { name: /Add user/ }).click()
        await page.getByLabel('Name').fill('District Office')
        await enterPin(page, '2222')
        await page.getByRole('button', { name: 'Create vault' }).click()
        await addNote(page, 'District note')

        const before = await readIndexedDb(page)
        expect(before.notes).toHaveLength(2)

        await page.getByRole('button', { name: 'Sign out and switch user' }).click()

        // An in-app AlertDialog now, not window.confirm - so confirm by
        // clicking, the way a user does.
        await page.getByRole('button', { name: 'Remove District Office' }).click()
        await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click()

        const after = await readIndexedDb(page)
        expect(after.notes).toHaveLength(1)
        expect(after.vaults).toHaveLength(1)
    })
})
