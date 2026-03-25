"""Tests for StateService."""

import asyncio
from unittest.mock import MagicMock

import pytest

from src.server.services.workflow.state_service import StateService


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    return StateService(supabase_client=mock_supabase)


class TestProcessNodeState:
    @pytest.mark.asyncio
    async def test_update_node_to_running(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"id": "n1", "workflow_run_id": "wr1", "node_id": "step-one", "state": "pending"}
        ]
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [
            {"id": "n1", "state": "running"}
        ]
        success, result = await service.process_node_state(
            node_id="n1", state="running", output=None, session_id=None, duration_seconds=None,
        )
        assert success is True

    @pytest.mark.asyncio
    async def test_completed_node_stores_output(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"id": "n1", "workflow_run_id": "wr1", "node_id": "step-one", "state": "running"}
        ]
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [
            {"id": "n1", "state": "completed", "output": "feat/branch"}
        ]
        success, result = await service.process_node_state(
            node_id="n1", state="completed", output="feat/branch", session_id="sess_1", duration_seconds=12.5,
        )
        assert success is True
        update_data = mock_supabase.table.return_value.update.call_args[0][0]
        assert update_data["output"] == "feat/branch"
        assert update_data["session_id"] == "sess_1"


class TestSSESubscription:
    def test_subscribe_creates_queue(self, service):
        queue = service.subscribe_to_run("wr1")
        assert isinstance(queue, asyncio.Queue)

    def test_unsubscribe_removes_queue(self, service):
        queue = service.subscribe_to_run("wr1")
        service.unsubscribe_from_run("wr1", queue)
        assert "wr1" not in service._sse_queues or queue not in service._sse_queues.get("wr1", [])

    @pytest.mark.asyncio
    async def test_fire_event_reaches_subscriber(self, service):
        queue = service.subscribe_to_run("wr1")
        await service.fire_sse_event("wr1", "node_state_changed", {"node_id": "n1", "state": "running"})
        event = queue.get_nowait()
        assert event["type"] == "node_state_changed"
        assert event["data"]["node_id"] == "n1"

    @pytest.mark.asyncio
    async def test_fire_event_no_subscribers_is_safe(self, service):
        # Should not raise
        await service.fire_sse_event("nonexistent", "test", {})
