"""Scanner API endpoints for bulk project onboarding.

Handles:
- Directory scanning for Git repositories
- Applying scan templates to create Archon projects
- Time estimation for apply operations
- Scan report retrieval
- Template CRUD
"""

import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..config.logfire_config import get_logger
from ..config.scanner_config import SCANNER_ENABLED
from ..services.scanner.scan_template import (
    ApplyRequest,
    ApplyResponse,
    EstimateRequest,
    EstimateResponse,
    ScanRequest,
    ScanResponse,
    ScanTemplate,
    TemplateSaveRequest,
    TemplateResponse,
)
from ..services.scanner.scanner_service import ScannerService

logger = get_logger(__name__)

router = APIRouter(prefix="/api/scanner", tags=["scanner"])


def _check_scanner_enabled():
    if not SCANNER_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Scanner is not enabled. Set SCANNER_ENABLED=true and "
            "PROJECTS_DIRECTORY in your .env file, then restart Docker.",
        )


# ── Scan ─────────────────────────────────────────────────────────────────────


@router.post("/scan")
async def scan_directory(req: ScanRequest) -> dict[str, Any]:
    """Scan the mounted projects directory for Git repositories."""
    _check_scanner_enabled()

    service = ScannerService()

    # Validate system is registered
    system = service._get_system_by_fingerprint(req.system_fingerprint)
    if not system:
        raise HTTPException(
            status_code=400,
            detail="System not registered. Run /archon-setup in any project first.",
        )

    container_path = req.directory_path
    host_path = req.directory_path or "~/projects"

    success, result = await service.scan_directory(
        container_path=container_path or "",
        host_path=host_path,
        system_id=system["id"],
    )

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error", "Scan failed"))

    return result


@router.get("/results/{scan_id}")
async def get_scan_results(scan_id: str) -> dict[str, Any]:
    """Get scan results with per-project details."""
    _check_scanner_enabled()

    service = ScannerService()
    success, result = await service.get_scan_results(scan_id)

    if not success:
        status = 404 if "not found" in result.get("error", "").lower() else 400
        raise HTTPException(status_code=status, detail=result.get("error"))

    return result


# ── Apply ────────────────────────────────────────────────────────────────────


@router.post("/apply")
async def apply_scan(req: ApplyRequest) -> dict[str, Any]:
    """Apply template to selected projects from a scan."""
    _check_scanner_enabled()

    service = ScannerService()

    # Validate system
    system = service._get_system_by_fingerprint(req.system_fingerprint)
    if not system:
        raise HTTPException(
            status_code=400,
            detail="System not registered. Run /archon-setup in any project first.",
        )

    progress_id = str(uuid.uuid4())

    success, result = await service.apply_scan(
        scan_id=req.scan_id,
        template=req.template,
        selected_project_ids=req.selected_project_ids,
        descriptions=req.descriptions,
        system_fingerprint=req.system_fingerprint,
        system_name=req.system_name,
        progress_id=progress_id,
    )

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result


# ── Estimate ─────────────────────────────────────────────────────────────────


@router.post("/estimate")
async def estimate_apply_time(req: EstimateRequest) -> dict[str, Any]:
    """Get time estimate for apply operation."""
    _check_scanner_enabled()

    service = ScannerService()
    return await service.estimate_apply_time(
        scan_id=req.scan_id,
        template=req.template,
        selected_count=req.selected_count,
    )


# ── Report ───────────────────────────────────────────────────────────────────


@router.get("/report/{scan_id}")
async def get_scan_report(scan_id: str) -> dict[str, Any]:
    """Get scan report summary and CSV path."""
    _check_scanner_enabled()

    service = ScannerService()

    from ..services.scanner.scan_report import generate_scan_report
    success, result = await generate_scan_report(scan_id, service.supabase_client)

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result


# ── Templates ────────────────────────────────────────────────────────────────


@router.get("/templates")
async def list_templates(
    system_id: str | None = Query(None),
) -> dict[str, Any]:
    """List saved scanner templates."""
    _check_scanner_enabled()

    service = ScannerService()
    success, result = service.list_templates(system_id=system_id)

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result


@router.post("/templates")
async def save_template(req: TemplateSaveRequest) -> dict[str, Any]:
    """Save a scanner template."""
    _check_scanner_enabled()

    service = ScannerService()
    success, result = service.save_template(
        name=req.name,
        template=req.template,
        description=req.description,
        is_default=req.is_default,
        system_id=req.system_id,
    )

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str) -> dict[str, Any]:
    """Delete a scanner template."""
    _check_scanner_enabled()

    service = ScannerService()
    success, result = service.delete_template(template_id)

    if not success:
        raise HTTPException(status_code=400, detail=result.get("error"))

    return result
