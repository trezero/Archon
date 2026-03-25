"""Backend registration, heartbeat, and routing service.

Manages the execution_backends table — a routing table that maps
remote-agent instances to projects for workflow dispatch.
"""

import hashlib
import secrets
from datetime import UTC, datetime
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class BackendService:
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def register_backend(
        self,
        name: str,
        base_url: str,
        project_id: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Register a remote-agent instance. Returns a one-time auth token."""
        try:
            token = secrets.token_urlsafe(32)
            token_hash = hashlib.sha256(token.encode()).hexdigest()

            data = {
                "name": name,
                "base_url": base_url.rstrip("/"),
                "auth_token_hash": token_hash,
                "status": "healthy",
                "last_heartbeat_at": datetime.now(UTC).isoformat(),
                "registered_at": datetime.now(UTC).isoformat(),
            }
            if project_id:
                data["project_id"] = project_id

            response = self.supabase_client.table("execution_backends").insert(data).execute()

            if not response.data:
                return False, {"error": "Failed to register backend — database returned no data"}

            backend = response.data[0]
            logger.info(f"Backend registered: {name} ({backend['id']})")

            return True, {
                "backend_id": backend["id"],
                "auth_token": token,
            }
        except Exception as e:
            logger.error(f"Error registering backend: {e}")
            return False, {"error": f"Failed to register backend: {str(e)}"}

    def verify_token(self, token: str) -> tuple[bool, dict[str, Any]]:
        """Verify a Bearer token against registered backends."""
        try:
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            response = (
                self.supabase_client.table("execution_backends")
                .select("id, name, status, auth_token_hash")
                .eq("auth_token_hash", token_hash)
                .execute()
            )

            if not response.data:
                return False, {"error": "Invalid or unknown backend token"}

            backend = response.data[0]
            return True, {"backend_id": backend["id"], "backend_name": backend["name"]}
        except Exception as e:
            logger.error(f"Error verifying backend token: {e}")
            return False, {"error": f"Token verification failed: {str(e)}"}

    def record_heartbeat(self, backend_id: str) -> tuple[bool, dict[str, Any]]:
        """Update heartbeat timestamp and set status to healthy."""
        try:
            response = (
                self.supabase_client.table("execution_backends")
                .update({
                    "last_heartbeat_at": datetime.now(UTC).isoformat(),
                    "status": "healthy",
                })
                .eq("id", backend_id)
                .execute()
            )

            if not response.data:
                return False, {"error": f"Backend {backend_id} not found"}

            return True, {"backend_id": backend_id, "status": "healthy"}
        except Exception as e:
            logger.error(f"Error recording heartbeat for {backend_id}: {e}")
            return False, {"error": f"Heartbeat failed: {str(e)}"}

    def resolve_backend_for_project(self, project_id: str | None = None) -> tuple[bool, dict[str, Any]]:
        """Find the best backend for a given project.

        Resolution order:
        1. Backend registered for this specific project_id
        2. Default backend (project_id IS NULL)
        3. Error if no backends available
        """
        try:
            # Try project-specific backend first
            if project_id:
                response = (
                    self.supabase_client.table("execution_backends")
                    .select("*")
                    .eq("project_id", project_id)
                    .eq("status", "healthy")
                    .execute()
                )
                if response.data:
                    return True, {"backend": response.data[0]}

            # Fall back to default backend (no project_id)
            response = (
                self.supabase_client.table("execution_backends")
                .select("*")
                .is_("project_id", "null")
                .eq("status", "healthy")
                .execute()
            )
            if response.data:
                return True, {"backend": response.data[0]}

            return False, {"error": "No healthy execution backends available. Register a remote-agent first."}
        except Exception as e:
            logger.error(f"Error resolving backend for project {project_id}: {e}")
            return False, {"error": f"Backend resolution failed: {str(e)}"}

    def list_backends(self) -> tuple[bool, dict[str, Any]]:
        """List all registered backends."""
        try:
            response = self.supabase_client.table("execution_backends").select("*").execute()
            return True, {"backends": response.data or []}
        except Exception as e:
            logger.error(f"Error listing backends: {e}")
            return False, {"error": f"Failed to list backends: {str(e)}"}

    def deregister_backend(self, backend_id: str) -> tuple[bool, dict[str, Any]]:
        """Remove a backend from the routing table."""
        try:
            response = (
                self.supabase_client.table("execution_backends")
                .delete()
                .eq("id", backend_id)
                .execute()
            )
            if not response.data:
                return False, {"error": f"Backend {backend_id} not found"}

            logger.info(f"Backend deregistered: {backend_id}")
            return True, {"deleted": backend_id}
        except Exception as e:
            logger.error(f"Error deregistering backend {backend_id}: {e}")
            return False, {"error": f"Failed to deregister: {str(e)}"}
