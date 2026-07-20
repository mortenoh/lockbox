// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Central tunables for key derivation and unlock performance.
 *
 * Everything adjustable about the KDF lives here, in one place: which
 * algorithm new vaults use, the Argon2id parameter ladder that on-device
 * calibration picks from, the unlock-time budget it aims for, and the
 * memory caps for low-RAM devices.
 *
 * The deployment target is NOT developer hardware. Assume the field devices
 * - decade-old laptops, cheap Android phones and tablets - are at least 10x
 * slower than the laptop this was written on, and may have 1-2 GB of RAM.
 * That is why parameters are calibrated per device at vault creation
 * (see `calibrateKdfParams` in crypto.ts) instead of hardcoded: a fixed
 * "strong" setting turns unlocking into a multi-second freeze or an outright
 * WASM allocation failure on exactly the machines this must run on. The
 * chosen parameters are recorded in the vault record, so unlocking never
 * needs to calibrate again and existing vaults are never affected by edits
 * here - see `vaultKdf`.
 */

import type { KdfId, KdfParams } from '@/lib/crypto'

/** The KDF used for vaults created from now on. */
export const DEFAULT_KDF: KdfId = 'argon2id'

/**
 * PBKDF2 iteration count (OWASP 2026 guidance for HMAC-SHA256).
 *
 * Retained for two reasons: opening vaults created before Argon2id, and
 * serving as the comparison arm in the KDF Lab. Not recommended for new vaults.
 */
export const PBKDF2_ITERATIONS = 600_000

/**
 * Argon2id candidate parameters, strongest first.
 *
 * Argon2id is *memory-hard*: every guess must allocate `memorySize` of RAM.
 * That is the whole point. PBKDF2 is merely CPU-hard, and a GPU can run tens
 * of thousands of SHA-256 chains in parallel at almost no memory cost per
 * lane. Forcing real memory per guess caps how many guesses fit on a card
 * and shrinks that advantage by orders of magnitude. This only matters for
 * weak passphrases - and users choose weak passphrases.
 *
 * Calibration picks the strongest tier the device can derive within
 * `TARGET_UNLOCK_MS`. Measured on an Apple Silicon laptop for scale:
 *
 *     128 MiB / 3 passes -> 263 ms   <- what a dev-class machine gets
 *      64 MiB / 3 passes -> 121 ms
 *      32 MiB / 3 passes ->  ~60 ms
 *      19 MiB / 2 passes ->  ~26 ms  <- the floor, and the calibration probe
 *
 * A device 10x slower lands on 32 MiB / 3 (~650 ms); one 25x slower falls to
 * the floor. The floor is OWASP's minimum recommendation for Argon2id
 * (19 MiB, t=2, p=1) and is used even when it exceeds the time budget:
 * calibration trades strength for speed only down to there, never further.
 *
 * `parallelism` stays 1 throughout - browsers give us no reliable
 * parallelism here.
 */
export const ARGON2ID_LADDER: readonly Required<KdfParams>[] = [
    { memorySize: 131_072, iterations: 3, parallelism: 1 }, // 128 MiB
    { memorySize: 65_536, iterations: 3, parallelism: 1 }, //   64 MiB
    { memorySize: 32_768, iterations: 3, parallelism: 1 }, //   32 MiB
    { memorySize: 19_456, iterations: 2, parallelism: 1 }, //   19 MiB - OWASP minimum
]

/** The ceiling: what calibration awards a machine with headroom. */
export const ARGON2ID_PARAMS: Required<KdfParams> = ARGON2ID_LADDER[0]

/** The floor: never derive with less work than this, however slow the device. */
export const ARGON2ID_MIN_PARAMS: Required<KdfParams> = ARGON2ID_LADDER[ARGON2ID_LADDER.length - 1]

/**
 * The most one KDF derivation may be predicted to take.
 *
 * One derivation happens per unlock, so this is the unlock-latency budget.
 * Higher favours security on slow devices, lower favours not making the
 * lock screen feel broken.
 */
export const TARGET_UNLOCK_MS = 1_000

/**
 * Memory ceilings by reported device RAM (`navigator.deviceMemory`, in GB).
 *
 * Speed is not the only constraint: on a 1-2 GB Android phone a 128 MiB
 * Argon2id allocation can fail outright or push the tab into memory
 * pressure long before it is slow. Entries are checked in order; the first
 * whose `belowGb` exceeds the reported RAM applies. Browsers without
 * `navigator.deviceMemory` (Safari, Firefox) get no cap - the time probe
 * and the allocation-failure fallback still protect them.
 */
export const DEVICE_MEMORY_CAPS: readonly { belowGb: number; maxMemorySizeKib: number }[] = [
    { belowGb: 2, maxMemorySizeKib: 32_768 },
    { belowGb: 4, maxMemorySizeKib: 65_536 },
]
