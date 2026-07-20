"""Tests for the sync API and record store."""

import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from lockbox.api import STATIC_DIR, create_app
from lockbox.schemas import EncryptedNote
from lockbox.store import RecordStore


@pytest.fixture
def data_file(tmp_path: Path) -> Path:
    return tmp_path / "notes.json"


@pytest.fixture
def client(data_file: Path) -> TestClient:
    return TestClient(create_app(data_file))


def make_note(note_id: str = "n1", updated_at: int = 1000) -> dict[str, object]:
    return {
        "id": note_id,
        "iv": "aXYtYnl0ZXM",
        "ciphertext": "Y2lwaGVydGV4dA",
        "createdAt": 1000,
        "updatedAt": updated_at,
    }


def make_plain_note(note_id: str = "p1", updated_at: int = 1000) -> dict[str, object]:
    return {
        "id": note_id,
        "title": "Field visit",
        "body": "Readable, the way DHIS2 needs it.",
        "createdAt": 1000,
        "updatedAt": updated_at,
    }


class TestApi:
    def test_index_serves_shell(self, client: TestClient) -> None:
        response = client.get("/")
        assert response.status_code == 200
        assert "Lockbox" in response.text

    def test_service_worker_served_from_root(self, client: TestClient) -> None:
        """The SW must be at / so its scope covers the whole app."""
        response = client.get("/sw.js")
        assert response.status_code == 200
        assert "text/javascript" in response.headers["content-type"]
        # Must not be cached, or the app could never ship an update.
        assert response.headers["cache-control"] == "no-cache"

    def test_service_worker_has_injected_cache_version(self, client: TestClient) -> None:
        """The cache name carries a content hash, not a hand-bumped constant."""
        body = client.get("/sw.js").text
        match = re.search(r'const CACHE_VERSION = "lockbox-([0-9a-f]{12})"', body)
        assert match is not None, "cache version was not injected"

    def test_service_worker_precaches_built_assets(self, client: TestClient) -> None:
        """Vite emits hashed filenames, so the list must come from disk."""
        body = client.get("/sw.js").text
        assets = json.loads(re.search(r"const SHELL_ASSETS = (\[.*?\]);", body, re.S).group(1))  # type: ignore[union-attr]
        assert "/" in assets
        # index.html is reached via "/", so listing it again would double-fetch.
        assert not any(a.endswith("index.html") for a in assets)
        assert all(a.startswith("/") for a in assets)

    def test_info(self, client: TestClient) -> None:
        response = client.get("/api/info")
        assert response.status_code == 200
        assert response.json() == {
            "name": "lockbox",
            "version": "0.1.0",
            "noteCount": 0,
            "plainNoteCount": 0,
        }

    def test_put_and_list_note(self, client: TestClient) -> None:
        note = make_note()
        assert client.put("/api/notes/n1", json=note).status_code == 200

        listed = client.get("/api/notes").json()["notes"]
        assert len(listed) == 1
        assert listed[0]["ciphertext"] == note["ciphertext"]

    def test_put_is_idempotent(self, client: TestClient) -> None:
        """Replaying a queued upload must not duplicate the record."""
        note = make_note()
        for _ in range(3):
            client.put("/api/notes/n1", json=note)

        assert client.get("/api/info").json()["noteCount"] == 1

    def test_put_rejects_id_mismatch(self, client: TestClient) -> None:
        response = client.put("/api/notes/other", json=make_note("n1"))
        assert response.status_code == 400

    def test_delete_is_idempotent(self, client: TestClient) -> None:
        client.put("/api/notes/n1", json=make_note())
        assert client.delete("/api/notes/n1").status_code == 204
        assert client.delete("/api/notes/n1").status_code == 204
        assert client.get("/api/info").json()["noteCount"] == 0

    def test_rejects_malformed_payload(self, client: TestClient) -> None:
        response = client.put("/api/notes/n1", json={"id": "n1"})
        assert response.status_code == 422


