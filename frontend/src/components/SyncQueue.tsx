import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import type { OutboxEntry } from '@/lib/db'

interface SyncQueueProps {
    queue: OutboxEntry[]
    onDiscard: (seq: number) => void
}

/**
 * The pending-write queue, surfaced so offline work is visible rather than
 * silently buffered - and so permanently-failed entries can be dealt with.
 */
export function SyncQueue({ queue, onDiscard }: SyncQueueProps) {
    if (queue.length === 0) return null

    return (
        <Card>
            <CardHeader>
                <CardTitle>Sync queue</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
                {queue.map((entry, index) => {
                    const failed = entry.status === 'failed'
                    return (
                        <div key={entry.seq}>
                            {index > 0 && <Separator className="mb-2" />}
                            <div className="flex items-center gap-3 text-sm">
                                <code className="text-muted-foreground text-xs">
                                    {entry.op.toUpperCase()} {entry.noteId.slice(0, 8)}…
                                </code>
                                <span
                                    className={
                                        failed ? 'text-destructive' : 'text-muted-foreground'
                                    }
                                >
                                    {failed
                                        ? `failed: ${entry.lastError}`
                                        : `pending (${entry.attempts} attempts)`}
                                </span>
                                <div className="flex-1" />
                                {failed && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => onDiscard(entry.seq)}
                                    >
                                        Discard
                                    </Button>
                                )}
                            </div>
                        </div>
                    )
                })}
            </CardContent>
        </Card>
    )
}
