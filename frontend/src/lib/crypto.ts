/**
 * Client-side envelope encryption on top of the Web Crypto API.
 *
 * ============================================================================
 * THE SCHEME
 * ============================================================================
 *
 * Two keys, not one:
 *
 *   DEK (data encryption key)  A random 256-bit AES-GCM key. Encrypts the notes.
 *                              Never derived from anything, never leaves memory
 *                              in usable form.
 *   KEK (key encryption key)   Derived from the user's passphrase. Its only job
 *                              is to encrypt ("wrap") the DEK.
 *
 * What actually gets persisted is the *wrapped* DEK, plus the salt and IV needed
 * to unwrap it. All three are safe to store in the clear: without the passphrase
 * they are inert bytes.
 *
 *     passphrase ──(Argon2id + salt)──▶ KEK ──(AES-GCM unwrap)──▶ DEK ──▶ notes
 *
 * WHY THE EXTRA LAYER? Two concrete payoffs:
 *
 *   1. Changing the passphrase re-wraps one 32-byte key instead of decrypting
 *      and re-encrypting every note. See `changePassphrase`.
 *   2. Multiple unlock methods can wrap the *same* DEK. A WebAuthn/Touch ID
 *      unlock would just be a second envelope over the same key - the notes
 *      never know the difference. (Roadmap.)
 *
 * ============================================================================
 * THREAT MODEL - read this before trusting any of it
 * ============================================================================
 *
 * ✅ Protects: a lost or stolen device. An attacker holding the browser profile
 *    finds ciphertext, a salt, and a wrapped key. Without the passphrase, that
 *    is all they will ever have.
 *
 * ❌ Does NOT protect: a compromised running page. Once unlocked, the DEK is a
 *    live object in this tab's memory. Any injected script (XSS) can use it.
 *    Marking the key non-extractable stops its *bytes* being read, not its
 *    *use* - an attacker can still call decrypt(). This is a real limit of
 *    doing crypto in a web page, not something a better design fixes here.
 *
 * ❌ Not end-to-end encryption between users. See `sync.ts` and the DHIS2 docs:
 *    when the backend must share records between users, the data has to arrive
 *    readable, and this encryption is local-only.
 */

import { argon2id } from 'hash-wasm'

import type { PrfEnvelope } from '@/lib/webauthn'

// ============================================================================
// Key derivation parameters
// ============================================================================

/**
 * Argon2id parameters. The default KDF for new vaults.
 *
 * Argon2id is *memory-hard*: every guess must allocate `memorySize` of RAM.
 * That is the whole point. PBKDF2 is merely CPU-hard, and a GPU can run tens of
 * thousands of SHA-256 chains in parallel at almost no memory cost per lane, so
 * an attacker's advantage over one browser thread is enormous. Forcing 128 MiB
 * per guess caps how many guesses fit on a card and shrinks that advantage by
 * orders of magnitude.
 *
 * This only matters for weak passphrases - and users choose weak passphrases.
 *
 * Values follow OWASP's 2026 baseline, raised substantially on memory. Chosen
 * from measurements rather than taste - the KDF Lab timed these on an Apple
 * Silicon laptop:
 *
 *      64 MiB / 3 passes -> 121 ms   (previous default, too cheap)
 *      96 MiB / 3 passes -> 197 ms
 *     128 MiB / 3 passes -> 263 ms   <- current
 *     128 MiB / 4 passes -> 355 ms
 *     192 MiB / 3 passes -> 402 ms
 *     256 MiB / 3 passes -> 554 ms
 *
 * The target is roughly 250-500 ms for one derivation. 128 MiB doubles the
 * memory an attacker must commit per guess while staying comfortably
 * allocatable on a phone, and leaves headroom for slower hardware: a low-end
 * Android tablet can be 3-4x slower, which would push the 128/4 option past a
 * second and make unlocking feel broken.
 *
 * Benchmark on the weakest device you must support before raising this further.
 * Existing vaults keep their own recorded parameters, so a change here only
 * affects new ones - see `vaultKdf`.
 */
export const ARGON2ID_PARAMS = {
    /**
     * KiB of memory per guess. The parameter that actually hurts attackers,
     * because it caps how many guesses fit on a GPU rather than merely slowing
     * each one down.
     */
    memorySize: 131_072, // 128 MiB
    /** Passes over memory. Raises cost linearly for attacker and defender alike. */
    iterations: 3,
    /** Lanes. Kept at 1 - browsers give us no reliable parallelism here. */
    parallelism: 1,
} as const

