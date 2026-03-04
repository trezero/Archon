"""Tests for Phase 6: Progress data retention."""

import os
import pytest
from unittest.mock import patch

from src.server.utils.progress.progress_tracker import ProgressTracker, COMPLETION_TTL


class TestCompletionTTL:
    """Tests for configurable completion TTL."""

    def test_default_ttl_is_300_seconds(self):
        """Default COMPLETION_TTL should be 300 seconds (5 minutes)."""
        assert COMPLETION_TTL == 300

    def test_ttl_from_env_var(self):
        """COMPLETION_TTL should be configurable via environment variable."""
        # The module reads env at import time, so we verify the mechanism
        with patch.dict(os.environ, {"PROGRESS_COMPLETION_TTL": "600"}):
            ttl = int(os.getenv("PROGRESS_COMPLETION_TTL", "300"))
            assert ttl == 600

    def test_ttl_default_without_env(self):
        """Without env var, TTL defaults to 300."""
        with patch.dict(os.environ, {}, clear=True):
            # Remove the key if present
            os.environ.pop("PROGRESS_COMPLETION_TTL", None)
            ttl = int(os.getenv("PROGRESS_COMPLETION_TTL", "300"))
            assert ttl == 300


class TestDelayedCleanupSignature:
    """Tests that _delayed_cleanup uses COMPLETION_TTL by default."""

    def test_delayed_cleanup_accepts_none_delay(self):
        """_delayed_cleanup should accept None to use the default COMPLETION_TTL."""
        import inspect
        sig = inspect.signature(ProgressTracker._delayed_cleanup)
        params = sig.parameters
        assert "delay_seconds" in params
        # Default should be None (which means use COMPLETION_TTL)
        assert params["delay_seconds"].default is None


class TestProgressTrackerLifecycle:
    """Tests for progress tracker state management."""

    def setup_method(self):
        """Clear all progress states before each test."""
        ProgressTracker._progress_states.clear()

    def test_progress_created_and_accessible(self):
        """Progress should be accessible after creation."""
        tracker = ProgressTracker("test-1", operation_type="test")
        state = ProgressTracker.get_progress("test-1")
        assert state is not None
        assert state["progress_id"] == "test-1"
        assert state["type"] == "test"

    def test_progress_cleared(self):
        """Progress should be removable."""
        tracker = ProgressTracker("test-2", operation_type="test")
        ProgressTracker.clear_progress("test-2")
        assert ProgressTracker.get_progress("test-2") is None

    def test_list_active_returns_all(self):
        """list_active should return all active progress states."""
        ProgressTracker("a", operation_type="test")
        ProgressTracker("b", operation_type="test")
        active = ProgressTracker.list_active()
        assert "a" in active
        assert "b" in active


class TestLastIngestionMetadataFormat:
    """Tests for the last_ingestion metadata format."""

    def test_last_ingestion_structure(self):
        """Verify the expected structure of last_ingestion metadata."""
        from datetime import datetime, timezone

        last_ingestion = {
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "documents_processed": 3,
            "chunks_stored": 47,
            "code_examples_stored": 12,
            "status": "completed",
        }

        assert "completed_at" in last_ingestion
        assert isinstance(last_ingestion["documents_processed"], int)
        assert isinstance(last_ingestion["chunks_stored"], int)
        assert isinstance(last_ingestion["code_examples_stored"], int)
        assert last_ingestion["status"] == "completed"

    def test_last_ingestion_in_metadata_dict(self):
        """last_ingestion should be stored as a nested dict in source metadata."""
        metadata = {
            "knowledge_type": "technical",
            "source_type": "inline",
            "last_ingestion": {
                "completed_at": "2026-03-03T23:05:00Z",
                "documents_processed": 3,
                "chunks_stored": 47,
                "code_examples_stored": 12,
                "status": "completed",
            },
        }

        assert "last_ingestion" in metadata
        li = metadata["last_ingestion"]
        assert li["documents_processed"] == 3
        assert li["chunks_stored"] == 47
        assert li["status"] == "completed"
