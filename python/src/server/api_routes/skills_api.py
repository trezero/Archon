"""Skills management API endpoints for Archon.

Handles:
- Skill CRUD operations with version management
- System registration and lookup
- Project-scoped skill configuration and install queuing
"""

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from ..config.logfire_config import get_logger, logfire
from ..services.skills import SkillService, SkillValidationService, SystemService

logger = get_logger(__name__)

router = APIRouter(prefix="/api", tags=["skills"])


# ── Request models ────────────────────────────────────────────────────────────


class CreateSkillRequest(BaseModel):
    name: str
    description: str
    content: str
    created_by: str


class UpdateSkillRequest(BaseModel):
    content: str
    updated_by: str
    description: str | None = None


class ValidateSkillRequest(BaseModel):
    content: str


class UpdateSystemRequest(BaseModel):
    name: str | None = None
    hostname: str | None = None


class SaveProjectOverrideRequest(BaseModel):
    custom_content: str | None = None
    is_enabled: bool = True


class InstallSkillRequest(BaseModel):
    system_ids: list[str]


class RemoveSkillRequest(BaseModel):
    system_ids: list[str]


class RegisterSystemRequest(BaseModel):
    fingerprint: str
    name: str
    hostname: str | None = None
    os: str | None = None


class SyncSystemRequest(BaseModel):
    fingerprint: str
    system_name: str | None = None
    local_skills: list[dict[str, Any]] = []


# ── Skills CRUD ───────────────────────────────────────────────────────────────


@router.post("/skills/validate")
async def validate_skill_standalone(request: ValidateSkillRequest):
    """Validate skill content without requiring an existing skill ID."""
    try:
        logfire.debug("Validating skill content (standalone)")
        validator = SkillValidationService()
        result = validator.validate(request.content)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to validate skill | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/skills")
