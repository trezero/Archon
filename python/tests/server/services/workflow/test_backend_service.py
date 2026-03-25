"""Tests for BackendService."""

import hashlib
from unittest.mock import MagicMock, patch

import pytest

from src.server.services.workflow.backend_service import BackendService


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    return BackendService(supabase_client=mock_supabase)


class TestRegisterBackend:
    def test_register_returns_token(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "be_abc", "name": "test-agent", "base_url": "http://agent:3000"}
        ]
        success, result = service.register_backend(
            name="test-agent",
            base_url="http://agent:3000",
            project_id=None,
        )
        assert success is True
        assert "backend_id" in result
        assert "auth_token" in result
        assert len(result["auth_token"]) > 20

    def test_register_stores_hashed_token(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "be_abc", "name": "test-agent", "base_url": "http://agent:3000"}
        ]
        service.register_backend(name="test-agent", base_url="http://agent:3000")
        insert_call = mock_supabase.table.return_value.insert.call_args[0][0]
        assert "auth_token_hash" in insert_call
        assert insert_call["auth_token_hash"] != insert_call.get("auth_token", "")


class TestVerifyToken:
    def test_valid_token(self, service, mock_supabase):
        token = "test_token_123"
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"id": "be_abc", "name": "test-agent", "auth_token_hash": token_hash, "status": "healthy"}
        ]
        success, result = service.verify_token(token)
        assert success is True
        assert result["backend_id"] == "be_abc"

    def test_invalid_token(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        success, result = service.verify_token("bad_token")
        assert success is False


class TestHeartbeat:
    def test_record_heartbeat(self, service, mock_supabase):
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [
            {"id": "be_abc", "status": "healthy"}
        ]
        success, result = service.record_heartbeat("be_abc")
        assert success is True


class TestResolveBackend:
    def test_resolve_by_project(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
            {"id": "be_abc", "base_url": "http://agent:3000", "status": "healthy"}
        ]
        success, result = service.resolve_backend_for_project("proj_xyz")
        assert success is True
        assert result["backend"]["id"] == "be_abc"

    def test_resolve_default_when_no_project_match(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.select.return_value.is_.return_value.eq.return_value.execute.return_value.data = [
            {"id": "be_default", "base_url": "http://default:3000", "status": "healthy"}
        ]
        success, result = service.resolve_backend_for_project("proj_xyz")
        assert success is True
        assert result["backend"]["id"] == "be_default"

    def test_no_backends_returns_error(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
        mock_supabase.table.return_value.select.return_value.is_.return_value.eq.return_value.execute.return_value.data = []
        success, result = service.resolve_backend_for_project("proj_xyz")
        assert success is False
        assert "error" in result
