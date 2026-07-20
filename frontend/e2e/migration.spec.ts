import { expect, test } from '@playwright/test'

import { wipeDevice } from './helpers'

/**
 * IndexedDB schema jumps must chain every intermediate step.
 *
 * An earlier upgrade path returned early after v1 → v2 and skipped the v2 → v3
 * compound-key rebuild when a client jumped straight from version 1 to 3.
 * Notes then stayed keyed by `id` alone, so two users pulling the same server
 * record could overwrite each other.
 */
test.describe('database migration', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/')
        await wipeDevice(page)
    })

    test('a v1 database upgrades through to compound note keys', async ({ page }) => {
        // Seed a v1-shaped database while the app is not holding a connection.
        await page.evaluate(async () => {
            await new Promise<void>((resolve, reject) => {
                const del = indexedDB.deleteDatabase('lockbox')
                del.onsuccess = () => resolve()
                del.onerror = () => reject(del.error)
                del.onblocked = () => resolve()
            })

            await new Promise<void>((resolve, reject) => {
                const req = indexedDB.open('lockbox', 1)
                req.onupgradeneeded = () => {
                    const db = req.result
                    db.createObjectStore('vault') // out-of-line keys, fixed "default"
                    db.createObjectStore('notes', { keyPath: 'id' })
                    db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true })
                }
                req.onsuccess = () => {
                    const db = req.result
                    const tx = db.transaction(['vault', 'notes', 'outbox'], 'readwrite')
                    tx.objectStore('vault').put(
                        {
                            salt: 'c2FsdA',
                            wrapIv: 'd3JhcGl2',
                            wrappedDek: 'd3JhcHBlZA',
                            kdf: 'argon2id',
                            params: { memorySize: 131072, iterations: 3, parallelism: 1 },
                            createdAt: Date.now(),
                        },
                        'default',
                    )
                    tx.objectStore('notes').put({
                        id: 'shared-note-id',
                        iv: 'aXY',
                        ciphertext: 'Y2lwaGVy',
                        createdAt: 1,
                        updatedAt: 1,
                        synced: false,
                    })
                    tx.objectStore('outbox').add({
                        op: 'put',
                        noteId: 'shared-note-id',
                        payload: null,
                        status: 'pending',
                        attempts: 0,
                        lastError: null,
                        queuedAt: Date.now(),
                    })
                    tx.oncomplete = () => {
                        db.close()
                        resolve()
                    }
                    tx.onerror = () => reject(tx.error)
                }
                req.onerror = () => reject(req.error)
            })
        })

        // App open at DB_VERSION 3 must chain v1 → v2 → v3.
        await page.reload()
        // Migrated vault keeps the data as "Existing user" on the picker.
        await expect(page.getByText('Who is using this device?')).toBeVisible({
            timeout: 15_000,
        })
        await expect(page.getByRole('button', { name: 'EU Existing user PIN' })).toBeVisible()

        const shape = await page.evaluate(async () => {
            return await new Promise<{
                version: number
                notesKeyPath: IDBValidKey | IDBValidKey[] | null
                noteOwnerId: string | undefined
                vaultCount: number
                outboxOwnerId: string | undefined
            }>((resolve, reject) => {
                const req = indexedDB.open('lockbox')
                req.onsuccess = () => {
                    const db = req.result
                    const version = db.version
                    const notes = db.transaction('notes').objectStore('notes')
                    const notesKeyPath = notes.keyPath
                    const vaults = db.transaction('vault').objectStore('vault')
                    const outbox = db.transaction('outbox').objectStore('outbox')

                    Promise.all([
                        new Promise<number>((res, rej) => {
                            const r = vaults.count()
                            r.onsuccess = () => res(r.result)
                            r.onerror = () => rej(r.error)
                        }),
                        new Promise<{ ownerId?: string } | undefined>((res, rej) => {
                            const r = notes.getAll()
                            r.onsuccess = () => res(r.result[0] as { ownerId?: string } | undefined)
                            r.onerror = () => rej(r.error)
                        }),
                        new Promise<{ ownerId?: string } | undefined>((res, rej) => {
                            const r = outbox.getAll()
                            r.onsuccess = () => res(r.result[0] as { ownerId?: string } | undefined)
                            r.onerror = () => rej(r.error)
                        }),
                    ])
                        .then(([vaultCount, note, entry]) => {
                            db.close()
                            resolve({
                                version,
                                notesKeyPath,
                                noteOwnerId: note?.ownerId,
                                vaultCount,
                                outboxOwnerId: entry?.ownerId,
                            })
                        })
                        .catch(reject)
                }
                req.onerror = () => reject(req.error)
            })
        })

        expect(shape.version).toBe(3)
        expect(shape.notesKeyPath).toEqual(['ownerId', 'id'])
        expect(shape.vaultCount).toBe(1)
        expect(shape.noteOwnerId).toBeTruthy()
        expect(shape.outboxOwnerId).toBe(shape.noteOwnerId)
    })
})
