// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { expect, test } from '@playwright/test'

import {
    addNote,
    clearServer,
    createUser,
    enterPin,
    expectUnlocked,
    readIndexedDb,
    wipeDevice,
} from './helpers'

/**
 * Vault lifecycle: creation, locking, unlocking, and the encryption claim.
 *
 * These run against real Web Crypto - a real Argon2id derivation and real
 * AES-GCM - so a passing test means the scheme actually works, not that a mock
 * agreed with itself.
 */
test.describe('vault', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('first run creates a vault and unlocks it', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await expectUnlocked(page)
    })

    test('the PIN pad registers every digit', async ({ page }) => {
        // Regression: each key handler closed over the value as it was at render
        // time, so several quick taps all computed from the same stale string
        // and only one digit survived.
        await page.goto('/')
        await page.getByLabel('Name').fill('Digit Test')
        await enterPin(page, '1234')

        await expect(page.getByRole('button', { name: 'Create vault' })).toBeEnabled()
    })

    test('a wrong PIN is rejected and the vault stays locked', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await page.getByRole('button', { name: /Lock/ }).click()

        await enterPin(page, '9999')
        await page.getByRole('button', { name: 'Unlock', exact: true }).click()

        // Detected by AES-GCM's auth tag failing during unwrap - there is no
        // stored password hash being compared.
        await expect(page.getByText('Wrong PIN.')).toBeVisible()
        await expect(page.getByRole('button', { name: 'New note' })).toBeHidden()
    })

    test('the correct PIN unlocks and decrypts existing notes', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'Malaria cases W12', 'Confirmed 14')

        await page.getByRole('button', { name: /Lock/ }).click()
        await enterPin(page, '1111')
        await page.getByRole('button', { name: 'Unlock', exact: true }).click()

        await expect(page.getByText('Malaria cases W12')).toBeVisible()
        await expect(page.getByText('Confirmed 14')).toBeVisible()
    })

    test('no plaintext reaches IndexedDB', async ({ page }) => {
        // The project's central claim, checked against raw storage.
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'Sensitive title', 'Sensitive body text')

        const { notes, vaults } = await readIndexedDb(page)
        const raw = JSON.stringify({ notes, vaults })

        expect(raw).not.toContain('Sensitive title')
        expect(raw).not.toContain('Sensitive body text')
        expect(notes[0]).toHaveProperty('ciphertext')
        expect(notes[0]).toHaveProperty('iv')
    })

    test('the stored vault reveals only wrapped key material', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')

        const { vaults } = await readIndexedDb(page)
        const vault = vaults[0] as Record<string, unknown>

        expect(vault).toMatchObject({ kdf: 'argon2id', owner: 'Ward 3 Clinic' })
        expect(vault).toHaveProperty('wrappedDek')
        expect(vault).toHaveProperty('salt')
        // The PIN must not be recoverable from anything persisted.
        expect(JSON.stringify(vault)).not.toContain('1111')
    })

    test('each note gets a unique IV', async ({ page }) => {
        // Reusing an IV under one AES-GCM key is catastrophic, so this is worth
        // asserting rather than trusting.
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'First note')
        await addNote(page, 'Second note')
        await addNote(page, 'Third note')

        const { notes } = await readIndexedDb(page)
        const ivs = notes.map((n) => n.iv as string)

        expect(ivs).toHaveLength(3)
        expect(new Set(ivs).size).toBe(3)
    })

    test('locking clears decrypted content from the screen', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1111')
        await addNote(page, 'Secret note')

        await page.getByRole('button', { name: /Lock/ }).click()

        await expect(page.getByText('Secret note')).toBeHidden()
        await expect(page.getByRole('button', { name: 'Unlock', exact: true })).toBeVisible()
    })
})

test.describe('create-form validation', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('an incomplete form cannot be submitted at all', async ({ page }) => {
        // Better than accepting the submission and answering with an error,
        // which is what used to happen - and which pushed the keypad down.
        const submit = page.getByRole('button', { name: 'Create vault' })
        await expect(submit).toBeDisabled()

        await enterPin(page, '1234')
        await expect(submit).toBeDisabled() // still no name

        await page.getByLabel('Name').fill('Ward 3 Clinic')
        await expect(submit).toBeEnabled()
    })

    test('the keypad never moves as the form is filled in', async ({ page }) => {
        // Regression: the advisory only rendered past four digits, so the keys
        // shifted upward under the user's finger mid-entry.
        const key = page.getByRole('button', { name: '1', exact: true })
        const top = async () => Math.round((await key.boundingBox())!.y)

        const empty = await top()
        await enterPin(page, '12')
        const partial = await top()
        await page.getByLabel('Name').fill('Ward 3 Clinic')
        await enterPin(page, '34')
        const complete = await top()

        expect(Math.abs(partial - empty)).toBeLessThanOrEqual(2)
        expect(Math.abs(complete - empty)).toBeLessThanOrEqual(2)
    })

    test('a well-known PIN is called out', async ({ page }) => {
        await page.getByLabel('Name').fill('Ward 3 Clinic')
        await enterPin(page, '1111')

        await expect(page.getByText(/one of the most frequently chosen PINs/)).toBeVisible()
        // Still allowed - it is advice, not a policy.
        await expect(page.getByRole('button', { name: 'Create vault' })).toBeEnabled()
    })
})

test.describe('security page', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('no token field when the server does not want one', async ({ page }) => {
        // The e2e server runs with --auth none, so asking for a credential
        // would be requesting a secret that has no use - and implying an
        // authentication step that does not exist.
        await createUser(page, 'Ward 3 Clinic', '1234')
        await page.locator('aside').getByRole('link', { name: /Security/ }).click()

        await expect(page.getByText('nothing to configure')).toBeVisible()
        await expect(page.locator('#api-token')).toBeHidden()
    })
})

test.describe('routing', () => {
    test.beforeEach(async ({ page, request }) => {
        await clearServer(request)
        await page.goto('/')
        await wipeDevice(page)
    })

    test('each page has its own URL', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1234')

        await page.locator('aside').getByRole('link', { name: /Security/ }).click()
        await expect(page).toHaveURL(/#\/security$/)

        await page.locator('aside').getByRole('link', { name: /KDF Lab/ }).click()
        await expect(page).toHaveURL(/#\/kdf$/)
    })

    test('a reload returns to the same page, not the start', async ({ page }) => {
        // The vault still has to be unlocked again - the key cannot survive a
        // reload - but the app should not also forget where you were.
        await createUser(page, 'Ward 3 Clinic', '1234')
        await page.locator('aside').getByRole('link', { name: /Security/ }).click()
        await expect(page).toHaveURL(/#\/security$/)

        await page.reload()

        await expect(page).toHaveURL(/#\/security$/)
        await enterPin(page, '1234')
        await page.getByRole('button', { name: 'Unlock', exact: true }).click()

        // Scoped to the content area: the sidebar link matches too.
        await expect(page.locator('main').getByRole('heading', { name: 'Security' })).toBeVisible()
    })

    test('browser back navigates between pages', async ({ page }) => {
        await createUser(page, 'Ward 3 Clinic', '1234')
        await page.locator('aside').getByRole('link', { name: /KDF Lab/ }).click()
        await page.locator('aside').getByRole('link', { name: /At Rest/ }).click()
        await expect(page).toHaveURL(/#\/storage$/)

        await page.goBack()
        await expect(page).toHaveURL(/#\/kdf$/)
    })
})
