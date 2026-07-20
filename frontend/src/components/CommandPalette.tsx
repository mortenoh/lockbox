// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CloudDownload, Lock, NotebookPen, SunMoon, UserRoundX } from 'lucide-react'
import { useTheme } from 'next-themes'

import { NAV_ITEMS } from '@/components/AppLayout'
import {
    Command,
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from '@/components/ui/command'

interface CommandPaletteProps {
    /** Drop the key, keep the user selected. */
    onLock: () => void
    /** Drop the key and forget the user, returning to the picker. */
    onSwitchUser: () => void
    /** Drain then fetch - the same cycle as the Notes page button. */
    onPull: () => void | Promise<void>
}

/**
 * Ctrl/Cmd+K palette over the actions that already exist elsewhere.
 *
 * Nothing here is reachable only through the palette - it is a faster path for
 * keyboard users (the laptop half of the field fleet), not a second place
 * where behaviour lives. Every entry delegates to the same handler the visible
 * control uses.
 */
export function CommandPalette({ onLock, onSwitchUser, onPull }: CommandPaletteProps) {
    const [open, setOpen] = useState(false)
    const navigate = useNavigate()
    const { resolvedTheme, setTheme } = useTheme()

    useEffect(() => {
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                setOpen((previous) => !previous)
            }
        }
        document.addEventListener('keydown', handleKey)
        return () => document.removeEventListener('keydown', handleKey)
    }, [])

    /** Close first, then act - so a navigation is not fighting the dialog's exit. */
    const run = (action: () => void) => {
        setOpen(false)
        action()
    }

    return (
        <CommandDialog open={open} onOpenChange={setOpen}>
            {/* The dialog only provides the frame; the Command root carries the
                cmdk store, and items crash without it. */}
            <Command>
                <CommandInput placeholder="Type a command or search…" />
            <CommandList>
                <CommandEmpty>No matching command.</CommandEmpty>
                <CommandGroup heading="Go to">
                    {NAV_ITEMS.map((item) => {
                        const Icon = item.icon
                        return (
                            <CommandItem
                                key={item.path}
                                // The hint joins the searchable value so "argon"
                                // finds the KDF Lab, not just its title.
                                value={`${item.label} ${item.hint}`}
                                onSelect={() =>
                                    run(() => navigate(item.path === '' ? '/' : `/${item.path}`))
                                }
                            >
                                <Icon aria-hidden />
                                {item.label}
                                <span className="text-muted-foreground text-xs">{item.hint}</span>
                            </CommandItem>
                        )
                    })}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Actions">
                    <CommandItem
                        onSelect={() =>
                            run(() => {
                                navigate('/')
                                // The Notes page mounts with the navigation and
                                // owns the compose dialog; the event has to wait
                                // for the frame that renders its listener.
                                requestAnimationFrame(() =>
                                    document.dispatchEvent(new CustomEvent('lockbox:new-note')),
                                )
                            })
                        }
                    >
                        <NotebookPen aria-hidden />
                        New note
                    </CommandItem>
                    <CommandItem onSelect={() => run(() => void onPull())}>
                        <CloudDownload aria-hidden />
                        Pull from server
                    </CommandItem>
                    <CommandItem
                        onSelect={() =>
                            run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))
                        }
                    >
                        <SunMoon aria-hidden />
                        Toggle theme
                    </CommandItem>
                    <CommandItem onSelect={() => run(onLock)}>
                        <Lock aria-hidden />
                        Lock
                    </CommandItem>
                    <CommandItem onSelect={() => run(onSwitchUser)}>
                        <UserRoundX aria-hidden />
                        Switch user
                    </CommandItem>
                    </CommandGroup>
                </CommandList>
            </Command>
        </CommandDialog>
    )
}
