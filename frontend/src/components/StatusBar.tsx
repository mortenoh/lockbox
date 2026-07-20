import { CloudOff, Lock, RefreshCw, ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useSync } from '@/hooks/use-sync'
import { cn } from '@/lib/utils'
import { formatTime } from '@/lib/format'

interface StatusBarProps {
    onSyncNow: () => void
    onLock: () => void
}

/** Sticky header showing connectivity, queue depth, and session controls. */
export function StatusBar({ onSyncNow, onLock }: StatusBarProps) {
    const { online, syncing, pending, failed, lastSyncAt } = useSync()

    return (
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-10 border-b backdrop-blur">
            <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-2.5">
                <span className="flex items-center gap-2 text-sm">
                    {online ? (
                        <ShieldCheck
                            className={cn('size-4 text-emerald-600 dark:text-emerald-400', syncing && 'animate-pulse')}
                            aria-hidden
                        />
                    ) : (
                        <CloudOff className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
                    )}
                    <span className="text-muted-foreground">
                        {syncing
                            ? 'Syncing…'
                            : online
                              ? lastSyncAt
                                  ? `Online · synced ${formatTime(lastSyncAt)}`
                                  : 'Online'
                              : 'Offline — changes are queued'}
                    </span>
                </span>

                <div className="flex-1" />

                {pending > 0 && <Badge variant="secondary">{pending} queued</Badge>}
                {failed > 0 && <Badge variant="destructive">{failed} failed</Badge>}

                <Button variant="ghost" size="sm" onClick={onSyncNow} disabled={syncing}>
                    <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
                    <span className="sr-only sm:not-sr-only">Sync now</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={onLock}>
                    <Lock className="size-4" />
                    <span className="sr-only sm:not-sr-only">Lock</span>
                </Button>
            </div>
        </header>
    )
}
