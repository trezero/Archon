"""Tests for Postman MCP tools."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def mock_httpx_client():
    """Mock httpx.AsyncClient for MCP tool tests."""
    with patch("src.mcp_server.features.postman.postman_tools.httpx.AsyncClient") as mock:
        client_instance = AsyncMock()
        mock.return_value.__aenter__ = AsyncMock(return_value=client_instance)
        mock.return_value.__aexit__ = AsyncMock(return_value=False)
        yield client_instance


def _register_and_capture_tools():
    """Register tools and capture references to the tool functions."""
    from src.mcp_server.features.postman.postman_tools import register_postman_tools

    mcp = MagicMock()
    tools = {}

    def capture_tool():
        def decorator(func):
            tools[func.__name__] = func
            return func
        return decorator

    mcp.tool = capture_tool
    register_postman_tools(mcp)
    return tools


class TestFindPostman:
    @pytest.mark.anyio
    async def test_returns_sync_mode(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "git", "configured": False},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["find_postman"](ctx)
        data = json.loads(result)
        assert data["sync_mode"] == "git"
        assert data["success"] is True

    @pytest.mark.anyio
    async def test_returns_message_for_non_api_mode_with_project_id(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "git"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["find_postman"](ctx, project_id="proj-123")
        data = json.loads(result)
        assert data["sync_mode"] == "git"
        assert "only available in api mode" in data["message"]

    @pytest.mark.anyio
    async def test_returns_error_on_status_failure(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=500,
            json=lambda: {"detail": "Server error"},
            text="Internal Server Error",
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["find_postman"](ctx)
        data = json.loads(result)
        assert data["success"] is False


class TestManagePostman:
    @pytest.mark.anyio
    async def test_skips_when_not_api_mode(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "git"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["manage_postman"](ctx, action="add_request", folder_name="Test", request={"name": "test"})
        data = json.loads(result)
        assert data["status"] == "skipped"
        assert "git" in data["reason"]

    @pytest.mark.anyio
    async def test_unknown_action_returns_error(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "api"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["manage_postman"](ctx, action="invalid_action")
        data = json.loads(result)
        assert data["success"] is False
        assert "Unknown action" in data["error"]["message"]

    @pytest.mark.anyio
    async def test_init_collection_requires_project_name(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "api"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["manage_postman"](ctx, action="init_collection")
        data = json.loads(result)
        assert data["success"] is False
        assert "project_name" in data["error"]["message"]

    @pytest.mark.anyio
    async def test_add_request_requires_folder_and_request(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "api"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["manage_postman"](ctx, action="add_request")
        data = json.loads(result)
        assert data["success"] is False
        assert "folder_name" in data["error"]["message"]

    @pytest.mark.anyio
    async def test_import_from_git_not_blocked_by_mode(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "git"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["manage_postman"](ctx, action="import_from_git")
        data = json.loads(result)
        assert data["success"] is True
        assert "import_from_git" in data["message"]

    @pytest.mark.anyio
    async def test_export_to_git_not_blocked_by_mode(self, mock_httpx_client):
        mock_httpx_client.get = AsyncMock(return_value=MagicMock(
            status_code=200,
            json=lambda: {"sync_mode": "git"},
        ))

        tools = _register_and_capture_tools()
        ctx = MagicMock()
        result = await tools["manage_postman"](ctx, action="export_to_git")
        data = json.loads(result)
        assert data["success"] is True
        assert "export_to_git" in data["message"]
