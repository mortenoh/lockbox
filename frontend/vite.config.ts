import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app is served by lockbox itself: we build straight into the Python
// package so the assets ship with it, and proxy API calls to a running lockbox
// server during development.
//
// `base: '/'` (not './') matters here - the service worker precaches absolute
// URLs, and a relative base would break those paths.
const target = process.env.VITE_LOCKBOX_TARGET ?? 'http://127.0.0.1:8000'
const proxy = Object.fromEntries(
    ['/api', '/sw.js'].map((p) => [p, { target, changeOrigin: true }]),
)

export default defineConfig({
    base: '/',
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: { proxy },
    build: {
        outDir: path.resolve(__dirname, '../src/lockbox/static'),
        emptyOutDir: true,
    },
})
