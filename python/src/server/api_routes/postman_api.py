"""Postman integration API endpoints.

Handles:
- Collection creation and management (API mode)
- Environment sync from session-start hook
- Status/mode checking
"""

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..config.logfire_config import get_logger, logfire
from ..services.postman.postman_service import PostmanService

logger = get_logger(__name__)

router = APIRouter(prefix="/api/postman", tags=["postman"])


# ── Request models ────────────────────────────────────────────────────────────

class CreateCollectionRequest(BaseModel):
    project_name: str
    project_id: str | None = None


class UpsertRequestBody(BaseModel):
    folder_name: str
    request: dict[str, Any]


class UpsertEnvironmentRequest(BaseModel):
    name: str
    variables: dict[str, str]


class SyncEnvironmentRequest(BaseModel):
    project_id: str
    system_name: str
    env_file_content: str


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/status")
async def get_postman_status():
    """Get Postman integration status and current sync mode."""
    try:
        service = PostmanService()
        mode = await service.get_sync_mode()
        configured = mode == "api"

        if configured:
            try:
                await service._get_client()
                configured = True
            except ValueError:
                configured = False

        return {
            "sync_mode": mode,
            "configured": configured,
        }
    except Exception as e:
        logfire.error(f"Error checking postman status | error={e}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/collections")
async def create_collection(request: CreateCollectionRequest):
    """Create or find a collection for a project."""
    try:
        service = PostmanService()
        if await service.get_sync_mode() != "api":
            return {"status": "skipped", "reason": "sync_mode is not api"}

        logfire.info(f"Creating collection | project_name={request.project_name}")
        uid = await service.get_or_create_collection(request.project_name)
        return {"collection_uid": uid, "project_name": request.project_name}
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e)})
    except Exception as e:
        logfire.error(f"Error creating collection | error={e}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/collections/{collection_uid}/requests")
async def upsert_request(collection_uid: str, body: UpsertRequestBody):
    """Add or update a request in a collection folder."""
    try:
        service = PostmanService()
        if await service.get_sync_mode() != "api":
            return {"status": "skipped", "reason": "sync_mode is not api"}

        logfire.info(f"Upserting request | collection={collection_uid} | folder={body.folder_name}")
        await service.upsert_request(collection_uid, body.folder_name, body.request)
        return {"success": True, "folder": body.folder_name, "request_name": body.request.get("name")}
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e)})
    except Exception as e:
        logfire.error(f"Error upserting request | error={e}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.put("/environments/{env_name}")
async def upsert_environment(env_name: str, body: UpsertEnvironmentRequest):
    """Create or update an environment."""
    try:
        service = PostmanService()
        if await service.get_sync_mode() != "api":
            return {"status": "skipped", "reason": "sync_mode is not api"}

        logfire.info(f"Upserting environment | name={env_name}")
        await service.upsert_environment(env_name, body.variables)
        return {"success": True, "environment": env_name}
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e)})
    except Exception as e:
        logfire.error(f"Error upserting environment | error={e}")
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/environments/sync")
async def sync_environment(body: SyncEnvironmentRequest):
    """Sync .env file content to a Postman environment. Called by session-start hook."""
    try:
        service = PostmanService()
        if await service.get_sync_mode() != "api":
            return {"status": "skipped", "reason": "sync_mode is not api"}

        # Parse .env content into key-value pairs
        variables = {}
        for line in body.env_file_content.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key:
                    variables[key] = value

        env_name = f"{body.project_id} - {body.system_name}"
        await service.upsert_environment(env_name, variables)
        return {"success": True, "environment": env_name, "variables_count": len(variables)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail={"error": str(e)})
    except Exception as e:
        logfire.error(f"Error syncing environment | error={e}")
        raise HTTPException(status_code=500, detail={"error": str(e)})
