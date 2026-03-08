"""Materialization API — endpoints for knowledge materialization."""

import uuid

from fastapi import APIRouter, HTTPException

from ..config.logfire_config import get_logger
from ..models.materialization import MaterializationRequest
from ..services.knowledge.materialization_service import MaterializationService
from ..utils import get_supabase_client

logger = get_logger(__name__)

router = APIRouter(prefix="/api/materialization", tags=["materialization"])


@router.post("/execute")
async def execute_materialization(request: MaterializationRequest) -> dict:
    """Execute a knowledge materialization pipeline for the given topic and project."""
    progress_id = str(uuid.uuid4())
    service = MaterializationService(supabase_client=get_supabase_client())
    result = await service.materialize(
        topic=request.topic,
        project_id=request.project_id,
        project_path=request.project_path,
        progress_id=progress_id,
        agent_context=request.agent_context,
    )
    return {
        "success": result.success,
        "progress_id": progress_id,
        "materialization_id": result.materialization_id,
        "file_path": result.file_path,
        "filename": result.filename,
        "word_count": result.word_count,
        "summary": result.summary,
        "reason": result.reason,
    }


@router.get("/history")
async def list_materializations(project_id: str | None = None, status: str | None = None) -> dict:
    """List materialization records, optionally filtered by project and/or status."""
    service = MaterializationService(supabase_client=get_supabase_client())
    records = await service.list_materializations(project_id=project_id, status=status)
    return {"items": [r.model_dump() for r in records], "total": len(records)}


@router.get("/{materialization_id}")
async def get_materialization(materialization_id: str) -> dict:
    """Get a single materialization record by ID."""
    service = MaterializationService(supabase_client=get_supabase_client())
    record = await service.get_record(materialization_id)
    if not record:
        raise HTTPException(status_code=404, detail="Materialization not found")
    return record.model_dump()


@router.put("/{materialization_id}/access")
async def mark_accessed(materialization_id: str) -> dict:
    """Increment the access count and update last_accessed_at for a materialization."""
    service = MaterializationService(supabase_client=get_supabase_client())
    await service.mark_accessed(materialization_id)
    return {"success": True}


@router.put("/{materialization_id}/status")
async def update_status(materialization_id: str, status: str) -> dict:
    """Update the status of a materialization record."""
    if status not in ("active", "stale", "archived"):
        raise HTTPException(status_code=400, detail="Invalid status")
    service = MaterializationService(supabase_client=get_supabase_client())
    await service.update_status(materialization_id, status)
    return {"success": True}


@router.delete("/{materialization_id}")
async def delete_materialization(materialization_id: str) -> dict:
    """Delete a materialization record and its associated file from the project repo."""
    service = MaterializationService(supabase_client=get_supabase_client())
    record = await service.get_record(materialization_id)
    if not record:
        raise HTTPException(status_code=404, detail="Materialization not found")
    from ..services.knowledge.indexer_service import IndexerService

    indexer = IndexerService()
    await indexer.remove_file(record.project_path, record.filename)
    await indexer.update_index(record.project_path)
    await service.delete_record(materialization_id)
    return {"success": True}
