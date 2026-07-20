import { Delete, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
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
    maxLength?: number
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
    maxLength = 6,
    disabled,
    submitLabel = 'Unlock',
    busyLabel = 'Deriving key…',
    submitDisabled = false,
}: PinPadProps) {
    const press = (digit: string) =>
        onChange((previous) => (previous.length >= maxLength ? previous : previous + digit))

    return (
        // cursor-progress rather than cursor-wait: the app is still responsive,
        // it is just working. Applied to the whole pad so the pointer changes
        // wherever it happens to be.
        <div className={cn('grid gap-4', disabled && 'cursor-progress')}>
            {/* Filled dots rather than the digits: shoulder-surfing in a clinic
                is a real threat, and the count is the only useful feedback. */}
            <div className="flex justify-center gap-2.5" aria-hidden>
                {Array.from({ length: maxLength }, (_, i) => (
                    <span
                        key={i}
                        className={cn(
                            'size-3 rounded-full border transition-colors',
                            i < value.length ? 'bg-primary border-primary' : 'border-muted-foreground/40',
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
                    className="h-14"
                    aria-label="Clear"
                    onClick={() => onChange(() => '')}
                >
                    clear
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
                    className="h-14"
                    aria-label="Delete last digit"
                    onClick={() => onChange((previous) => previous.slice(0, -1))}
                >
                    <Delete className="size-5" />
                </Button>
            </div>

            <Button
                type="button"
                disabled={disabled || submitDisabled || value.length < 4}
                onClick={onSubmit}
                className="w-full"
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