/**
 * PBKDF2 iteration count (OWASP 2026 guidance for HMAC-SHA256).
 *
 * Retained for two reasons: opening vaults created before Argon2id, and serving
 * as the comparison arm in the KDF Lab. Not recommended for new vaults.
 */
export const PBKDF2_ITERATIONS = 600_000

const SALT_BYTES = 16
/** 96 bits - the IV size AES-GCM is actually specified for. Do not change. */
const IV_BYTES = 12
const DEK_BITS = 256

/** Which key-derivation function a vault uses. */
export type KdfId = 'argon2id' | 'pbkdf2'

/** The KDF used for vaults created from now on. */
export const DEFAULT_KDF: KdfId = 'argon2id'

/** Tunables recorded alongside the vault so old vaults stay openable. */
export interface KdfParams {
    iterations: number
    memorySize?: number
    parallelism?: number
}

/**
 * What gets written to IndexedDB. Every field here is safe in the clear.
 *
 * Storing the KDF *and its parameters* is what makes future migration possible:
 * costs can be raised, or the algorithm swapped, without stranding vaults that
 * already exist.
 */
export interface VaultRecord {
    /** Stable local id. One vault per user on this device. */
    id: string
    /** Random per-vault salt (base64url). Stops precomputed-table attacks. */
    salt: string
    /** IV used when wrapping the DEK (base64url). */
    wrapIv: string
    /** The DEK, encrypted under the KEK (base64url). The valuable part. */
    wrappedDek: string
    kdf: KdfId
    params: KdfParams
    createdAt: number
    /**
     * Optional second envelope over the same DEK, opened by an authenticator
     * instead of the PIN. Adding it never touches a single note.
     */
    prf?: PrfEnvelope
    /**
     * Display name for whoever owns this device's vault.
     *
     * Deliberately NOT encrypted: it is not a secret, it has to be readable
     * before unlock to label the lock screen, and the same name is published to
     * the server with every note anyway. In a real DHIS2 app this would come
     * from the authenticated session instead of being self-declared.
     */
    owner: string
}

/** An AES-GCM ciphertext together with the IV needed to decrypt it. */
export interface EncryptedPayload {
    iv: string
    ciphertext: string
}

/** The decrypted contents of a note. */
export interface NoteContent {
    title: string
    body: string
    /** Display name of whoever wrote it. Travels inside the ciphertext locally. */
    author: string
}

/**
 * The unwrapped DEK.
 *
 * Module-scoped and memory-only. Never persisted, never serialised, dropped by
 * `lockVault`. JavaScript cannot reliably zero memory, but a non-extractable
 * CryptoKey never exposes its bytes to JS in the first place.
 */
let sessionKey: CryptoKey | null = null

// ============================================================================
// Encoding helpers
// ============================================================================

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encode bytes as base64url: JSON- and URL-safe, unpadded. */
export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
    const view = new Uint8Array(bytes)
    let binary = ''
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode base64url back into bytes. */
export function fromBase64(text: string): Uint8Array {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

/** Cryptographically secure random bytes. Never use Math.random here. */
function randomBytes(length: number): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(length))
}

/**
 * Hand Web Crypto a plain ArrayBuffer.
 *
 * A Uint8Array can be a view onto part of a larger buffer; passing it straight
 * through can silently hand over the wrong bytes. `.slice()` copies exactly the
 * view's range.
 */
function bytesOf(value: Uint8Array): ArrayBuffer {
    return value.slice().buffer
}

// ============================================================================
// Key derivation
// ============================================================================

/**
 * Stretch a passphrase into a key-encryption key.
 *
 * The returned KEK is non-extractable and usable *only* for wrap/unwrap. It
 * cannot encrypt a note even by mistake, and its bytes can never be read back
 * out - the narrowest capability that does the job.
 */
async function deriveKek(
    passphrase: string,
    salt: Uint8Array,
    kdf: KdfId,
    params: KdfParams,
): Promise<CryptoKey> {
    const raw =
        kdf === 'argon2id'
            ? await deriveArgon2id(passphrase, salt, params)
            : await derivePbkdf2Bits(passphrase, salt, params)

    return crypto.subtle.importKey('raw', bytesOf(raw), { name: 'AES-GCM', length: DEK_BITS }, false, [
        'wrapKey',
        'unwrapKey',
    ])
}

