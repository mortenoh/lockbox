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
            <TooltipProvider delayDuration={200}>
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
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
            console.warn('[lockbox] service worker registration failed:', err)
        })
    })
}
