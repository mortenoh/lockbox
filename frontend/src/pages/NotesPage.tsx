// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useState } from 'react'

import { NoteComposer } from '@/components/NoteComposer'
import { NoteList } from '@/components/NoteList'
import { SyncQueue } from '@/components/SyncQueue'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import type { DecryptedNote } from '@/hooks/use-notes'
import type { OutboxEntry } from '@/lib/db'

interface NotesPageProps {
    notes: DecryptedNote[]
    /** Vault owner display name, for authorship and 'you' labelling. */
    owner: string
    /** Vault id, scoping writes to this user's key. */
    ownerId: string
    queue: OutboxEntry[]
    onReload: () => Promise<void> | void
    onDelete: (id: string) => void
    onPull: () => void
    onDiscard: (seq: number) => void
}

/** The working demo: a list first, with composing in a dialog on demand. */
export function NotesPage({
    notes,
    owner,
    ownerId,
    queue,
    onReload,
    onDelete,
    onPull,
    onDiscard,
}: NotesPageProps) {
    const [composing, setComposing] = useState(false)
    const [editing, setEditing] = useState<DecryptedNote | null>(null)

    // The command palette lives in the layout and cannot reach this state, so
    // its "New note" action navigates here and fires this event instead.
    useEffect(() => {
        const open = () => setComposing(true)
        document.addEventListener('lockbox:new-note', open)
        return () => document.removeEventListener('lockbox:new-note', open)
    }, [])

    const close = (open: boolean) => {
        if (!open) setEditing(null)
        setComposing(open)
    }

    return (
        <div className="grid gap-6">
            <NoteList
                notes={notes}
                owner={owner}
                onCompose={() => setComposing(true)}
                onEdit={(note) => {
                    setEditing(note)
                    setComposing(true)
                }}
                onDelete={onDelete}
                onPull={onPull}
            />
            <SyncQueue queue={queue} onDiscard={onDiscard} />

            <Dialog open={composing} onOpenChange={close}>
                {/* Wider than the shadcn default on desktop - notes are prose
                    and markdown tables need the room. Mobile stays full-width. */}
                <DialogContent className="sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editing ? 'Edit note' : 'New note'}</DialogTitle>
                        <DialogDescription className="sr-only">
                            Write a note. It is stored on this device and queued for upload.
                        </DialogDescription>
                    </DialogHeader>
                    <NoteComposer
                        owner={owner}
                        ownerId={ownerId}
                        editing={
                            editing?.content
                                ? {
                                      id: editing.id,
                                      createdAt: editing.createdAt,
                                      origin: editing.origin ?? 'local',
                                      title: editing.content.title,
                                      body: editing.content.body,
                                      author: editing.content.author,
                                  }
                                : null
                        }
                        onSaved={async () => {
                            close(false)
                            await onReload()
                        }}
                    />
                </DialogContent>
            </Dialog>
        </div>
    )
}