/**
 * Argon2id via WASM (hash-wasm).
 *
 * Web Crypto has no Argon2 - `crypto.subtle` only offers PBKDF2 - so this costs
 * a ~40 KB WASM payload. It precaches into the service worker with the rest of
 * the app, so the vault still opens with no network.
 */
async function deriveArgon2id(
    passphrase: string,
    salt: Uint8Array,
    params: KdfParams,
): Promise<Uint8Array> {
    return argon2id({
        password: passphrase,
        salt,
        memorySize: params.memorySize ?? ARGON2ID_PARAMS.memorySize,
        iterations: params.iterations,
        parallelism: params.parallelism ?? ARGON2ID_PARAMS.parallelism,
        hashLength: DEK_BITS / 8,
        outputType: 'binary',
    })
}

/** PBKDF2-HMAC-SHA256 via native Web Crypto. Legacy vaults and benchmarking. */
async function derivePbkdf2Bits(
    passphrase: string,
    salt: Uint8Array,
    params: KdfParams,
): Promise<Uint8Array> {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveBits'],
    )

    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: bytesOf(salt), iterations: params.iterations, hash: 'SHA-256' },
        baseKey,
        DEK_BITS,
    )

    return new Uint8Array(bits)
}

/** Default parameters for a KDF, used when creating a vault. */
export function defaultParams(kdf: KdfId): KdfParams {
    return kdf === 'argon2id' ? { ...ARGON2ID_PARAMS } : { iterations: PBKDF2_ITERATIONS }
}

/**
 * Derive a KEK and report how long it took.
 *
 * Exposed for the KDF Lab, which compares algorithms and parameters on the
 * actual device. Timing is the only honest way to choose parameters: guidance
 * is a starting point, the device decides.
 */
export async function benchmarkKdf(
    passphrase: string,
    kdf: KdfId,
    params: KdfParams,
): Promise<number> {
    const salt = randomBytes(SALT_BYTES)
    const started = performance.now()
    await deriveKek(passphrase, salt, kdf, params)
    return performance.now() - started
}

// ============================================================================
// Vault lifecycle
// ============================================================================

/**
 * Create a new vault for a passphrase.
 *
 * Generates a random DEK, wraps it under a passphrase-derived KEK, and returns
 * the material to persist. Also leaves the vault unlocked, so the caller does
 * not have to immediately ask for the passphrase again.
 */
export async function createVault(
    passphrase: string,
    owner: string,
    kdf: KdfId = DEFAULT_KDF,
): Promise<VaultRecord> {
    const salt = randomBytes(SALT_BYTES)
    const wrapIv = randomBytes(IV_BYTES)
    const params = defaultParams(kdf)
    const kek = await deriveKek(passphrase, salt, kdf, params)

    // Generated extractable *only* so it can be wrapped below. The handle kept
    // for the session is the non-extractable one produced by unwrapKey.
    const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: DEK_BITS }, true, [
        'encrypt',
        'decrypt',
    ])

    const wrappedDek = await crypto.subtle.wrapKey('raw', dek, kek, {
        name: 'AES-GCM',
        iv: bytesOf(wrapIv),
    })

    sessionKey = await crypto.subtle.unwrapKey(
        'raw',
        wrappedDek,
        kek,
        { name: 'AES-GCM', iv: bytesOf(wrapIv) },
        { name: 'AES-GCM', length: DEK_BITS },
        false, // non-extractable from here on
        ['encrypt', 'decrypt'],
    )

    return {
        id: crypto.randomUUID(),
        salt: toBase64(salt),
        wrapIv: toBase64(wrapIv),
        wrappedDek: toBase64(wrappedDek),
        kdf,
        params,
        createdAt: Date.now(),
        owner,
    }
}

/**
 * Read a vault's KDF settings, tolerating records written before `kdf` existed.
 *
 * Any vault without an explicit `kdf` predates Argon2id and must be PBKDF2 -
 * guessing wrong would make a correct passphrase look wrong.
 */
export function vaultKdf(vault: VaultRecord): { kdf: KdfId; params: KdfParams } {
    const kdf: KdfId = vault.kdf ?? 'pbkdf2'
    return { kdf, params: vault.params ?? { iterations: PBKDF2_ITERATIONS } }
}

