// Copyright (c) 2026 Morten Hansen
// SPDX-License-Identifier: BSD-3-Clause

import DOMPurify from 'dompurify'
import { marked } from 'marked'

/**
 * Note bodies render as Markdown - through DOMPurify, without exception.
 *
 * XSS is the one attack that defeats this app's entire design (an injected
 * script can simply use the live in-memory key), and note bodies are the only
 * user-authored rich content on screen. Every pulled note is another user's
 * text, so this is remote input, not just the local user's own words.
 */
export function renderMarkdown(markdown: string): string {
    const html = marked.parse(markdown, { async: false, gfm: true, breaks: true })
    return DOMPurify.sanitize(html)
}
