// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { HashRouter } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

import App from '@/App'
import '@/index.css'

// HashRouter keeps every route client-side (#/security, #/kdf, ...), which
// buys two things here. The server needs no SPA fallback - it can go on
// serving the bundle through StaticFiles - and, more usefully for a PWA, the
// service worker only ever sees "/" for a navigation, so the cached shell
// always matches and offline reloads work on any page.
createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {/* `class` strategy matches the `.dark` variant the stylesheet defines. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            {/* Slow enough that tooltips are an answer you wait for, not
                noise that chases the pointer. Once one is open, moving to a
                neighbouring control still shows its tip immediately (radix
                skipDelayDuration default). */}
            <TooltipProvider delayDuration={2000}>
                <HashRouter>
                    <App />
                </HashRouter>
                <Toaster richColors closeButton position="bottom-right" />
            </TooltipProvider>
        </ThemeProvider>
    </StrictMode>,
)

// Registered after load so it never competes with the first paint. Failure is
// not fatal - the app still works, it just will not load offline.
//
// PROD only: under the vite dev server the worker's cached shell references
// /assets/* bundle paths that vite does not serve, so its stale-shell
// self-heal clears caches and reloads in a loop. The worker is exercised for
// real by the e2e suite, which runs against the built bundle.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    // A worker that was already controlling this page means any handover is a
    // genuine update rather than the first install. Captured before registering,
    // because registration can change it.
    const hadController = Boolean(navigator.serviceWorker.controller)
    let reloading = false

    // The worker asks for this when it finds a hashed asset missing, which
    // means this document is running a shell a rebuild has superseded.
    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data !== 'RELOAD_STALE_SHELL' || reloading) return
        reloading = true
        window.location.reload()
    })

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        // The new worker has taken over, but this document is still running the
        // JavaScript the old one served. One reload lines them up.
        //
        // Guarded twice: `hadController` skips the pointless reload on a first
        // visit, and `reloading` stops the loop if the event fires again.
        if (!hadController || reloading) return
        reloading = true
        window.location.reload()
    })

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
            console.warn('[lockbox] service worker registration failed:', err)
        })
    })
}