/**
 * Unlock an existing vault.
 *
 * Note there is no stored password hash, and no comparison against one. A wrong
 * passphrase yields a wrong KEK, and AES-GCM's authentication tag fails during
 * unwrap - so `unwrapKey` throws. Verification is a side effect of the
 * cryptography, which means there is nothing on disk for an attacker to test
 * guesses against offline except the wrapped key itself.
 *
 * @returns true on success, false if the passphrase was wrong.
 */
export async function unlockVault(passphrase: string, vault: VaultRecord): Promise<boolean> {
    const { kdf, params } = vaultKdf(vault)
    const kek = await deriveKek(passphrase, fromBase64(vault.salt), kdf, params)

    try {
        sessionKey = await crypto.subtle.unwrapKey(
            'raw',
            bytesOf(fromBase64(vault.wrappedDek)),
            kek,
            { name: 'AES-GCM', iv: bytesOf(fromBase64(vault.wrapIv)) },
            { name: 'AES-GCM', length: DEK_BITS },
            false,
            ['encrypt', 'decrypt'],
        )
        return true
    } catch {
        // Wrong passphrase (or tampered vault). Indistinguishable by design.
        sessionKey = null
        return false
    }
}

/** Drop the in-memory DEK. Stored notes become unreadable again immediately. */
export function lockVault(): void {
    sessionKey = null
}

/** Whether a DEK is currently held in memory. */
export function isUnlocked(): boolean {
    return sessionKey !== null
}

// ============================================================================
// Record encryption
// ============================================================================

/**
 * Encrypt a JSON-serialisable value with the session DEK.
 *
 * A fresh random IV per call, always. Reusing an IV under the same AES-GCM key
 * is catastrophic - it leaks the XOR of the plaintexts and can expose the
 * authentication subkey, breaking forgery resistance entirely. This is the
 * single easiest way to destroy GCM, so the IV is generated here and never
 * cached, reused, or derived from the content.
 */
export async function encryptJson(value: unknown): Promise<EncryptedPayload> {
    if (!sessionKey) throw new Error('Vault is locked')

    const iv = randomBytes(IV_BYTES)
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: bytesOf(iv) },
        sessionKey,
        encoder.encode(JSON.stringify(value)),
    )

    return { iv: toBase64(iv), ciphertext: toBase64(ciphertext) }
}

/**
 * Decrypt a record produced by {@link encryptJson}.
 *
 * Throws if the ciphertext was altered or the wrong key is loaded: AES-GCM
 * verifies integrity before returning anything, so tampering surfaces as an
 * error rather than as plausible-looking garbage.
 */
export async function decryptJson<T>(record: EncryptedPayload): Promise<T> {
    if (!sessionKey) throw new Error('Vault is locked')

    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytesOf(fromBase64(record.iv)) },
        sessionKey,
        bytesOf(fromBase64(record.ciphertext)),
    )

    return JSON.parse(decoder.decode(plaintext)) as T
}

/**
 * Change the passphrase, or migrate the vault to a different KDF.
 *
 * The envelope earns its keep here: unwrap the DEK with the old KEK, re-wrap it
 * with the new one. Notes are untouched, so this is O(1) rather than O(notes)
 * and cannot half-fail across a large dataset. Migrating a PBKDF2 vault to
 * Argon2id is the same operation with a different `kdf` argument.
 *
 * @returns updated vault material to persist, or null if the old passphrase was wrong.
 */