async def list_skills(include_content: bool = Query(False)):
    """List all skills. Pass ?include_content=true to include full skill content."""
    try:
        logfire.debug(f"Listing all skills | include_content={include_content}")
        service = SkillService()
        if include_content:
            skills = service.list_skills_full()
        else:
            skills = service.list_skills()
        return {"skills": skills, "count": len(skills)}
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to list skills | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/skills/{skill_id}")
async def get_skill(skill_id: str):
    """Get a single skill by ID including full content."""
    try:
        logfire.debug(f"Getting skill | skill_id={skill_id}")
        service = SkillService()
        skill = service.get_skill(skill_id)
        if skill is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")
        return skill
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get skill | skill_id={skill_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.post("/skills")
async def create_skill(request: CreateSkillRequest):
    """Create a new skill. Validates content before saving."""
    try:
        logfire.info(f"Creating skill | name={request.name}")

        # Validate content first
        validator = SkillValidationService()
        validation = validator.validate(request.content)
        if not validation["valid"]:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "Skill content validation failed",
                    "errors": validation["errors"],
                    "warnings": validation["warnings"],
                },
            )

        service = SkillService()
        skill = service.create_skill(
            name=request.name,
            description=request.description,
            content=request.content,
            created_by=request.created_by,
        )

        logfire.info(f"Skill created | skill_id={skill.get('id')} | name={request.name}")
        return skill
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to create skill | name={request.name} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.put("/skills/{skill_id}")
async def update_skill(skill_id: str, request: UpdateSkillRequest):
    """Update a skill's content and bump its version."""
    try:
        logfire.info(f"Updating skill | skill_id={skill_id}")

        service = SkillService()

        # Fetch existing skill to compute next version and validate name
        existing = service.get_skill(skill_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

        # Validate content (pass existing name so name-change is rejected)
        validator = SkillValidationService()
        validation = validator.validate(request.content, existing_name=existing.get("name"))
        if not validation["valid"]:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "Skill content validation failed",
                    "errors": validation["errors"],
                    "warnings": validation["warnings"],
                },
            )

        new_version = existing["current_version"] + 1
        skill = service.update_skill(
            skill_id=skill_id,
            content=request.content,
            new_version=new_version,
            updated_by=request.updated_by,
            description=request.description,
        )

        logfire.info(f"Skill updated | skill_id={skill_id} | version={new_version}")
        return skill
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to update skill | skill_id={skill_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: str):
    """Delete a skill and its version history."""
    try:
        logfire.info(f"Deleting skill | skill_id={skill_id}")

        service = SkillService()

        # Verify skill exists
        existing = service.get_skill(skill_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

        service.delete_skill(skill_id)
        logfire.info(f"Skill deleted | skill_id={skill_id}")
        return {"status": "deleted", "skill_id": skill_id}
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to delete skill | skill_id={skill_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.post("/skills/{skill_id}/validate")
async def validate_skill(skill_id: str, request: ValidateSkillRequest):
    """Validate skill content without saving. Returns errors and warnings."""
    try:
        logfire.debug(f"Validating skill content | skill_id={skill_id}")

        service = SkillService()
        existing = service.get_skill(skill_id)
        existing_name = existing.get("name") if existing else None

        validator = SkillValidationService()
        result = validator.validate(request.content, existing_name=existing_name)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to validate skill | skill_id={skill_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/skills/{skill_id}/versions")
async def get_skill_versions(skill_id: str):
    """Get version history for a skill, newest first."""
    try:
        logfire.debug(f"Getting skill versions | skill_id={skill_id}")

        service = SkillService()

        # Verify skill exists
        existing = service.get_skill(skill_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

        versions = service.get_versions(skill_id)
        return {"versions": versions, "count": len(versions)}
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get skill versions | skill_id={skill_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


# ── Systems ───────────────────────────────────────────────────────────────────


@router.post("/systems")
async def register_system(request: RegisterSystemRequest):
    """Register a new system or return existing one if fingerprint already exists."""
    try:
        logfire.info(f"Registering system | fingerprint={request.fingerprint}")
        service = SystemService()

        # Check if system already exists by fingerprint
        existing = service.find_by_fingerprint(request.fingerprint)
        if existing:
            # Update last seen and return existing
            service.update_last_seen(existing["id"])
            return {"system": existing, "is_new": False}

        system = service.register_system(
            fingerprint=request.fingerprint,
            name=request.name,
            hostname=request.hostname,
            os=request.os,
        )
        logfire.info(f"System registered | system_id={system.get('id')}")
        return {"system": system, "is_new": True}
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to register system | fingerprint={request.fingerprint} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/systems")
async def list_systems():
    """List all registered systems."""
    try:
        logfire.debug("Listing all systems")
        service = SystemService()
        systems = service.list_systems()
        return {"systems": systems, "count": len(systems)}
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to list systems | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/systems/{system_id}")
async def get_system(system_id: str):
    """Get a single system by ID."""
    try:
        logfire.debug(f"Getting system | system_id={system_id}")
        service = SystemService()
        system = service.get_system(system_id)
        if system is None:
            raise HTTPException(status_code=404, detail=f"System '{system_id}' not found")
        return system
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get system | system_id={system_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.put("/systems/{system_id}")
async def update_system(system_id: str, request: UpdateSystemRequest):
    """Update a system's mutable fields (name, hostname)."""
    try:
        logfire.info(f"Updating system | system_id={system_id}")
        service = SystemService()
        system = service.update_system(
            system_id=system_id,
            name=request.name,
            hostname=request.hostname,
        )
        if system is None:
            raise HTTPException(status_code=404, detail=f"System '{system_id}' not found")

        logfire.info(f"System updated | system_id={system_id}")
        return system
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to update system | system_id={system_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.delete("/systems/{system_id}")
async def delete_system(system_id: str):
    """Delete a system by ID."""
    try:
        logfire.info(f"Deleting system | system_id={system_id}")
        service = SystemService()
        deleted = service.delete_system(system_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"System '{system_id}' not found")

        logfire.info(f"System deleted | system_id={system_id}")
        return {"status": "deleted", "system_id": system_id}
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to delete system | system_id={system_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


# ── Project-scoped skills ─────────────────────────────────────────────────────


@router.post("/projects/{project_id}/sync")
async def sync_system(project_id: str, request: SyncSystemRequest):
    """Register a system for a project and compute a skill sync report.

    Registers the system globally (or updates last_seen), associates it with
    the project so it appears in the Skills tab, then compares the system's
    local skills against the Archon registry and returns a full sync report.
    """
    try:
        logfire.info(f"Syncing system | project_id={project_id} | fingerprint={request.fingerprint}")

        system_service = SystemService()
        skill_service = SkillService()

        from ..services.skills.skill_sync_service import SkillSyncService

        sync_service = SkillSyncService()

        # Register or look up system
        existing = system_service.find_by_fingerprint(request.fingerprint)
        if existing:
            system_service.update_last_seen(existing["id"])
            system = existing
            is_new = False
        else:
            name = request.system_name or request.fingerprint
            system = system_service.register_system(
                fingerprint=request.fingerprint,
                name=name,
            )
            is_new = True

        system_id = system["id"]

        # Associate system with this project
        sync_service.register_system_for_project(system_id, project_id)

        # Fetch full skill registry (content needed for pending_install items)
        archon_skills = skill_service.list_skills_full()

        # Fetch existing system-project install records
        system_skills = sync_service.get_system_skills(system_id, project_id)

        # Compute sync report
        report = sync_service.compute_sync_report(
            local_skills=request.local_skills,
            archon_skills=archon_skills,
            system_skills=system_skills,
        )

        logfire.info(
            f"Sync complete | project_id={project_id} | system_id={system_id} | "
            f"in_sync={len(report['in_sync'])} | pending_install={len(report['pending_install'])} | "
            f"local_changes={len(report['local_changes'])} | unknown_local={len(report['unknown_local'])}"
        )

        return {
            "system": {**system, "is_new": is_new},
            **report,
        }

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to sync system | project_id={project_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/projects/{project_id}/skills")
async def get_project_skills(project_id: str):
    """Get skills data for a project.

    Returns all skills from the registry and systems with their install state,
    matching the frontend ProjectSkillsResponse shape: {all_skills, systems}.
    """
    try:
        logfire.debug(f"Getting project skills | project_id={project_id}")
        skill_service = SkillService()
        all_skills = skill_service.list_skills()

        # Build systems with nested skill install state
        systems_with_skills: list[dict[str, Any]] = []
        try:
            from ..services.skills.skill_sync_service import SkillSyncService

            sync_service = SkillSyncService()
            systems = sync_service.get_project_systems(project_id)

            for system in systems:
                sys_skills = sync_service.get_system_project_skills(system["id"], project_id)
                systems_with_skills.append({**system, "skills": sys_skills})
        except ImportError:
            pass

        return {
            "all_skills": all_skills,
            "systems": systems_with_skills,
        }

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get project skills | project_id={project_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.get("/projects/{project_id}/systems")
async def get_project_systems(project_id: str):
    """Get systems associated with a project."""
    try:
        logfire.debug(f"Getting project systems | project_id={project_id}")

        try:
            from ..services.skills.skill_sync_service import SkillSyncService

            sync_service = SkillSyncService()
            systems = sync_service.get_project_systems(project_id)
            return {"systems": systems, "count": len(systems)}
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="SkillSyncService is not yet available. Project-system mapping requires the sync service.",
            ) from None

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(f"Failed to get project systems | project_id={project_id} | error={e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.post("/projects/{project_id}/skills/{skill_id}/install")
async def install_skill(project_id: str, skill_id: str, request: InstallSkillRequest):
    """Queue a skill install on specified systems for a project."""
    try:
        logfire.info(
            f"Queueing skill install | project_id={project_id} | skill_id={skill_id} | "
            f"system_count={len(request.system_ids)}"
        )

        if not request.system_ids:
            raise HTTPException(status_code=422, detail="At least one system_id is required")

        try:
            from ..services.skills.skill_sync_service import SkillSyncService

            sync_service = SkillSyncService()
            result = sync_service.queue_install(
                system_ids=request.system_ids,
                skill_id=skill_id,
                project_id=project_id,
            )

            logfire.info(f"Skill install queued | project_id={project_id} | skill_id={skill_id}")
            return {"queued": result, "skill_id": skill_id, "project_id": project_id}
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="SkillSyncService is not yet available. Install queuing requires the sync service.",
            ) from None

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(
            f"Failed to queue skill install | project_id={project_id} | skill_id={skill_id} | error={e}",
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.post("/projects/{project_id}/skills/{skill_id}/remove")
async def remove_skill(project_id: str, skill_id: str, request: RemoveSkillRequest):
    """Queue a skill removal on specified systems for a project."""
    try:
        logfire.info(
            f"Queueing skill removal | project_id={project_id} | skill_id={skill_id} | "
            f"system_count={len(request.system_ids)}"
        )

        if not request.system_ids:
            raise HTTPException(status_code=422, detail="At least one system_id is required")

        try:
            from ..services.skills.skill_sync_service import SkillSyncService

            sync_service = SkillSyncService()
            result = sync_service.queue_remove(
                system_ids=request.system_ids,
                skill_id=skill_id,
                project_id=project_id,
            )

            logfire.info(f"Skill removal queued | project_id={project_id} | skill_id={skill_id}")
            return {"queued": result, "skill_id": skill_id, "project_id": project_id}
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="SkillSyncService is not yet available. Removal queuing requires the sync service.",
            ) from None

    except HTTPException:
        raise
    except Exception as e:
        logfire.error(
            f"Failed to queue skill removal | project_id={project_id} | skill_id={skill_id} | error={e}",
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e


@router.put("/projects/{project_id}/skills/{skill_id}")
async def save_project_override(project_id: str, skill_id: str, request: SaveProjectOverrideRequest):
    """Save a per-project skill override (custom content and/or enabled state)."""
    try:
        logfire.info(f"Saving project skill override | project_id={project_id} | skill_id={skill_id}")

        service = SkillService()

        # Verify skill exists
        existing = service.get_skill(skill_id)
        if existing is None:
            raise HTTPException(status_code=404, detail=f"Skill '{skill_id}' not found")

        # Validate custom content if provided
        if request.custom_content is not None:
            validator = SkillValidationService()
            validation = validator.validate(request.custom_content, existing_name=existing.get("name"))
            if not validation["valid"]:
                raise HTTPException(
                    status_code=422,
                    detail={
                        "message": "Custom content validation failed",
                        "errors": validation["errors"],
                        "warnings": validation["warnings"],
                    },
                )

        override = service.save_project_override(
            project_id=project_id,
            skill_id=skill_id,
            custom_content=request.custom_content,
            is_enabled=request.is_enabled,
        )

        logfire.info(f"Project skill override saved | project_id={project_id} | skill_id={skill_id}")
        return override
    except HTTPException:
        raise
    except Exception as e:
        logfire.error(
            f"Failed to save project override | project_id={project_id} | skill_id={skill_id} | error={e}",
            exc_info=True,
        )
        raise HTTPException(status_code=500, detail={"error": str(e)}) from e
