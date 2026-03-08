"""LeaveOff Point API — per-project session continuity state."""

from fastapi import APIRouter, HTTPException

from ..config.logfire_config import get_logger
from ..models.leaveoff import UpsertLeaveOffRequest
from ..services.leaveoff.leaveoff_service import LeaveOffService
from ..utils import get_supabase_client

logger = get_logger(__name__)

router = APIRouter(prefix="/api/projects", tags=["leaveoff"])


@router.put("/{project_id}/leaveoff")
async def upsert_leaveoff(project_id: str, request: UpsertLeaveOffRequest) -> dict:
    service = LeaveOffService(supabase_client=get_supabase_client())
    record = await service.upsert(
        project_id=project_id,
        content=request.content,
        next_steps=request.next_steps,
        component=request.component,
        references=request.references,
        machine_id=request.machine_id,
        last_session_id=request.last_session_id,
        metadata=request.metadata,
    )
    return record


@router.get("/{project_id}/leaveoff")
async def get_leaveoff(project_id: str) -> dict:
    service = LeaveOffService(supabase_client=get_supabase_client())
    record = await service.get(project_id)
    if not record:
        raise HTTPException(status_code=404, detail="No LeaveOff point found for this project")
    return record


@router.delete("/{project_id}/leaveoff")
async def delete_leaveoff(project_id: str) -> dict:
    service = LeaveOffService(supabase_client=get_supabase_client())
    deleted = await service.delete(project_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="No LeaveOff point found for this project")
    return {"success": True}
