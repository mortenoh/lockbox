import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/**
 * Unit tests run in plain Node: Web Crypto, TextEncoder and btoa are all
 * native there, and hash-wasm's Argon2id is WASM, so the crypto layer runs
 * for real without a browser. Browser-only machinery (IndexedDB, WebAuthn,
 * service worker) stays covered by the Playwright e2e suite instead.
 *
 * Deliberately separate from vite.config.ts so tests do not load the React
 * and Tailwind plugins.
 */
export default defineConfig({
    resolve: {
        alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
})