class TestPlainNoteApi:
    """The DHIS2-realistic path: readable data, shared between users."""

    def test_put_and_list_plain_note(self, client: TestClient) -> None:
        note = make_plain_note()
        assert client.put("/api/plain-notes/p1", json=note).status_code == 200

        listed = client.get("/api/plain-notes").json()["notes"]
        assert len(listed) == 1
        assert listed[0]["title"] == "Field visit"

    def test_plain_and_encrypted_stores_are_separate(self, client: TestClient) -> None:
        """The two sync modes must not contaminate each other's data."""
        client.put("/api/notes/n1", json=make_note())
        client.put("/api/plain-notes/p1", json=make_plain_note())

        info = client.get("/api/info").json()
        assert info["noteCount"] == 1
        assert info["plainNoteCount"] == 1

    def test_plain_note_is_readable_on_disk(self, client: TestClient, data_file: Path) -> None:
        """The whole point: a DHIS2 backend can actually read what it stores."""
        client.put("/api/plain-notes/p1", json=make_plain_note())
        plain_file = data_file.with_suffix(".plain.json")
        assert "Field visit" in plain_file.read_text()

    def test_encrypted_note_is_not_readable_on_disk(self, client: TestClient, data_file: Path) -> None:
        """And the contrast: the encrypted store leaks no content."""
        client.put("/api/notes/n1", json=make_note())
        assert "Field visit" not in data_file.read_text()

    def test_plain_put_rejects_id_mismatch(self, client: TestClient) -> None:
        assert client.put("/api/plain-notes/other", json=make_plain_note("p1")).status_code == 400

    def test_plain_delete_is_idempotent(self, client: TestClient) -> None:
        client.put("/api/plain-notes/p1", json=make_plain_note())
        assert client.delete("/api/plain-notes/p1").status_code == 204
        assert client.delete("/api/plain-notes/p1").status_code == 204


class TestRecordStore:
    def test_persists_across_instances(self, data_file: Path) -> None:
        RecordStore(data_file, EncryptedNote).put(EncryptedNote.model_validate(make_note()))
        assert RecordStore(data_file, EncryptedNote).count() == 1

    def test_newer_update_wins(self, data_file: Path) -> None:
        store = RecordStore(data_file, EncryptedNote)
        store.put(EncryptedNote.model_validate(make_note(updated_at=1000)))
        store.put(EncryptedNote.model_validate(make_note(updated_at=2000)))
        stored = store.get("n1")
        assert stored is not None
        assert stored.updated_at == 2000

    def test_stale_update_is_ignored(self, data_file: Path) -> None:
        """A late-arriving retry must not clobber a newer version."""
        store = RecordStore(data_file, EncryptedNote)
        store.put(EncryptedNote.model_validate(make_note(updated_at=2000)))
        store.put(EncryptedNote.model_validate(make_note(updated_at=1000)))
        stored = store.get("n1")
        assert stored is not None
        assert stored.updated_at == 2000

    def test_tolerates_corrupt_file(self, data_file: Path) -> None:
        data_file.write_text("not json at all")
        assert RecordStore(data_file, EncryptedNote).count() == 0

    def test_delete_reports_whether_it_removed(self, data_file: Path) -> None:
        store = RecordStore(data_file, EncryptedNote)
        store.put(EncryptedNote.model_validate(make_note()))
        assert store.delete("n1", 5000) is True
        assert store.delete("n1", 5000) is False


