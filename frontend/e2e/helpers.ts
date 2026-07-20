import { expect, type Page } from '@playwright/test'

/**
 * Shared steps for driving the app.
 *
 * Kept deliberately close to what a user does - clicking real keys rather than
 * setting state - because that is how the PIN pad's stale-closure bug was
 * found. Four rapid taps all read the same render's value, and only a real
 * sequence of clicks reproduced it.
 */

/** Tap a PIN on the keypad, one real click per digit. */
export async function enterPin(page: Page, pin: string): Promise<void> {
    for (const digit of pin) {
        await page.getByRole('button', { name: digit, exact: true }).click()
    }
}

/** Create the first user on a fresh device. */
export async function createUser(page: Page, name: string, pin: string): Promise<void> {
    await page.goto('/')
    await page.getByLabel('Name').fill(name)
    await enterPin(page, pin)
    await page.getByRole('button', { name: 'Create vault' }).click()
    await expectUnlocked(page)
}

/**
 * Wait until the app is unlocked.
 *
 * Keys off the compose button rather than the "New note" card title: shadcn's
 * CardTitle renders a plain div, so getByRole('heading') never matches it.
 */
export async function expectUnlocked(page: Page): Promise<void> {
    await expect(page.getByRole('button', { name: 'Encrypt & save' })).toBeVisible()
}

/** Unlock an existing user from the picker. */
export async function unlockAs(page: Page, name: string, pin: string): Promise<void> {
    const picker = page.getByRole('button', { name: new RegExp(name) })
    if (await picker.isVisible().catch(() => false)) await picker.click()
    await enterPin(page, pin)
    await page.getByRole('button', { name: 'Unlock', exact: true }).click()
}

/** Write a note and wait for it to appear in the list. */
export async function addNote(page: Page, title: string, body = ''): Promise<void> {
    await page.getByLabel('Title').fill(title)
    if (body) await page.getByLabel('Body').fill(body)
    await page.getByRole('button', { name: 'Encrypt & save' }).click()
    await expect(page.getByText(title, { exact: true })).toBeVisible()
}

/** Navigate via the sidebar. */
export async function goToPage(page: Page, label: string): Promise<void> {
    await page.locator('aside').getByRole('button', { name: new RegExp(label) }).click()
}

/** Everything currently in IndexedDB, read without decrypting. */
export async function readIndexedDb(page: Page): Promise<{
    vaults: unknown[]
    notes: Record<string, unknown>[]
    outbox: Record<string, unknown>[]
}> {
    return page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
            const r = indexedDB.open('lockbox')
            r.onsuccess = () => res(r.result)
            r.onerror = () => rej(r.error)
        })
        const all = (store: string) =>
            new Promise<Record<string, unknown>[]>((res) => {
                const q = db.transaction(store).objectStore(store).getAll()
                q.onsuccess = () => res(q.result)
            })
        const result = {
            vaults: await all('vault'),
            notes: await all('notes'),
            outbox: await all('outbox'),
        }
        db.close()
        return result
    })
}

/** Wipe local state so a test can act as a brand-new device. */
export async function wipeDevice(page: Page): Promise<void> {
    await page.evaluate(async () => {
        for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister()
        for (const k of await caches.keys()) await caches.delete(k)
        localStorage.clear()
        await new Promise<void>((res) => {
            const d = indexedDB.deleteDatabase('lockbox')
            d.onsuccess = d.onerror = d.onblocked = () => res()
        })
    })
}