export async function changePassphrase(
    oldPassphrase: string,
    newPassphrase: string,
    vault: VaultRecord,
    kdf: KdfId = DEFAULT_KDF,
): Promise<VaultRecord | null> {
    const current = vaultKdf(vault)
    const oldKek = await deriveKek(
        oldPassphrase,
        fromBase64(vault.salt),
        current.kdf,
        current.params,
    )

    let dek: CryptoKey
    try {
        dek = await crypto.subtle.unwrapKey(
            'raw',
            bytesOf(fromBase64(vault.wrappedDek)),
            oldKek,
            { name: 'AES-GCM', iv: bytesOf(fromBase64(vault.wrapIv)) },
            { name: 'AES-GCM', length: DEK_BITS },
            true, // extractable, so it can be re-wrapped under the new KEK
            ['encrypt', 'decrypt'],
        )
    } catch {
        return null
    }

    // Fresh salt and IV: reusing either across a passphrase change would leak
    // information about the relationship between the old and new keys.
    const salt = randomBytes(SALT_BYTES)
    const wrapIv = randomBytes(IV_BYTES)
    const params = defaultParams(kdf)
    const newKek = await deriveKek(newPassphrase, salt, kdf, params)
    const wrappedDek = await crypto.subtle.wrapKey('raw', dek, newKek, {
        name: 'AES-GCM',
        iv: bytesOf(wrapIv),
    })

    return {
        ...vault,
        salt: toBase64(salt),
        wrapIv: toBase64(wrapIv),
        wrappedDek: toBase64(wrappedDek),
        kdf,
        params,
    }
}

/**
 * Adopt a DEK obtained by some other means (currently a biometric unwrap).
 *
 * Lets an alternative unlock path hand the session key over without this module
 * needing to know anything about how it was recovered.
 */
export function adoptSessionKey(dek: CryptoKey): void {
    sessionKey = dek
}

/**
 * Recover the DEK in *extractable* form, for wrapping under a second envelope.
 *
 * Enrolling biometrics needs the raw key to re-wrap it, and the session key is
 * deliberately non-extractable - so the PIN must be supplied again. That is not
 * an inconvenience to work around: it is what stops someone who finds an
 * unlocked laptop from silently binding their own fingerprint to the vault.
 *
 * @returns an extractable DEK, or null if the PIN was wrong.
 */
export async function exportDekForRewrap(
    passphrase: string,
    vault: VaultRecord,
): Promise<CryptoKey | null> {
    const { kdf, params } = vaultKdf(vault)
    const kek = await deriveKek(passphrase, fromBase64(vault.salt), kdf, params)

    try {
        return await crypto.subtle.unwrapKey(
            'raw',
            bytesOf(fromBase64(vault.wrappedDek)),
            kek,
            { name: 'AES-GCM', iv: bytesOf(fromBase64(vault.wrapIv)) },
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt'],
        )
    } catch {
        return null
    }
}

/**
 * The most commonly chosen PINs, in rough order of real-world frequency.
 *
 * Attackers do not search a keyspace uniformly - they try these first. Public
 * analyses of leaked PIN sets put "1234" alone at roughly 10% of four-digit
 * choices, with the top twenty covering something like a quarter of them. A PIN
 * on this list falls in seconds no matter how expensive the KDF is, because the
 * attacker never really has to search.
 */
const COMMON_PINS = new Set([
    '1234', '1111', '0000', '1212', '7777', '1004', '2000', '4444', '2222',
    '6969', '9999', '3333', '5555', '6666', '1122', '1313', '8888', '4321',
    '2001', '1010', '123456', '111111', '000000', '121212', '654321', '123123',
])

/**
 * Whether a PIN appears in public "most common" lists.
 *
 * This is the only claim about secret strength this project is willing to make,
 * because it is the only one that is a *fact about the input* rather than a
 * prediction about an attacker.
 *
 * An earlier version showed an estimated cracking time ("about 11 minutes").
 * It was removed. Three things were wrong with it:
 *
 *  1. It read as a guarantee while resting on stacked guesses - the attacker's
 *     hardware, their parallelism, and the defender's own measured KDF cost.
 *  2. It assumed a uniformly random secret. Search order genuinely does not
 *     matter for one of those - expected work is half the keyspace whether the
 *     attacker counts up, counts down or shuffles - but nobody picks randomly,
 *     so an attacker ordering guesses by known frequency wins far sooner than
 *     the arithmetic implies.
 *  3. Stripped of the theatre, it was just reporting the length of the PIN.
 *
 * A number that cannot be honoured is worse than no number: it invites trust it
 * has not earned. What the UI says instead is what actually reduces risk -
 * enable biometrics, keep auto-lock short, let notes sync.
 */
export function isCommonPin(secret: string): boolean {
    return COMMON_PINS.has(secret)
}

/**
 * Generate a note id.
 *
 * Client-generated on purpose: it doubles as the server-side idempotency key,
 * which is what makes retrying a queued upload an overwrite instead of a
 * duplicate. See `sync.ts`.
 */
export function newId(): string {
    return crypto.randomUUID()
}
