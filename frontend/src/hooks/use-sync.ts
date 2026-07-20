// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useSyncExternalStore } from 'react'

import { getState, subscribe } from '@/lib/sync'

/** Subscribe a component to the sync engine's state. */
export function useSync() {
    return useSyncExternalStore(subscribe, getState)
}
