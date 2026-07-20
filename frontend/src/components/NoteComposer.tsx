import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useSync } from '@/hooks/use-sync'
import { toast } from 'sonner'
import { encryptJson, newId } from '@/lib/crypto'
import * as db from '@/lib/db'
import * as sync from '@/lib/sync'

interface NoteComposerProps {
    /** Vault owner display name, stamped onto notes written here. */
    owner: string
    /** Vault id, scoping the record to this user's key. */
    ownerId: string
    onSaved: () => Promise<void> | void
}

/**
 * The write path: encrypt, store locally, queue for upload.
 *
 * Plaintext never leaves this component - it goes straight into encryptJson and
 * only the ciphertext is handed to IndexedDB and the outbox.
 */
export function NoteComposer({ owner, ownerId, onSaved }: NoteComposerProps) {
    const { mode } = useSync()
    const [title, setTitle] = useState('')
    const [body, setBody] = useState('')
    const [busy, setBusy] = useState(false)

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault()
        if (!title.trim()) return

        setBusy(true)
        try {
            const now = Date.now()
            const { iv, ciphertext } = await encryptJson({
                title: title.trim(),
                body,
                author: owner,
            })
            const payload = { id: newId(), iv, ciphertext, createdAt: now, updatedAt: now }

            // One transaction: a note must never exist without its queue entry.
            await db.putNoteAndEnqueue(
                { ...payload, synced: false, origin: 'local', ownerId },
                'put',
                payload,
            )

            setTitle('')
            setBody('')
            await sync.refresh()
            await onSaved()

            // Names the thing that actually happened - encryption is local and
            // immediate, upload is not.
            toast.success('Encrypted and saved locally', {
                description: 'Queued for upload when the server is reachable.',
            })

            void sync.drain({ force: true })
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>New note</CardTitle>
            </CardHeader>
            <CardContent>
                <form onSubmit={handleSubmit} className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="note-title">Title</Label>
                        <Input
                            id="note-title"
                            required
                            value={title}
                            placeholder="Field visit — Ward 3"
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </div>

                    <div className="grid gap-2">
                        <Label htmlFor="note-body">Body</Label>
                        <Textarea
                            id="note-body"
                            rows={4}
                            value={body}
                            placeholder="Anything sensitive goes here."
                            onChange={(e) => setBody(e.target.value)}
                        />
                    </div>

                    <Button type="submit" disabled={busy}>
                        <LockKeyhole className="size-4" />
                        Encrypt &amp; save
                    </Button>

                    {/* The second sentence depends on the active sync mode - claiming
                        the server never sees plaintext would be false in plaintext mode. */}
                    <p className="text-muted-foreground text-sm">
                        Encrypted in the browser before it touches IndexedDB, then queued.{' '}
                        {mode === 'plaintext'
                            ? 'On upload it is decrypted and sent readable, the way a DHIS2 backend needs it.'
                            : 'It is uploaded as ciphertext, which the server cannot read.'}
                    </p>
                </form>
            </CardContent>
        </Card>
    )
}
