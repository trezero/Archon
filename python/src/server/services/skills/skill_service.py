"""Skill CRUD and version management service.

Handles creating, reading, updating, and deleting skills in the
archon_skills table, maintaining version history in archon_skill_versions,
and managing per-project overrides in archon_project_skills.
"""

import hashlib
from datetime import UTC, datetime
from typing import Any

from src.server.config.logfire_config import get_logger
from src.server.utils import get_supabase_client

logger = get_logger(__name__)

SKILLS_TABLE = "archon_skills"
VERSIONS_TABLE = "archon_skill_versions"
PROJECT_SKILLS_TABLE = "archon_project_skills"


class SkillService:
    """Service for skill CRUD operations and version management."""

    def __init__(self, supabase_client=None):
        """Initialize with optional Supabase client (defaults to shared instance)."""
        self.supabase_client = supabase_client or get_supabase_client()

    @staticmethod
    def compute_content_hash(content: str) -> str:
        """Compute SHA-256 hex digest of skill content."""
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def create_skill(
        self,
        name: str,
        description: str,
        content: str,
        created_by: str,
    ) -> dict[str, Any]:
        """Create a new skill and save version 1.

        Args:
            name: Kebab-case skill name (must be unique).
            description: Human-readable description.
            content: Full SKILL.md content.
            created_by: Identifier of the user or agent creating the skill.

        Returns:
            The created skill row as a dict.

        Raises:
            RuntimeError: If the database insert returns no data.
        """
        content_hash = self.compute_content_hash(content)
        now = datetime.now(UTC).isoformat()

        skill_data = {
            "name": name,
            "display_name": name,
            "description": description,
            "content": content,
            "content_hash": content_hash,
            "current_version": 1,
            "created_by": created_by,
            "created_at": now,
            "updated_at": now,
        }

        response = self.supabase_client.table(SKILLS_TABLE).insert(skill_data).execute()

        if not response.data:
            raise RuntimeError(f"Failed to create skill '{name}': database returned no data")

        skill = response.data[0]
        logger.info(f"Skill created: {skill.get('id')} ({name})")

        # Save initial version
        self._save_version(
            skill_id=skill["id"],
            version_number=1,
            content=content,
            content_hash=content_hash,
            created_by=created_by,
        )

        return skill

    def list_skills(self) -> list[dict[str, Any]]:
        """List all skills without the full content field.

        Returns:
            List of skill metadata dicts (id, name, description, version, timestamps).
        """
        response = (
            self.supabase_client.table(SKILLS_TABLE)
            .select("id, name, display_name, description, current_version, content_hash, is_required, is_validated, tags, created_by, created_at, updated_at")
            .order("name")
            .execute()
        )
        return response.data

    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        """Get a single skill by ID including full content.

        Returns:
            Skill dict or None if not found.
        """
        response = (
            self.supabase_client.table(SKILLS_TABLE)
            .select("*")
            .eq("id", skill_id)
            .execute()
        )
        if response.data:
            return response.data[0]
        return None

    def find_by_name(self, name: str) -> dict[str, Any] | None:
        """Find a skill by its unique kebab-case name.

        Returns:
            Skill dict or None if not found.
        """
        response = (
            self.supabase_client.table(SKILLS_TABLE)
            .select("*")
            .eq("name", name)
            .limit(1)
            .execute()
        )
        if response.data:
            return response.data[0]
        return None

    def update_skill(
        self,
        skill_id: str,
        content: str,
        new_version: int,
        updated_by: str,
        description: str | None = None,
    ) -> dict[str, Any]:
        """Update a skill's content and bump its version.

        Args:
            skill_id: The skill UUID.
            content: New SKILL.md content.
            new_version: The new version number (caller must compute this).
            updated_by: Identifier of the user or agent performing the update.
            description: Optional updated description.

        Returns:
            The updated skill row as a dict.

        Raises:
            RuntimeError: If the database update returns no data (e.g., skill not found).
        """
        content_hash = self.compute_content_hash(content)
        now = datetime.now(UTC).isoformat()

        update_data: dict[str, Any] = {
            "content": content,
            "content_hash": content_hash,
            "current_version": new_version,
            "updated_at": now,
        }
        if description is not None:
            update_data["description"] = description

        response = (
            self.supabase_client.table(SKILLS_TABLE)
            .update(update_data)
            .eq("id", skill_id)
            .execute()
        )

        if not response.data:
            raise RuntimeError(f"Failed to update skill '{skill_id}': database returned no data")

        skill = response.data[0]
        logger.info(f"Skill updated: {skill_id} -> v{new_version}")

        # Save version history entry
        self._save_version(
            skill_id=skill_id,
            version_number=new_version,
            content=content,
            content_hash=content_hash,
            created_by=updated_by,
        )

        return skill

    def delete_skill(self, skill_id: str) -> None:
        """Delete a skill by ID.

        Version history rows are expected to be cascade-deleted by the database.
        """
        self.supabase_client.table(SKILLS_TABLE).delete().eq("id", skill_id).execute()
        logger.info(f"Skill deleted: {skill_id}")

    def get_versions(self, skill_id: str) -> list[dict[str, Any]]:
        """Get the version history for a skill, newest first.

        Args:
            skill_id: The skill UUID.

        Returns:
            List of version rows ordered by version_number descending.
        """
        response = (
            self.supabase_client.table(VERSIONS_TABLE)
            .select("*")
            .eq("skill_id", skill_id)
            .order("version_number", desc=True)
            .execute()
        )
        return response.data

    def get_project_skills(self, project_id: str) -> list[dict[str, Any]]:
        """Get all skill overrides for a project.

        Args:
            project_id: The project UUID.

        Returns:
            List of project-skill override rows.
        """
        response = (
            self.supabase_client.table(PROJECT_SKILLS_TABLE)
            .select("*")
            .eq("project_id", project_id)
            .execute()
        )
        return response.data

    def save_project_override(
        self,
        project_id: str,
        skill_id: str,
        custom_content: str | None = None,
        is_enabled: bool = True,
    ) -> dict[str, Any]:
        """Upsert a per-project skill override.

        Args:
            project_id: The project UUID.
            skill_id: The skill UUID.
            custom_content: Optional project-specific content override.
            is_enabled: Whether the skill is enabled for this project.

        Returns:
            The upserted project-skill row.
        """
        now = datetime.now(UTC).isoformat()

        upsert_data = {
            "project_id": project_id,
            "skill_id": skill_id,
            "custom_content": custom_content,
            "is_enabled": is_enabled,
            "updated_at": now,
        }

        response = (
            self.supabase_client.table(PROJECT_SKILLS_TABLE)
            .upsert(upsert_data)
            .execute()
        )
        return response.data[0]

    def _save_version(
        self,
        skill_id: str,
        version_number: int,
        content: str,
        content_hash: str,
        created_by: str,
    ) -> None:
        """Save a version history entry for a skill.

        Args:
            skill_id: The skill UUID.
            version_number: Sequential version number.
            content: Full content snapshot at this version.
            content_hash: SHA-256 hash of the content.
            created_by: Identifier of the user or agent.
        """
        version_data = {
            "skill_id": skill_id,
            "version_number": version_number,
            "content": content,
            "content_hash": content_hash,
            "created_by": created_by,
            "created_at": datetime.now(UTC).isoformat(),
        }

        self.supabase_client.table(VERSIONS_TABLE).insert(version_data).execute()
        logger.debug(f"Version {version_number} saved for skill {skill_id}")
