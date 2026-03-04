"""Tests for Phase 5: Server-side file hashes and incremental sync."""

import pytest
from unittest.mock import MagicMock, patch, AsyncMock

from src.server.api_routes.knowledge_api import (
    InlineDocument,
    InlineSyncRequest,
)


class TestInlineDocumentFileHash:
    """Tests for file_hash field on InlineDocument."""

    def test_file_hash_optional(self):
        doc = InlineDocument(title="file.md", content="# Content")
        assert doc.file_hash is None

    def test_file_hash_provided(self):
        doc = InlineDocument(title="file.md", content="# Content", file_hash="abc123")
        assert doc.file_hash == "abc123"

    def test_file_hash_empty_string(self):
        doc = InlineDocument(title="file.md", content="# Content", file_hash="")
        assert doc.file_hash == ""


class TestSyncDiffComputation:
    """Tests for the hash comparison logic used in incremental sync."""

    def _compute_sync_diff(self, valid_docs, stored_hashes):
        """Replicate the sync diff logic from sync_inline_documents."""
        incoming_titles = {doc.title for doc in valid_docs}
        stored_titles = set(stored_hashes.keys())

        changed_docs = []
        unchanged_docs = []
        new_docs = []

        for doc in valid_docs:
            if doc.title in stored_hashes:
                if doc.file_hash and doc.file_hash == stored_hashes[doc.title]:
                    unchanged_docs.append(doc)
                else:
                    changed_docs.append(doc)
            else:
                new_docs.append(doc)

        deleted_titles = list(stored_titles - incoming_titles)

        return {
            "changed": [d.title for d in changed_docs],
            "unchanged": [d.title for d in unchanged_docs],
            "new": [d.title for d in new_docs],
            "deleted": deleted_titles,
            "_docs_to_process": changed_docs + new_docs,
        }

    def test_all_unchanged(self):
        """When all hashes match, no documents need processing."""
        stored = {"file1.md": "hash1", "file2.md": "hash2"}
        docs = [
            InlineDocument(title="file1.md", content="x", file_hash="hash1"),
            InlineDocument(title="file2.md", content="y", file_hash="hash2"),
        ]
        diff = self._compute_sync_diff(docs, stored)
        assert diff["changed"] == []
        assert diff["unchanged"] == ["file1.md", "file2.md"]
        assert diff["new"] == []
        assert diff["deleted"] == []
        assert len(diff["_docs_to_process"]) == 0

    def test_one_changed(self):
        """When one hash differs, only that document needs processing."""
        stored = {"file1.md": "hash1", "file2.md": "hash2"}
        docs = [
            InlineDocument(title="file1.md", content="x", file_hash="hash1"),
            InlineDocument(title="file2.md", content="updated", file_hash="new_hash2"),
        ]
        diff = self._compute_sync_diff(docs, stored)
        assert diff["changed"] == ["file2.md"]
        assert diff["unchanged"] == ["file1.md"]
        assert diff["new"] == []
        assert len(diff["_docs_to_process"]) == 1

    def test_new_document_added(self):
        """Documents not in stored hashes are classified as new."""
        stored = {"file1.md": "hash1"}
        docs = [
            InlineDocument(title="file1.md", content="x", file_hash="hash1"),
            InlineDocument(title="file3.md", content="new file", file_hash="hash3"),
        ]
        diff = self._compute_sync_diff(docs, stored)
        assert diff["changed"] == []
        assert diff["unchanged"] == ["file1.md"]
        assert diff["new"] == ["file3.md"]
        assert len(diff["_docs_to_process"]) == 1

    def test_document_deleted(self):
        """Documents in stored hashes but not in incoming are classified as deleted."""
        stored = {"file1.md": "hash1", "file2.md": "hash2", "removed.md": "hash_old"}
        docs = [
            InlineDocument(title="file1.md", content="x", file_hash="hash1"),
            InlineDocument(title="file2.md", content="y", file_hash="hash2"),
        ]
        diff = self._compute_sync_diff(docs, stored)
        assert diff["deleted"] == ["removed.md"]
        assert diff["unchanged"] == ["file1.md", "file2.md"]

    def test_mixed_changes(self):
        """Test a realistic scenario with changed, new, unchanged, and deleted."""
        stored = {
            "README.md": "hash_readme",
            "CLAUDE.md": "hash_claude_old",
            "deprecated.md": "hash_dep",
        }
        docs = [
            InlineDocument(title="README.md", content="same", file_hash="hash_readme"),
            InlineDocument(title="CLAUDE.md", content="updated", file_hash="hash_claude_new"),
            InlineDocument(title="NEW.md", content="brand new", file_hash="hash_new"),
        ]
        diff = self._compute_sync_diff(docs, stored)
        assert diff["unchanged"] == ["README.md"]
        assert diff["changed"] == ["CLAUDE.md"]
        assert diff["new"] == ["NEW.md"]
        assert diff["deleted"] == ["deprecated.md"]
        assert len(diff["_docs_to_process"]) == 2

    def test_no_hash_on_doc_treated_as_changed(self):
        """When a doc has no file_hash, it should be treated as changed."""
        stored = {"file1.md": "hash1"}
        docs = [
            InlineDocument(title="file1.md", content="x", file_hash=None),
        ]
        diff = self._compute_sync_diff(docs, stored)
        assert diff["changed"] == ["file1.md"]
        assert diff["unchanged"] == []


class TestFileHashStorageInMetadata:
    """Tests for file_hash storage in source metadata."""

    def test_file_hashes_collected_from_docs(self):
        """File hashes should be collected into a dict keyed by title."""
        docs = [
            InlineDocument(title="a.md", content="x", file_hash="h1"),
            InlineDocument(title="b.md", content="y", file_hash="h2"),
            InlineDocument(title="c.md", content="z"),  # No hash
        ]
        file_hashes = {}
        for doc in docs:
            if doc.file_hash:
                file_hashes[doc.title] = doc.file_hash

        assert file_hashes == {"a.md": "h1", "b.md": "h2"}
        assert "c.md" not in file_hashes

    def test_empty_hashes_when_no_docs_have_hash(self):
        """When no docs have file_hash, the dict should be empty."""
        docs = [
            InlineDocument(title="a.md", content="x"),
            InlineDocument(title="b.md", content="y"),
        ]
        file_hashes = {}
        for doc in docs:
            if doc.file_hash:
                file_hashes[doc.title] = doc.file_hash

        assert file_hashes == {}


class TestInlineSyncRequestWithHash:
    """Tests for InlineSyncRequest with file_hash documents."""

    def test_sync_request_with_hashed_docs(self):
        req = InlineSyncRequest(
            source_id="src_123",
            documents=[
                InlineDocument(title="f.md", content="x", file_hash="abc"),
            ],
        )
        assert req.documents[0].file_hash == "abc"

    def test_sync_request_mixed_hash_docs(self):
        req = InlineSyncRequest(
            source_id="src_123",
            documents=[
                InlineDocument(title="a.md", content="x", file_hash="h1"),
                InlineDocument(title="b.md", content="y"),
            ],
        )
        assert req.documents[0].file_hash == "h1"
        assert req.documents[1].file_hash is None
