import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { AppLayout, type PageId } from '@/components/AppLayout'
import { UnlockScreen } from '@/components/UnlockScreen'
import { KdfLabPage } from '@/pages/KdfLabPage'
import { NotesPage } from '@/pages/NotesPage'
import { SecurityPage } from '@/pages/SecurityPage'
import { StoragePage } from '@/pages/StoragePage'
import { SyncModesPage } from '@/pages/SyncModesPage'
import { useAutoLock } from '@/hooks/use-auto-lock'
import { useNotes } from '@/hooks/use-notes'
import { isUnlocked, lockVault, type VaultRecord } from '@/lib/crypto'
import * as db from '@/lib/db'
import * as session from '@/lib/session'
import * as sync from '@/lib/sync'

/**
 * Navigation is plain component state rather than a router.
 *
 * Four sibling pages with no deep-linking requirement do not justify a routing
 * dependency, and keeping it out means one less thing between the reader and
 * the parts of this project that are actually interesting.
 *
 * The device may have several registered users. Exactly one is active at a time,
 * and everything below is scoped to them: their notes, their queue, their key.
 */
export default function App() {
    const [vault, setVault] = useState<VaultRecord | null>(null)
    const [page, setPage] = useState<PageId>('notes')
    const [autoLockMinutes, setAutoLockMinutes] = useState(session.getAutoLockMinutes())

    const ownerId = vault?.id ?? null
    const { notes, queue, reload } = useNotes(ownerId)

    // Tell the sync engine how to check lock state. Plaintext uploads must
    // decrypt, so it needs to know when it cannot proceed.
    useEffect(() => {
        sync.setUnlockedCheck(isUnlocked)
    }, [])

    // Re-read notes whenever a drain finishes, so "this device only" badges flip
    // to "on server" without the user doing anything.
    useEffect(() => {
        if (!ownerId) return
        let wasSyncing = false
        return sync.subscribe((state) => {
            if (wasSyncing && !state.syncing) void reload()
            wasSyncing = state.syncing
        })
    }, [ownerId, reload])

    const handleUnlocked = useCallback((unlockedVault: VaultRecord) => {
        setVault(unlockedVault)
        // Remember *who*, never the key - so a reload can open straight onto
        // this user's PIN pad instead of the picker.
        session.setLastUserId(unlockedVault.id)
        sync.setActiveOwner(unlockedVault.id)
        sync.start()
        void sync.drain({ force: true })
    }, [])

    /** Drop the key but keep the user selected. */
    const handleLock = useCallback(() => {
        lockVault()
        sync.setActiveOwner(null)
        setVault(null)
    }, [])

    /** Drop the key and forget the user, returning to the picker. */
    const handleSwitchUser = useCallback(() => {
        lockVault()
        sync.setActiveOwner(null)
        session.clearLastUserId()
        setVault(null)
    }, [])

    // Idle timeout. Matters most with a short PIN, where the in-memory window is
    // the main thing protecting a device someone else can pick up.
    useAutoLock(vault !== null, autoLockMinutes, handleLock)

    const handleDelete = useCallback(
        async (id: string) => {
            if (!ownerId) return
            await db.deleteNoteAndEnqueue(ownerId, id)
            await sync.refresh()
            await reload()
            void sync.drain({ force: true })
        },
        [ownerId, reload],
    )

    const handlePull = useCallback(async () => {
        const changed = await sync.pull()
        await reload()

        // Silence was how the broken pull went unnoticed - always say what happened.
        if (changed > 0) {
            toast.success(`Pulled ${changed} note${changed === 1 ? '' : 's'}`, {
                description:
                    sync.getState().mode === 'plaintext'
                        ? 'Re-encrypted with this user’s key before storing.'
                        : 'Copied as ciphertext. Records from another device will not open here.',
            })
        } else {
            toast.info('Nothing new to pull')
        }
    }, [reload])

    const handleDiscard = useCallback(
        async (seq: number) => {
            await db.discardEntry(seq)
            await sync.refresh()
            await reload()
        },
        [reload],
    )

    // `isUnlocked()` is checked as well as `vault`, so a lock triggered anywhere
    // else in the app still sends us back to the sign-in screen.
    if (!vault || !isUnlocked()) {
        return <UnlockScreen initialUserId={session.getLastUserId()} onUnlocked={handleUnlocked} />
    }

    return (
        <AppLayout
            page={page}
            ownerId={vault.id}
            owner={vault.owner}
            onNavigate={setPage}
            onLock={handleLock}
            onSwitchUser={handleSwitchUser}
        >
            {page === 'notes' && (
                <NotesPage
                    notes={notes}
                    owner={vault.owner}
                    ownerId={vault.id}
                    queue={queue}
                    onReload={reload}
                    onDelete={handleDelete}
                    onPull={handlePull}
                    onDiscard={handleDiscard}
                />
            )}
            {page === 'kdf' && <KdfLabPage />}
            {page === 'sync-modes' && <SyncModesPage />}
            {page === 'storage' && <StoragePage />}
            {page === 'security' && (
                <SecurityPage
                    vault={vault}
                    onVaultChanged={setVault}
                    autoLockMinutes={autoLockMinutes}
                    onAutoLockChanged={setAutoLockMinutes}
                />
            )}
        </AppLayout>
    )
}
