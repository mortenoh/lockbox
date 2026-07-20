import type { ReactNode } from 'react'
import {
    Database,
    FlaskConical,
    KeyRound,
    Lock,
    NotebookPen,
    PanelLeftClose,
    PanelLeftOpen,
    RefreshCw,
    ShieldCheck,
    UserRoundX,
} from 'lucide-react'

import { StatusMenu } from '@/components/StatusMenu'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSidebar } from '@/hooks/use-sidebar'
import { useSync } from '@/hooks/use-sync'
import { cn } from '@/lib/utils'

/** The demo pages reachable from the sidebar. */
export type PageId = 'notes' | 'kdf' | 'sync-modes' | 'storage' | 'security'

interface NavItem {
    id: PageId
    label: string
    hint: string
    icon: typeof NotebookPen
}

/**
 * Each page isolates one idea, so a variation can be explored without the
 * others getting in the way.
 */
const NAV_ITEMS: NavItem[] = [
    { id: 'notes', label: 'Notes', hint: 'The working demo', icon: NotebookPen },
    { id: 'kdf', label: 'KDF Lab', hint: 'Argon2id vs PBKDF2', icon: FlaskConical },
    { id: 'sync-modes', label: 'Sync Modes', hint: 'Plaintext vs encrypted', icon: RefreshCw },
    { id: 'storage', label: 'At Rest', hint: 'What IndexedDB holds', icon: Database },
    { id: 'security', label: 'Security', hint: 'Biometrics, auto-lock', icon: ShieldCheck },
]

interface AppLayoutProps {
    page: PageId
    /** Active user, so status counts are scoped to them. */
    ownerId: string
    /** Display name, shown so it is obvious who is signed in. */
    owner: string
    onNavigate: (page: PageId) => void
    /** Drop the key, keep the user selected. */
    onLock: () => void
    /** Drop the key and forget the user, returning to the picker. */
    onSwitchUser: () => void
    children: ReactNode
}

/** Sidebar shell: collapsible navigation, status header, page content. */
export function AppLayout({
    page,
    ownerId,
    owner,
    onNavigate,
    onLock,
    onSwitchUser,
    children,
}: AppLayoutProps) {
    const { collapsed, toggle } = useSidebar()
    const { failed } = useSync()
    const title = NAV_ITEMS.find((item) => item.id === page)?.label ?? 'Lockbox'

    return (
        <div className="flex min-h-svh">
            <aside
                className={cn(
                    'bg-sidebar hidden shrink-0 flex-col border-r transition-[width] duration-200 md:flex',
                    collapsed ? 'w-16' : 'w-60',
                )}
            >
                <div
                    className={cn(
                        'flex items-center gap-2 px-3 py-4',
                        collapsed && 'justify-center px-0',
                    )}
                >
                    <div className="from-primary/20 to-primary/5 ring-primary/20 flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ring-1">
                        <KeyRound className="text-primary size-4" aria-hidden />
                    </div>
                    {!collapsed && <span className="text-lg font-semibold">Lockbox</span>}
                </div>

                <nav className="flex flex-col gap-1 px-2 py-2">
                    {NAV_ITEMS.map((item) => {
                        const Icon = item.icon
                        const active = item.id === page

                        const button = (
                            <button
                                type="button"
                                onClick={() => onNavigate(item.id)}
                                aria-current={active ? 'page' : undefined}
                                aria-label={item.label}
                                className={cn(
                                    'relative flex items-start gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                                    collapsed && 'justify-center px-0 py-2.5',
                                    active
                                        ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                                        : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                                )}
                            >
                                {/* Active marker stays legible when labels are hidden. */}
                                {active && (
                                    <span className="bg-primary absolute inset-y-1.5 left-0 w-0.5 rounded-full" />
                                )}
                                <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                                {!collapsed && (
                                    <span className="grid">
                                        <span>{item.label}</span>
                                        <span className="text-muted-foreground text-xs">
                                            {item.hint}
                                        </span>
                                    </span>
                                )}
                            </button>
                        )

                        // Collapsed to icons, the label has to come back somehow.
                        return collapsed ? (
                            <Tooltip key={item.id}>
                                <TooltipTrigger asChild>{button}</TooltipTrigger>
                                <TooltipContent side="right">
                                    <span className="font-medium">{item.label}</span>
                                    <span className="opacity-70"> — {item.hint}</span>
                                </TooltipContent>
                            </Tooltip>
                        ) : (
                            <div key={item.id}>{button}</div>
                        )
                    })}
                </nav>

                <div className="flex-1" />

                {!collapsed && (
                    <div className="text-muted-foreground border-t px-4 py-3 text-xs">
                        <p className="text-foreground/80 font-medium">{owner}</p>
                        <p className="mt-1">Protects a lost device, not a compromised session.</p>
                    </div>
                )}
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="bg-background/95 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-10 border-b backdrop-blur">
                    <div className="flex items-center gap-2 px-4 py-2.5 md:px-6">
                        {/* Lives in the page header, not the sidebar, so it keeps a
                            fixed screen position instead of moving when clicked.
                            This is the shadcn/ui convention. */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={toggle}
                                    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                                    className="text-muted-foreground hover:text-foreground hidden md:inline-flex"
                                >
                                    {collapsed ? (
                                        <PanelLeftOpen className="size-4" />
                                    ) : (
                                        <PanelLeftClose className="size-4" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                                {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                            </TooltipContent>
                        </Tooltip>

                        <Separator orientation="vertical" className="hidden !h-4 md:block" />

                        <h1 className="text-sm font-medium">{title}</h1>

                        <div className="flex-1" />

                        {failed > 0 && <Badge variant="destructive">{failed} failed</Badge>}

                        <StatusMenu ownerId={ownerId} onOpenSecurity={() => onNavigate('security')} />
                        <ThemeToggle />

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button variant="ghost" size="sm" onClick={onLock}>
                                    <Lock className="size-4" />
                                    <span className="sr-only lg:not-sr-only">Lock</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                Drop the key. {owner} stays selected.
                            </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={onSwitchUser}
                                    aria-label="Sign out and switch user"
                                >
                                    <UserRoundX className="size-4" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>Sign out and choose another user</TooltipContent>
                        </Tooltip>
                    </div>

                    {/* Sidebar is hidden below md, so nav moves inline. */}
                    <nav className="flex gap-1 overflow-x-auto border-t px-4 py-2 md:hidden">
                        {NAV_ITEMS.map((item) => (
                            <Button
                                key={item.id}
                                variant={item.id === page ? 'secondary' : 'ghost'}
                                size="sm"
                                onClick={() => onNavigate(item.id)}
                            >
                                {item.label}
                            </Button>
                        ))}
                    </nav>
                </header>

                <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8">{children}</main>
            </div>
        </div>
    )
}
