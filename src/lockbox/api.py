# Copyright (c) 2026 Morten Hansen
# SPDX-License-Identifier: BSD-3-Clause

"""FastAPI application: serves the PWA and a small sync API.

Two parallel note APIs exist so the two sync strategies can be compared
directly:

- `/api/plain-notes` stands in for a real DHIS2 backend. It receives readable
  data, which is the only thing that works when a server must validate,
  aggregate and share records between users.
- `/api/notes` receives opaque ciphertext. Useful for demonstrating what
  end-to-end encryption would cost, and unusable for DHIS2's actual purpose.

Authentication has two modes, selected at startup:

- `none`  - no credentials required. Correct for `127.0.0.1` development, and
            dangerous the moment the server is reachable from anywhere else.
- `token` - a shared bearer token on every `/api/*` call. Enough to stop a
            publicly reachable deployment being an open read/write endpoint.

Neither is per-user authentication. See `auth.py` for what that means for the
`author` field, and `docs/context/dhis2.md` for what a real integration does.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from lockbox import __version__
from lockbox.auth import unauthorized_response
from lockbox.schemas import (
    EncryptedNote,
    NoteList,
    PlainNote,
    PlainNoteList,
    ServerInfo,
)
from lockbox.store import RecordStore

PACKAGE_DIR = Path(__file__).parent
STATIC_DIR = PACKAGE_DIR / "static"
TEMPLATES_DIR = PACKAGE_DIR / "templates"

DEFAULT_DATA_FILE = Path("data") / "notes.json"

# Uvicorn's reloader re-imports the app in a child process and calls the factory
# with no arguments, so anything passed on the command line has to survive via
# the environment. Forgetting this silently served an unauthenticated API in
# --reload mode while still printing a token.
ENV_TOKEN = "LOCKBOX_TOKEN"
ENV_DATA_FILE = "LOCKBOX_DATA_FILE"


def iter_static_files() -> list[Path]:
    """Return every built asset, sorted for a stable hash."""
    return sorted(p for p in STATIC_DIR.rglob("*") if p.is_file())


def compute_asset_hash() -> str:
    """Hash the contents of every static asset.

    The service worker uses this as its cache name. Because a cache-first
    strategy would otherwise serve stale JS/CSS indefinitely, the cache name has
    to change whenever an asset does - hashing contents makes that automatic
    rather than a constant someone has to remember to bump.
    """
    digest = hashlib.sha256()
    for path in iter_static_files():
        digest.update(path.relative_to(STATIC_DIR).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def compute_shell_assets() -> list[str]:
    """List the URLs the service worker should precache.

    Vite emits content-hashed filenames, so this is enumerated from what is
    actually on disk rather than hard-coded. "/" is included explicitly because
    the app shell is served there, not at "/index.html".
    """
    urls = ["/"]
    for path in iter_static_files():
        rel = path.relative_to(STATIC_DIR).as_posix()
        if rel != "index.html":  # already covered by "/"
            urls.append(f"/{rel}")
    return urls


def create_app(data_file: Path | None = None, token: str | None = None) -> FastAPI:
    """Build the FastAPI application.

    Args:
        data_file: Where to persist encrypted blobs. Defaults to ./data/notes.json.
        token: Shared bearer token required on /api/*. None disables auth, which
            is only safe when the server is unreachable from other machines.
    """
    if data_file is None:
        env_path = os.environ.get(ENV_DATA_FILE)
        data_file = Path(env_path) if env_path else None
    if token is None:
        token = os.environ.get(ENV_TOKEN) or None

    encrypted_file = data_file or DEFAULT_DATA_FILE
    # Sits beside the encrypted store, e.g. data/notes.plain.json.
    plain_file = encrypted_file.with_suffix(".plain" + encrypted_file.suffix)

    store = RecordStore(encrypted_file, EncryptedNote)
    plain_store = RecordStore(plain_file, PlainNote)
    templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

    app = FastAPI(
        title="Lockbox",
        version=__version__,
        description="Offline-first PWA with client-side encryption at rest.",
    )
    app.state.store = store
    app.state.plain_store = plain_store
    app.state.token = token

    @app.middleware("http")
    async def cache_policy(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """Set an explicit caching policy for everything we serve.

        Starlette's StaticFiles sends only ETag and Last-Modified. With no
        Cache-Control, RFC 9111 lets a browser apply *heuristic* freshness -
        commonly a tenth of the document's age - and serve the shell from its
        HTTP cache without revalidating. For a shell that names content-hashed
        assets, a stale copy points at filenames a rebuild deleted, and the page
        renders blank.

        That failure is indistinguishable from the service-worker one and
        survives everything a user might try, because unregistering a worker and
        clearing Cache Storage do not touch the HTTP cache.

        So the policy is stated rather than inferred:

        - hashed assets are immutable, since their name changes with content
        - everything else must revalidate
        """
        response = await call_next(request)

        if request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        elif not request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-cache")

        return response

    @app.middleware("http")
    async def require_token(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        """Gate the API. The app shell and service worker stay public.

        Applied as middleware rather than per-route so a newly added endpoint is
        protected by default - forgetting a dependency on one route is exactly
        how these gaps appear.
        """
        if request.url.path.startswith("/api/"):
            rejection = unauthorized_response(request, token)
            if rejection is not None:
                return rejection
        return await call_next(request)

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker(request: Request) -> Response:
        """Serve the service worker from the root.

        A service worker can only control pages at or below its own path, so
        this must be served from "/" rather than "/static/" to control the whole
        app. It is also served no-cache: the browser has to be able to see a new
        worker, or the app could never update itself.
        """
        return templates.TemplateResponse(
            request,
            "sw.js",
            {
                "cache_version": compute_asset_hash(),
                "shell_assets": json.dumps(compute_shell_assets(), indent=4),
            },
            media_type="text/javascript",
            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
        )

    @app.get("/api/info", response_model=ServerInfo)
    async def info() -> ServerInfo:
        """Report server identity and note counts. Used as a reachability probe."""
        return ServerInfo(
            name="lockbox",
            version=__version__,
            note_count=store.count(),
            plain_note_count=plain_store.count(),
        )

    @app.get("/api/notes", response_model=NoteList)
    async def list_notes() -> NoteList:
        """Return every stored note, still encrypted."""
        return NoteList(notes=store.list(include_deleted=True))

    @app.put("/api/notes/{note_id}", response_model=EncryptedNote)
    async def put_note(note_id: str, note: EncryptedNote) -> EncryptedNote:
        """Upsert one encrypted note.

        PUT with a client-generated id makes this idempotent, which is what lets
        the client's outbox retry safely after a dropped connection.
        """
        if note_id != note.id:
            raise HTTPException(status_code=400, detail="Note id in path and body must match")
        return store.put(note)

    @app.delete("/api/notes/{note_id}", status_code=204)
    async def delete_note(note_id: str) -> Response:
        """Tombstone one note. Deleting an unknown id is not an error."""
        store.delete(note_id, int(time.time() * 1000))
        return Response(status_code=204)

    # ------------------------------------------------------------------
    # Plaintext API - the DHIS2-realistic path
    # ------------------------------------------------------------------

    @app.get("/api/plain-notes", response_model=PlainNoteList)
    async def list_plain_notes() -> PlainNoteList:
        """Return every stored note in readable form.

        Any authorised user gets the same readable data - which is the point.
        A per-user passphrase must never influence what lands here, or the
        records stop being shareable.
        """
        return PlainNoteList(notes=plain_store.list(include_deleted=True))

    @app.put("/api/plain-notes/{note_id}", response_model=PlainNote)
    async def put_plain_note(note_id: str, note: PlainNote) -> PlainNote:
        """Upsert one readable note, the way a DHIS2 data value would arrive."""
        if note_id != note.id:
            raise HTTPException(status_code=400, detail="Note id in path and body must match")
        return plain_store.put(note)

    @app.delete("/api/plain-notes/{note_id}", status_code=204)
    async def delete_plain_note(note_id: str) -> Response:
        """Tombstone one readable note. Idempotent."""
        plain_store.delete(note_id, int(time.time() * 1000))
        return Response(status_code=204)

    # Mounted last so the routes above win: Starlette matches in registration
    # order, and this catch-all would otherwise swallow /api and /sw.js.
    # html=True serves index.html at "/" (and as the 404 fallback, which is what
    # a single-page app wants).
    if STATIC_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="app")

    return app
