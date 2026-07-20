/**
 * Bytes <-> base64url conversion, shared by the crypto and WebAuthn layers.
 *
 * Everything binary in this app (salts, IVs, wrapped keys, ciphertext,
 * credential ids) is persisted and transported as base64url: JSON- and
 * URL-safe, unpadded. Both directions must stay byte-identical forever -
 * every vault record already in IndexedDB was written with this encoding.
 */

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
