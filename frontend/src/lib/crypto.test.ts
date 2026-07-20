// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { afterEach, describe, expect, it } from 'vitest'

import {
    ARGON2ID_LADDER,
    ARGON2ID_MIN_PARAMS,
    ARGON2ID_PARAMS,
    TARGET_UNLOCK_MS,
} from '@/lib/config'
import {
    calibrateKdfParams,
    changePassphrase,
    createVault,
    decryptJson,
    encryptJson,
    isUnlocked,
    lockVault,
    pickArgon2idParams,
    unlockVault,
    vaultKdf,
    type KdfParams,
    type VaultRecord,
} from '@/lib/crypto'

/**
 * Tiny parameters so each derivation is milliseconds. Only the vault
 * *creation* path accepts explicit parameters - production code always
 * calibrates - which is exactly what lets tests opt out of the cost.
 */
const TEST_ARGON2ID: KdfParams = { memorySize: 8_192, iterations: 1, parallelism: 1 }
const TEST_PBKDF2: KdfParams = { iterations: 1_000 }

const PASSPHRASE = 'correct horse battery staple'

afterEach(() => {
    lockVault()
})

describe('vault lifecycle', () => {
    it('creates a vault and leaves it unlocked', async () => {
        const vault = await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)
        expect(isUnlocked()).toBe(true)
        expect(vault.kdf).toBe('argon2id')
        expect(vault.params).toEqual(TEST_ARGON2ID)
        expect(vault.owner).toBe('tester')
    })

    it('unlocks with the right passphrase and refuses the wrong one', async () => {
        const vault = await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)
        lockVault()

        expect(await unlockVault('wrong', vault)).toBe(false)
        expect(isUnlocked()).toBe(false)
        expect(await unlockVault(PASSPHRASE, vault)).toBe(true)
        expect(isUnlocked()).toBe(true)
    })

    it('supports pbkdf2 vaults', async () => {
        const vault = await createVault(PASSPHRASE, 'tester', 'pbkdf2', TEST_PBKDF2)
        lockVault()
        expect(await unlockVault(PASSPHRASE, vault)).toBe(true)
    })

    it('treats a record without a kdf field as pbkdf2', () => {
        const legacy = { salt: 'x' } as unknown as VaultRecord
        expect(vaultKdf(legacy).kdf).toBe('pbkdf2')
        expect(vaultKdf(legacy).params.iterations).toBeGreaterThan(0)
    })
})

describe('record encryption', () => {
    it('round-trips JSON and uses a fresh IV per call', async () => {
        await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)

        const value = { title: 'a', body: 'b', author: 'c' }
        const first = await encryptJson(value)
        const second = await encryptJson(value)

        expect(first.iv).not.toBe(second.iv)
        expect(first.ciphertext).not.toBe(second.ciphertext)
        expect(await decryptJson(first)).toEqual(value)
        expect(await decryptJson(second)).toEqual(value)
    })

    it('refuses to work while locked', async () => {
        await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)
        const payload = await encryptJson({ x: 1 })
        lockVault()

        await expect(encryptJson({ x: 1 })).rejects.toThrow('Vault is locked')
        await expect(decryptJson(payload)).rejects.toThrow('Vault is locked')
    })

    it('rejects tampered ciphertext', async () => {
        await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)
        const payload = await encryptJson({ x: 1 })
        const flipped = payload.ciphertext.startsWith('A') ? 'B' : 'A'
        const tampered = { ...payload, ciphertext: flipped + payload.ciphertext.slice(1) }

        await expect(decryptJson(tampered)).rejects.toThrow()
    })
})

