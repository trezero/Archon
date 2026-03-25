"""State tracking service for workflow execution.

Processes REST callbacks from the remote-agent, updates Supabase,
and fans out SSE events to subscribed UI clients.
"""

import asyncio
from datetime import UTC, datetime
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class StateService:
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()
        self._sse_queues: dict[str, list[asyncio.Queue]] = {}

    # -- SSE subscription management --

    def subscribe_to_run(self, run_id: str) -> asyncio.Queue:
        """Create a queue for SSE events for a specific workflow run."""
        queue: asyncio.Queue = asyncio.Queue()
        if run_id not in self._sse_queues:
            self._sse_queues[run_id] = []
        self._sse_queues[run_id].append(queue)
        logger.info(f"SSE subscriber added for run {run_id} (total: {len(self._sse_queues[run_id])})")
        return queue

    def unsubscribe_from_run(self, run_id: str, queue: asyncio.Queue) -> None:
        """Remove a queue when the SSE client disconnects."""
        if run_id in self._sse_queues:
            try:
                self._sse_queues[run_id].remove(queue)
            except ValueError:
                pass
            if not self._sse_queues[run_id]:
                del self._sse_queues[run_id]
            logger.info(f"SSE subscriber removed for run {run_id}")

    async def fire_sse_event(self, run_id: str, event_type: str, data: dict[str, Any]) -> None:
        """Push an event to all subscribers for a given run."""
        queues = self._sse_queues.get(run_id, [])
        event = {"type": event_type, "data": data}
        for queue in queues:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                logger.warning(f"SSE queue full for run {run_id}, dropping event")

    # -- Callback processing --

    async def process_node_state(
        self,
        node_id: str,
        state: str,
        output: str | None,
        error: str | None = None,
        session_id: str | None = None,
        duration_seconds: float | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Process a node state callback from the remote-agent."""
        try:
            # Get current node to find run_id and previous state
            node_response = (
                self.supabase_client.table("workflow_nodes")
                .select("id, workflow_run_id, node_id, state")
                .eq("id", node_id)
                .execute()
            )
            if not node_response.data:
                return False, {"error": f"Node {node_id} not found"}

            node = node_response.data[0]
            previous_state = node["state"]
            run_id = node["workflow_run_id"]

            # Build update payload
            update_data: dict[str, Any] = {"state": state}
            if output is not None:
                update_data["output"] = output
            if error is not None:
                update_data["error"] = error
            if session_id is not None:
                update_data["session_id"] = session_id
            if state == "running" and not node.get("started_at"):
                update_data["started_at"] = datetime.now(UTC).isoformat()
            if state in ("completed", "failed", "skipped", "cancelled"):
                update_data["completed_at"] = datetime.now(UTC).isoformat()

            # Update node
            self.supabase_client.table("workflow_nodes").update(update_data).eq("id", node_id).execute()

            # Update run status based on node states
            await self._update_run_status(run_id)

            # Fire SSE event
            await self.fire_sse_event(run_id, "node_state_changed", {
                "node_id": node_id,
                "yaml_node_id": node["node_id"],
                "previous_state": previous_state,
                "new_state": state,
                "output": output,
            })

            return True, {"node_id": node_id, "state": state}
        except Exception as e:
            logger.error(f"Error processing node state for {node_id}: {e}", exc_info=True)
            return False, {"error": f"Failed to process node state: {str(e)}"}

    async def process_node_progress(self, node_id: str, message: str) -> tuple[bool, dict[str, Any]]:
        """Process a progress update from the remote-agent."""
        try:
            node_response = (
                self.supabase_client.table("workflow_nodes")
                .select("id, workflow_run_id, node_id")
                .eq("id", node_id)
                .execute()
            )
            if not node_response.data:
                return False, {"error": f"Node {node_id} not found"}

            node = node_response.data[0]
            await self.fire_sse_event(node["workflow_run_id"], "node_progress", {
                "node_id": node_id,
                "yaml_node_id": node["node_id"],
                "message": message,
            })
            return True, {"accepted": True}
        except Exception as e:
            logger.error(f"Error processing progress for {node_id}: {e}")
            return False, {"error": str(e)}

    async def process_run_complete(
        self,
        run_id: str,
        status: str,
        summary: str | None = None,
        node_outputs: dict[str, str] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Process a workflow completion callback."""
        try:
            update_data: dict[str, Any] = {
                "status": status,
                "completed_at": datetime.now(UTC).isoformat(),
            }
            if summary:
                update_data["trigger_context"] = (
                    self.supabase_client.table("workflow_runs")
                    .select("trigger_context")
                    .eq("id", run_id)
                    .execute()
                    .data[0].get("trigger_context", {})
                )
                update_data["trigger_context"]["summary"] = summary

            self.supabase_client.table("workflow_runs").update(update_data).eq("id", run_id).execute()

            await self.fire_sse_event(run_id, "run_status_changed", {
                "status": status,
                "summary": summary,
            })

            return True, {"run_id": run_id, "status": status}
        except Exception as e:
            logger.error(f"Error processing run completion for {run_id}: {e}", exc_info=True)
            return False, {"error": str(e)}

    async def _update_run_status(self, run_id: str) -> None:
        """Derive run status from the aggregate state of all nodes."""
        try:
            nodes_response = (
                self.supabase_client.table("workflow_nodes")
                .select("state")
                .eq("workflow_run_id", run_id)
                .execute()
            )
            if not nodes_response.data:
                return

            states = [n["state"] for n in nodes_response.data]

            # Determine run status from node states
            if any(s == "waiting_approval" for s in states):
                new_status = "paused"
            elif any(s == "running" for s in states):
                new_status = "running"
            elif all(s in ("completed", "skipped") for s in states):
                new_status = "completed"
            elif any(s == "failed" for s in states) and not any(s in ("running", "pending") for s in states):
                new_status = "failed"
            elif any(s == "cancelled" for s in states):
                new_status = "cancelled"
            else:
                return  # No status change needed

            # Get current status to check if changed
            run_response = (
                self.supabase_client.table("workflow_runs")
                .select("status")
                .eq("id", run_id)
                .execute()
            )
            if run_response.data and run_response.data[0]["status"] != new_status:
                previous = run_response.data[0]["status"]
                update_data: dict[str, Any] = {"status": new_status}
                if new_status == "running" and previous in ("pending", "dispatched"):
                    update_data["started_at"] = datetime.now(UTC).isoformat()
                if new_status in ("completed", "failed", "cancelled"):
                    update_data["completed_at"] = datetime.now(UTC).isoformat()

                self.supabase_client.table("workflow_runs").update(update_data).eq("id", run_id).execute()

                await self.fire_sse_event(run_id, "run_status_changed", {
                    "status": new_status,
                    "previous_status": previous,
                })
        except Exception as e:
            logger.error(f"Error updating run status for {run_id}: {e}", exc_info=True)
