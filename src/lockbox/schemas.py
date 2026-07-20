"""Wire models for the sync API.

Two shapes travel over the wire, and the difference between them is the whole
architectural argument of this project:

- `PlainNote` is what a real DHIS2-style backend receives: ordinary readable
  data, governed by the server's own sharing rules, visible to every user
  authorised to see it. This is the realistic target.
- `EncryptedNote` is the opaque-blob alternative, where the server stores
  ciphertext it cannot read. It is included to demonstrate the trade-off, not
  because it suits DHIS2 - see `docs/context/dhis2.md`.

Both carry timestamps and a client-generated id in the clear, because the server
needs them to store, order and de-duplicate records.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class NoteBase(BaseModel):
    """Fields every note shares regardless of whether the body is encrypted.

    Attributes:
        id: Client-generated UUID. Doubles as the idempotency key, so replaying
            a queued upload after a flaky connection is a harmless overwrite.
        created_at: Client clock, milliseconds since the epoch.
        updated_at: Client clock, milliseconds since the epoch. Used for
            last-write-wins on the server.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(min_length=1, max_length=128)
    created_at: int = Field(alias="createdAt", ge=0)
    updated_at: int = Field(alias="updatedAt", ge=0)
    # Tombstone marker. A delete that simply removed the row would be invisible
    # to every other device, which would keep its copy forever - and an older
    # queued PUT could resurrect the record. Keeping a dated tombstone lets the
    # same last-write-wins rule settle deletions too.
    deleted: bool = False


class EncryptedNote(NoteBase):
    """A note the server stores but cannot read.

    Attributes:
        iv: Base64url-encoded 12-byte AES-GCM initialization vector, unique per
            encryption. Not secret.
        ciphertext: Base64url-encoded AES-256-GCM ciphertext (includes the auth
            tag). The plaintext is a JSON object with the note title and body.
    """

    iv: str = Field(min_length=1, max_length=64)
    ciphertext: str = Field(min_length=1, max_length=1_000_000)


class PlainNote(NoteBase):
    """A note in readable form - what DHIS2 would actually store.

    The client decrypts at the moment of sync and sends this. Confidentiality on
    the wire is TLS's job; confidentiality at rest on the server is the
    platform's job, under its own access-control rules.
    """

    title: str = Field(min_length=1, max_length=1_000)
    body: str = Field(default="", max_length=100_000)
    # Who wrote it. Plaintext by necessity: other users need to see authorship,
    # which is exactly the kind of shared-context field that cannot survive
    # per-user encryption. In a real deployment this would be the DHIS2 user,
    # established by the session rather than self-declared.
    author: str = Field(default="unknown", min_length=1, max_length=100)


class NoteList(BaseModel):
    """Response body for a full pull of the server's encrypted notes."""

    notes: list[EncryptedNote]


class PlainNoteList(BaseModel):
    """Response body for a full pull of the server's plaintext notes."""

    notes: list[PlainNote]


class ServerInfo(BaseModel):
    """Small health/identity payload, handy for connectivity checks."""

    model_config = ConfigDict(serialize_by_alias=True)

    name: str
    version: str
    note_count: int = Field(serialization_alias="noteCount")
    plain_note_count: int = Field(serialization_alias="plainNoteCount")
