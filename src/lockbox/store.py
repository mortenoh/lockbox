"""Persistence for note records.

A JSON file on disk is plenty for a learning demo: it survives restarts, and it
makes it trivial to `cat` the file and see exactly what the server holds - which
is the point when comparing the encrypted and plaintext sync modes side by side.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path

from lockbox.schemas import NoteBase


class RecordStore[T: NoteBase]:
    """Thread-safe, last-write-wins store of notes of a single shape.

    Generic over the record type so the same logic serves both the encrypted
    blob store and the plaintext (DHIS2-style) store.
    """

    def __init__(self, path: Path, model: type[T]) -> None:
        self._path = path
        self._model = model
        self._lock = threading.Lock()
        self._notes: dict[str, T] = {}
        self._load()

    @property
    def path(self) -> Path:
        """Return the backing file path."""
        return self._path

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for item in raw.get("notes", []):
            try:
                note = self._model.model_validate(item)
            except ValueError:
                continue
            self._notes[note.id] = note

    def _flush(self) -> None:
        """Write the store out atomically so a crash cannot truncate it."""
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"notes": [n.model_dump(by_alias=True) for n in self._notes.values()]}
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self._path)

    def list(self, include_deleted: bool = False) -> list[T]:
        """Return stored notes, oldest first.

        Tombstones are included only when asked for: clients need them to
        converge, but `lockbox dump` and the counters should not show ghosts.
        """
        with self._lock:
            notes = [n for n in self._notes.values() if include_deleted or not n.deleted]
            return sorted(notes, key=lambda n: n.created_at)

    def get(self, note_id: str) -> T | None:
        """Return a single note by id, or None if it is unknown."""
        with self._lock:
            return self._notes.get(note_id)

    def put(self, note: T) -> T:
        """Upsert a note, keeping whichever version has the newer updated_at.

        Because the client generates the id, replaying a queued upload is
        idempotent rather than duplicating the record.
        """
        with self._lock:
            existing = self._notes.get(note.id)
            if existing is not None and existing.updated_at > note.updated_at:
                return existing
            self._notes[note.id] = note
            self._flush()
            return note

    def delete(self, note_id: str, when: int) -> bool:
        """Tombstone a note. Returns True if it existed and was not already gone.

        Soft rather than hard: other devices only learn about a deletion by
        seeing the record, so removing the row outright would leave their copies
        untouched indefinitely.
        """
        with self._lock:
            existing = self._notes.get(note_id)
            if existing is None or existing.deleted:
                return False
            self._notes[note_id] = existing.model_copy(
                update={"deleted": True, "updated_at": max(when, existing.updated_at + 1)}
            )
            self._flush()
            return True

    def count(self) -> int:
        """Return the number of live (non-tombstoned) notes."""
        with self._lock:
            return sum(1 for n in self._notes.values() if not n.deleted)
