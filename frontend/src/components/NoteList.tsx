// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import { CloudDownload, CloudOff, Download, Pencil, ShieldAlert, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DecryptedNote } from '@/hooks/use-notes'
import { formatFullTime, formatRelative, formatTime, initials } from '@/lib/format'
import { cn } from '@/lib/utils'

interface NoteListProps {
    notes: DecryptedNote[]
    /** The current vault owner, so "mine" can be distinguished from "theirs". */
    owner: string
    onDelete: (id: string) => void
    onPull: () => void
}

/** The decrypted note list. Reads from IndexedDB, never from a server response. */
export function NoteList({ notes, owner, onDelete, onPull }: NoteListProps) {
    return (
        <section className="grid gap-3">
            <div className="flex items-center justify-between">
                <div className="flex items-baseline gap-2">
                    <h2 className="text-lg font-semibold">Notes</h2>
                    <span className="text-muted-foreground text-sm">
                        {notes.length === 0 ? '' : `${notes.length} on this device`}
                    </span>
                </div>
                <Button variant="outline" size="sm" onClick={onPull}>
                    <CloudDownload className="size-4" />
                    Pull from server
                </Button>
            </div>

            {notes.length === 0 ? (
                <Card>
                    <CardContent className="text-muted-foreground py-10 text-center text-sm">
                        No notes yet. Write one above, or pull what other users have already
                        published.
                    </CardContent>
                </Card>
            ) : (
                <ul className="grid gap-3">
                    {notes.map((note) => (
                        <li key={note.id}>
                            <NoteCard note={note} owner={owner} onDelete={onDelete} />
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

interface NoteCardProps {
    note: DecryptedNote
    owner: string
    onDelete: (id: string) => void
}

/**
 * One note, with enough context to answer "who wrote this, when, and where does
 * it live" without opening anything.
 */
function NoteCard({ note, owner, onDelete }: NoteCardProps) {
    const author = note.content?.author ?? 'unknown'
    const mine = author === owner
    const edited = note.updatedAt > note.createdAt + 1000
    const unreadable = note.content === null

    return (
        <Card className={cn(unreadable && 'border-destructive/40')}>
            <CardContent className="grid gap-3">
                <div className="flex items-start gap-3">
                    <span
                        className={cn(
                            'flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                            mine
                                ? 'bg-primary/15 text-primary ring-primary/20 ring-1'
                                : 'bg-muted text-muted-foreground ring-border ring-1',
                        )}
                        aria-hidden
                    >
                        {unreadable ? '?' : initials(author)}
                    </span>

                    <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="leading-tight font-medium break-words">
                            {unreadable ? 'Cannot decrypt' : note.content?.title}
                        </span>
                        <span className="text-muted-foreground text-xs">
                            {unreadable ? (
                                'author unknown'
                            ) : (
                                <>
                                    <span className="text-foreground/80 font-medium">
                                        {mine ? `${author} (you)` : author}
                                    </span>
                                    {' · '}
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <span className="cursor-default underline decoration-dotted underline-offset-2">
                                                {formatRelative(note.createdAt)}
                                            </span>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Created {formatFullTime(note.createdAt)}
                                        </TooltipContent>
                                    </Tooltip>
                                </>
                            )}
                        </span>
                    </div>

                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${note.content?.title ?? 'note'}`}
                                onClick={() => onDelete(note.id)}
                            >
                                <Trash2 className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete everywhere</TooltipContent>
                    </Tooltip>
                </div>

                {unreadable ? (
                    <p className="text-muted-foreground text-sm">
                        Encrypted with a different device&rsquo;s key. This is what encrypted-sync
                        looks like to a second user.
                    </p>
                ) : (
                    note.content?.body && (
                        <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                            {note.content.body}
                        </p>
                    )
                )}

                <div className="flex flex-wrap items-center gap-1.5">
                    {unreadable ? (
                        <Badge variant="destructive" className="gap-1">
                            <ShieldAlert className="size-3" />
                            unreadable
                        </Badge>
                    ) : note.synced ? (
                        <Badge variant="outline" className="gap-1 font-normal">
                            <CloudDownload className="size-3" />
                            on server
                        </Badge>
                    ) : (
                        <Badge variant="secondary" className="gap-1">
                            <CloudOff className="size-3" />
                            this device only
                        </Badge>
                    )}

                    <Badge variant="outline" className="gap-1 font-normal">
                        {note.origin === 'pulled' ? (
                            <>
                                <Download className="size-3" />
                                pulled
                            </>
                        ) : (
                            <>
                                <Pencil className="size-3" />
                                written here
                            </>
                        )}
                    </Badge>

                    {edited && (
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Badge variant="outline" className="cursor-default font-normal">
                                    edited {formatRelative(note.updatedAt)}
                                </Badge>
                            </TooltipTrigger>
                            <TooltipContent>
                                Updated {formatFullTime(note.updatedAt)}
                            </TooltipContent>
                        </Tooltip>
                    )}

                    <span className="text-muted-foreground ml-auto text-xs">
                        {formatTime(note.createdAt)}
                    </span>
                </div>
            </CardContent>
        </Card>
    )
}
