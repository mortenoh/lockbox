/**
 * Service worker: makes the app shell available offline.
 *
 * Strategy split:
 *
 *   app shell (HTML/CSS/JS/icons) - cache-first, precached at install. These are
 *       the files that must exist for the app to boot with no network at all.
 *   /api/*                        - never cached, never intercepted. Data lives
 *       in IndexedDB, and writes go through the outbox. Serving a stale cached
 *       API response would just confuse the sync engine into thinking a request
 *       succeeded.
 *
 * The cache name carries a content hash of the shell assets (injected by the
 * server), so shipping any change to a JS/CSS file installs a new worker, which
 * then activates immediately and deletes the superseded caches.
 *
 * Updating has to be automatic here. A cache-first shell that never hands over
 * to its replacement does not merely serve stale code - it serves a shell whose
 * asset filenames have been rebuilt away, which is a blank page rather than an
 * out-of-date one.
 */

/* Injected by the server: a hash of the shell assets' contents. Change any
   asset and this changes, which installs a new worker and evicts the old cache.
   This is the same trick Workbox's revisioned precache manifest uses - without
   it, cache-first would serve stale code forever. */
const CACHE_VERSION = "lockbox-{{ cache_version }}";

/* Also injected: the built asset list. Vite emits content-hashed filenames, so
   this cannot be hard-coded - the server enumerates what it actually serves. */
const SHELL_ASSETS = {{ shell_assets }};

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE_VERSION)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            // Activate immediately instead of waiting for every tab to close.
            //
            // Without this a rebuilt worker sits in "waiting" indefinitely while
            // the previous one keeps serving its cached shell - and that shell
            // references asset filenames that no longer exist, so the page
            // renders blank. The only cure was closing every tab, which is why
            // it looked fine in a private window and broken everywhere else.
            //
            // The earlier design deferred to a SKIP_WAITING message from the
            // page, which nothing ever sent. Half a handshake is worse than
            // none: it looked deliberate while behaving like a bug.
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const names = await caches.keys();
            await Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)));
            // Take over open tabs immediately so an updated worker is not stuck
            // waiting behind the previous one.
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("message", (event) => {
    // Retained so a page can still force activation explicitly, though install
    // now skips waiting on its own.
    if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    // Let API traffic hit the network untouched - offline failures are the
    // signal the sync engine is built around.
    if (url.pathname.startsWith("/api/")) return;

    // Navigations: try the network so a deployed update is picked up, but fall
    // back to the cached shell when offline.
    if (request.mode === "navigate") {
        event.respondWith(
            (async () => {
                try {
                    return await fetch(request);
                } catch {
                    const cached = await caches.match("/");
                    return cached ?? Response.error();
                }
            })(),
        );
        return;
    }

    // Static assets: cache-first, since they are versioned by CACHE_VERSION.
    event.respondWith(
        (async () => {
            const cached = await caches.match(request);
            if (cached) return cached;

            try {
                const response = await fetch(request);
                if (response.ok) {
                    const cache = await caches.open(CACHE_VERSION);
                    cache.put(request, response.clone());
                }
                return response;
            } catch {
                return Response.error();
            }
        })(),
    );
});
