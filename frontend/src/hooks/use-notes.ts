import { useCallback, useEffect, useState } from 'react'

import { decryptJson } from '@/lib/crypto'
import * as db from '@/lib/db'
import type { NoteContent, NoteRecord, OutboxEntry } from '@/lib/db'

/** A stored note paired with its decrypted contents (null if undecryptable). */
export interface DecryptedNote extends NoteRecord {
    content: NoteContent | null
}

/**
 * Load notes from IndexedDB and decrypt them for display.
 *
 * The list always comes from local storage rather than a server response, so
 * the UI behaves identically online and offline.
 */
export function useNotes(ownerId: string | null) {
    const [notes, setNotes] = useState<DecryptedNote[]>([])
    const [queue, setQueue] = useState<OutboxEntry[]>([])

    const reload = useCallback(async () => {
        if (!ownerId) {
            setNotes([])
            setQueue([])
            return
        }

        const stored = await db.getNotes(ownerId)
        const decrypted = await Promise.all(
            stored.map(async (note) => {
                try {
                    return { ...note, content: await decryptJson<NoteContent>(note) }
                } catch {
                    // A record encrypted under a different DEK (e.g. pulled from
                    // the server after a local wipe) cannot be read. Surface it
                    // honestly rather than dropping it silently.
                    return { ...note, content: null }
                }
            }),
        )

        setNotes(decrypted)
        setQueue(await db.getOutbox(ownerId))
    }, [ownerId])

    useEffect(() => {
        void reload()
    }, [reload])

    return { notes, queue, reload }
}
