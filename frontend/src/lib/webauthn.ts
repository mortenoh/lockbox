/**
 * Biometric unlock via the WebAuthn PRF extension.
 *
 * ============================================================================
 * WHY THIS IS THE RIGHT ANSWER TO "PINs ARE WEAK"
 * ============================================================================
 *
 * A 4-digit PIN has 10,000 possibilities. Argon2id makes each guess cost ~130 ms,
 * so an attacker holding the device grinds the whole space in under half an hour.
 * No amount of KDF tuning fixes that - the entropy simply is not there.
 *
 * Phone PINs work because the Secure Enclave rate-limits attempts *in hardware*
 * and the key material never leaves it. The web has no equivalent: any attempt
 * counter written to IndexedDB is bypassed by editing IndexedDB.
 *
 * The PRF extension borrows exactly that hardware property. The authenticator
 * (Touch ID, Face ID, Windows Hello, an Android screen lock) verifies the user
 * itself, enforces its own retry limits, and returns 32 bytes of high-entropy
 * key material derived from a hardware-held secret. Those bytes are:
 *
 *   - stable      - the same credential and salt always yield the same output,
 *                   so they can key an envelope
 *   - unguessable - not derived from anything the user typed
 *   - unextractable - the underlying secret never leaves the authenticator
 *
 * So biometric unlock here is not merely nicer than a PIN, it is *stronger* than
 * a passphrase most users would actually choose. That combination is rare enough
 * to be worth stating plainly.
 *
 * ============================================================================
 * WHY IT CANNOT BE THE ONLY UNLOCK METHOD
 * ============================================================================
 *
 * A platform authenticator is bound to one device. Lose the phone, replace the
 * laptop, or wipe the OS keychain, and the credential is gone - and with it the
 * only way to unwrap the DEK. Windows Hello's PRF support is also still patchy
 * in 2026.
 *
 * The envelope makes coexistence trivial: the *same* DEK is wrapped twice, once
 * under a PIN-derived KEK and once under a PRF-derived KEK. Either unwraps it,
 * and enrolling biometrics does not re-encrypt a single note.
 *
 *     PIN  --Argon2id--> KEK(pin)  --unwrap--> DEK
 *     Touch ID --PRF--> KEK(prf)   --unwrap--> DEK
 */

const PRF_SALT_BYTES = 32
const RP_NAME = 'Lockbox'

/** What must be persisted to unlock with an authenticator later. */
export interface PrfEnvelope {
    /** Credential id (base64url) to pass as an allowed credential. */
    credentialId: string
    /** Per-vault PRF salt (base64url). Not secret. */
    prfSalt: string
    /** IV used when wrapping the DEK under the PRF-derived KEK. */
    wrapIv: string
    /** The DEK, encrypted under the PRF-derived KEK. */
    wrappedDek: string
    /** Label for the UI, e.g. "Touch ID". */
    label: string
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
    const view = new Uint8Array(bytes)
    let binary = ''
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64(text: string): Uint8Array {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return bytes
}

/**
 * Whether this device can plausibly do biometric unlock.
 *
 * Only tells us a platform authenticator exists - PRF support itself cannot be
 * feature-detected up front, so enrolment must be attempted and may still fail.
 */
export async function isBiometricAvailable(): Promise<boolean> {
    if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false
    try {
        return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
    } catch {
        return false
    }
}

/** A guess at the authenticator's name, purely for labelling the button. */
function platformLabel(): string {
    const ua = navigator.userAgent
    if (/iPhone|iPad|Mac/.test(ua)) return 'Touch ID / Face ID'
    if (/Android/.test(ua)) return 'Device biometrics'
    if (/Windows/.test(ua)) return 'Windows Hello'
    return 'Biometric unlock'
}

/**
 * Turn PRF output into an AES-GCM key-encryption key.
 *
 * The 32 bytes are already high-entropy, so no stretching is needed - HKDF is
 * used only for domain separation, so this key cannot collide with any other
 * use of the same PRF output.
 */
async function kekFromPrf(output: ArrayBuffer): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveKey'])

    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0),
            info: new TextEncoder().encode('lockbox-prf-kek-v1'),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['wrapKey', 'unwrapKey'],
    )
}

/** Read the PRF result out of an assertion, or null if unsupported. */
function prfOutput(credential: PublicKeyCredential): ArrayBuffer | null {
    const results = credential.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer } }
    }
    return results.prf?.results?.first ?? null
}

/** Enrolment that produced a credential but still needs a second user gesture. */
export interface PendingEnrollment {
    credentialId: string
    prfSalt: Uint8Array
    label: string
}

/** Outcome of the first enrolment ceremony. */
export type EnrollStart =
    | { status: 'complete'; output: ArrayBuffer; credentialId: string; prfSalt: Uint8Array; label: string }
    | { status: 'needs-assertion'; pending: PendingEnrollment }
    | { status: 'unsupported'; reason: string }

/**
 * First half of enrolment: create the credential.
 *
 * The PRF salt is supplied via `eval` here rather than afterwards, because a
 * browser that supports it will return the derived bytes straight from
 * `create()` - finishing enrolment in a single prompt.
 *
 * Why that matters: **each WebAuthn ceremony consumes the page's user
 * activation.** Calling `create()` and then `get()` inside one click handler
 * fails with `NotAllowedError` on most browsers, because the gesture is already
 * spent. (That is exactly how the first version of this file was written, and
 * why biometric enrolment silently refused to work.) When `eval` is not
 * honoured at creation time, the caller must obtain a *fresh* gesture before
 * calling `finishEnrollment`.
 */
