"""Tests for the archon-setup download endpoints."""
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient


@pytest.fixture
def mcp_test_client():
    """TestClient using the FastMCP app directly."""
    with patch.dict("os.environ", {"ARCHON_MCP_PORT": "8051"}):
        from src.mcp_server.mcp_server import mcp
        return TestClient(mcp.streamable_http_app())


def test_archon_setup_sh_returns_200(mcp_test_client):
    with patch("src.mcp_server.mcp_server._render_setup_sh", return_value="#!/bin/bash\nARCHON_SERVER=http://test"):
        response = mcp_test_client.get("/archon-setup.sh")
        assert response.status_code == 200


def test_archon_setup_sh_content_type_is_plain_text(mcp_test_client):
    with patch("src.mcp_server.mcp_server._render_setup_sh", return_value="#!/bin/bash\nARCHON_SERVER=http://test"):
        response = mcp_test_client.get("/archon-setup.sh")
        assert response.headers["content-type"].startswith("text/plain")


def test_archon_setup_bat_returns_200(mcp_test_client):
    with patch("src.mcp_server.mcp_server._render_setup_bat", return_value="@echo off\nset ARCHON_SERVER=http://test"):
        response = mcp_test_client.get("/archon-setup.bat")
        assert response.status_code == 200


def test_archon_setup_md_returns_200(mcp_test_client):
    with patch("src.mcp_server.mcp_server._render_setup_md", return_value="# Archon Setup\n\narchon-setup content"):
        response = mcp_test_client.get("/archon-setup.md")
        assert response.status_code == 200


def test_archon_setup_sh_contains_server_url(mcp_test_client):
    with patch("src.mcp_server.mcp_server._render_setup_sh", return_value="#!/bin/bash\nARCHON_SERVER=http://testserver"):
        response = mcp_test_client.get("/archon-setup.sh")
        assert "ARCHON_SERVER=" in response.text
