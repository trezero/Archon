"""LeaveOff point service for storing and retrieving where a developer left off."""
from datetime import UTC, datetime

from ...config.logfire_config import get_logger
from ...utils import get_supabase_client

logger = get_logger(__name__)

TABLE = "archon_leaveoff_points"


class LeaveOffService:
    """Service for LeaveOff point CRUD operations.

    Each project has at most one LeaveOff point (upsert on project_id).
    """

    def __init__(self, supabase_client=None):
        self.supabase = supabase_client or get_supabase_client()

    async def upsert(
        self,
        project_id: str,
        content: str,
        next_steps: list[str] | None = None,
        component: str | None = None,
        references: list[str] | None = None,
        machine_id: str | None = None,
        last_session_id: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        """Atomic UPSERT using on_conflict='project_id'.

        Creates a new LeaveOff point or replaces the existing one for the given project.

        Args:
            project_id: The project this LeaveOff point belongs to.
            content: Free-form description of current state / where you left off.
            next_steps: Ordered list of next actions to take.
            component: Which component or area of the project was being worked on.
            references: File paths, URLs, or other references relevant to the work.
            machine_id: SHA256 fingerprint of the machine that created this point.
            last_session_id: Session ID from the last coding session.
            metadata: Arbitrary key-value data.

        Returns:
            The upserted row as a dict.

        Raises:
            RuntimeError: If the upsert returns no data.
        """
        now = datetime.now(UTC).isoformat()
        data = {
            "project_id": project_id,
            "content": content,
            "component": component,
            "next_steps": next_steps or [],
            "references": references or [],
            "machine_id": machine_id,
            "last_session_id": last_session_id,
            "metadata": metadata or {},
            "updated_at": now,
        }
        result = self.supabase.table(TABLE).upsert(data, on_conflict="project_id").execute()
        if not result.data:
            raise RuntimeError(f"LeaveOff upsert returned no data for project {project_id}")
        logger.info("LeaveOff point upserted", project_id=project_id, component=component)
        return result.data[0]

    async def get(self, project_id: str) -> dict | None:
        """Get the LeaveOff point for a project.

        Args:
            project_id: The project to look up.

        Returns:
            The row as a dict, or None if no LeaveOff point exists for this project.
        """
        result = self.supabase.table(TABLE).select("*").eq("project_id", project_id).execute()
        if not result.data:
            return None
        return result.data[0]

    async def delete(self, project_id: str) -> bool:
        """Delete the LeaveOff point for a project.

        Args:
            project_id: The project whose LeaveOff point should be removed.

        Returns:
            True if a record was deleted, False if nothing existed.
        """
        result = self.supabase.table(TABLE).delete().eq("project_id", project_id).execute()
        deleted = bool(result.data)
        if deleted:
            logger.info("LeaveOff point deleted", project_id=project_id)
        return deleted
