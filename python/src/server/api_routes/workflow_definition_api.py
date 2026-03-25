"""Workflow definition management endpoints.

CRUD operations for YAML workflow definitions stored in Supabase.
"""

from typing import Any

from fastapi import APIRouter, Header, HTTPException
from fastapi import status as http_status
from pydantic import BaseModel, Field

from ..config.logfire_config import get_logger
from ..services.workflow.definition_service import DefinitionService
from ..utils.etag_utils import check_etag, generate_etag

logger = get_logger(__name__)

router = APIRouter(prefix="/api/workflows", tags=["workflow-definitions"])


class CreateDefinitionRequest(BaseModel):
    name: str = Field(..., description="Workflow name")
    yaml_content: str = Field(..., description="YAML workflow definition")
    description: str | None = Field(None, description="Human-readable description")
    project_id: str | None = Field(None, description="Scope to a specific project")
    tags: list[str] | None = Field(None, description="Searchable tags")


class UpdateDefinitionRequest(BaseModel):
    yaml_content: str | None = Field(None, description="Updated YAML content")
    description: str | None = Field(None, description="Updated description")
    tags: list[str] | None = Field(None, description="Updated tags")


@router.get("/definitions")
async def list_definitions(
    project_id: str | None = None,
    if_none_match: str | None = Header(None),
):
    try:
        service = DefinitionService()
        success, result = service.list_definitions(project_id=project_id)
        if not success:
            raise HTTPException(status_code=500, detail=result)

        etag = generate_etag(result["definitions"])
        if check_etag(if_none_match, etag):
            from fastapi.responses import Response as RawResponse
            return RawResponse(status_code=304)

        from fastapi.responses import JSONResponse
        response = JSONResponse(content=result["definitions"])
        response.headers["ETag"] = etag
        return response
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing definitions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/definitions", status_code=http_status.HTTP_201_CREATED)
async def create_definition(request: CreateDefinitionRequest):
    try:
        service = DefinitionService()
        success, result = service.create_definition(
            name=request.name,
            yaml_content=request.yaml_content,
            description=request.description,
            project_id=request.project_id,
            tags=request.tags,
        )
        if not success:
            raise HTTPException(status_code=400, detail=result)
        return result["definition"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating definition: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.get("/definitions/{definition_id}")
async def get_definition(definition_id: str):
    try:
        service = DefinitionService()
        success, result = service.get_definition(definition_id)
        if not success:
            raise HTTPException(status_code=404, detail=result)
        return result["definition"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting definition: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.put("/definitions/{definition_id}")
async def update_definition(definition_id: str, request: UpdateDefinitionRequest):
    try:
        service = DefinitionService()
        success, result = service.update_definition(
            definition_id=definition_id,
            yaml_content=request.yaml_content,
            description=request.description,
            tags=request.tags,
        )
        if not success:
            raise HTTPException(status_code=400, detail=result)
        return result["definition"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating definition: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.delete("/definitions/{definition_id}")
async def delete_definition(definition_id: str):
    try:
        service = DefinitionService()
        success, result = service.delete_definition(definition_id)
        if not success:
            raise HTTPException(status_code=404, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting definition: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/definitions/{definition_id}/export")
async def export_definition(definition_id: str):
    """Export a definition as a downloadable YAML file."""
    try:
        service = DefinitionService()
        success, result = service.get_definition(definition_id)
        if not success:
            raise HTTPException(status_code=404, detail=result)

        from fastapi.responses import Response
        definition = result["definition"]
        return Response(
            content=definition["yaml_content"],
            media_type="application/x-yaml",
            headers={"Content-Disposition": f'attachment; filename="{definition["name"]}.yaml"'},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error exporting definition: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


# -- Command Library --


class CreateCommandRequest(BaseModel):
    name: str = Field(..., description="Command name")
    prompt_template: str = Field(..., description="Markdown prompt template")
    description: str | None = Field(None)


class UpdateCommandRequest(BaseModel):
    name: str | None = Field(None)
    prompt_template: str | None = Field(None)
    description: str | None = Field(None)


@router.get("/commands")
async def list_commands():
    try:
        from ..services.workflow.command_service import CommandService

        service = CommandService()
        success, result = service.list_commands()
        if not success:
            raise HTTPException(status_code=500, detail=result)
        return result["commands"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing commands: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/commands", status_code=http_status.HTTP_201_CREATED)
async def create_command(request: CreateCommandRequest):
    try:
        from ..services.workflow.command_service import CommandService

        service = CommandService()
        success, result = service.create_command(
            name=request.name,
            prompt_template=request.prompt_template,
            description=request.description,
        )
        if not success:
            raise HTTPException(status_code=400, detail=result)
        return result["command"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating command: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.put("/commands/{command_id}")
async def update_command(command_id: str, request: UpdateCommandRequest):
    try:
        from ..services.workflow.command_service import CommandService

        service = CommandService()
        success, result = service.update_command(
            command_id,
            name=request.name,
            prompt_template=request.prompt_template,
            description=request.description,
        )
        if not success:
            raise HTTPException(status_code=400, detail=result)
        return result["command"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating command: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.delete("/commands/{command_id}")
async def delete_command(command_id: str):
    try:
        from ..services.workflow.command_service import CommandService

        service = CommandService()
        success, result = service.delete_command(command_id)
        if not success:
            raise HTTPException(status_code=404, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting command: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})