class TestAuth:
    """Token mode is what makes a publicly reachable deployment defensible."""

    @pytest.fixture
    def secured(self, data_file: Path) -> TestClient:
        return TestClient(create_app(data_file, token="s3cret"))

    def test_api_rejects_missing_token(self, secured: TestClient) -> None:
        for path in ("/api/info", "/api/notes", "/api/plain-notes"):
            assert secured.get(path).status_code == 401

    def test_api_rejects_wrong_token(self, secured: TestClient) -> None:
        response = secured.get("/api/info", headers={"Authorization": "Bearer nope"})
        assert response.status_code == 401

    def test_rejection_is_401_not_500(self, secured: TestClient) -> None:
        """Raising inside Starlette middleware yields a 500 - it must not."""
        response = secured.get("/api/info")
        assert response.status_code == 401
        assert response.headers["www-authenticate"] == "Bearer"

    def test_writes_are_rejected_too(self, secured: TestClient) -> None:
        assert secured.put("/api/plain-notes/p1", json=make_plain_note()).status_code == 401
        assert secured.delete("/api/plain-notes/p1").status_code == 401

    def test_valid_token_passes(self, secured: TestClient) -> None:
        response = secured.get("/api/info", headers={"Authorization": "Bearer s3cret"})
        assert response.status_code == 200

    def test_app_shell_stays_public(self, secured: TestClient) -> None:
        """Gating static assets would stop the service worker installing."""
        assert secured.get("/").status_code == 200
        assert secured.get("/sw.js").status_code == 200

    def test_auth_disabled_by_default(self, client: TestClient) -> None:
        assert client.get("/api/info").status_code == 200


class TestTombstones:
    """Deletions have to reach other devices, so they cannot just vanish."""

    def test_delete_keeps_a_dated_tombstone(self, data_file: Path) -> None:
        store = RecordStore(data_file, EncryptedNote)
        store.put(EncryptedNote.model_validate(make_note(updated_at=1000)))
        assert store.delete("n1", 5000) is True

        record = store.get("n1")
        assert record is not None
        assert record.deleted is True
        assert record.updated_at == 5000

    def test_tombstones_are_hidden_from_normal_listing(self, data_file: Path) -> None:
        store = RecordStore(data_file, EncryptedNote)
        store.put(EncryptedNote.model_validate(make_note()))
        store.delete("n1", 5000)

        assert store.list() == []
        assert len(store.list(include_deleted=True)) == 1
        assert store.count() == 0

    def test_clients_can_see_tombstones_over_the_api(self, client: TestClient) -> None:
        """Without this a second device would keep a deleted note forever."""
        client.put("/api/plain-notes/p1", json=make_plain_note())
        client.delete("/api/plain-notes/p1")

        notes = client.get("/api/plain-notes").json()["notes"]
        assert len(notes) == 1
        assert notes[0]["deleted"] is True

    def test_stale_put_cannot_resurrect_a_deleted_note(self, data_file: Path) -> None:
        """An older queued upload must not undo a newer deletion."""
        store = RecordStore(data_file, EncryptedNote)
        store.put(EncryptedNote.model_validate(make_note(updated_at=1000)))
        store.delete("n1", 5000)

        store.put(EncryptedNote.model_validate(make_note(updated_at=2000)))

        record = store.get("n1")
        assert record is not None
        assert record.deleted is True


class TestCachePolicy:
    """Caching must be stated, not left to the browser's heuristics."""

    def test_shell_must_revalidate(self, client: TestClient) -> None:
        """Without this a browser may serve a stale shell without asking.

        RFC 9111 permits heuristic freshness when no Cache-Control is present,
        and a stale shell names assets a rebuild has deleted - a blank page that
        clearing the service worker does not fix, because the HTTP cache is a
        different cache.
        """
        response = client.get("/")
        assert response.headers["cache-control"] == "no-cache"

    def test_service_worker_must_revalidate(self, client: TestClient) -> None:
        assert client.get("/sw.js").headers["cache-control"] == "no-cache"

    def test_hashed_assets_are_immutable(self, client: TestClient) -> None:
        """Safe precisely because the filename changes whenever content does."""
        assets = [p for p in STATIC_DIR.rglob("*") if p.suffix == ".js" and p.is_file()]
        if not assets:
            pytest.skip("frontend not built")

        rel = assets[0].relative_to(STATIC_DIR).as_posix()
        response = client.get(f"/{rel}")
        assert "immutable" in response.headers["cache-control"]
        assert "max-age=31536000" in response.headers["cache-control"]

    def test_api_responses_are_not_given_a_cache_policy(self, client: TestClient) -> None:
        """The sync engine sets its own no-store per request."""
        assert "cache-control" not in client.get("/api/info").headers
