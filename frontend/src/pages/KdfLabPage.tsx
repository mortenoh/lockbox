import { useState } from 'react'
import { FlaskConical, Loader2 } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ARGON2ID_PARAMS, PBKDF2_ITERATIONS } from '@/lib/config'
import { benchmarkKdf, type KdfId } from '@/lib/crypto'

/**
 * KDF Lab: derive a key with each algorithm and time it on this device.
 *
 * The point is not the absolute numbers, it is the shape of the trade-off.
 * Both algorithms are tuned so a single legitimate derivation takes a fraction
 * of a second - the user waits that long once per unlock. The difference is
 * what an *attacker* has to spend for the same work:
 *
 *   PBKDF2   pure SHA-256 chains, tiny memory. A GPU runs tens of thousands of
 *            lanes in parallel, so its throughput dwarfs one browser thread.
 *   Argon2id every guess must allocate memorySize of RAM. Memory bandwidth and
 *            capacity now cap the parallelism, which is what closes the gap.
 *
 * Same user-visible delay, very different cost to crack.
 */

interface Result {
    kdf: KdfId
    ms: number
    label: string
    detail: string
}

export function KdfLabPage() {
    const [passphrase, setPassphrase] = useState('correct-horse-battery-staple')
    const [memoryMib, setMemoryMib] = useState(ARGON2ID_PARAMS.memorySize / 1024)
    const [argonIterations, setArgonIterations] = useState<number>(ARGON2ID_PARAMS.iterations)
    const [pbkdf2Iterations, setPbkdf2Iterations] = useState(PBKDF2_ITERATIONS)
    const [results, setResults] = useState<Result[]>([])
    const [running, setRunning] = useState<KdfId | null>(null)

    async function run(kdf: KdfId) {
        setRunning(kdf)
        try {
            const params =
                kdf === 'argon2id'
                    ? {
                          iterations: argonIterations,
                          memorySize: memoryMib * 1024,
                          parallelism: ARGON2ID_PARAMS.parallelism,
                      }
                    : { iterations: pbkdf2Iterations }

            const ms = await benchmarkKdf(passphrase, kdf, params)

            const result: Result =
                kdf === 'argon2id'
                    ? {
                          kdf,
                          ms,
                          label: 'Argon2id',
                          detail: `${memoryMib} MiB · ${argonIterations} passes · 1 lane`,
                      }
                    : {
                          kdf,
                          ms,
                          label: 'PBKDF2-HMAC-SHA256',
                          detail: `${pbkdf2Iterations.toLocaleString()} iterations`,
                      }

            // Newest first, keeping a short history so parameter tweaks can be
            // compared without re-reading the previous number.
            setResults((prev) => [result, ...prev].slice(0, 8))
        } finally {
            setRunning(null)
        }
    }

    return (
        <div className="grid gap-6">
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-semibold">
                    <FlaskConical className="text-primary size-6" aria-hidden />
                    KDF Lab
                </h1>
                <p className="text-muted-foreground mt-1">
                    Turning a passphrase into a key is the one place where a deliberate slowdown is
                    the feature. Measure both algorithms on this device.
                </p>
            </div>

            <Alert>
                <AlertDescription>
                    Guidance is a starting point; the device decides. Benchmark on the weakest
                    hardware you must support — a low-end tablet behaves nothing like a laptop.
                    Aim for roughly <strong>250–500&nbsp;ms</strong> per derivation.
                </AlertDescription>
            </Alert>

            <Card>
                <CardHeader>
                    <CardTitle>Parameters</CardTitle>
                    <CardDescription>
                        Same passphrase through both algorithms, so only the cost differs.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="kdf-passphrase">Passphrase</Label>
                        <Input
                            id="kdf-passphrase"
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                        />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-3">
                        <div className="grid gap-2">
                            <Label htmlFor="argon-memory">Argon2id memory (MiB)</Label>
                            <Input
                                id="argon-memory"
                                type="number"
                                min={8}
                                max={1024}
                                step={8}
                                value={memoryMib}
                                onChange={(e) => setMemoryMib(Number(e.target.value) || 8)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="argon-iterations">Argon2id passes</Label>
                            <Input
                                id="argon-iterations"
                                type="number"
                                min={1}
                                max={10}
                                value={argonIterations}
                                onChange={(e) => setArgonIterations(Number(e.target.value) || 1)}
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="pbkdf2-iterations">PBKDF2 iterations</Label>
                            <Input
                                id="pbkdf2-iterations"
                                type="number"
                                min={1000}
                                step={50_000}
                                value={pbkdf2Iterations}
                                onChange={(e) => setPbkdf2Iterations(Number(e.target.value) || 1000)}
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void run('argon2id')} disabled={running !== null}>
                            {running === 'argon2id' && <Loader2 className="animate-spin" />}
                            Run Argon2id
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() => void run('pbkdf2')}
                            disabled={running !== null}
                        >
                            {running === 'pbkdf2' && <Loader2 className="animate-spin" />}
                            Run PBKDF2
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {results.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle>Measurements</CardTitle>
                        <CardDescription>Most recent first.</CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-2">
                        {results.map((result, index) => (
                            <div
                                key={`${result.kdf}-${index}`}
                                className="flex items-center gap-3 border-b py-2 last:border-b-0"
                            >
                                <Badge variant={result.kdf === 'argon2id' ? 'default' : 'outline'}>
                                    {result.label}
                                </Badge>
                                <span className="text-muted-foreground text-xs">
                                    {result.detail}
                                </span>
                                <div className="flex-1" />
                                <span className="font-mono text-sm">{result.ms.toFixed(0)} ms</span>
                            </div>
                        ))}
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader>
                    <CardTitle>Why Argon2id is the default here</CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground grid gap-3 text-sm">
                    <p>
                        <strong className="text-foreground">PBKDF2 is CPU-hard but not
                        memory-hard.</strong>{' '}
                        Each guess is a chain of SHA-256 operations needing almost no memory, so a
                        GPU can run enormous numbers of them side by side. The defender gets one
                        browser thread. That asymmetry is the problem.
                    </p>
                    <p>
                        <strong className="text-foreground">Argon2id forces each guess to allocate
                        memory.</strong>{' '}
                        At 128&nbsp;MiB per guess, a card with 16&nbsp;GB fits barely a hundred
                        parallel attempts rather than tens of thousands — cutting the
                        attacker&rsquo;s advantage by orders of magnitude for the same
                        user-visible delay.
                    </p>
                    <p>
                        <strong className="text-foreground">It only matters for weak
                        passphrases.</strong>{' '}
                        Against a long random passphrase, PBKDF2 at 600k is already out of reach.
                        Against <code>summer2026</code>, Argon2id may buy weeks where PBKDF2 buys
                        hours. Users pick <code>summer2026</code>.
                    </p>
                    <p>
                        The cost is a ~40&nbsp;KB WASM payload, since Web Crypto offers no Argon2 —
                        <code>crypto.subtle</code> only provides PBKDF2. It precaches with the rest
                        of the app, so unlocking still works fully offline.
                    </p>
                </CardContent>
            </Card>
        </div>
    )
}
