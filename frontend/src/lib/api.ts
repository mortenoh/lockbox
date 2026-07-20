/**
 * Server access token.
 *
 * The API can require a shared bearer token (`lockbox serve --auth token`),
 * which is what makes a publicly reachable deployment - Tailscale Funnel, a
 * tunnel, a VPS - something other than an open read/write endpoint.
 *
 * ============================================================================
 * PERSISTING THIS WEAKENS THE STOLEN-DEVICE CLAIM. READ THIS.
 * ============================================================================
 *
 * An earlier version of this comment argued that storing the token was free,
 * because an attacker holding the device "could reach the API from that machine
 * anyway". That reasoning was wrong, and worth leaving on the record.
 *
 * In the default plaintext sync mode the server holds **readable** data. So a
 * persisted token hands a device thief a complete bypass:
 *
 *     steal device -> read token from localStorage -> GET /api/plain-notes
 *                  -> every synced record, in the clear
 *
 * No PIN. No DEK. None of the encryption this project is about. The local
 * ciphertext is irrelevant when the plaintext can simply be fetched.
 *
 * So the honest scope is narrower than "protects a lost device":
 *
 *   - `remember: false` (default) - the token lives in memory only and must be
 *     re-entered after a reload. Encryption at rest then means what it claims.
 *   - `remember: true` - convenience for a trusted personal machine, at the
 *     cost that a device thief reaches all *synced* data. Local-only records
 *     are still protected, because those never left the device.
 *
 * The DEK is never persisted under either setting.
 */

const TOKEN_KEY = 'lockbox.apiToken'
const REMEMBER_KEY = 'lockbox.apiTokenRemember'

/** Memory-only token. Lost on reload, which is the point. */
let sessionToken: string | null = null

/** Whether the user opted to persist the token across reloads. */
export function isRemembered(): boolean {
    return localStorage.getItem(REMEMBER_KEY) === 'true'
}

/** The active token: the remembered one, else whatever this session holds. */
export function getToken(): string | null {
    return isRemembered() ? localStorage.getItem(TOKEN_KEY) : sessionToken
}

/**
 * Set the token for this session, optionally persisting it.
 *
 * Not persisted by default. See the module comment for why that default is not
 * mere caution: a stored token bypasses the encryption entirely for any record
 * that has already synced.
 */
export function setToken(token: string, remember = false): void {
    sessionToken = token
    if (remember) {
        localStorage.setItem(REMEMBER_KEY, 'true')
        localStorage.setItem(TOKEN_KEY, token)
    } else {
        localStorage.removeItem(REMEMBER_KEY)
        localStorage.removeItem(TOKEN_KEY)
    }
}

/** Forget the token everywhere, e.g. on lock or after a 401. */
export function clearToken(): void {
    sessionToken = null
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(REMEMBER_KEY)
}

/**
 * `fetch` with the bearer token attached.
 *
 * Every call to the API goes through here, so a new endpoint cannot
 * accidentally be added without credentials.
 */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const token = getToken()
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)
    return fetch(input, { ...init, headers })
}

/**
 * Ask the server whether our credentials are acceptable.
 *
 * Three outcomes worth distinguishing: reachable and authorised, reachable but
 * rejected (so prompt for a token), and unreachable (so stay offline and keep
 * queueing - not an auth problem at all).
 */
export async function checkAuth(): Promise<'ok' | 'unauthorized' | 'unreachable'> {
    try {
        const response = await apiFetch('/api/info', { cache: 'no-store' })
        if (response.status === 401) return 'unauthorized'
        return response.ok ? 'ok' : 'unreachable'
    } catch {
        return 'unreachable'
    }
}
