// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect } from 'react'

import { Delete, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { PIN_LENGTH } from '@/lib/config'
import { cn } from '@/lib/utils'

interface PinPadProps {
    value: string
    /**
     * Receives an updater rather than a value.
     *
     * Each key's handler closes over `value` as it was at render time, so two
     * taps landing in the same React batch would both compute from the same
     * stale string and the second would overwrite the first. Passing a function
     * makes every tap derive from the latest state instead.
     */
    onChange: (update: (previous: string) => string) => void
    onSubmit: () => void
    disabled?: boolean
    /** Submit button label - this pad is used to both create and unlock. */
    submitLabel?: string
    /** Shown in place of the label while the key is being derived. */
    busyLabel?: string
    /**
     * Extra reason the form is not submittable yet, beyond PIN length.
     *
     * Lets the caller keep the button disabled while its own fields are
     * incomplete, so an invalid form can never be submitted at all - which is
     * better than accepting it and answering with an error.
     */
    submitDisabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * Numeric keypad.
 *
 * Exists because a PIN typed on a phone keyboard in the field is a worse
 * experience than tapping large targets, and because the entry method should
 * make it obvious this is a short numeric secret rather than a password.
 *
 * Kept as one option among several - the passphrase field and biometric unlock
 * are still there, and each buys something different.
 */
export function PinPad({
    value,
    onChange,
    onSubmit,
    disabled,
    submitLabel = 'Unlock',
    busyLabel = 'Deriving key…',
    submitDisabled = false,
}: PinPadProps) {
    const press = (digit: string) =>
        onChange((previous) => (previous.length >= PIN_LENGTH ? previous : previous + digit))

    // Half the field hardware is old laptops, where clicking each digit with a
    // trackpad is the slowest possible entry. Listening on the document rather
    // than the pad means it works without first clicking into anything - but
    // never while the user is typing in a real field (the name input here, or
    // a dialog's search box), which keeps digits out of the PIN when they were
    // meant for the field.
    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (disabled) return
            if (event.metaKey || event.ctrlKey || event.altKey) return
            const target = event.target as HTMLElement | null
            if (target?.closest('input, textarea, select, [contenteditable="true"]')) return

            if (/^[0-9]$/.test(event.key)) {
                event.preventDefault()
                press(event.key)
            } else if (event.key === 'Backspace') {
                event.preventDefault()
                onChange((previous) => previous.slice(0, -1))
            } else if (event.key === 'Enter') {
                if (submitDisabled || value.length < PIN_LENGTH) return
                event.preventDefault()
                onSubmit()
            }
        }
        document.addEventListener('keydown', handleKey)
        return () => document.removeEventListener('keydown', handleKey)
    })

    return (
        // cursor-progress rather than cursor-wait: the app is still responsive,
        // it is just working. Applied to the whole pad so the pointer changes
        // wherever it happens to be.
        <div className={cn('grid gap-4', disabled && 'cursor-progress')}>
            {/* Filled dots rather than the digits: shoulder-surfing in a clinic
                is a real threat, and the count is the only useful feedback. */}
            <div className="flex justify-center gap-3" aria-hidden>
                {Array.from({ length: PIN_LENGTH }, (_, i) => (
                    <span
                        key={i}
                        className={cn(
                            'size-3.5 rounded-full border-2 transition-colors',
                            i < value.length ? 'bg-primary border-primary' : 'border-muted-foreground/50',
                        )}
                    />
                ))}
            </div>

            <div className="mx-auto grid w-full max-w-[15rem] grid-cols-3 gap-2">
                {KEYS.map((digit) => (
                    <Button
                        key={digit}
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        className="h-14 text-lg font-medium"
                        onClick={() => press(digit)}
                    >
                        {digit}
                    </Button>
                ))}

                <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled || value.length === 0}
                    className="text-muted-foreground hover:text-foreground h-14"
                    aria-label="Clear"
                    onClick={() => onChange(() => '')}
                >
                    Clear
                </Button>

                <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    className="h-14 text-lg font-medium"
                    onClick={() => press('0')}
                >
                    0
                </Button>

                <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled || value.length === 0}
                    className="text-muted-foreground hover:text-foreground h-14"
                    aria-label="Delete last digit"
                    onClick={() => onChange((previous) => previous.slice(0, -1))}
                >
                    <Delete className="size-5" />
                </Button>
            </div>

            <Button
                type="button"
                disabled={disabled || submitDisabled || value.length < PIN_LENGTH}
                onClick={onSubmit}
                // Same column as the keypad, so the pad reads as one block
                // instead of a narrow grid over a full-width bar.
                className="mx-auto w-full max-w-[15rem]"
            >
                {disabled ? (
                    <>
                        <Loader2 className="animate-spin" />
                        {busyLabel}
                    </>
                ) : (
                    submitLabel
                )}
            </Button>
        </div>
    )
}