export async function startEnrollment(userId: string, userName: string): Promise<EnrollStart> {
    const prfSalt = crypto.getRandomValues(new Uint8Array(PRF_SALT_BYTES))

    let created: PublicKeyCredential | null
    try {
        created = (await navigator.credentials.create({
            publicKey: {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: { name: RP_NAME, id: window.location.hostname },
                user: {
                    id: new TextEncoder().encode(userId),
                    name: userName,
                    displayName: userName,
                },
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 }, // ES256
                    { type: 'public-key', alg: -257 }, // RS256
                ],
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    // 'preferred', not 'required': a discoverable credential is
                    // unnecessary since the id is stored in the vault, and
                    // demanding one fails on authenticators with full slots.
                    residentKey: 'preferred',
                    userVerification: 'required',
                },
                timeout: 60_000,
                extensions: {
                    prf: { eval: { first: prfSalt.slice().buffer } },
                } as AuthenticationExtensionsClientInputs,
            },
        })) as PublicKeyCredential | null
    } catch (error) {
        return { status: 'unsupported', reason: describeWebAuthnError(error) }
    }

    if (!created) return { status: 'unsupported', reason: 'The authenticator returned nothing.' }

    const credentialId = toBase64(created.rawId)
    const label = platformLabel()
    const results = created.getClientExtensionResults() as {
        prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
    }

    if (!results.prf?.enabled && !results.prf?.results) {
        return {
            status: 'unsupported',
            reason:
                'This authenticator does not support the PRF extension, so it cannot derive an ' +
                'encryption key. The PIN still works.',
        }
    }

    const immediate = results.prf?.results?.first
    if (immediate) {
        return { status: 'complete', output: immediate, credentialId, prfSalt, label }
    }

    // PRF is supported but the bytes only come from an assertion. Hand back to
    // the UI so the user can trigger that with a fresh tap.
    return { status: 'needs-assertion', pending: { credentialId, prfSalt, label } }
}

/**
 * Second half of enrolment, when the authenticator withheld PRF output at
 * creation. Must be called from its own user gesture.
 */
export async function finishEnrollment(pending: PendingEnrollment): Promise<ArrayBuffer | null> {
    return evaluatePrf(pending.credentialId, pending.prfSalt)
}

/** Wrap the DEK under a PRF-derived KEK, producing the storable envelope. */
export async function buildEnvelope(
    output: ArrayBuffer,
    credentialId: string,
    prfSalt: Uint8Array,
    label: string,
    dek: CryptoKey,
): Promise<PrfEnvelope> {
    const kek = await kekFromPrf(output)
    const wrapIv = crypto.getRandomValues(new Uint8Array(12))
    const wrappedDek = await crypto.subtle.wrapKey('raw', dek, kek, {
        name: 'AES-GCM',
        iv: wrapIv.slice().buffer,
    })

    return {
        credentialId,
        prfSalt: toBase64(prfSalt),
        wrapIv: toBase64(wrapIv),
        wrappedDek: toBase64(wrappedDek),
        label,
    }
}

/** Turn a WebAuthn failure into something a user can act on. */
export function describeWebAuthnError(error: unknown): string {
    if (!(error instanceof DOMException)) {
        return error instanceof Error ? error.message : String(error)
    }
    switch (error.name) {
        case 'NotAllowedError':
            return 'The prompt was dismissed, timed out, or the page had already used its user gesture.'
        case 'InvalidStateError':
            return 'This authenticator is already enrolled for this user.'
        case 'NotSupportedError':
            return 'This device does not offer a suitable authenticator.'
        case 'SecurityError':
            return 'Blocked for security reasons - the page must be served over HTTPS or localhost.'
        default:
            return `${error.name}: ${error.message}`
    }
}

/** Prompt the authenticator and evaluate the PRF for a stored credential. */
async function evaluatePrf(credentialId: string, salt: Uint8Array): Promise<ArrayBuffer | null> {
    const assertion = (await navigator.credentials.get({
        publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: window.location.hostname,
            allowCredentials: [{ type: 'public-key', id: fromBase64(credentialId).slice().buffer }],
            userVerification: 'required',
            timeout: 60_000,
            extensions: {
                prf: { eval: { first: salt.slice().buffer } },
            } as AuthenticationExtensionsClientInputs,
        },
    })) as PublicKeyCredential | null

    return assertion ? prfOutput(assertion) : null
}

/**
 * Unlock using a stored biometric envelope.
 *
 * @returns the DEK as a non-extractable key, or null if the user cancelled or
 *          the authenticator could not produce the PRF output.
 */
export async function unlockWithBiometric(
    envelope: PrfEnvelope,
    onError?: (reason: string) => void,
): Promise<CryptoKey | null> {
    try {
        const output = await evaluatePrf(envelope.credentialId, fromBase64(envelope.prfSalt))
        if (!output) return null

        const kek = await kekFromPrf(output)

        return await crypto.subtle.unwrapKey(
            'raw',
            fromBase64(envelope.wrappedDek).slice().buffer,
            kek,
            { name: 'AES-GCM', iv: fromBase64(envelope.wrapIv).slice().buffer },
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt'],
        )
    } catch (error) {
        // Cancelled, timed out, or PRF unsupported. The PIN still works, but
        // say why rather than failing silently - a dismissed prompt and an
        // unsupported authenticator need very different responses.
        onError?.(describeWebAuthnError(error))
        return null
    }
}
