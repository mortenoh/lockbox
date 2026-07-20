import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, KeyRound, Lock, RefreshCw, ShieldCheck, WifiOff } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { useSync } from '@/hooks/use-sync'
import * as db from '@/lib/db'
import { formatTime } from '@/lib/format'
import * as sync from '@/lib/sync'
import { cn } from '@/lib/utils'

/**
 * Connectivity light plus an "what is actually on this device" panel.
 *
 * In an offline-first app the interesting question is rarely "am I online" - it
 * is "what has not reached the server yet, and would I lose it". The dot answers
 * the first at a glance, the panel answers the second on demand.
 */
export function StatusMenu({ ownerId, onOpenSecurity }: { ownerId: string; onOpenSecurity: () => void }) {
    const { online, syncing, pending, failed, lastSyncAt, mode, blockedByLock, unauthorized } =
        useSync()
    const [open, setOpen] = useState(false)
    const [local, setLocal] = useState({ notes: 0, unsynced: 0, persisted: false })

    const loadLocal = useCallback(async () => {
        const notes = await db.getNotes(ownerId)
        setLocal({
            notes: notes.length,
            unsynced: notes.filter((n) => !n.synced).length,
            persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : false,
        })
    }, [ownerId])

    // Only read IndexedDB while the panel is open - no reason to poll storage
    // for a panel nobody is looking at.
    useEffect(() => {
        if (open) void loadLocal()
    }, [open, loadLocal])

    // 'unauthorized' is deliberately its own state. Folding it into "offline"
    // is what made a missing token look like a network fault.
    const tone = unauthorized ? 'red' : blockedByLock || !online ? 'amber' : 'emerald'
    const label = unauthorized
        ? 'No access'
        : blockedByLock
          ? 'Locked'
          : !online
            ? 'Offline'
            : syncing
              ? 'Syncing'
              : 'Online'

    const StatusIcon = unauthorized
        ? KeyRound
        : blockedByLock
          ? Lock
          : !online
            ? WifiOff
            : syncing
              ? RefreshCw
              : ShieldCheck

    const dotClass =
        tone === 'emerald' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-red-500'

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2"
                    aria-label={`Connection status: ${label}. Open details.`}
                >
                    <span className="relative flex size-2.5">
                        {/* Halo only while syncing, so motion means something. */}
                        {syncing && (
                            <span
                                className={cn(
                                    'absolute inline-flex size-full animate-ping rounded-full opacity-70',
                                    dotClass,
                                )}
                            />
                        )}
                        <span
                            className={cn('relative inline-flex size-2.5 rounded-full', dotClass)}
                        />
                    </span>
                    <span className="hidden sm:inline">{label}</span>
                    {pending > 0 && (
                        <Badge variant="secondary" className="ml-0.5">
                            {pending}
                        </Badge>
                    )}
                    <ChevronDown className="size-3.5 opacity-60" aria-hidden />
                </Button>
            </PopoverTrigger>

            {/* Constrained so it cannot overflow a narrow phone viewport. */}
            <PopoverContent align="end" sideOffset={8} className="w-[min(20rem,calc(100vw-1.5rem))]">
                <div className="flex items-center gap-2">
                    <StatusIcon
                        className={cn(
                            'size-4',
                            tone === 'emerald'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : tone === 'amber'
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-destructive',
                            syncing && 'animate-spin',
                        )}
                        aria-hidden
                    />
                    <span className="font-medium">{label}</span>
                    <div className="flex-1" />
                    <Badge variant="outline" className="font-normal">
                        {mode === 'plaintext' ? 'plaintext sync' : 'encrypted sync'}
                    </Badge>
                </div>

                {unauthorized && (
                    <div className="mt-2 grid gap-2">
                        <p className="text-muted-foreground text-xs">
                            The server is reachable but rejected this device (HTTP 401). It is
                            running with <code>--auth token</code> and no matching token is stored
                            here — this is <strong>not</strong> a connectivity problem.
                        </p>
                        <Button
                            size="sm"
                            className="w-full"
                            onClick={() => {
                                setOpen(false)
                                onOpenSecurity()
                            }}
                        >
                            <KeyRound className="size-4" />
                            Enter access token
                        </Button>
                    </div>
                )}

                {blockedByLock && (
                    <p className="text-muted-foreground mt-2 text-xs">
                        Plaintext uploads must be decrypted first, so syncing is paused until the
                        vault is unlocked.
                    </p>
                )}

                <Separator className="my-3" />

                <dl className="grid gap-2 text-sm">
                    <Row label="Notes on this device" value={local.notes} />
                    <Row
                        label="Not yet on the server"
                        value={local.unsynced}
                        tone={local.unsynced > 0 ? 'amber' : undefined}
                    />
                    <Row
                        label="Queued uploads"
                        value={pending}
                        tone={pending > 0 ? 'amber' : undefined}
                    />
                    <Row
                        label="Failed uploads"
                        value={failed}
                        tone={failed > 0 ? 'destructive' : undefined}
                    />
                    <Row
                        label="Last sync"
                        value={lastSyncAt ? formatTime(lastSyncAt) : 'never'}
                    />
                    <Row
                        label="Storage"
                        value={local.persisted ? 'persisted' : 'evictable'}
                        tone={local.persisted ? undefined : 'amber'}
                    />
                </dl>

                <Separator className="my-3" />

                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        className="flex-1"
                        disabled={syncing}
                        onClick={async () => {
                            await sync.drain({ force: true })
                            await loadLocal()
                        }}
                    >
                        <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
                        Sync now
                    </Button>
                </div>

                <p className="text-muted-foreground mt-3 text-xs">
                    Everything above is stored encrypted at rest. Unsynced notes live only on this
                    device.
                </p>
            </PopoverContent>
        </Popover>
    )
}

interface RowProps {
    label: string
    value: string | number
    tone?: 'amber' | 'destructive'
}

function Row({ label, value, tone }: RowProps) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
                className={cn(
                    'font-medium tabular-nums',
                    tone === 'amber' && 'text-amber-600 dark:text-amber-400',
                    tone === 'destructive' && 'text-destructive',
                )}
            >
                {value}
            </dd>
        </div>
    )
}
