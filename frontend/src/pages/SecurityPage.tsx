import { useEffect, useState } from 'react'
import { Fingerprint, Loader2, ShieldCheck, Timer, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { PinPad } from '@/components/PinPad'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { checkAuth, getToken, isRemembered, setToken as storeToken } from '@/lib/api'
import { exportDekForRewrap, type VaultRecord } from '@/lib/crypto'
import * as db from '@/lib/db'
import { AUTO_LOCK_OPTIONS, setAutoLockMinutes } from '@/lib/session'
import {
    buildEnvelope,
    describeWebAuthnError,
    finishEnrollment,
    isBiometricAvailable,
    startEnrollment,
    type PendingEnrollment,
} from '@/lib/webauthn'

interface SecurityPageProps {
    vault: VaultRecord
    onVaultChanged: (vault: VaultRecord) => void
    /** Lifted to App so the auto-lock timer restarts when this changes. */
    autoLockMinutes: number
    onAutoLockChanged: (minutes: number) => void
}

/**
 * Security settings for the signed-in user.
 *
 * Two things live here, and they address the same weakness from opposite ends:
 * biometric unlock replaces a low-entropy PIN with hardware-held key material,
 * and auto-lock shrinks the window in which the derived key is sitting in
 * memory at all.
 */
export function SecurityPage({
    vault,
    onVaultChanged,
    autoLockMinutes,
    onAutoLockChanged,
}: SecurityPageProps) {
    const [available, setAvailable] = useState(false)
    const [enrolling, setEnrolling] = useState(false)
    const [pin, setPin] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [token, setTokenValue] = useState(getToken() ?? '')
    const [remember, setRemember] = useState(isRemembered())
    // Held between the two ceremonies when the authenticator withholds PRF
    // output at creation time and needs a second, freshly-gestured tap.
    const [pending, setPending] = useState<{ step: PendingEnrollment; dek: CryptoKey } | null>(null)
    const [authState, setAuthState] = useState<'ok' | 'unauthorized' | 'unreachable' | null>(null)

    useEffect(() => {
        void isBiometricAvailable().then(setAvailable)
        void checkAuth().then(setAuthState)
    }, [])

    async function saveToken() {
        storeToken(token.trim(), remember)
        const result = await checkAuth()
        setAuthState(result)
        if (result === 'ok') {
            toast.success('Server accepted the token')
        } else if (result === 'unauthorized') {
            toast.error('Server rejected the token')
        } else {
            toast.info('Server unreachable — the token is saved and will be used when it returns')
        }
    }

    async function enroll() {
        setError(null)
        setEnrolling(true)
        try {
            // Enrolment must prove knowledge of the existing PIN. Without this,
            // anyone who found the device unlocked could silently bind their own
            // fingerprint to the vault and keep access forever.
            const dek = await exportDekForRewrap(pin, vault)
            if (!dek) {
                setError('Wrong PIN.')
                setPin('')
                return
            }

            const started = await startEnrollment(vault.id, vault.owner)

            if (started.status === 'unsupported') {
                setError(started.reason)
                return
            }

            if (started.status === 'needs-assertion') {
                // Cannot chain a second ceremony here - the click's user
                // activation was spent by create(). Ask for another tap.
                setPending({ step: started.pending, dek })
                return
            }

            await persist(
                await buildEnvelope(
                    started.output,
                    started.credentialId,
                    started.prfSalt,
                    started.label,
                    dek,
                ),
            )
        } catch (err) {
            setError(describeWebAuthnError(err))
        } finally {
            setEnrolling(false)
        }
    }

    /** Second ceremony, driven by its own button so it has a fresh gesture. */
    async function confirmEnrollment() {
        if (!pending) return
        setError(null)
        setEnrolling(true)
        try {
            const output = await finishEnrollment(pending.step)
            if (!output) {
                setError('The authenticator did not return PRF key material.')
                return
            }
            await persist(
                await buildEnvelope(
                    output,
                    pending.step.credentialId,
                    pending.step.prfSalt,
                    pending.step.label,
                    pending.dek,
                ),
            )
            setPending(null)
        } catch (err) {
            setError(describeWebAuthnError(err))
        } finally {
            setEnrolling(false)
        }
    }

    async function persist(envelope: Awaited<ReturnType<typeof buildEnvelope>>) {
        const updated = { ...vault, prf: envelope }
        await db.putVault(updated)
        onVaultChanged(updated)
        setPin('')
        toast.success(`${envelope.label} enabled`, {
            description: 'The same key is now wrapped twice. No note was re-encrypted.',
        })
    }

    async function removeBiometric() {
        const { prf: _removed, ...rest } = vault
        await db.putVault(rest)
        onVaultChanged(rest)
        toast.info('Biometric unlock removed', { description: 'The PIN still opens this vault.' })
    }

    return (
        <div className="grid gap-6">
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                    <ShieldCheck className="text-primary size-6" aria-hidden />
                    Security
                </h1>
                <p className="text-muted-foreground mt-1">
                    Settings for <strong>{vault.owner}</strong> on this device.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <Fingerprint className="text-primary size-5" aria-hidden />
                        <CardTitle>Biometric unlock</CardTitle>
                        {vault.prf && <Badge>enabled</Badge>}
                    </div>
                    <CardDescription>
                        A PIN has very little entropy, and how long it would survive an offline
                        attack depends on the attacker&rsquo;s hardware and on how predictable the
                        PIN is — neither of which this app can know. An authenticator sidesteps the
                        question: it rate-limits attempts <em>in hardware</em> and returns
                        high-entropy key material, which is the one thing a browser cannot do on
                        its own.
                    </CardDescription>
                </CardHeader>

                <CardContent className="grid gap-4">
                    {!available ? (
                        <Alert>
                            <AlertDescription>
                                No platform authenticator detected. On macOS this needs Touch ID in
                                Chrome or Safari, on Windows a working Windows Hello, and the page
                                must be a secure context (https, or localhost).
                            </AlertDescription>
                        </Alert>
                    ) : vault.prf ? (
                        <>
                            <p className="text-muted-foreground text-sm">
                                Unlocking with <strong>{vault.prf.label}</strong> is available for
                                this user. The PIN still works as a fallback — deliberately, since
                                an authenticator is bound to one device and can be lost.
                            </p>
                            <Button variant="outline" size="sm" onClick={() => void removeBiometric()}>
                                <Trash2 className="size-4" />
                                Remove biometric unlock
                            </Button>
                        </>
                    ) : (
                        <>
                            <p className="text-muted-foreground text-sm">
                                Confirm your PIN to wrap the existing key a second time. No note is
                                re-encrypted — that is the payoff of the envelope design.
                            </p>

                            {pending ? (
                                <Button
                                    disabled={enrolling}
                                    onClick={() => void confirmEnrollment()}
                                >
                                    {enrolling && <Loader2 className="animate-spin" />}
                                    Confirm with {pending.step.label}
                                </Button>
                            ) : (
                                <PinPad
                                    value={pin}
                                    onChange={setPin}
                                    onSubmit={() => void enroll()}
                                    disabled={enrolling}
                                    submitLabel="Enable biometric unlock"
                                />
                            )}

                            {enrolling && (
                                <p className="text-muted-foreground text-center text-xs">
                                    <Loader2 className="mr-1 inline size-3 animate-spin" />
                                    Waiting for the authenticator…
                                </p>
                            )}
                        </>
                    )}

                    {error && (
                        <Alert variant="destructive">
                            <AlertDescription>{error}</AlertDescription>
                        </Alert>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <Timer className="text-primary size-5" aria-hidden />
                        <CardTitle>Auto-lock</CardTitle>
                    </div>
                    <CardDescription>
                        Drop the key after a period of inactivity. The shorter this is, the smaller
                        the window in which a borrowed device — or injected script — can use the
                        key that is already in memory.
                    </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                    {AUTO_LOCK_OPTIONS.map((minutes) => (
                        <Button
                            key={minutes}
                            variant={autoLockMinutes === minutes ? 'secondary' : 'outline'}
                            size="sm"
                            onClick={() => {
                                setAutoLockMinutes(minutes)
                                onAutoLockChanged(minutes)
                            }}
                        >
                            {minutes === 0 ? 'Never' : `${minutes} min`}
                        </Button>
                    ))}
                </CardContent>
            </Card>

            {/* Only shown when it is actually relevant. The server answers
                /api/info without credentials when it runs with --auth none, so
                presenting a token field then is asking for a secret that has no
                use - and implying an authentication step that does not exist. */}
            {authState === 'ok' && !token ? (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-base">Server access</CardTitle>
                        <CardDescription>
                            This server accepts requests without a token, so there is nothing to
                            configure. Start it with <code>--auth token</code> if it is reachable
                            beyond localhost — see the Remote Access docs.
                        </CardDescription>
                    </CardHeader>
                </Card>
            ) : (
                <Card>
                    <CardHeader>
                        <div className="flex items-center gap-2">
                            <CardTitle>Server access token</CardTitle>
                            {authState === 'ok' && <Badge variant="outline">authorised</Badge>}
                            {authState === 'unauthorized' && (
                                <Badge variant="destructive">rejected</Badge>
                            )}
                            {authState === 'unreachable' && (
                                <Badge variant="secondary">offline</Badge>
                            )}
                        </div>
                        <CardDescription>
                            This server requires a token on <code>/api/*</code>. It is a server
                            credential, not the encryption key — it never unlocks anything locally.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                        <Label htmlFor="api-token">Token</Label>
                        <Input
                            id="api-token"
                            value={token}
                            placeholder="Paste the token printed by the server"
                            onChange={(e) => setTokenValue(e.target.value)}
                        />
                        <label className="flex items-start gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={remember}
                                className="mt-1"
                                onChange={(e) => setRemember(e.target.checked)}
                            />
                            <span>
                                Remember on this device
                                <span className="text-muted-foreground block text-xs">
                                    Off by default. A stored token lets anyone holding this device
                                    fetch every <strong>synced</strong> note in plaintext from the
                                    server, without the PIN — bypassing the encryption entirely.
                                    Unsynced notes stay protected either way.
                                </span>
                            </span>
                        </label>

                        <Button
                            size="sm"
                            className="justify-self-start"
                            onClick={() => void saveToken()}
                        >
                            Save and test
                        </Button>
                    </CardContent>
                </Card>
            )}

            <Alert>
                <AlertTitle>Why a refresh always asks again</AlertTitle>
                <AlertDescription>
                    The key exists only as a non-extractable object in memory, so reloading the page
                    destroys it. Storing it anywhere that survives a reload would put it in the
                    browser profile — exactly what an attacker holding the device already has. The
                    re-prompt is the design working, not a missing feature.
                </AlertDescription>
            </Alert>

            <Separator />

            <p className="text-muted-foreground text-xs">
                Vault created {new Date(vault.createdAt).toLocaleString()} · key derivation{' '}
                {vault.kdf ?? 'pbkdf2'}
            </p>
        </div>
    )
}