describe('changePassphrase', () => {
    it('re-wraps the DEK so old notes stay readable under the new passphrase', async () => {
        const vault = await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)
        const payload = await encryptJson({ body: 'written before the change' })

        const updated = await changePassphrase(PASSPHRASE, 'new-secret', vault, 'argon2id', TEST_ARGON2ID)
        expect(updated).not.toBeNull()
        // Fresh salt and IV, same wrapped secret underneath.
        expect(updated!.salt).not.toBe(vault.salt)
        expect(updated!.wrapIv).not.toBe(vault.wrapIv)

        lockVault()
        expect(await unlockVault(PASSPHRASE, updated!)).toBe(false)
        expect(await unlockVault('new-secret', updated!)).toBe(true)
        expect(await decryptJson(payload)).toEqual({ body: 'written before the change' })
    })

    it('returns null when the old passphrase is wrong', async () => {
        const vault = await createVault(PASSPHRASE, 'tester', 'argon2id', TEST_ARGON2ID)
        expect(await changePassphrase('wrong', 'new-secret', vault, 'argon2id', TEST_ARGON2ID)).toBeNull()
    })

    it('migrates between KDFs', async () => {
        const vault = await createVault(PASSPHRASE, 'tester', 'pbkdf2', TEST_PBKDF2)
        const migrated = await changePassphrase(PASSPHRASE, PASSPHRASE, vault, 'argon2id', TEST_ARGON2ID)

        expect(migrated!.kdf).toBe('argon2id')
        lockVault()
        expect(await unlockVault(PASSPHRASE, migrated!)).toBe(true)
    })
})

describe('pickArgon2idParams', () => {
    const cost = (p: KdfParams) => (p.memorySize ?? 0) * p.iterations
    const floorCost = cost(ARGON2ID_MIN_PARAMS)
    // The probe time above which a given tier is predicted to bust the budget.
    const probeLimitFor = (tier: KdfParams) => (TARGET_UNLOCK_MS * floorCost) / cost(tier)

    it('awards a fast device the ceiling', () => {
        expect(pickArgon2idParams(probeLimitFor(ARGON2ID_PARAMS))).toEqual(ARGON2ID_PARAMS)
    })

    it('steps a device ~10x slower than a dev laptop down the ladder', () => {
        // Dev laptop floor probe is ~26 ms, so a 10x device probes ~260 ms.
        const picked = pickArgon2idParams(260)
        expect(cost(picked)).toBeLessThan(cost(ARGON2ID_PARAMS))
        expect(cost(picked)).toBeGreaterThanOrEqual(floorCost)
        // And its predicted unlock still fits the budget.
        expect((cost(picked) / floorCost) * 260).toBeLessThanOrEqual(TARGET_UNLOCK_MS)
    })

    it('never goes below the floor, even when the floor busts the budget', () => {
        expect(pickArgon2idParams(TARGET_UNLOCK_MS * 100)).toEqual(ARGON2ID_MIN_PARAMS)
    })

    it('is monotonic: a slower probe never yields stronger parameters', () => {
        let previous = Number.POSITIVE_INFINITY
        for (let probeMs = 5; probeMs <= 5000; probeMs += 5) {
            const picked = cost(pickArgon2idParams(probeMs))
            expect(picked).toBeLessThanOrEqual(previous)
            previous = picked
        }
    })

    it('caps memory on low-RAM devices regardless of speed', () => {
        const fast = probeLimitFor(ARGON2ID_PARAMS)
        expect(pickArgon2idParams(fast, 1)!.memorySize).toBeLessThanOrEqual(32_768)
        expect(pickArgon2idParams(fast, 3)!.memorySize).toBeLessThanOrEqual(65_536)
        expect(pickArgon2idParams(fast, 8)).toEqual(ARGON2ID_PARAMS)
        expect(pickArgon2idParams(fast, undefined)).toEqual(ARGON2ID_PARAMS)
    })

    it('returns a copy, not a shared ladder entry', () => {
        const picked = pickArgon2idParams(1)
        expect(picked).toEqual(ARGON2ID_PARAMS)
        expect(picked).not.toBe(ARGON2ID_PARAMS)
    })
})

describe('calibrateKdfParams', () => {
    it('returns a tier from the ladder after a real probe', async () => {
        const params = await calibrateKdfParams('argon2id')
        expect(ARGON2ID_LADDER).toContainEqual(params)
    })
})
