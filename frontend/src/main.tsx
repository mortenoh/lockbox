import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from 'next-themes'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'

import App from '@/App'
import '@/index.css'

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        {/* `class` strategy matches the `.dark` variant the stylesheet defines. */}
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
            <TooltipProvider delayDuration={200}>
                <App />
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
