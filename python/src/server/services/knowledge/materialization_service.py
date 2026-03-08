"""
MaterializationService — orchestrates knowledge materialization.

Coordinates RAG search, LLM synthesis, file writing, and DB tracking
to materialize Vector DB knowledge into local project repos.
"""

from datetime import UTC, datetime
from typing import Any

from ...config.logfire_config import get_logger
from ...models.materialization import MaterializationRecord
from ...utils import get_supabase_client

logger = get_logger(__name__)

TABLE = "archon_materialization_history"


class MaterializationService:
    def __init__(self, supabase_client=None):
        self.supabase = supabase_client or get_supabase_client()

    async def check_existing(self, topic: str, project_id: str) -> MaterializationRecord | None:
        """Check if topic is already materialized (active or pending) for this project."""
        result = (
            self.supabase.table(TABLE)
            .select("*")
            .eq("project_id", project_id)
            .eq("topic", topic)
            .in_("status", ["active", "pending"])
            .execute()
        )
        if result.data:
            return MaterializationRecord(**result.data[0])
        return None

    async def list_materializations(self, project_id: str | None = None, status: str | None = None) -> list[MaterializationRecord]:
        """List materialization records, optionally filtered by project and/or status."""
        query = self.supabase.table(TABLE).select("*")
        if project_id:
            query = query.eq("project_id", project_id)
        if status:
            query = query.eq("status", status)
        query = query.order("materialized_at", desc=True)
        result = query.execute()
        return [MaterializationRecord(**row) for row in result.data]

    async def create_record(
        self,
        project_id: str,
        project_path: str,
        topic: str,
        filename: str,
        file_path: str,
        source_ids: list[str],
        original_urls: list[str],
        synthesis_model: str | None,
        word_count: int,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        """Create a new materialization history record. Returns the record ID."""
        result = (
            self.supabase.table(TABLE)
            .insert({
                "project_id": project_id,
                "project_path": project_path,
                "topic": topic,
                "filename": filename,
                "file_path": file_path,
                "source_ids": source_ids,
                "original_urls": original_urls,
                "synthesis_model": synthesis_model,
                "word_count": word_count,
                "metadata": metadata or {},
            })
            .execute()
        )
        return result.data[0]["id"]

    async def mark_accessed(self, materialization_id: str) -> None:
        """Increment the access count and update last_accessed_at via database RPC."""
        self.supabase.rpc("increment_access_count", {"record_id": materialization_id}).execute()

    async def update_status(self, materialization_id: str, status: str) -> None:
        """Update the status of a materialization record."""
        now = datetime.now(UTC).isoformat()
        (
            self.supabase.table(TABLE)
            .update({"status": status, "updated_at": now})
            .eq("id", materialization_id)
            .execute()
        )

    async def delete_record(self, materialization_id: str) -> None:
        """Delete a materialization record."""
        self.supabase.table(TABLE).delete().eq("id", materialization_id).execute()

    async def get_record(self, materialization_id: str) -> MaterializationRecord | None:
        """Get a single materialization record by ID."""
        result = self.supabase.table(TABLE).select("*").eq("id", materialization_id).execute()
        if result.data:
            return MaterializationRecord(**result.data[0])
        return None
