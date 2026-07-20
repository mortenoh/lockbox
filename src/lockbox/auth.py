# Copyright (c) 2026 Morten Hansen
# SPDX-License-Identifier: BSD-3-Clause

"""Bearer-token authentication for the sync API.

Deliberately minimal, and deliberately not pretending to be more than it is: a
single shared token gates every API call. That is enough to stop a publicly
reachable deployment (Tailscale Funnel, a tunnel, a VPS) from being an open
read/write endpoint, which is the actual risk being addressed here.

What this is NOT:

- Not per-user authentication. Everyone shares one token, so the `author` field
  is still self-declared and still forgeable by anyone holding it.
- Not a session system. No expiry, no rotation, no revocation of individual
  clients.

A real DHIS2 integration would delegate all of this to the platform: the user
authenticates against DHIS2, and the server derives identity from that session
rather than trusting anything the client asserts.

The app shell stays public. Protecting static JS adds nothing - it contains no
secrets - and gating it would mean authenticating before the service worker can
install, which breaks offline loading. Public SPA, authenticated API is the
conventional split.
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse

TOKEN_BYTES = 32
BEARER_PREFIX = "Bearer "


def generate_token() -> str:
    """Mint a URL-safe random token."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def extract_token(request: Request) -> str | None:
    """Pull the bearer token from the Authorization header."""
    header = request.headers.get("Authorization")
    if header and header.startswith(BEARER_PREFIX):
        return header[len(BEARER_PREFIX) :].strip()
    return None


def unauthorized_response(request: Request, expected: str | None) -> JSONResponse | None:
    """Return a 401 response if the request lacks the expected token.

    Returns a response rather than raising. Exceptions thrown inside Starlette
    middleware bypass FastAPI's exception handlers entirely and surface as a
    500, so raising `HTTPException` here would turn every rejected request into
    a confusing server error - which is exactly what happened the first time
    this was written.

    Compared with `hmac.compare_digest` rather than `==`: a naive comparison
    short-circuits on the first differing byte, and that timing difference can
    be used to recover a secret one character at a time.

    Args:
        request: The incoming request.
        expected: The configured token, or None when auth is disabled.

    Returns:
        A 401 JSONResponse, or None when the request may proceed.
    """
    if expected is None:
        return None  # Auth disabled - local development only.

    supplied = extract_token(request)
    if supplied is not None and hmac.compare_digest(supplied, expected):
        return None

    return JSONResponse(
        status_code=401,
        content={"detail": "Missing or invalid access token"},
        headers={"WWW-Authenticate": "Bearer"},
    )
