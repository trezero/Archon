"""Tests for the inline document ingestion models."""

import pytest
from src.server.api_routes.knowledge_api import InlineIngestRequest, InlineDocument


class TestInlineDocument:
    def test_with_all_fields(self):
        doc = InlineDocument(
            title="auth.md",
            content="# Auth\n\nOverview content",
            path="docs/architecture/auth.md",
        )
        assert doc.title == "auth.md"
        assert doc.content == "# Auth\n\nOverview content"
        assert doc.path == "docs/architecture/auth.md"

    def test_without_path(self):
        doc = InlineDocument(title="auth.md", content="# Auth")
        assert doc.path is None

    def test_empty_content_allowed(self):
        # Pydantic allows empty string; validation happens in endpoint
        doc = InlineDocument(title="empty.md", content="")
        assert doc.content == ""


class TestInlineIngestRequest:
    def test_valid_request(self):
        req = InlineIngestRequest(
            title="Test Docs",
            documents=[InlineDocument(title="test.md", content="# Test")],
        )
        assert req.title == "Test Docs"
        assert len(req.documents) == 1
        assert req.knowledge_type == "technical"
        assert req.extract_code_examples is True
        assert req.tags == []
        assert req.project_id is None

    def test_with_project_id_and_tags(self):
        req = InlineIngestRequest(
            title="Test Docs",
            documents=[InlineDocument(title="test.md", content="# Test")],
            project_id="proj-123",
            tags=["test", "docs"],
        )
        assert req.project_id == "proj-123"
        assert req.tags == ["test", "docs"]

    def test_custom_knowledge_type(self):
        req = InlineIngestRequest(
            title="Test",
            documents=[InlineDocument(title="t.md", content="x")],
            knowledge_type="api_reference",
        )
        assert req.knowledge_type == "api_reference"

    def test_extract_code_disabled(self):
        req = InlineIngestRequest(
            title="Test",
            documents=[InlineDocument(title="t.md", content="x")],
            extract_code_examples=False,
        )
        assert req.extract_code_examples is False

    def test_multiple_documents(self):
        docs = [
            InlineDocument(title=f"doc{i}.md", content=f"# Doc {i}")
            for i in range(5)
        ]
        req = InlineIngestRequest(title="Batch", documents=docs)
        assert len(req.documents) == 5
