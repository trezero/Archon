"""Tests for HITLRouter."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.workflow.hitl_router import HITLRouter


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def mock_state_service():
    svc = AsyncMock()
    svc.fire_sse_event = AsyncMock()
    return svc


@pytest.fixture
def router(mock_state_service, mock_supabase):
    return HITLRouter(state_service=mock_state_service, supabase_client=mock_supabase)


class TestHandleApprovalRequest:
    @pytest.mark.asyncio
    async def test_creates_approval_and_dispatches_ui(self, router, mock_supabase, mock_state_service):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "apr_1", "workflow_run_id": "wr_1"}
        ]
        with patch.object(router._a2ui_service, "generate_approval_components", new_callable=AsyncMock) as mock_a2ui:
            mock_a2ui.return_value = [{"type": "a2ui.StatCard", "id": "s1", "props": {}}]
            success, result = await router.handle_approval_request(
                workflow_run_id="wr_1",
                workflow_node_id="n_1",
                yaml_node_id="plan-review",
                approval_type="plan_review",
                node_output="## Plan\n\nDo things",
                channels=["ui"],
            )
        assert success is True
        assert result["approval_id"] == "apr_1"
        mock_state_service.fire_sse_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_false_on_insert_failure(self, router, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = []
        with patch.object(router._a2ui_service, "generate_approval_components", new_callable=AsyncMock) as mock_a2ui:
            mock_a2ui.return_value = None
            success, result = await router.handle_approval_request(
                workflow_run_id="wr_1",
                workflow_node_id="n_1",
                yaml_node_id="plan-review",
                approval_type="plan_review",
                node_output="output",
                channels=["ui"],
            )
        assert success is False
        assert "error" in result

    @pytest.mark.asyncio
    async def test_dispatches_to_telegram_when_configured(self, router, mock_supabase, mock_state_service):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "apr_2", "workflow_run_id": "wr_2"}
        ]
        with (
            patch.object(router._a2ui_service, "generate_approval_components", new_callable=AsyncMock) as mock_a2ui,
            patch.object(router._telegram_channel, "send_approval_request", new_callable=AsyncMock) as mock_tg,
        ):
            mock_a2ui.return_value = None
            success, result = await router.handle_approval_request(
                workflow_run_id="wr_2",
                workflow_node_id="n_2",
                yaml_node_id="code-review",
                approval_type="code_review",
                node_output="review this",
                channels=["ui", "telegram"],
            )
        assert success is True
        mock_state_service.fire_sse_event.assert_called_once()
        mock_tg.assert_called_once()


class TestHandleResolution:
    @pytest.mark.asyncio
    async def test_notifies_ui_channel_on_resolution(self, router, mock_supabase, mock_state_service):
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {
                "id": "apr_1",
                "workflow_run_id": "wr_1",
                "workflow_node_id": "n_1",
                "yaml_node_id": "plan-review",
                "approval_type": "plan_review",
                "channels_notified": ["ui"],
            }
        ]
        await router.handle_resolution(approval_id="apr_1", decision="approved", resolved_by="user@test.com")
        mock_state_service.fire_sse_event.assert_called_once()
        call_args = mock_state_service.fire_sse_event.call_args
        assert call_args[0][0] == "wr_1"
        assert call_args[0][1] == "approval_resolved"
        assert call_args[0][2]["decision"] == "approved"

    @pytest.mark.asyncio
    async def test_no_op_when_approval_not_found(self, router, mock_supabase, mock_state_service):
        mock_supabase.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        await router.handle_resolution(approval_id="missing", decision="approved", resolved_by="user@test.com")
        mock_state_service.fire_sse_event.assert_not_called()
