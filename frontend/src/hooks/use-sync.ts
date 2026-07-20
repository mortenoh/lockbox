import { useSyncExternalStore } from 'react'

import { getState, subscribe } from '@/lib/sync'

/** Subscribe a component to the sync engine's state. */
export function useSync() {
    return useSyncExternalStore(subscribe, getState)
}
