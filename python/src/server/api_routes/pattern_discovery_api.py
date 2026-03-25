"""Pattern discovery API endpoints."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config.logfire_config import get_logger
from ..services.pattern_discovery.suggestion_service import SuggestionService

logger = get_logger(__name__)

router = APIRouter(prefix="/api/patterns", tags=["pattern-discovery"])


@router.get("/suggestions")
async def list_suggestions(status: str = "pending_review", limit: int = 20):
    try:
        service = SuggestionService()
        success, result = service.list_suggestions(status, limit)
        if not success:
            raise HTTPException(status_code=500, detail=result)
        return result["suggestions"]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing suggestions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


class AcceptRequest(BaseModel):
    customized_yaml: str | None = Field(None)


@router.post("/suggestions/{pattern_id}/accept")
async def accept_suggestion(pattern_id: str, request: AcceptRequest):
    try:
        service = SuggestionService()
        success, result = service.accept_suggestion(pattern_id, request.customized_yaml)
        if not success:
            raise HTTPException(status_code=400, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error accepting suggestion: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


class DismissRequest(BaseModel):
    reason: str | None = Field(None)


@router.post("/suggestions/{pattern_id}/dismiss")
async def dismiss_suggestion(pattern_id: str, request: DismissRequest):
    try:
        service = SuggestionService()
        success, result = service.dismiss_suggestion(pattern_id, request.reason)
        if not success:
            raise HTTPException(status_code=400, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error dismissing suggestion: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/backfill")
async def trigger_backfill(lookback_days: int = 90):
    """Trigger historical data backfill from all registered projects."""
    try:
        from ..services.pattern_discovery.backfill_service import BackfillService

        service = BackfillService()
        success, result = await service.backfill_all_projects(lookback_days)
        if not success:
            raise HTTPException(status_code=500, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error running backfill: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})


@router.post("/run-pipeline")
async def run_pipeline():
    """Trigger the full discovery pipeline."""
    try:
        service = SuggestionService()
        success, result = await service.run_discovery_pipeline()
        if not success:
            raise HTTPException(status_code=500, detail=result)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error running pipeline: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})
