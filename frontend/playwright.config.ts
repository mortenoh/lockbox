import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests against a real browser.
 *
 * Chosen over a jsdom + fake-indexeddb unit setup deliberately. Everything this
 * project is actually about - Web Crypto, IndexedDB transactions and key paths,
 * service worker caching, WebAuthn - is browser machinery that shims reproduce
 * only approximately. The bugs that shipped here (a compound-key collision, a
 * stale-closure keypad, a 401 misreported as offline) all lived in that layer,
 * so the tests run where the behaviour is real.
 *
 * The Python server is started by Playwright with its own data file, so a run
 * never touches whatever is in ./data.
 */
const PORT = 8388
const DATA_FILE = '.e2e-data/notes.json'

export default defineConfig({
    testDir: './e2e',
    // Vault creation runs Argon2id at 128 MiB, so unlocks are deliberately slow.
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: false, // one shared server, so keep server state predictable
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],

    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
        // Each test gets a fresh context, so IndexedDB starts empty every time -
        // which is what makes the multi-user isolation tests trustworthy.
        storageState: undefined,
    },

    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

    webServer: {
        command: `cd .. && rm -rf frontend/${DATA_FILE.split('/')[0]} && uv run lockbox serve --port ${PORT} --data-file frontend/${DATA_FILE}`,
        url: `http://127.0.0.1:${PORT}/api/info`,
        reuseExistingServer: false,
        timeout: 60_000,
    },
})
