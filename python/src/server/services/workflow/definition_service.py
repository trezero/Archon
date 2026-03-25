"""Workflow definition CRUD, YAML validation, and versioning.

Stores canonical YAML definitions in Supabase. Validates structure
(node IDs, depends_on references) but does NOT interpret execution
semantics — that is the remote-agent's responsibility.
"""

from typing import Any

import yaml

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class DefinitionService:
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def validate_yaml(self, yaml_content: str) -> tuple[bool, dict[str, Any]]:
        """Validate YAML structure. Returns node_ids on success."""
        try:
            parsed = yaml.safe_load(yaml_content)
        except yaml.YAMLError as e:
            return False, {"error": f"Invalid YAML syntax: {str(e)}"}

        if not isinstance(parsed, dict):
            return False, {"error": "YAML must be a mapping at the top level"}

        nodes = parsed.get("nodes")
        if not nodes or not isinstance(nodes, list):
            return False, {"error": "YAML must contain a 'nodes' list with at least one node"}

        node_ids = []
        for i, node in enumerate(nodes):
            if not isinstance(node, dict):
                return False, {"error": f"Node at index {i} must be a mapping"}
            node_id = node.get("id")
            if not node_id:
                return False, {"error": f"Node at index {i} is missing required 'id' field"}
            node_ids.append(node_id)

        if len(node_ids) != len(set(node_ids)):
            dupes = [nid for nid in node_ids if node_ids.count(nid) > 1]
            return False, {"error": f"Duplicate node IDs: {list(set(dupes))}"}

        # Validate depends_on references
        node_id_set = set(node_ids)
        for node in nodes:
            deps = node.get("depends_on", [])
            for dep in deps:
                if dep not in node_id_set:
                    return False, {"error": f"Node '{node['id']}' depends on unknown node '{dep}'"}

        return True, {"parsed": parsed, "node_ids": node_ids}

    def create_definition(
        self,
        name: str,
        yaml_content: str,
        description: str | None = None,
        project_id: str | None = None,
        tags: list[str] | None = None,
        origin: str = "user",
    ) -> tuple[bool, dict[str, Any]]:
        """Create a new workflow definition. Validates YAML before storing."""
        valid, validation_result = self.validate_yaml(yaml_content)
        if not valid:
            return False, validation_result

        try:
            data = {
                "name": name,
                "yaml_content": yaml_content,
                "parsed_definition": validation_result["parsed"],
                "version": 1,
                "is_latest": True,
                "origin": origin,
            }
            if description:
                data["description"] = description
            if project_id:
                data["project_id"] = project_id
            if tags:
                data["tags"] = tags

            response = self.supabase_client.table("workflow_definitions").insert(data).execute()

            if not response.data:
                return False, {"error": "Failed to create definition — database returned no data"}

            definition = response.data[0]
            logger.info(f"Workflow definition created: {name} ({definition['id']})")
            return True, {"definition": definition}
        except Exception as e:
            logger.error(f"Error creating definition: {e}")
            return False, {"error": f"Failed to create definition: {str(e)}"}

    def get_definition(self, definition_id: str) -> tuple[bool, dict[str, Any]]:
        """Get a single workflow definition by ID."""
        try:
            response = (
                self.supabase_client.table("workflow_definitions")
                .select("*")
                .eq("id", definition_id)
                .is_("deleted_at", "null")
                .execute()
            )
            if not response.data:
                return False, {"error": f"Definition {definition_id} not found"}
            return True, {"definition": response.data[0]}
        except Exception as e:
            logger.error(f"Error getting definition {definition_id}: {e}")
            return False, {"error": f"Failed to get definition: {str(e)}"}

    def list_definitions(self, project_id: str | None = None) -> tuple[bool, dict[str, Any]]:
        """List latest versions of all definitions."""
        try:
            query = (
                self.supabase_client.table("workflow_definitions")
                .select("*")
                .eq("is_latest", True)
                .is_("deleted_at", "null")
            )
            if project_id:
                query = query.eq("project_id", project_id)
            response = query.order("created_at", desc=True).execute()
            return True, {"definitions": response.data or []}
        except Exception as e:
            logger.error(f"Error listing definitions: {e}")
            return False, {"error": f"Failed to list definitions: {str(e)}"}

    def update_definition(
        self,
        definition_id: str,
        yaml_content: str | None = None,
        description: str | None = None,
        tags: list[str] | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Update a definition by creating a new version."""
        try:
            success, result = self.get_definition(definition_id)
            if not success:
                return success, result

            current = result["definition"]
            new_yaml = yaml_content or current["yaml_content"]
            if yaml_content:
                valid, validation_result = self.validate_yaml(yaml_content)
                if not valid:
                    return False, validation_result

            self.supabase_client.table("workflow_definitions").update(
                {"is_latest": False}
            ).eq("name", current["name"]).eq("is_latest", True).execute()

            new_data = {
                "name": current["name"],
                "description": description or current.get("description"),
                "project_id": current.get("project_id"),
                "yaml_content": new_yaml,
                "parsed_definition": yaml.safe_load(new_yaml) if yaml_content else current.get("parsed_definition", {}),
                "version": current["version"] + 1,
                "is_latest": True,
                "tags": tags or current.get("tags", []),
                "origin": current.get("origin", "user"),
            }

            response = self.supabase_client.table("workflow_definitions").insert(new_data).execute()
            if not response.data:
                return False, {"error": "Failed to create new version"}

            logger.info(f"Definition updated: {current['name']} v{new_data['version']}")
            return True, {"definition": response.data[0]}
        except Exception as e:
            logger.error(f"Error updating definition {definition_id}: {e}")
            return False, {"error": f"Failed to update definition: {str(e)}"}

    def delete_definition(self, definition_id: str) -> tuple[bool, dict[str, Any]]:
        """Soft-delete a definition."""
        try:
            from datetime import UTC, datetime

            response = (
                self.supabase_client.table("workflow_definitions")
                .update({"deleted_at": datetime.now(UTC).isoformat(), "is_latest": False})
                .eq("id", definition_id)
                .execute()
            )
            if not response.data:
                return False, {"error": f"Definition {definition_id} not found"}
            return True, {"deleted": definition_id}
        except Exception as e:
            logger.error(f"Error deleting definition {definition_id}: {e}")
            return False, {"error": f"Failed to delete definition: {str(e)}"}
