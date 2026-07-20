import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Route, Routes } from 'react-router-dom'

import { AppLayout } from '@/components/AppLayout'
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
 * Routing uses HashRouter, which is worth a word of explanation.
 *
 * Reloading destroys the key by design, so the app always returns to the unlock
 * screen. It should not *also* forget which page you were on - and giving each
 * page a URL is the fix. A hash route keeps that entirely client-side, so the
 * server needs no SPA fallback and, more usefully here, the service worker only
 * ever sees "/" for a navigation. The cached shell therefore matches any route,
 * and a deep-linked page still loads with no network.
 *
 * The device may have several registered users. Exactly one is active at a time,
 * and everything below is scoped to them: their notes, their queue, their key.
 */
export default function App() {
    const [vault, setVault] = useState<VaultRecord | null>(null)
    const [autoLockMinutes, setAutoLockMinutes] = useState(session.getAutoLockMinutes())

    const ownerId = vault?.id ?? null
    const { notes, queue, reload } = useNotes(ownerId)

    // Tell the sync engine how to check lock state. Plaintext uploads must
    // decrypt, so it needs to know when it cannot proceed.
    useEffect(() => {
        sync.setUnlockedCheck(isUnlocked)
    }, [])

    // Re-read notes when a drain finishes, so "this device only" badges flip to
    // "on server" on their own - and when an automatic pull brings in changes
    // someone else made.
    useEffect(() => {
        if (!ownerId) return
        let wasSyncing = false
        let lastPullSeen: number | null = null
        return sync.subscribe((state) => {
            if (wasSyncing && !state.syncing) void reload()
            if (state.lastPullAt && state.lastPullAt !== lastPullSeen) {
                lastPullSeen = state.lastPullAt
                void reload()
            }
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
        // Drain first so unsent local work is not clobbered by a remote LWW win.
        const before = sync.getState().lastPullAt
        await sync.runSyncCycle({ forceDrain: true, minPullIntervalMs: 0 })
        await reload()

        const after = sync.getState().lastPullAt
        const changed = after !== null && after !== before

        // Silence was how the broken pull went unnoticed - always say what happened.
        // lastPullAt only advances when pull actually wrote something.
        if (changed) {
            toast.success('Pulled remote changes', {
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
            ownerId={vault.id}
            owner={vault.owner}
            onLock={handleLock}
            onSwitchUser={handleSwitchUser}
        >
            {/* Routed rather than switched on state, so a reload returns to the
                page you were on. The vault still has to be unlocked again - the
                key cannot survive a reload - but it no longer also throws away
                where you were. */}
            <Routes>
                <Route
                    index
                    element={
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
                    }
                />
                <Route path="kdf" element={<KdfLabPage />} />
                <Route path="sync-modes" element={<SyncModesPage />} />
                <Route path="storage" element={<StoragePage />} />
                <Route
                    path="security"
                    element={
                        <SecurityPage
                            vault={vault}
                            onVaultChanged={setVault}
                            autoLockMinutes={autoLockMinutes}
                            onAutoLockChanged={setAutoLockMinutes}
                        />
                    }
                />
                {/* Unknown hash routes fall back to the demo rather than a blank page. */}
                <Route
                    path="*"
                    element={
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
                    }
                />
            </Routes>
        </AppLayout>
    )
}
