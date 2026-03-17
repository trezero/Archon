"""Unit tests for LeaveOff Point API endpoints."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

# ── PUT /api/projects/{project_id}/leaveoff ──────────────────────────────────


def test_upsert_leaveoff():
    """PUT /api/projects/{id}/leaveoff creates or replaces the LeaveOff point."""
    fake_row = {
        "id": "lp-1",
        "project_id": "proj-1",
        "content": "Working on auth flow",
        "next_steps": ["finish login", "add tests"],
        "component": "auth",
        "references": ["/src/auth.py"],
        "machine_id": "machine-abc",
        "last_session_id": "sess-1",
        "metadata": {},
        "updated_at": "2026-03-08T00:00:00+00:00",
    }

    with patch("src.server.api_routes.leaveoff_api.LeaveOffService") as MockSvc:
        instance = MockSvc.return_value
        instance.upsert = AsyncMock(return_value=fake_row)

        with patch("src.server.api_routes.leaveoff_api.get_supabase_client"):
            from src.server.api_routes.leaveoff_api import upsert_leaveoff
            from src.server.models.leaveoff import UpsertLeaveOffRequest

            req = UpsertLeaveOffRequest(
                content="Working on auth flow",
                next_steps=["finish login", "add tests"],
                component="auth",
                references=["/src/auth.py"],
                machine_id="machine-abc",
                last_session_id="sess-1",
            )
            result = asyncio.run(upsert_leaveoff("proj-1", req))

        assert result["project_id"] == "proj-1"
        assert result["content"] == "Working on auth flow"
        assert result["next_steps"] == ["finish login", "add tests"]
        assert result["component"] == "auth"
        instance.upsert.assert_called_once_with(
            project_id="proj-1",
            content="Working on auth flow",
            next_steps=["finish login", "add tests"],
            component="auth",
            references=["/src/auth.py"],
            machine_id="machine-abc",
            system_name=None,
            git_clean=None,
            last_session_id="sess-1",
            metadata=None,
            project_path=None,
        )


# ── GET /api/projects/{project_id}/leaveoff ──────────────────────────────────


def test_get_leaveoff():
    """GET /api/projects/{id}/leaveoff returns the LeaveOff point when it exists."""
    fake_row = {
        "id": "lp-1",
        "project_id": "proj-1",
        "content": "Left off debugging",
        "next_steps": ["check logs"],
        "component": None,
        "references": [],
        "machine_id": None,
        "last_session_id": None,
        "metadata": {},
        "updated_at": "2026-03-08T00:00:00+00:00",
    }

    with patch("src.server.api_routes.leaveoff_api.LeaveOffService") as MockSvc:
        instance = MockSvc.return_value
        instance.get = AsyncMock(return_value=fake_row)

        with patch("src.server.api_routes.leaveoff_api.get_supabase_client"):
            from src.server.api_routes.leaveoff_api import get_leaveoff

            result = asyncio.run(get_leaveoff("proj-1"))

        assert result["project_id"] == "proj-1"
        assert result["content"] == "Left off debugging"
        instance.get.assert_called_once_with("proj-1")


def test_get_leaveoff_not_found():
    """GET /api/projects/{id}/leaveoff returns 404 when no LeaveOff point exists."""
    from fastapi import HTTPException

    with patch("src.server.api_routes.leaveoff_api.LeaveOffService") as MockSvc:
        instance = MockSvc.return_value
        instance.get = AsyncMock(return_value=None)

        with patch("src.server.api_routes.leaveoff_api.get_supabase_client"):
            from src.server.api_routes.leaveoff_api import get_leaveoff

            with pytest.raises(HTTPException) as exc_info:
                asyncio.run(get_leaveoff("proj-nonexistent"))

        assert exc_info.value.status_code == 404


# ── DELETE /api/projects/{project_id}/leaveoff ───────────────────────────────


def test_delete_leaveoff():
    """DELETE /api/projects/{id}/leaveoff returns success when record is deleted."""
    with patch("src.server.api_routes.leaveoff_api.LeaveOffService") as MockSvc:
        instance = MockSvc.return_value
        instance.delete = AsyncMock(return_value=True)

        with patch("src.server.api_routes.leaveoff_api.get_supabase_client"):
            from src.server.api_routes.leaveoff_api import delete_leaveoff

            result = asyncio.run(delete_leaveoff("proj-1"))

        assert result["success"] is True
        instance.delete.assert_called_once_with("proj-1")


def test_delete_leaveoff_not_found():
    """DELETE /api/projects/{id}/leaveoff returns 404 when no record exists."""
    from fastapi import HTTPException

    with patch("src.server.api_routes.leaveoff_api.LeaveOffService") as MockSvc:
        instance = MockSvc.return_value
        instance.delete = AsyncMock(return_value=False)

        with patch("src.server.api_routes.leaveoff_api.get_supabase_client"):
            from src.server.api_routes.leaveoff_api import delete_leaveoff

            with pytest.raises(HTTPException) as exc_info:
                asyncio.run(delete_leaveoff("proj-nonexistent"))

        assert exc_info.value.status_code == 404
