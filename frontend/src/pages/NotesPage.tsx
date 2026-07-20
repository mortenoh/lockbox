// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { NoteComposer } from '@/components/NoteComposer'
import { NoteList } from '@/components/NoteList'
import { SyncQueue } from '@/components/SyncQueue'
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

/** The working demo: compose, list, and watch the queue drain. */
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
    return (
        <div className="grid gap-6">
            <NoteComposer owner={owner} ownerId={ownerId} onSaved={onReload} />
            <NoteList notes={notes} owner={owner} onDelete={onDelete} onPull={onPull} />
            <SyncQueue queue={queue} onDiscard={onDiscard} />
        </div>
    )
}
