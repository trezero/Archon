"""Tests for manage_rag_source MCP tool validation."""

import json
from unittest.mock import MagicMock

import pytest
from mcp.server.fastmcp import Context

from src.mcp_server.features.rag.rag_tools import register_rag_tools


@pytest.fixture
def mock_mcp():
    """Create a mock MCP server that captures registered tool functions."""
    mock = MagicMock()
    mock._tools = {}

    def tool_decorator():
        def decorator(func):
            mock._tools[func.__name__] = func
            return func

        return decorator

    mock.tool = tool_decorator
    return mock


@pytest.fixture
def mock_context():
    """Create a mock context for testing."""
    return MagicMock(spec=Context)


@pytest.fixture
def manage_rag_source(mock_mcp):
    """Register RAG tools and return the manage_rag_source function."""
    register_rag_tools(mock_mcp)
    tool = mock_mcp._tools.get("manage_rag_source")
    assert tool is not None, "manage_rag_source tool not registered"
    return tool


class TestManageRagSourceValidation:
    """Test input validation for manage_rag_source."""

    @pytest.mark.asyncio
    async def test_invalid_action(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="invalid")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "invalid" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_missing_title(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="add")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "title" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_missing_source_type(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="add", title="Test")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "source_type" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_invalid_source_type(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="add", title="Test", source_type="ftp")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "source_type" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_inline_missing_documents(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="add", title="Test", source_type="inline")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "documents" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_inline_invalid_json(self, manage_rag_source, mock_context):
        result = await manage_rag_source(
            mock_context, action="add", title="Test", source_type="inline", documents="not json"
        )
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "json" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_inline_empty_array(self, manage_rag_source, mock_context):
        result = await manage_rag_source(
            mock_context, action="add", title="Test", source_type="inline", documents="[]"
        )
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "non-empty" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_inline_non_array_json(self, manage_rag_source, mock_context):
        result = await manage_rag_source(
            mock_context, action="add", title="Test", source_type="inline", documents='{"title": "x"}'
        )
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "non-empty" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_add_inline_list_documents_accepted(self, manage_rag_source, mock_context):
        """Test that documents passed as a native list (MCP auto-deserialization) are accepted."""
        # This should pass validation and proceed to the HTTP call, which will fail
        # since we don't mock it — but validation should NOT fail.
        docs_list = [{"title": "test.md", "content": "# Test content"}]
        result = await manage_rag_source(
            mock_context, action="add", title="Test", source_type="inline", documents=docs_list
        )
        data = json.loads(result)
        # Should either succeed (with HTTP error since no server) or fail with connection error
        # but NOT with a validation error about documents format
        if not data["success"]:
            assert data["error"]["type"] != "validation_error", (
                f"List documents should pass validation, got: {data['error']['message']}"
            )

    @pytest.mark.asyncio
    async def test_add_inline_empty_list_rejected(self, manage_rag_source, mock_context):
        """Test that an empty native list is rejected."""
        result = await manage_rag_source(
            mock_context, action="add", title="Test", source_type="inline", documents=[]
        )
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"

    @pytest.mark.asyncio
    async def test_add_url_missing_url(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="add", title="Test", source_type="url")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "url" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_sync_missing_source_id(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="sync")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "source_id" in data["error"]["message"].lower()

    @pytest.mark.asyncio
    async def test_delete_missing_source_id(self, manage_rag_source, mock_context):
        result = await manage_rag_source(mock_context, action="delete")
        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "validation_error"
        assert "source_id" in data["error"]["message"].lower()
