// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

/** Shared display formatting helpers. */

/** Format an epoch-milliseconds timestamp for compact display. */
export function formatTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

/** Full timestamp, for tooltips where precision beats brevity. */
export function formatFullTime(ms: number): string {
    return new Date(ms).toLocaleString(undefined, {
        dateStyle: 'full',
        timeStyle: 'medium',
    })
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000_000],
    ['month', 2_592_000_000],
    ['week', 604_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
]

/**
 * "3 minutes ago" style timestamps.
 *
 * Uses Intl.RelativeTimeFormat so it localises correctly rather than
 * hard-coding English. Anything under a minute reads as "just now", since
 * second-level precision is noise for a note list.
 */
export function formatRelative(ms: number): string {
    const delta = ms - Date.now()
    const magnitude = Math.abs(delta)

    if (magnitude < 60_000) return 'just now'

    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    for (const [unit, size] of UNITS) {
        if (magnitude >= size) {
            return formatter.format(Math.round(delta / size), unit)
        }
    }
    return 'just now'
}

/** Initials for an avatar chip, e.g. "Ward 3 Clinic" -> "W3". */
export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length === 0) return '?'
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
