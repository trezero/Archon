"""Workflow run management and SSE event stream.

Creates and manages workflow runs. The SSE endpoint provides
live state updates to UI clients.
"""

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi import status as http_status
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from ..config.logfire_config import get_logger
from ..services.workflow.backend_service import BackendService
from ..services.workflow.definition_service import DefinitionService
from ..services.workflow.dispatch_service import DispatchService
from ..utils import get_supabase_client

logger = get_logger(__name__)

router = APIRouter(prefix="/api/workflows", tags=["workflows"])


# Import singleton state service from backend API (shared SSE queues)
from .workflow_backend_api import get_state_service


class CreateRunRequest(BaseModel):
    definition_id: str = Field(..., description="Workflow definition to execute")
    project_id: str | None = Field(None, description="Project context")
    backend_id: str | None = Field(None, description="Specific backend to use (auto-resolved if omitted)")
    trigger_context: dict | None = Field(None, description="Context passed to the remote-agent")


@router.post("", status_code=http_status.HTTP_201_CREATED)
async def create_run(request: CreateRunRequest, req: Request):
    """Create and dispatch a workflow run."""
    try:
        # 1. Load definition
        def_service = DefinitionService()
        success, def_result = def_service.get_definition(request.definition_id)
        if not success:
            raise HTTPException(status_code=404, detail=def_result)
        definition = def_result["definition"]

        # 2. Resolve backend
        backend_service = BackendService()
        if request.backend_id:
            client = get_supabase_client()
            be_response = client.table("execution_backends").select("*").eq("id", request.backend_id).execute()
            if not be_response.data:
                raise HTTPException(status_code=404, detail={"error": f"Backend {request.backend_id} not found"})
            backend = be_response.data[0]
        else:
            success, be_result = backend_service.resolve_backend_for_project(request.project_id)
            if not success:
                raise HTTPException(status_code=400, detail=be_result)
            backend = be_result["backend"]

        # 3. Create run record
        dispatch_service = DispatchService()
        success, run_result = dispatch_service.create_run(
            definition_id=request.definition_id,
            project_id=request.project_id,
            backend_id=backend["id"],
            triggered_by="ui",
            trigger_context=request.trigger_context or {},
        )
        if not success:
            raise HTTPException(status_code=500, detail=run_result)
        run = run_result["run"]

        # 4. Create node records
        success, node_result = dispatch_service.create_nodes_for_run(
            run["id"], definition["yaml_content"],
        )
        if not success:
            raise HTTPException(status_code=500, detail=node_result)

        # 5. Dispatch to backend
        callback_url = str(req.base_url).rstrip("/") + "/api/workflows"
        success, dispatch_result = await dispatch_service.dispatch_to_backend(
            workflow_run_id=run["id"],
            yaml_content=definition["yaml_content"],
            backend=backend,
            node_id_map=node_result["node_id_map"],
            trigger_context=request.trigger_context or {},
            callback_url=callback_url,
        )
        if not success:
            raise HTTPException(status_code=502, detail=dispatch_result)

        return {
            "run_id": run["id"],
            "status": "dispatched",
            "backend": backend["name"],
            "node_count": node_result["node_count"],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating workflow run: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("")
async def list_runs(
    status: str | None = None,
    project_id: str | None = None,
):
    try:
        client = get_supabase_client()
        query = client.table("workflow_runs").select("*")
        if status:
            query = query.eq("status", status)
        if project_id:
            query = query.eq("project_id", project_id)
        response = query.order("created_at", desc=True).execute()
        return response.data or []
    except Exception as e:
        logger.error(f"Error listing runs: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/{run_id}")
async def get_run(run_id: str):
    try:
        client = get_supabase_client()
        run_response = client.table("workflow_runs").select("*").eq("id", run_id).execute()
        if not run_response.data:
            raise HTTPException(status_code=404, detail={"error": "Run not found"})

        nodes_response = client.table("workflow_nodes").select("*").eq("workflow_run_id", run_id).execute()

        return {
            "run": run_response.data[0],
            "nodes": nodes_response.data or [],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting run: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/{run_id}/cancel")
async def cancel_run(run_id: str):
    try:
        client = get_supabase_client()
        run_response = client.table("workflow_runs").select("*").eq("id", run_id).execute()
        if not run_response.data:
            raise HTTPException(status_code=404, detail={"error": "Run not found"})

        run = run_response.data[0]
        if run["status"] in ("completed", "failed", "cancelled"):
            raise HTTPException(status_code=400, detail={"error": f"Run is already {run['status']}"})

        backend_response = client.table("execution_backends").select("*").eq("id", run["backend_id"]).execute()
        backend = backend_response.data[0] if backend_response.data else {"base_url": "http://unknown", "name": "unknown"}

        dispatch_service = DispatchService()
        success, result = await dispatch_service.cancel_run(run_id, backend)
        if not success:
            raise HTTPException(status_code=500, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error cancelling run: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/{run_id}/events")
async def stream_run_events(run_id: str):
    """SSE stream for live workflow execution updates."""
    state_service = get_state_service()

    async def event_generator():
        queue = state_service.subscribe_to_run(run_id)
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield {
                        "event": event["type"],
                        "data": json.dumps(event["data"]),
                    }
                except asyncio.TimeoutError:
                    yield {"comment": "keepalive"}
        except asyncio.CancelledError:
            pass
        finally:
            state_service.unsubscribe_from_run(run_id, queue)

    return EventSourceResponse(event_generator())
