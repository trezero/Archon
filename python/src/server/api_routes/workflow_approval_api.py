"""Approval management endpoints.

Stub for Phase 1 -- full HITL with A2UI rendering and Telegram
integration ships in Phase 2.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config.logfire_config import get_logger
from ..utils import get_supabase_client

logger = get_logger(__name__)

router = APIRouter(prefix="/api/workflows", tags=["workflow-approvals"])


class ResolveApprovalRequest(BaseModel):
    decision: str = Field(..., description="'approved' or 'rejected'")
    comment: str | None = Field(None, description="Optional comment")
    resolved_by: str | None = Field(None, description="Who resolved")


@router.get("/approvals")
async def list_approvals(status: str | None = "pending"):
    try:
        client = get_supabase_client()
        query = client.table("approval_requests").select("*")
        if status:
            query = query.eq("status", status)
        response = query.order("created_at", desc=True).execute()
        return response.data or []
    except Exception as e:
        logger.error(f"Error listing approvals: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/approvals/{approval_id}")
async def get_approval(approval_id: str):
    try:
        client = get_supabase_client()
        response = client.table("approval_requests").select("*").eq("id", approval_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail={"error": "Approval not found"})
        return response.data[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting approval: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/approvals/{approval_id}/resolve")
async def resolve_approval(approval_id: str, request: ResolveApprovalRequest):
    """Resolve an approval. Phase 1: updates DB + transitions node state.
    Phase 2 will add: resume signal to remote-agent, Telegram message edit, A2UI."""
    try:
        client = get_supabase_client()
        from datetime import UTC, datetime

        response = client.table("approval_requests").update({
            "status": request.decision,
            "resolved_by": request.resolved_by or "user",
            "resolved_via": "ui",
            "resolved_comment": request.comment,
            "resolved_at": datetime.now(UTC).isoformat(),
        }).eq("id", approval_id).eq("status", "pending").execute()

        if not response.data:
            raise HTTPException(status_code=404, detail={"error": "Approval not found or already resolved"})

        approval = response.data[0]

        # Update the workflow node state based on decision
        from .workflow_backend_api import get_state_service
        state_service = get_state_service()
        node_state = "completed" if request.decision == "approved" else "failed"
        await state_service.process_node_state(
            node_id=approval["workflow_node_id"],
            state=node_state,
            output=f"Approval {request.decision}" + (f": {request.comment}" if request.comment else ""),
        )

        # Fire SSE event for approval resolution
        await state_service.fire_sse_event(approval["workflow_run_id"], "approval_resolved", {
            "approval_id": approval_id,
            "decision": request.decision,
            "resolved_by": request.resolved_by or "user",
            "resolved_via": "ui",
        })

        # TODO Phase 2: Send resume signal to remote-agent
        # TODO Phase 2: Edit Telegram message with resolution status

        return {"resolved": True, "decision": request.decision}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error resolving approval: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})
