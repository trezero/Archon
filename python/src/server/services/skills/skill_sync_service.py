"""Skill sync service.

Compares local skill state against the Archon registry,
resolves pending actions, and detects drift between
what a system has installed and what the registry expects.
"""

from typing import Any

from ...config.logfire_config import get_logger

logger = get_logger(__name__)

SYSTEM_SKILLS_TABLE = "archon_system_skills"
REGISTRATIONS_TABLE = "archon_project_system_registrations"


class SkillSyncService:
    """Handles sync logic between local systems and the Archon skill registry."""

    def __init__(self, supabase_client=None):
        """Initialize with an optional Supabase client.

        When *supabase_client* is ``None`` the global client is
        fetched lazily so the service can be instantiated before
        environment variables are loaded.
        """
        if supabase_client is None:
            from ...utils import get_supabase_client

            supabase_client = get_supabase_client()
        self.supabase_client = supabase_client

    # ── Sync Report ────────────────────────────────────────────────────────

    def compute_sync_report(
        self,
        local_skills: list[dict[str, Any]],
        archon_skills: list[dict[str, Any]],
        system_skills: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Compare local skills against Archon state and return a sync report.

        Args:
            local_skills: [{name, content_hash}] from the client's disk.
            archon_skills: Full skill records from archon_skills table.
            system_skills: Records from archon_system_skills for this system+project.

        Returns:
            Sync report with keys: in_sync, local_changes, pending_install,
            pending_remove, unknown_local.
        """
        archon_by_name: dict[str, dict[str, Any]] = {s["name"]: s for s in archon_skills}
        system_by_skill_id: dict[str, dict[str, Any]] = {s["skill_id"]: s for s in system_skills}
        local_by_name: dict[str, dict[str, Any]] = {s["name"]: s for s in local_skills}

        in_sync: list[str] = []
        local_changes: list[dict[str, Any]] = []
        pending_install: list[dict[str, Any]] = []
        pending_remove: list[dict[str, Any]] = []
        unknown_local: list[dict[str, Any]] = []

        # Classify each local skill against the Archon registry
        for local in local_skills:
            name = local["name"]
            archon_skill = archon_by_name.get(name)

            if not archon_skill:
                unknown_local.append({"name": name, "content_hash": local["content_hash"]})
                continue

            sys_skill = system_by_skill_id.get(archon_skill["id"])

            if sys_skill and sys_skill["status"] == "pending_remove":
                pending_remove.append({
                    "skill_id": archon_skill["id"],
                    "name": name,
                })
            elif local["content_hash"] == archon_skill["content_hash"]:
                in_sync.append(name)
            else:
                local_changes.append({
                    "name": name,
                    "skill_id": archon_skill["id"],
                    "local_hash": local["content_hash"],
                    "archon_hash": archon_skill["content_hash"],
                })

        # Detect pending installs: skills in Archon with pending_install status
        # that are NOT already present locally
        for sys_skill in system_skills:
            if sys_skill["status"] != "pending_install":
                continue
            skill_id = sys_skill["skill_id"]
            archon_skill = next((s for s in archon_skills if s["id"] == skill_id), None)
            if archon_skill and archon_skill["name"] not in local_by_name:
                pending_install.append({
                    "skill_id": skill_id,
                    "name": archon_skill["name"],
                    "content": archon_skill.get("content", ""),
                })

        return {
            "in_sync": in_sync,
            "local_changes": local_changes,
            "pending_install": pending_install,
            "pending_remove": pending_remove,
            "unknown_local": unknown_local,
        }

    # ── Project-System Registration ────────────────────────────────────────

    def register_system_for_project(self, system_id: str, project_id: str) -> None:
        """Upsert a registration record linking a system to a project.

        Called on every skill sync so the system appears in the project's
        Skills tab immediately, even before any skills are installed.
        """
        self.supabase_client.table(REGISTRATIONS_TABLE).upsert(
            {"project_id": project_id, "system_id": system_id, "last_sync_at": "now()"},
            on_conflict="project_id,system_id",
        ).execute()

    def unlink_system_from_project(self, system_id: str, project_id: str) -> bool:
        """Remove a system's association with a project.

        Deletes from archon_project_system_registrations. The system remains
        globally in archon_systems — only the project link is removed.
        Returns True if a record was deleted, False if the association did not exist.
        """
        result = (
            self.supabase_client.table(REGISTRATIONS_TABLE)
            .delete()
            .eq("project_id", project_id)
            .eq("system_id", system_id)
            .execute()
        )
        return len(result.data) > 0

    def get_project_systems(self, project_id: str) -> list[dict[str, Any]]:
        """Get all systems that have synced with a project."""
        result = (
            self.supabase_client.table(REGISTRATIONS_TABLE)
            .select("system_id, archon_systems(*)")
            .eq("project_id", project_id)
            .execute()
        )
        if not result.data:
            return []
        return [row["archon_systems"] for row in result.data if row.get("archon_systems")]

    # ── System Skill Queries ───────────────────────────────────────────────

    def get_system_skills(self, system_id: str, project_id: str) -> list[dict[str, Any]]:
        """Get all skill install records for a system+project pair."""
        result = (
            self.supabase_client.table(SYSTEM_SKILLS_TABLE)
            .select("*")
            .eq("system_id", system_id)
            .eq("project_id", project_id)
            .execute()
        )
        return result.data or []

    def get_system_project_skills(self, system_id: str, project_id: str) -> list[dict[str, Any]]:
        """Get detailed skill state for a system within a project.

        Joins with archon_skills to include skill metadata alongside
        install status information.
        """
        result = (
            self.supabase_client.table(SYSTEM_SKILLS_TABLE)
            .select(
                "*, archon_skills(id, name, display_name, description, current_version,"
                " content_hash, is_required, is_validated, tags)"
            )
            .eq("system_id", system_id)
            .eq("project_id", project_id)
            .execute()
        )
        return result.data or []

    # ── Install Status Management ──────────────────────────────────────────

    def set_install_status(
        self,
        system_id: str,
        skill_id: str,
        project_id: str,
        status: str,
        installed_content_hash: str | None = None,
        installed_version: int | None = None,
        has_local_changes: bool = False,
    ) -> dict[str, Any]:
        """Create or update a system-skill install record.

        Uses upsert on the (system_id, skill_id, project_id) composite key.

        Raises:
            RuntimeError: If the database upsert returns no data.
        """
        data: dict[str, Any] = {
            "system_id": system_id,
            "skill_id": skill_id,
            "project_id": project_id,
            "status": status,
            "installed_content_hash": installed_content_hash,
            "installed_version": installed_version,
            "has_local_changes": has_local_changes,
        }
        result = (
            self.supabase_client.table(SYSTEM_SKILLS_TABLE)
            .upsert(data, on_conflict="system_id,skill_id,project_id")
            .execute()
        )
        if not result.data:
            raise RuntimeError(f"Failed to set install status for skill {skill_id} on system {system_id}")
        return result.data[0]

    # ── Queue Operations ───────────────────────────────────────────────────

    def queue_install(self, system_ids: list[str], skill_id: str, project_id: str) -> int:
        """Queue a skill for installation on multiple systems.

        Returns the number of systems queued.
        """
        count = 0
        for system_id in system_ids:
            self.set_install_status(system_id, skill_id, project_id, status="pending_install")
            count += 1
        return count

    def queue_remove(self, system_ids: list[str], skill_id: str, project_id: str) -> int:
        """Queue a skill for removal on multiple systems.

        Returns the number of systems queued.
        """
        count = 0
        for system_id in system_ids:
            self.set_install_status(system_id, skill_id, project_id, status="pending_remove")
            count += 1
        return count
