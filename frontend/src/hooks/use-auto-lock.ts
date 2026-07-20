import { useEffect, useRef } from 'react'



/** Activity that counts as "the user is still here". */
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const

/**
 * Drop the key after a period of inactivity.
 *
 * This matters more than it looks. The window during which the DEK sits in
 * memory is the window in which a walk-up attacker - or injected script - can
 * use it. A short PIN makes that window the main thing standing between a
 * borrowed clinic tablet and its data, so shrinking it is one of the cheapest
 * real security improvements available here.
 *
 * Deliberately timestamp-based rather than a rolling `setTimeout`: if the device
 * sleeps or the tab is suspended, timers do not fire reliably, and we want the
 * app to notice on wake that far too much time has passed.
 */
export function useAutoLock(active: boolean, minutes: number, onLock: () => void) {
    const lastActivity = useRef(Date.now())
    const onLockRef = useRef(onLock)
    onLockRef.current = onLock

    useEffect(() => {
        if (!active) return

        if (minutes <= 0) return
        const timeoutMs = minutes * 60_000

        const touch = () => {
            lastActivity.current = Date.now()
        }
        for (const event of ACTIVITY_EVENTS) {
            window.addEventListener(event, touch, { passive: true })
        }

        const check = () => {
            if (Date.now() - lastActivity.current >= timeoutMs) onLockRef.current()
        }

        // Poll rather than schedule: a suspended tab's timers are unreliable, so
        // the elapsed-time check has to run again when the page comes back.
        const interval = window.setInterval(check, 15_000)
        document.addEventListener('visibilitychange', check)

        return () => {
            for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, touch)
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', check)
            window.clearTimeout(interval)
        }
        // `minutes` is a dependency so changing the setting restarts the timer
        // immediately, rather than only taking effect after the next unlock.
    }, [active, minutes])
}
