"""UI channel — dispatches approval events via SSE."""

from src.server.config.logfire_config import get_logger
from src.server.services.workflow.hitl_models import ApprovalContext

logger = get_logger(__name__)


class UIChannel:
    def __init__(self, state_service):
        self._state_service = state_service

    async def send_approval_request(self, context: ApprovalContext) -> None:
        await self._state_service.fire_sse_event(
            context.workflow_run_id,
            "approval_requested",
            {
                "approval_id": context.approval_id,
                "node_id": context.workflow_node_id,
                "yaml_node_id": context.yaml_node_id,
                "approval_type": context.approval_type,
                "summary": context.node_output[:200],
            },
        )

    async def notify_resolution(
        self, context: ApprovalContext, decision: str, resolved_by: str
    ) -> None:
        await self._state_service.fire_sse_event(
            context.workflow_run_id,
            "approval_resolved",
            {
                "approval_id": context.approval_id,
                "decision": decision,
                "resolved_by": resolved_by,
                "resolved_via": "ui",
            },
        )
