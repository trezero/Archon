"""CRUD operations for workflow commands."""

from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class CommandService:
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def list_commands(self) -> tuple[bool, dict[str, Any]]:
        try:
            response = self.supabase_client.table("workflow_commands").select("*").order("name").execute()
            return True, {"commands": response.data or []}
        except Exception as e:
            logger.error(f"Error listing commands: {e}", exc_info=True)
            return False, {"error": str(e)}

    def get_command(self, command_id: str) -> tuple[bool, dict[str, Any]]:
        try:
            response = self.supabase_client.table("workflow_commands").select("*").eq("id", command_id).execute()
            if not response.data:
                return False, {"error": "Command not found"}
            return True, {"command": response.data[0]}
        except Exception as e:
            logger.error(f"Error getting command: {e}", exc_info=True)
            return False, {"error": str(e)}

    def create_command(
        self,
        name: str,
        prompt_template: str,
        description: str | None = None,
        is_builtin: bool = False,
    ) -> tuple[bool, dict[str, Any]]:
        try:
            data = {
                "name": name,
                "prompt_template": prompt_template,
                "description": description,
                "is_builtin": is_builtin,
            }
            response = self.supabase_client.table("workflow_commands").insert(data).execute()
            if not response.data:
                return False, {"error": "Failed to create command"}
            return True, {"command": response.data[0]}
        except Exception as e:
            logger.error(f"Error creating command: {e}", exc_info=True)
            return False, {"error": str(e)}

    def update_command(
        self,
        command_id: str,
        name: str | None = None,
        prompt_template: str | None = None,
        description: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        try:
            updates = {
                k: v
                for k, v in {"name": name, "prompt_template": prompt_template, "description": description}.items()
                if v is not None
            }
            if not updates:
                return False, {"error": "No fields to update"}
            response = (
                self.supabase_client.table("workflow_commands").update(updates).eq("id", command_id).execute()
            )
            if not response.data:
                return False, {"error": "Command not found"}
            return True, {"command": response.data[0]}
        except Exception as e:
            logger.error(f"Error updating command: {e}", exc_info=True)
            return False, {"error": str(e)}

    def delete_command(self, command_id: str) -> tuple[bool, dict[str, Any]]:
        try:
            response = self.supabase_client.table("workflow_commands").delete().eq("id", command_id).execute()
            if not response.data:
                return False, {"error": "Command not found"}
            return True, {"deleted": True}
        except Exception as e:
            logger.error(f"Error deleting command: {e}", exc_info=True)
            return False, {"error": str(e)}
