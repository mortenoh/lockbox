/**
 * Session preferences: the small amount of state that may safely outlive a
 * reload.
 *
 * The rule that governs this file: **the key is never here.** The DEK exists
 * only as a non-extractable CryptoKey in memory, which means a page refresh
 * destroys it and the PIN must be entered again. That is not a limitation to
 * engineer around - persisting the key anywhere reachable from JavaScript would
 * hand it to precisely the attacker this project defends against (someone
 * holding the device's browser profile).
 *
 * What *can* persist is who was last signed in. A user id is not a secret, and
 * remembering it lets the app open on that person's PIN pad instead of making
 * them pick themselves out of a list every time.
 */

const LAST_USER_KEY = 'lockbox.lastUserId'
const AUTO_LOCK_KEY = 'lockbox.autoLockMinutes'

/** Auto-lock choices. 0 disables it. */
export const AUTO_LOCK_OPTIONS = [1, 5, 15, 30, 0] as const

const DEFAULT_AUTO_LOCK_MINUTES = 5

/** Who was signed in last, so the app can skip the picker. Not a secret. */
export function getLastUserId(): string | null {
    return localStorage.getItem(LAST_USER_KEY)
}

/** Remember the signed-in user. Called on unlock, not on lock. */
export function setLastUserId(id: string): void {
    localStorage.setItem(LAST_USER_KEY, id)
}

/** Forget the remembered user, so the picker is shown next time. */
export function clearLastUserId(): void {
    localStorage.removeItem(LAST_USER_KEY)
}

/**
 * Idle minutes before the key is dropped. 0 means never.
 *
 * The null check is load-bearing: `Number(null)` is `0`, not `NaN`, so parsing
 * before checking for a missing value made an unset preference read as
 * "never" - and auto-lock silently never fired for anyone who had not chosen a
 * value explicitly.
 */
export function getAutoLockMinutes(): number {
    const stored = localStorage.getItem(AUTO_LOCK_KEY)
    if (stored === null) return DEFAULT_AUTO_LOCK_MINUTES

    const raw = Number(stored)
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_AUTO_LOCK_MINUTES
}

/** Persist the auto-lock preference. */
export function setAutoLockMinutes(minutes: number): void {
    localStorage.setItem(AUTO_LOCK_KEY, String(minutes))
}
