// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
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

import { CommandPalette } from '@/components/CommandPalette'
import { StatusMenu } from '@/components/StatusMenu'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSidebar } from '@/hooks/use-sidebar'
import { useSync } from '@/hooks/use-sync'
import { initials } from '@/lib/format'
import { cn } from '@/lib/utils'

interface NavItem {
    /** Route path. '' is the index route. */
    path: string
    label: string
    hint: string
    icon: typeof NotebookPen
}

/**
 * Each page isolates one idea, so a variation can be explored without the
 * others getting in the way.
 */
export const NAV_ITEMS: NavItem[] = [
    { path: '', label: 'Notes', hint: 'The working demo', icon: NotebookPen },
    { path: 'kdf', label: 'KDF Lab', hint: 'Argon2id vs PBKDF2', icon: FlaskConical },
    { path: 'sync-modes', label: 'Sync Modes', hint: 'Plaintext vs encrypted', icon: RefreshCw },
    { path: 'storage', label: 'At Rest', hint: 'What IndexedDB holds', icon: Database },
    { path: 'security', label: 'Security', hint: 'Biometrics, auto-lock', icon: ShieldCheck },
]

interface AppLayoutProps {
    /** Active user, so status counts are scoped to them. */
    ownerId: string
    /** Display name, shown so it is obvious who is signed in. */
    owner: string
    /** Drop the key, keep the user selected. */
    onLock: () => void
    /** Drop the key and forget the user, returning to the picker. */
    onSwitchUser: () => void
    /** Drain then fetch, so the palette can trigger the same cycle as the Notes page button. */
    onPull: () => void | Promise<void>
    children: ReactNode
}

/** Sidebar shell: collapsible navigation, status header, page content. */
export function AppLayout({
    ownerId,
    owner,
    onLock,
    onSwitchUser,
    onPull,
    children,
}: AppLayoutProps) {
    const { collapsed, toggle } = useSidebar()
    const { failed } = useSync()
    const { pathname } = useLocation()
    const current = pathname.replace(/^\//, '')
    const title = NAV_ITEMS.find((item) => item.path === current)?.label ?? 'Lockbox'

    // The strip scrolls, but a cut-off label was the only hint that it does.
    // The fade is the affordance - and it must vanish once the user reaches
    // the end, or the last item would look permanently grayed out.
    const mobileNavRef = useRef<HTMLElement>(null)
    const [navOverflows, setNavOverflows] = useState(false)
    useEffect(() => {
        const el = mobileNavRef.current
        if (!el) return
        const update = () => setNavOverflows(el.scrollWidth - el.clientWidth - el.scrollLeft > 4)
        update()
        el.addEventListener('scroll', update, { passive: true })
        window.addEventListener('resize', update)
        return () => {
            el.removeEventListener('scroll', update)
            window.removeEventListener('resize', update)
        }
    }, [])

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
                    {/* Solid brand tile: foreground-on-light flips to primary
                        green in dark, per the mockups. */}
                    <div className="bg-foreground text-background dark:bg-primary dark:text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg">
                        <KeyRound className="size-4" aria-hidden />
                    </div>
                    {!collapsed && <span className="text-lg font-bold tracking-tight">Lockbox</span>}
                </div>

                <nav className="flex flex-col gap-1 px-2 py-2">
                    {NAV_ITEMS.map((item) => {
                        const Icon = item.icon

                        const link = (
                            <NavLink
                                to={item.path === '' ? '/' : `/${item.path}`}
                                end={item.path === ''}
                                aria-label={item.label}
                                className={({ isActive }) =>
                                    cn(
                                        // The active rail is a left border, not an
                                        // overlay - it survives collapsed mode and
                                        // gives the asymmetric rounding from the
                                        // mockups for free.
                                        'flex items-start gap-3 rounded-r-lg rounded-l-[4px] border-l-[3px] px-3 py-2 text-left text-sm transition-colors',
                                        collapsed && 'justify-center px-0 py-2.5',
                                        isActive
                                            ? 'border-sidebar-primary bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                                            : 'text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground border-transparent',
                                    )
                                }
                            >
                                {({ isActive }) => (
                                    <>
                                        <Icon
                                            className={cn(
                                                'mt-0.5 size-4 shrink-0',
                                                isActive && 'text-sidebar-accent-foreground',
                                            )}
                                            aria-hidden
                                        />
                                        {!collapsed && (
                                            <span className="grid">
                                                <span>{item.label}</span>
                                                <span
                                                    className={cn(
                                                        'text-xs',
                                                        isActive
                                                            ? 'text-sidebar-accent-foreground/75'
                                                            : 'text-muted-foreground',
                                                    )}
                                                >
                                                    {item.hint}
                                                </span>
                                            </span>
                                        )}
                                    </>
                                )}
                            </NavLink>
                        )

                        // Collapsed to icons, the label has to come back somehow.
                        return collapsed ? (
                            <Tooltip key={item.path}>
                                <TooltipTrigger asChild>{link}</TooltipTrigger>
                                <TooltipContent side="right">
                                    <span className="font-medium">{item.label}</span>
                                    <span className="opacity-70"> — {item.hint}</span>
                                </TooltipContent>
                            </Tooltip>
                        ) : (
                            <div key={item.path}>{link}</div>
                        )
                    })}
                </nav>

                <div className="flex-1" />

                {!collapsed && (
                    <div className="flex items-center gap-3 border-t px-4 py-3">
                        <span
                            className="bg-accent text-accent-foreground flex size-9 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold"
                            aria-hidden
                        >
                            {initials(owner)}
                        </span>
                        <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{owner}</p>
                            <p className="text-muted-foreground text-xs">Unlocked on this device</p>
                        </div>
                    </div>
                )}
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
                {/* Solid surface, no backdrop-blur: blur is one of the most
                    expensive things to composite on the decade-old integrated
                    GPUs this app actually runs on, and the redesign's header
                    is opaque anyway. bg-sidebar matches the mockup exactly
                    (white in light, one step above the page in dark). */}
                <header className="bg-sidebar sticky top-0 z-10 border-b">
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

                        <StatusMenu ownerId={ownerId} />
                        <ThemeToggle />

                        <Tooltip>
                            <TooltipTrigger asChild>
                                {/* A bordered chip in the mockups - the one
                                    always-available security action earns more
                                    presence than a ghost icon. */}
                                <Button variant="outline" size="sm" onClick={onLock}>
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

                    {/* Sidebar is hidden below md, so nav moves inline. The
                        border lives on the wrapper because the fade mask on the
                        nav itself would eat the border's right end. */}
                    <div className="border-t md:hidden">
                        <nav
                            ref={mobileNavRef}
                            className={cn(
                                // Scrollbar hidden on purpose: the fade is the
                                // scroll affordance, and the bar under a strip
                                // this small reads as clutter.
                                'flex gap-1 overflow-x-auto px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                                navOverflows &&
                                    '[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]',
                            )}
                        >
                            {NAV_ITEMS.map((item) => (
                                <Button
                                    key={item.path}
                                    asChild
                                    variant={item.path === current ? 'secondary' : 'ghost'}
                                    size="sm"
                                    className={cn(
                                        item.path === current && 'border-border font-semibold',
                                    )}
                                >
                                    <NavLink to={item.path === '' ? '/' : `/${item.path}`}>
                                        {item.label}
                                    </NavLink>
                                </Button>
                            ))}
                        </nav>
                    </div>
                </header>

                <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 md:px-8">{children}</main>
            </div>

            <CommandPalette onLock={onLock} onSwitchUser={onSwitchUser} onPull={onPull} />
        </div>
    )
}
