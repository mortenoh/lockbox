"""Typer CLI for the lockbox demo server."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Annotated, Any

import typer
import uvicorn

from lockbox import __version__
from lockbox.api import DEFAULT_DATA_FILE, ENV_DATA_FILE, ENV_TOKEN, create_app
from lockbox.auth import generate_token
from lockbox.schemas import EncryptedNote, PlainNote
from lockbox.store import RecordStore

app = typer.Typer(
    name="lockbox",
    help="Offline-first PWA with client-side encryption at rest - a learning project.",
    no_args_is_help=True,
    add_completion=False,
)


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Bind address.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Bind port.")] = 8000,
    data_file: Annotated[Path, typer.Option(help="Where to persist encrypted blobs.")] = DEFAULT_DATA_FILE,
    auth: Annotated[str, typer.Option(help="Auth mode: 'none' (local only) or 'token' (shared bearer).")] = "none",
    token: Annotated[str | None, typer.Option(help="Token to require. Generated if omitted in token mode.")] = None,
    reload: Annotated[bool, typer.Option(help="Auto-reload on source changes.")] = False,
) -> None:
    """Run the demo server.

    Note that service workers require a secure context: localhost counts, but a
    plain-HTTP LAN address does not. Test on localhost or put TLS in front.
    """
    if auth not in {"none", "token"}:
        typer.echo("--auth must be 'none' or 'token'", err=True)
        raise typer.Exit(code=2)

    resolved: str | None = None
    if auth == "token":
        resolved = token or generate_token()
        typer.echo("Auth: token required on /api/*")
        typer.echo(f"  token: {resolved}")
        typer.echo("  paste this into the app when it asks for an access token\n")
    elif host not in {"127.0.0.1", "localhost"}:
        # Binding beyond loopback with no auth exposes an open read/write API.
        typer.secho(
            f"WARNING: serving on {host} with --auth none. "
            "Anyone who can reach this port can read, write and delete every note.",
            fg=typer.colors.RED,
            err=True,
        )

    if reload:
        # The reloader re-imports the app in a child process and calls the
        # factory with no arguments, so configuration has to travel via the
        # environment. Passing it positionally here would be silently dropped -
        # which previously meant `--reload --auth token` printed a token and
        # then served an unauthenticated API.
        os.environ[ENV_DATA_FILE] = str(data_file)
        if resolved is not None:
            os.environ[ENV_TOKEN] = resolved
        uvicorn.run("lockbox.api:create_app", factory=True, host=host, port=port, reload=True)
    else:
        uvicorn.run(create_app(data_file, resolved), host=host, port=port)


@app.command()
def dump(
    data_file: Annotated[Path, typer.Option(help="Path to the stored blobs.")] = DEFAULT_DATA_FILE,
) -> None:
    """Print what the server actually holds.

    This is the point of the demo: the output is ciphertext plus routing
    metadata, with no readable note content anywhere.

    The plaintext store is printed too, so the contrast between the two sync
    modes is visible in one place: one is unreadable, the other is exactly what
    a DHIS2 backend would hold.
    """
    plain_file = data_file.with_suffix(".plain" + data_file.suffix)

    _dump_store(
        RecordStore(data_file, EncryptedNote),
        data_file,
        "Encrypted sync mode - server cannot read these",
    )
    _dump_store(
        RecordStore(plain_file, PlainNote),
        plain_file,
        "Plaintext sync mode (DHIS2-realistic) - readable, as it must be",
    )


def _dump_store(store: RecordStore[Any], path: Path, heading: str) -> None:
    """Print one store's contents, or note that it is empty."""
    typer.echo(f"=== {heading} ===")
    notes = store.list()
    if not notes:
        typer.echo(f"(nothing at {path})\n")
        return

    typer.echo(f"{len(notes)} note(s) at {path}:\n")
    for note in notes:
        typer.echo(json.dumps(note.model_dump(by_alias=True), indent=2))
    typer.echo("")


@app.command()
def version() -> None:
    """Print the version."""
    typer.echo(__version__)


def main() -> None:
    """CLI entry point."""
    app()


if __name__ == "__main__":
    main()
