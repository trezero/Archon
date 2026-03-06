"""Tests for SessionService."""
from unittest.mock import MagicMock

import pytest

from src.server.services.sessions.session_service import SessionService


@pytest.fixture
def mock_supabase():
    client = MagicMock()

    def _table(name):
        builder = MagicMock(name=f"table({name})")
        for method in ("select", "insert", "update", "delete", "upsert"):
            getattr(builder, method).return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=[])
        return builder

    client.table.side_effect = _table
    return client


@pytest.fixture
def service(mock_supabase):
    return SessionService(supabase_client=mock_supabase)


def test_create_session_success(service, mock_supabase):
    """Creating a session with observations stores both."""
    session_row = {"id": "uuid-1", "session_id": "sess-1"}

    def _table(name):
        builder = MagicMock(name=f"table({name})")
        for method in ("select", "insert", "update", "delete", "upsert"):
            getattr(builder, method).return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=[session_row])
        return builder

    mock_supabase.table.side_effect = _table

    success, result = service.create_session(
        session_id="sess-1",
        machine_id="machine-abc",
        project_id="proj-1",
        started_at="2026-03-05T10:00:00Z",
        ended_at="2026-03-05T11:00:00Z",
        summary="Fixed a bug",
        observations=[
            {
                "type": "bugfix",
                "title": "Fixed null check",
                "content": "Added guard clause",
                "files": ["src/main.py"],
                "timestamp": "2026-03-05T10:30:00Z",
            }
        ],
    )

    assert success is True
    assert "session" in result


def test_create_session_missing_session_id(service):
    """session_id is required."""
    success, result = service.create_session(
        session_id="",
        machine_id="m",
        project_id="p",
        started_at="2026-03-05T10:00:00Z",
    )
    assert success is False
    assert "error" in result


def test_create_session_missing_machine_id(service):
    """machine_id is required."""
    success, result = service.create_session(
        session_id="sess-1",
        machine_id="",
        project_id="p",
        started_at="2026-03-05T10:00:00Z",
    )
    assert success is False
    assert "error" in result


def test_list_sessions_by_project(service, mock_supabase):
    """List sessions filtered by project_id."""
    success, result = service.list_sessions(project_id="proj-1", limit=5)
    assert success is True
    assert "sessions" in result


def test_list_sessions_by_machine(service, mock_supabase):
    """List sessions filtered by machine_id."""
    success, result = service.list_sessions(machine_id="m1", limit=5)
    assert success is True
    assert "sessions" in result


def test_list_sessions_no_filter(service, mock_supabase):
    """List sessions with no filter returns recent sessions."""
    success, result = service.list_sessions(limit=10)
    assert success is True
    assert "sessions" in result


def test_get_session_with_observations(service, mock_supabase):
    """Get a single session with its observations."""
    session_row = {"id": "uuid-1", "session_id": "sess-1", "summary": "Did stuff"}
    obs_rows = [{"id": "obs-1", "session_id": "sess-1", "title": "Fixed bug"}]

    call_count = [0]

    def _table(name):
        builder = MagicMock(name=f"table({name})")
        for method in ("select", "insert", "update", "delete", "upsert"):
            getattr(builder, method).return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        call_count[0] += 1
        if call_count[0] == 1:
            builder.execute.return_value = MagicMock(data=[session_row])
        else:
            builder.execute.return_value = MagicMock(data=obs_rows)
        return builder

    mock_supabase.table.side_effect = _table

    success, result = service.get_session("sess-1")
    assert success is True
    assert "session" in result


def test_get_session_not_found(service, mock_supabase):
    """Getting a session that doesn't exist returns error."""
    success, result = service.get_session("nonexistent")
    assert success is False
    assert "error" in result


def test_search_sessions_full_text(service, mock_supabase):
    """Search sessions by full-text query."""
    mock_supabase.rpc.return_value.execute.return_value = MagicMock(data=[])

    success, result = service.search_sessions(query="authentication", project_id="proj-1")
    assert success is True
    assert "sessions" in result


def test_search_sessions_empty_query(service):
    """Empty query string returns error."""
    success, result = service.search_sessions(query="")
    assert success is False
    assert "error" in result
