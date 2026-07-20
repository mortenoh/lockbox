// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useCallback, useEffect, useState } from 'react'
import { Database, RefreshCw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import * as db from '@/lib/db'
import type { NoteRecord, OutboxEntry } from '@/lib/db'
import type { VaultRecord } from '@/lib/crypto'

/**
 * At Rest: the raw contents of IndexedDB.
 *
 * This is the page that either substantiates the project's central claim or
 * disproves it. Everything here is read straight from IndexedDB with no
 * decryption, so it is exactly what someone with the browser profile of a
 * stolen laptop would find.
 *
 * It also makes the honest limitation visible: ids and timestamps are in the
 * clear. That is a deliberate trade - the outbox has to be readable for sync to
 * work, and list ordering has to work before unlock - but it does leak that a
 * record exists and when it changed.
 */

export function StoragePage() {
    const [vaults, setVaults] = useState<VaultRecord[]>([])
    const [notes, setNotes] = useState<NoteRecord[]>([])
    const [outbox, setOutbox] = useState<OutboxEntry[]>([])
    const [persisted, setPersisted] = useState<boolean | null>(null)

    const reload = useCallback(async () => {
        setVaults(await db.listVaults())
        setNotes(await db.getAllNotes())
        setOutbox(await db.getAllOutbox())
        setPersisted(
            navigator.storage?.persisted ? await navigator.storage.persisted() : null,
        )
    }, [])

    useEffect(() => {
        void reload()
    }, [reload])

    return (
        <div className="grid gap-6">
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                    <Database className="text-primary size-6" aria-hidden />
                    At Rest
                </h1>
                <p className="text-muted-foreground mt-1">
                    Raw IndexedDB, read without decrypting — what an attacker holding the browser
                    profile would actually see.
                </p>
            </div>

            <div className="flex items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                    <RefreshCw className="size-4" />
                    Reload
                </Button>
                {persisted !== null && (
                    <Badge variant={persisted ? 'secondary' : 'outline'}>
                        {persisted ? 'storage persisted' : 'storage evictable'}
                    </Badge>
                )}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>vault</CardTitle>
                    <CardDescription>
                        One wrapped key per user of this device. Safe in the clear: without the
                        PIN (or the enrolled authenticator) these bytes do nothing.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {vaults.length === 0 ? (
                        <p className="text-muted-foreground text-sm">No vaults.</p>
                    ) : (
                        <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs">
                            <code>{JSON.stringify(vaults, null, 2)}</code>
                        </pre>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <CardTitle>notes</CardTitle>
                        <Badge variant="outline">{notes.length}</Badge>
                    </div>
                    <CardDescription>
                        Ciphertext plus routing metadata. Note what is <em>not</em> protected: ids
                        and timestamps.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {notes.length === 0 ? (
                        <p className="text-muted-foreground text-sm">Empty.</p>
                    ) : (
                        <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs">
                            <code>{JSON.stringify(notes, null, 2)}</code>
                        </pre>
                    )}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <CardTitle>outbox</CardTitle>
                        <Badge variant="outline">{outbox.length}</Badge>
                    </div>
                    <CardDescription>
                        Queued uploads, each carrying a complete encrypted record.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    {outbox.length === 0 ? (
                        <p className="text-muted-foreground text-sm">Empty.</p>
                    ) : (
                        <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 text-xs">
                            <code>{JSON.stringify(outbox, null, 2)}</code>
                        </pre>
                    )}
                </CardContent>
            </Card>

            <Alert>
                <AlertTitle>What this does and does not prove</AlertTitle>
                <AlertDescription>
                    No note title or body appears anywhere above — that is the claim, demonstrated.
                    But this page is rendered by the running app, which holds the key while
                    unlocked. It shows that data is safe on a <strong>powered-off, stolen
                    device</strong>. It says nothing about a page compromised by XSS, where an
                    attacker can simply use the live key.
                </AlertDescription>
            </Alert>
        </div>
    )
}
