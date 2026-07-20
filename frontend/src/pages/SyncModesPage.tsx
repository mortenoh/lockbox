// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useState } from 'react'
import { Check, RefreshCw, ServerCog } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from 'sonner'

import { useSync } from '@/hooks/use-sync'
import { fetchServerState, setMode, type SyncMode } from '@/lib/sync'

/**
 * Sync Modes: what the backend actually ends up holding.
 *
 * This page exists because the choice it presents is the central architectural
 * decision of the project, and it is much easier to see than to describe. Both
 * server stores are fetched and printed raw, side by side.
 */

const MODES: { id: SyncMode; title: string; blurb: string }[] = [
    {
        id: 'plaintext',
        title: 'Plaintext sync',
        blurb: 'Decrypt on upload. The backend receives readable data — the DHIS2-realistic path.',
    },
    {
        id: 'encrypted',
        title: 'Encrypted sync',
        blurb: 'Upload ciphertext untouched. The backend stores bytes it cannot read.',
    },
]

export function SyncModesPage() {
    const { mode, blockedByLock } = useSync()
    const [server, setServer] = useState<{ plain: unknown[]; encrypted: unknown[] } | null>(null)
    const [loading, setLoading] = useState(false)

    const refresh = useCallback(async () => {
        setLoading(true)
        try {
            setServer(await fetchServerState())
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    return (
        <div className="grid gap-6">
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                    <ServerCog className="text-primary size-6" aria-hidden />
                    Sync Modes
                </h1>
                <p className="text-muted-foreground mt-1">
                    Local encryption is settled. The open question is what crosses the network —
                    and it decides whether the backend can do its job.
                </p>
            </div>

            <Alert>
                <AlertTitle>Why DHIS2 forces this choice</AlertTitle>
                <AlertDescription>
                    Every user of this PWA sets their own passphrase. If uploads were encrypted with
                    it, each record would be readable by exactly one person — and a platform that
                    exists to validate, aggregate and <em>share</em> data between users would be
                    handed bytes it cannot process. So encryption here stays local: it protects
                    IndexedDB on a stolen device, while TLS protects the wire and the platform&rsquo;s
                    own rules govern the server.
                </AlertDescription>
            </Alert>

            <div className="grid gap-3 sm:grid-cols-2">
                {MODES.map((option) => {
                    const active = option.id === mode
                    return (
                        <Card
                            key={option.id}
                            className={active ? 'border-primary ring-primary/20 ring-2' : undefined}
                        >
                            <CardHeader>
                                <div className="flex items-center gap-2">
                                    <CardTitle className="text-base">{option.title}</CardTitle>
                                    {active && <Badge>active</Badge>}
                                    {option.id === 'plaintext' && (
                                        <Badge variant="outline">default</Badge>
                                    )}
                                </div>
                                <CardDescription>{option.blurb}</CardDescription>
                            </CardHeader>
                            <CardContent>
                                {/* The active card already says so twice (ring,
                                    badge) - a disabled button that never enables
                                    only pretended to be a control. The line is
                                    sized like the sm button opposite, so the two
                                    cards keep aligned bottoms. */}
                                {active ? (
                                    <p className="text-muted-foreground flex h-10 items-center gap-1.5 text-sm md:h-7">
                                        <Check className="size-4" aria-hidden />
                                        In use
                                    </p>
                                ) : (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => {
                                            setMode(option.id)
                                            toast.info(`Switched to ${option.title.toLowerCase()}`, {
                                                description:
                                                    option.id === 'plaintext'
                                                        ? 'Uploads are decrypted first. Syncing now requires an unlocked vault.'
                                                        : 'Uploads stay encrypted. The server cannot read them, and neither can other users.',
                                            })
                                            void refresh()
                                        }}
                                    >
                                        Switch to this mode
                                    </Button>
                                )}
                            </CardContent>
                        </Card>
                    )
                })}
            </div>

            {blockedByLock && (
                <Alert variant="destructive">
                    <AlertTitle>Sync is paused because the vault is locked</AlertTitle>
                    <AlertDescription>
                        This is the cost of plaintext mode, not a bug: uploading requires decrypting,
                        which requires the key. Encrypted mode would keep syncing while locked,
                        because it never needs to read the data.
                    </AlertDescription>
                </Alert>
            )}

            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">What the server holds right now</h2>
                <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
                    <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
                    Refresh
                </Button>
            </div>

            {server === null ? (
                <p className="text-muted-foreground text-sm">
                    Server unreachable — start it to inspect the stores.
                </p>
            ) : (
                <div className="grid gap-4">
                    <ServerStore
                        title="/api/plain-notes"
                        subtitle="Plaintext mode — readable, and therefore usable by the platform"
                        rows={server.plain}
                        tone="readable"
                    />
                    <ServerStore
                        title="/api/notes"
                        subtitle="Encrypted mode — opaque, and therefore inert to the platform"
                        rows={server.encrypted}
                        tone="opaque"
                    />
                </div>
            )}
        </div>
    )
}

interface ServerStoreProps {
    title: string
    subtitle: string
    rows: unknown[]
    tone: 'readable' | 'opaque'
}

/** Dump one server store verbatim - no formatting tricks, just the JSON. */
function ServerStore({ title, subtitle, rows, tone }: ServerStoreProps) {
    return (
        <Card>
            <CardHeader>
                <div className="flex items-center gap-2">
                    <CardTitle className="font-mono text-sm">{title}</CardTitle>
                    <Badge variant={tone === 'readable' ? 'secondary' : 'outline'}>
                        {rows.length} record{rows.length === 1 ? '' : 's'}
                    </Badge>
                </div>
                <CardDescription>{subtitle}</CardDescription>
            </CardHeader>
            <CardContent>
                {rows.length === 0 ? (
                    <p className="text-muted-foreground text-sm">Empty.</p>
                ) : (
                    <pre className="bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs">
                        <code>{JSON.stringify(rows, null, 2)}</code>
                    </pre>
                )}
            </CardContent>
        </Card>
    )
}
