// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useRef, useState } from 'react'
import { Fingerprint, KeyRound, Loader2, Plus, Trash2, UserRound } from 'lucide-react'
import { toast } from 'sonner'

import { PinPad } from '@/components/PinPad'
import { ThemeToggle } from '@/components/ThemeToggle'
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { DEFAULT_KDF, PIN_LENGTH } from '@/lib/config'
import {
    adoptSessionKey,
    createVault,
    isCommonPin,
    unlockVault,
    vaultKdf,
    type VaultRecord,
} from '@/lib/crypto'
import * as db from '@/lib/db'
import { initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isBiometricAvailable, unlockWithBiometric } from '@/lib/webauthn'

interface UnlockScreenProps {
    /** Last signed-in user, so a reload skips the picker. Never a secret. */
    initialUserId?: string | null
    onUnlocked: (vault: VaultRecord) => void
}

type Screen = 'pick' | 'unlock' | 'create'

/**
 * Sign-in for a device that may be shared by several users.
 *
 * Each user gets their own vault, their own secret and their own DEK, all on the
 * same browser profile. The server data they sync to is shared - the local
 * encryption is not.
 */
export function UnlockScreen({ initialUserId, onUnlocked }: UnlockScreenProps) {
    const [vaults, setVaults] = useState<VaultRecord[] | null>(null)
    const [storageError, setStorageError] = useState<string | null>(null)
    const [screen, setScreen] = useState<Screen>('pick')
    const [selected, setSelected] = useState<VaultRecord | null>(null)
    // null while the probe is still running - the distinction matters on a
    // reload, where the unlock form renders before the answer arrives.
    const [biometricAvailable, setBiometricAvailable] = useState<boolean | null>(null)

    const refresh = useCallback(async () => {
        let list: VaultRecord[]
        try {
            list = await db.listVaults()
        } catch (err) {
            // Never leave the screen blank. Opening the database can fail - most
            // often because another tab holds it open on an older version - and
            // rendering nothing gives the user neither an explanation nor a way
            // out.
            setStorageError(err instanceof Error ? err.message : String(err))
            return
        }
        setVaults(list)

        if (list.length === 0) {
            setScreen('create')
            return
        }

        // A reload destroys the key but not the knowledge of who was using the
        // app, so go straight to their PIN rather than making them re-pick.
        const remembered = initialUserId ? list.find((v) => v.id === initialUserId) : undefined
        if (remembered) {
            setSelected(remembered)
            setScreen('unlock')
            return
        }

        setScreen('pick')
    }, [initialUserId])

    useEffect(() => {
        void refresh()
        void isBiometricAvailable().then(setBiometricAvailable)
    }, [refresh])

    if (storageError !== null) return <StorageFailure message={storageError} />
    if (vaults === null) return <LoadingCard />

    return (
        <div className="flex min-h-svh w-full flex-col">
            {/* The same top bar the unlocked app has - same surface, border and
                height - so locking does not feel like leaving the app. Brand
                left; connectivity and theme right, where the unlocked header
                keeps its status cluster. */}
            <header className="bg-sidebar sticky top-0 z-10 border-b">
                <div className="flex items-center gap-2.5 px-4 py-2.5 md:px-6">
                    <div className="bg-foreground text-background dark:bg-primary dark:text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                        <KeyRound className="size-4" aria-hidden />
                    </div>
                    <span className="text-lg font-bold tracking-tight">Lockbox</span>
                    <div className="flex-1" />
                    <OnlineChip />
                    <ThemeToggle />
                </div>
            </header>

            <div className="relative flex flex-1 flex-col justify-center px-4 py-10">
                <div
                    aria-hidden
                    className="from-primary/10 pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,var(--tw-gradient-from),transparent_60%)]"
                />

                <div className="mx-auto w-full max-w-md">
                {screen === 'pick' && (
                    <UserPicker
                        vaults={vaults}
                        onSelect={(vault) => {
                            setSelected(vault)
                            setScreen('unlock')
                        }}
                        onAdd={() => setScreen('create')}
                        onRemoved={refresh}
                    />
                )}

                {screen === 'unlock' && selected && (
                    <UnlockForm
                        vault={selected}
                        biometricAvailable={biometricAvailable}
                        onBack={() => setScreen('pick')}
                        onUnlocked={onUnlocked}
                    />
                )}

                    {screen === 'create' && (
                        <CreateForm
                            canCancel={vaults.length > 0}
                            onCancel={() => setScreen('pick')}
                            onCreated={onUnlocked}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}

/** Shown while the database is opening, so the screen is never empty. */
function LoadingCard() {
    return (
        <div className="flex min-h-svh items-center justify-center px-4">
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" />
                Opening local storage…
            </p>
        </div>
    )
}

/**
 * Shown when IndexedDB cannot be opened at all.
 *
 * This replaces a blank page - the worst possible outcome, because it explains
 * nothing and offers nothing. The most common cause is another tab holding the
 * database open on an older schema, so the first suggestion is the one that
 * usually works and costs nothing.
 */
function StorageFailure({ message }: { message: string }) {
    return (
        <div className="flex min-h-svh items-center justify-center px-4">
            <Card className="w-full max-w-md shadow-lg">
                <CardHeader>
                    <CardTitle className="text-lg">Cannot open local storage</CardTitle>
                    <CardDescription>{message}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3">
                    <Button onClick={() => window.location.reload()}>Reload</Button>

                    <p className="text-muted-foreground text-xs">
                        Close every other tab of this app first — one holding the database open on
                        an older version is the usual cause.
                    </p>

                    <Separator />

                    {/* Last resort, in the app rather than in DevTools. Nobody
                        should have to be told to open developer tools to make a
                        page load. */}
                    <AlertDialog>
                        <AlertDialogTrigger asChild>
                            <Button variant="destructive" size="sm">
                                Reset local data
                            </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Delete all local data?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    Every vault on this device is removed, along with any note that
                                    has not synced yet. Notes already on the server can be
                                    recovered by signing in again and pulling.
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                    className={buttonVariants({ variant: 'destructive' })}
                                    onClick={async () => {
                                        await db.destroyDatabase()
                                        window.location.reload()
                                    }}
                                >
                                    Delete everything
                                </AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </CardContent>
            </Card>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Who are you?
// ---------------------------------------------------------------------------

interface UserPickerProps {
    vaults: VaultRecord[]
    onSelect: (vault: VaultRecord) => void
    onAdd: () => void
    onRemoved: () => void
}

function UserPicker({ vaults, onSelect, onAdd, onRemoved }: UserPickerProps) {
    async function handleRemove(vault: VaultRecord) {
        await db.deleteVault(vault.id)
        onRemoved()
    }

    return (
        <Card className="shadow-lg">
            {/* The brand lives in the shared top bar now - this card only has
                to ask its one question. */}
            <CardHeader>
                <CardTitle className="text-lg">Who is using this device?</CardTitle>
            </CardHeader>

            <CardContent className="grid gap-2">
                {vaults.map((vault) => (
                    <div key={vault.id} className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => onSelect(vault)}
                            className="hover:bg-accent flex flex-1 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors"
                        >
                            <span className="bg-primary/15 text-primary ring-primary/20 flex size-9 items-center justify-center rounded-full text-sm font-semibold ring-1">
                                {initials(vault.owner)}
                            </span>
                            <span className="grid">
                                <span className="font-medium">{vault.owner}</span>
                                <span className="text-muted-foreground text-xs">
                                    {vaultKdf(vault).kdf === 'pbkdf2' && 'legacy PBKDF2 · '}
                                    {vault.prf ? vault.prf.label : 'PIN'}
                                </span>
                            </span>
                        </button>
                        <AlertDialog>
                            <AlertDialogTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={`Remove ${vault.owner}`}
                                >
                                    <Trash2 className="size-4" />
                                </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                                <AlertDialogHeader>
                                    <AlertDialogTitle>
                                        Remove {vault.owner} from this device?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription>
                                        Their notes that have not synced yet are lost. Anything
                                        already on the server can be recovered by signing in again
                                        and pulling.
                                    </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                        className={buttonVariants({ variant: 'destructive' })}
                                        onClick={() => void handleRemove(vault)}
                                    >
                                        Remove
                                    </AlertDialogAction>
                                </AlertDialogFooter>
                            </AlertDialogContent>
                        </AlertDialog>
                    </div>
                ))}

                <Button variant="outline" onClick={onAdd} className="mt-2">
                    <Plus className="size-4" />
                    Add user
                </Button>
            </CardContent>
        </Card>
    )
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

interface UnlockFormProps {
    vault: VaultRecord
    /** null while the availability probe is still in flight. */
    biometricAvailable: boolean | null
    onBack: () => void
    onUnlocked: (vault: VaultRecord) => void
}

/**
 * Browser connectivity, live.
 *
 * Deliberately navigator.onLine and not the sync engine's richer state: the
 * vault is locked here, sync is not running, and the chip only has to answer
 * "will pulling work once I'm in".
 */
function useOnline() {
    const [online, setOnline] = useState(navigator.onLine)
    useEffect(() => {
        const up = () => setOnline(true)
        const down = () => setOnline(false)
        window.addEventListener('online', up)
        window.addEventListener('offline', down)
        return () => {
            window.removeEventListener('online', up)
            window.removeEventListener('offline', down)
        }
    }, [])
    return online
}

/** Connectivity chip for the locked top bar. */
function OnlineChip() {
    const online = useOnline()
    return (
        <span className="border-border bg-secondary text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-medium tracking-wider uppercase">
            <span
                className={cn(
                    'size-[7px] rounded-full',
                    online ? 'bg-status-synced' : 'bg-status-local',
                )}
                aria-hidden
            />
            {online ? 'Online' : 'Offline'}
        </span>
    )
}

function UnlockForm({ vault, biometricAvailable, onBack, onUnlocked }: UnlockFormProps) {
    const [secret, setSecret] = useState('')
    const [busy, setBusy] = useState<'secret' | 'biometric' | null>(null)
    const submitting = useRef(false)

    // When biometrics are enrolled they become the whole screen: one tap, no
    // keypad. The PIN is still there, one link away, because an authenticator
    // is bound to a single device and can fail or be unavailable.
    //
    // Derived, not initialised into state: on a reload this form mounts before
    // the availability probe answers, and a useState snapshot taken at that
    // moment left the keypad up next to the biometric button forever. While
    // the probe is pending (null) an enrolled vault is treated as available -
    // the credential was created on this very device - so the keypad does not
    // flash in and out; if the probe then says no, the keypad appears.
    const canUseBiometric = Boolean(vault.prf) && biometricAvailable !== false
    const [pinRequested, setPinRequested] = useState(false)
    const showPin = pinRequested || !canUseBiometric

    async function submit() {
        if (submitting.current) return
        submitting.current = true

        setBusy('secret')
        try {
            if (await unlockVault(secret, vault)) {
                await db.requestPersistence()
                onUnlocked(vault)
            } else {
                // A toast, not an inline alert: the panel used to appear below
                // the pad and shove the layout around. The cleared dots are
                // the in-place signal; the toast carries the words.
                toast.error('Wrong PIN.')
                setSecret('')
            }
        } catch (err) {
            toast.error(`Could not unlock: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
            submitting.current = false
            setBusy(null)
        }
    }

    async function submitBiometric() {
        if (!vault.prf) return
        setBusy('biometric')
        try {
            let reason: string | null = null
            const dek = await unlockWithBiometric(vault.prf, (r) => (reason = r))
            if (!dek) {
                toast.error(reason ?? 'Biometric unlock was cancelled or unavailable.')
                return
            }
            adoptSessionKey(dek)
            await db.requestPersistence()
            onUnlocked(vault)
        } finally {
            setBusy(null)
        }
    }

    return (
        <Card className="shadow-lg">
            <CardHeader>
                <div className="flex items-center gap-3">
                    <span className="bg-accent text-accent-foreground flex size-9 items-center justify-center rounded-full font-mono text-sm font-semibold">
                        {initials(vault.owner)}
                    </span>
                    <div className="grid">
                        <CardTitle className="text-lg">{vault.owner}</CardTitle>
                        <CardDescription>Enter PIN to unlock</CardDescription>
                    </div>
                </div>
            </CardHeader>

            <CardContent className="grid gap-4">
                {canUseBiometric && (
                    <Button
                        variant={showPin ? 'outline' : 'default'}
                        className="w-full"
                        disabled={busy !== null}
                        onClick={() => void submitBiometric()}
                    >
                        {busy === 'biometric' ? (
                            <Loader2 className="animate-spin" />
                        ) : (
                            <Fingerprint className="size-4" />
                        )}
                        Unlock with {vault.prf?.label}
                    </Button>
                )}

                {showPin ? (
                    <>
                        {canUseBiometric && (
                            <div className="flex items-center gap-3">
                                <Separator className="flex-1" />
                                <span className="text-muted-foreground text-xs">or</span>
                                <Separator className="flex-1" />
                            </div>
                        )}

                        <PinPad
                            value={secret}
                            onChange={setSecret}
                            onSubmit={() => void submit()}
                            disabled={busy !== null}
                        />

                        {busy === 'secret' && (
                            <p className="text-muted-foreground text-center text-xs">
                                Deriving key…
                            </p>
                        )}
                    </>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => setPinRequested(true)}
                    >
                        Use PIN instead
                    </Button>
                )}

                <div className="flex items-center justify-between gap-2">
                    <Button variant="ghost" size="sm" onClick={onBack}>
                        <UserRound className="size-4" />
                        Switch user
                    </Button>
                </div>
            </CardContent>
        </Card>
    )
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

interface CreateFormProps {
    canCancel: boolean
    onCancel: () => void
    onCreated: (vault: VaultRecord) => void
}

function CreateForm({ canCancel, onCancel, onCreated }: CreateFormProps) {
    const [owner, setOwner] = useState('')
    const [secret, setSecret] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const submitting = useRef(false)

    // The submit button is disabled until both fields are valid, so `create`
    // can only ever run on a complete form. Nothing here re-checks them.
    // New PINs are exactly PIN_LENGTH digits; only unlocking is lenient.
    const trimmedOwner = owner.trim()
    const isComplete = trimmedOwner.length > 0 && secret.length >= PIN_LENGTH

    // The one incomplete state worth shouting about: the PIN is done but the
    // name is not, so the user thinks they are finished and the hint at the
    // bottom of the card is easy to miss. Marking the field itself is what
    // points them at the right place. An untouched form stays unmarked - red
    // borders before anyone typed anything is scolding, not guidance.
    const nameMissing = secret.length >= PIN_LENGTH && trimmedOwner.length === 0

    async function create() {
        // A ref, not the `busy` state: setBusy only takes effect on the next
        // render, so clicks landing before that would each start their own
        // createVault - and since every call mints a fresh vault id, that means
        // several vaults from one intent. Argon2id takes long enough for this to
        // be easy to hit.
        if (submitting.current) return
        submitting.current = true

        setError(null)
        setBusy(true)
        try {
            const vault = await createVault(secret, trimmedOwner, DEFAULT_KDF)
            await db.putVault(vault)
            await db.requestPersistence()
            onCreated(vault)
        } catch (err) {
            setError(`Could not create: ${err instanceof Error ? err.message : String(err)}`)
        } finally {
            submitting.current = false
            setBusy(false)
        }
    }

    return (
        <Card className={cn('shadow-lg', busy && 'cursor-progress')} aria-busy={busy}>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <KeyRound className="text-primary size-5" aria-hidden />
                    <CardTitle className="text-xl">Add a user</CardTitle>
                </div>
                <CardDescription>
                    Their notes are unreadable to the other users of this device.
                </CardDescription>
            </CardHeader>

            <CardContent className="grid gap-4">
                <div className="grid gap-2">
                    <Label htmlFor="owner">Name</Label>
                    <Input
                        id="owner"
                        autoFocus
                        value={owner}
                        placeholder="e.g. Ward 3 Clinic"
                        aria-invalid={nameMissing || undefined}
                        onChange={(e) => setOwner(e.target.value)}
                    />
                    <p className="text-muted-foreground text-xs">
                        Shown with every note so others can see who wrote it.
                    </p>
                </div>

                <PinPad
                    value={secret}
                    onChange={setSecret}
                    onSubmit={() => void create()}
                    disabled={busy}
                    submitLabel="Create vault"
                    submitDisabled={!isComplete}
                />

                {busy && (
                    <p className="text-muted-foreground text-center text-xs">
                        <Loader2 className="mr-1 inline size-3 animate-spin" />
                        Deriving key…
                    </p>
                )}

                {/* One fixed-height slot for everything this form has to say:
                    what is still missing, a warning about the PIN, or a real
                    failure. Adding a second box on submit is what made the
                    keypad jump. */}
                <div className="min-h-[5rem]">
                    {/* Destructive only when the message itself is urgent. The
                        variant used to key off isCommonPin alone, which turned
                        the box red while its text talked about the name. */}
                    <Alert
                        variant={
                            error || nameMissing || (isComplete && isCommonPin(secret))
                                ? 'destructive'
                                : 'default'
                        }
                    >
                        <AlertDescription className="text-xs">
                            {error ? (
                                error
                            ) : !isComplete ? (
                                <>
                                    {!trimmedOwner
                                        ? 'Enter a name to continue.'
                                        : `Enter ${PIN_LENGTH} digits.`}
                                </>
                            ) : isCommonPin(secret) ? (
                                <>
                                    <strong>{secret}</strong> is one of the most frequently chosen
                                    PINs, so it would be among the first an attacker tries. Pick
                                    something less common.
                                </>
                            ) : (
                                <>
                                    The PIN protects this device&rsquo;s local cache; synced notes
                                    stay recoverable from the server. Biometric unlock and a short
                                    auto-lock help more than PIN length.
                                </>
                            )}
                        </AlertDescription>
                    </Alert>
                </div>

                {canCancel && (
                    <Button variant="ghost" size="sm" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
            </CardContent>
        </Card>
    )
}
