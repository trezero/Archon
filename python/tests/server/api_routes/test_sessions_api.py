"""Unit tests for session memory API endpoints."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest


# ── POST /api/sessions ────────────────────────────────────────────────────────


def test_create_session_success():
    """POST /api/sessions with valid payload returns session data."""
    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.create_session.return_value = (True, {"session": {"session_id": "sess-1"}})

        from src.server.api_routes.sessions_api import create_session, CreateSessionRequest

        req = CreateSessionRequest(
            session_id="sess-1",
            machine_id="machine-abc",
            project_id=None,
            started_at="2026-03-05T10:00:00Z",
        )
        result = asyncio.run(create_session(req))

        instance.create_session.assert_called_once()
        assert result["session"]["session_id"] == "sess-1"


def test_create_session_service_error_raises_422():
    """POST /api/sessions when service returns failure raises HTTPException."""
    from fastapi import HTTPException

    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.create_session.return_value = (False, {"error": "machine_id is required"})

        from src.server.api_routes.sessions_api import create_session, CreateSessionRequest

        req = CreateSessionRequest(
            session_id="sess-1",
            machine_id="",
            project_id=None,
            started_at="2026-03-05T10:00:00Z",
        )
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(create_session(req))

        assert exc_info.value.status_code == 422


# ── GET /api/sessions (list) ──────────────────────────────────────────────────


def test_list_sessions_by_project():
    """GET /api/sessions?project_id=X returns session list."""
    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_sessions.return_value = (True, {"sessions": [{"session_id": "s1"}]})

        from src.server.api_routes.sessions_api import list_or_search_sessions

        result = asyncio.run(list_or_search_sessions(project_id="proj-1", machine_id=None, q=None, limit=10))

        instance.list_sessions.assert_called_once_with(project_id="proj-1", machine_id=None, limit=10)
        assert len(result["sessions"]) == 1


def test_list_sessions_no_filter():
    """GET /api/sessions without filters returns all sessions."""
    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_sessions.return_value = (True, {"sessions": []})

        from src.server.api_routes.sessions_api import list_or_search_sessions

        result = asyncio.run(list_or_search_sessions(project_id=None, machine_id=None, q=None, limit=10))

        instance.list_sessions.assert_called_once_with(project_id=None, machine_id=None, limit=10)
        assert result["sessions"] == []


# ── GET /api/sessions (search) ────────────────────────────────────────────────


def test_search_sessions_with_query():
    """GET /api/sessions?q=... calls search_sessions not list_sessions."""
    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.search_sessions.return_value = (True, {"sessions": [{"session_id": "s2"}]})

        from src.server.api_routes.sessions_api import list_or_search_sessions

        result = asyncio.run(list_or_search_sessions(project_id=None, machine_id=None, q="auth bug", limit=5))

        instance.search_sessions.assert_called_once_with(query="auth bug", project_id=None, limit=5)
        instance.list_sessions.assert_not_called()
        assert len(result["sessions"]) == 1


def test_search_sessions_service_error_raises_500():
    """Search failure raises HTTPException 500."""
    from fastapi import HTTPException

    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.search_sessions.return_value = (False, {"error": "DB error"})

        from src.server.api_routes.sessions_api import list_or_search_sessions

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(list_or_search_sessions(project_id=None, machine_id=None, q="something", limit=10))

        assert exc_info.value.status_code == 500


# ── GET /api/sessions/{session_id} ───────────────────────────────────────────


def test_get_session_success():
    """GET /api/sessions/{session_id} returns session with observations."""
    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.get_session.return_value = (
            True,
            {"session": {"session_id": "sess-1"}, "observations": []},
        )

        from src.server.api_routes.sessions_api import get_session

        result = asyncio.run(get_session("sess-1"))

        instance.get_session.assert_called_once_with("sess-1")
        assert result["session"]["session_id"] == "sess-1"
        assert result["observations"] == []


def test_get_session_not_found_raises_404():
    """GET /api/sessions/{session_id} for missing session raises 404."""
    from fastapi import HTTPException

    with patch("src.server.api_routes.sessions_api.SessionService") as MockSvc:
        instance = MockSvc.return_value
        instance.get_session.return_value = (False, {"error": "Session 'bad-id' not found"})

        from src.server.api_routes.sessions_api import get_session

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(get_session("bad-id"))

        assert exc_info.value.status_code == 404
