"""Tests for manage_project source linking via MCP tool."""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from mcp.server.fastmcp import Context

from src.mcp_server.features.projects.project_tools import register_project_tools


@pytest.fixture
def mock_mcp():
    """Create a mock MCP server for testing."""
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
def mock_ctx():
    """Create a mock MCP context."""
    return MagicMock(spec=Context)


@pytest.mark.asyncio
async def test_manage_project_update_sends_technical_sources(mock_mcp, mock_ctx):
    """When technical_sources is provided in update, it should be sent to the API."""
    register_project_tools(mock_mcp)

    manage_project = mock_mcp._tools.get("manage_project")
    assert manage_project is not None, "manage_project tool not registered"

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "project": {
            "id": "proj-123",
            "title": "Test Project",
            "technical_sources": ["src_001", "src_002"],
        },
        "message": "Project updated successfully",
    }

    with patch("src.mcp_server.features.projects.project_tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        MockClient.return_value.__aenter__.return_value = mock_client
        mock_client.put = AsyncMock(return_value=mock_response)

        result = await manage_project(
            mock_ctx,
            action="update",
            project_id="proj-123",
            technical_sources=["src_001", "src_002"],
        )

        result_data = json.loads(result)
        assert result_data["success"] is True

        # Verify the API call included technical_sources
        call_args = mock_client.put.call_args
        request_body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert "technical_sources" in request_body
        assert request_body["technical_sources"] == ["src_001", "src_002"]


@pytest.mark.asyncio
async def test_manage_project_update_sends_business_sources(mock_mcp, mock_ctx):
    """When business_sources is provided in update, it should be sent to the API."""
    register_project_tools(mock_mcp)

    manage_project = mock_mcp._tools.get("manage_project")
    assert manage_project is not None, "manage_project tool not registered"

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "project": {
            "id": "proj-123",
            "title": "Test Project",
            "business_sources": ["src_003"],
        },
        "message": "Project updated successfully",
    }

    with patch("src.mcp_server.features.projects.project_tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        MockClient.return_value.__aenter__.return_value = mock_client
        mock_client.put = AsyncMock(return_value=mock_response)

        result = await manage_project(
            mock_ctx,
            action="update",
            project_id="proj-123",
            business_sources=["src_003"],
        )

        result_data = json.loads(result)
        assert result_data["success"] is True

        # Verify the API call included business_sources
        call_args = mock_client.put.call_args
        request_body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert "business_sources" in request_body
        assert request_body["business_sources"] == ["src_003"]


@pytest.mark.asyncio
async def test_manage_project_update_omits_sources_when_not_provided(mock_mcp, mock_ctx):
    """When source params are not provided, they should not appear in the request body."""
    register_project_tools(mock_mcp)

    manage_project = mock_mcp._tools.get("manage_project")
    assert manage_project is not None, "manage_project tool not registered"

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "project": {
            "id": "proj-123",
            "title": "Updated Title",
        },
        "message": "Project updated successfully",
    }

    with patch("src.mcp_server.features.projects.project_tools.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        MockClient.return_value.__aenter__.return_value = mock_client
        mock_client.put = AsyncMock(return_value=mock_response)

        result = await manage_project(
            mock_ctx,
            action="update",
            project_id="proj-123",
            title="Updated Title",
        )

        result_data = json.loads(result)
        assert result_data["success"] is True

        # Verify source fields are NOT in the request body
        call_args = mock_client.put.call_args
        request_body = call_args.kwargs.get("json") or call_args[1].get("json")
        assert "technical_sources" not in request_body
        assert "business_sources" not in request_body
