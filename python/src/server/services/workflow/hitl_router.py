"""HITL Router — channel-agnostic approval dispatch.

Generates A2UI payload, creates the approval_request record,
and dispatches to all configured channels.
"""

from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger
from ..generative_ui.a2ui_service import A2UIService
from .hitl_channels.telegram_channel import TelegramChannel
from .hitl_channels.ui_channel import UIChannel
from .hitl_models import ApprovalContext

logger = get_logger(__name__)


class HITLRouter:
    def __init__(self, state_service, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()
        self._ui_channel = UIChannel(state_service)
        self._telegram_channel = TelegramChannel()
        self._a2ui_service = A2UIService()

    async def handle_approval_request(
        self,
        workflow_run_id: str,
        workflow_node_id: str,
        yaml_node_id: str,
        approval_type: str,
        node_output: str,
        channels: list[str],
    ) -> tuple[bool, dict[str, Any]]:
        """Create approval record, generate A2UI payload, dispatch to channels."""
        try:
            # Generate A2UI payload
            a2ui_payload = await self._a2ui_service.generate_approval_components(
                node_output,
                approval_type,
            )

            # Create approval_request record
            data = {
                "workflow_run_id": workflow_run_id,
                "workflow_node_id": workflow_node_id,
                "yaml_node_id": yaml_node_id,
                "approval_type": approval_type,
                "payload": {"components": a2ui_payload} if a2ui_payload else {"raw_output": node_output},
                "status": "pending",
                "channels_notified": channels,
            }
            response = self.supabase_client.table("approval_requests").insert(data).execute()
            if not response.data:
                return False, {"error": "Failed to create approval request"}

            approval = response.data[0]
            approval_id = approval["id"]

            # Build context for channels
            context = ApprovalContext(
                approval_id=approval_id,
                workflow_run_id=workflow_run_id,
                workflow_node_id=workflow_node_id,
                yaml_node_id=yaml_node_id,
                approval_type=approval_type,
                node_output=node_output,
                a2ui_payload=a2ui_payload,
                channels=channels,
            )

            # Dispatch to channels
            if "ui" in channels:
                await self._ui_channel.send_approval_request(context)
            if "telegram" in channels:
                await self._telegram_channel.send_approval_request(context)

            return True, {"approval_id": approval_id}
        except Exception as e:
            logger.error(f"Error handling approval request: {e}", exc_info=True)
            return False, {"error": str(e)}

    async def handle_resolution(
        self,
        approval_id: str,
        decision: str,
        resolved_by: str,
    ) -> None:
        """Notify channels of approval resolution."""
        try:
            response = (
                self.supabase_client.table("approval_requests")
                .select("*")
                .eq("id", approval_id)
                .execute()
            )
            if not response.data:
                return

            approval = response.data[0]
            context = ApprovalContext(
                approval_id=approval_id,
                workflow_run_id=approval["workflow_run_id"],
                workflow_node_id=approval["workflow_node_id"],
                yaml_node_id=approval["yaml_node_id"],
                approval_type=approval["approval_type"],
                node_output="",
                channels=approval.get("channels_notified", ["ui"]),
            )

            if "ui" in context.channels:
                await self._ui_channel.notify_resolution(context, decision, resolved_by)
            if "telegram" in context.channels:
                await self._telegram_channel.notify_resolution(context, decision, resolved_by)
        except Exception as e:
            logger.error(f"Error notifying resolution: {e}", exc_info=True)
