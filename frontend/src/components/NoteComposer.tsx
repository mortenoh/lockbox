// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { encryptJson, newId } from '@/lib/crypto'
import * as db from '@/lib/db'
import { renderMarkdown } from '@/lib/markdown'
import * as sync from '@/lib/sync'
import { cn } from '@/lib/utils'

interface NoteComposerProps {
    /** Vault owner display name, stamped onto notes written here. */
    owner: string
    /** Vault id, scoping the record to this user's key. */
    ownerId: string
    /**
     * Present when editing. The dialog remounts this form per open, so state
     * initialises straight from these values - no effect needed.
     */
    editing?: {
        id: string
        createdAt: number
        origin: 'local' | 'pulled'
        title: string
        body: string
        author: string
    } | null
    onSaved: () => Promise<void> | void
}

/**
 * The write path: encrypt, store locally, queue for upload.
 *
 * Plaintext never leaves this component - it goes straight into encryptJson and
 * only the ciphertext is handed to IndexedDB and the outbox.
 *
 * Renders a bare form: the dialog on the Notes page provides the frame, so the
 * old Card wrapper is gone with it.
 */
export function NoteComposer({ owner, ownerId, editing = null, onSaved }: NoteComposerProps) {
    const [title, setTitle] = useState(editing?.title ?? '')
    const [body, setBody] = useState(editing?.body ?? '')
    const [preview, setPreview] = useState(false)
    const [busy, setBusy] = useState(false)

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault()
        if (!title.trim()) return

        // A save with nothing changed is a close, not a write. Writing would
        // claim "saved", re-queue an identical upload, and flip a synced note
        // back to "queued" - all for a no-op.
        if (editing && title.trim() === editing.title && body === editing.body) {
            await onSaved()
            return
        }

        setBusy(true)
        try {
            const now = Date.now()
            const { iv, ciphertext } = await encryptJson({
                title: title.trim(),
                body,
                // Editing keeps the original author - revising someone's pulled
                // note does not make it yours.
                author: editing?.author ?? owner,
            })
            const payload = {
                id: editing?.id ?? newId(),
                iv,
                ciphertext,
                createdAt: editing?.createdAt ?? now,
                updatedAt: now,
            }

            // One transaction: a note must never exist without its queue entry.
            await db.putNoteAndEnqueue(
                { ...payload, synced: false, origin: editing?.origin ?? 'local', ownerId },
                'put',
                payload,
            )

            setTitle('')
            setBody('')
            await sync.refresh()
            await onSaved()

            // Saving is local and immediate, upload is not - the toast only
            // needs to make that one distinction.
            toast.success('Saved on this device', {
                description: 'Queued for upload when the server is reachable.',
            })

            void sync.drain({ force: true })
        } finally {
            setBusy(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid gap-2">
                <Label htmlFor="note-title">Title</Label>
                <Input
                    id="note-title"
                    required
                    autoFocus
                    value={title}
                    placeholder="Field visit — Ward 3"
                    onChange={(e) => setTitle(e.target.value)}
                />
            </div>

            <div className="grid gap-2">
                <div className="flex items-center gap-3">
                    <Label htmlFor="note-body">Body</Label>
                    {/* Segmented control, left with the label it belongs to -
                        not buttons floating at the far edge of the dialog. */}
                    <div className="border-border inline-flex overflow-hidden rounded-lg border">
                        <button
                            type="button"
                            className={cn(
                                'px-2.5 py-1 text-xs font-medium transition-colors',
                                !preview
                                    ? 'bg-secondary text-foreground'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                            onClick={() => setPreview(false)}
                        >
                            Write
                        </button>
                        <button
                            type="button"
                            className={cn(
                                'border-border border-l px-2.5 py-1 text-xs font-medium transition-colors',
                                preview
                                    ? 'bg-secondary text-foreground'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                            onClick={() => setPreview(true)}
                        >
                            Preview
                        </button>
                    </div>
                </div>
                {preview ? (
                    <div
                        className="note-body border-input text-muted-foreground min-h-44 rounded-lg border px-2.5 py-2 text-sm md:min-h-40"
                        // Same sanitized renderer as the cards (lib/markdown.ts).
                        dangerouslySetInnerHTML={{
                            __html: renderMarkdown(body || '*Nothing to preview yet.*'),
                        }}
                    />
                ) : (
                    <Textarea
                        id="note-body"
                        rows={8}
                        value={body}
                        placeholder="Anything sensitive goes here. Markdown supported."
                        onChange={(e) => setBody(e.target.value)}
                    />
                )}
            </div>

            {/* "Save note", not "Encrypt and save": encryption is not a choice
                the user is making, it is what saving *is* here. The lock icon
                and the At Rest page carry that story. */}
            <Button type="submit" disabled={busy}>
                <LockKeyhole className="size-4" />
                Save note
            </Button>
        </form>
    )
}
