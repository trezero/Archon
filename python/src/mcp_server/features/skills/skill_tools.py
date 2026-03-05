"""
Skills management tools for Archon MCP Server.

Provides two consolidated tools:
- find_skills: List, search, and get skill details
- manage_skills: Sync, upload, validate, install, remove, and bootstrap skills
"""

import json
import logging
import re
from urllib.parse import urljoin

import httpx
from mcp.server.fastmcp import Context, FastMCP

from src.mcp_server.utils.error_handling import MCPErrorFormatter
from src.mcp_server.utils.timeout_config import get_default_timeout
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)

# Optimization constants
MAX_DESCRIPTION_LENGTH = 500
DEFAULT_PAGE_SIZE = 20


def truncate_text(text: str, max_length: int = MAX_DESCRIPTION_LENGTH) -> str:
    """Truncate text to maximum length with ellipsis."""
    if text and len(text) > max_length:
        return text[:max_length - 3] + "..."
    return text


def optimize_skill_response(skill: dict, include_content: bool = False) -> dict:
    """Optimize skill object for MCP response by trimming large fields."""
    skill = skill.copy()

    if "description" in skill and skill["description"]:
        skill["description"] = truncate_text(skill["description"])

    if not include_content and "content" in skill:
        content = skill.pop("content", "")
        if content:
            skill["content_length"] = len(content)

    return skill


def _parse_yaml_frontmatter(content: str) -> dict:
    """
    Extract YAML frontmatter metadata from skill content.

    Looks for a block delimited by --- at the start of the content.
    Returns extracted fields: name, description, version, tags.
    """
    metadata: dict = {}
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if not match:
        return metadata

    frontmatter = match.group(1)
    for line in frontmatter.split("\n"):
        line = line.strip()
        if ":" in line:
            key, _, value = line.partition(":")
            key = key.strip().lower()
            value = value.strip().strip("\"'")
            if key == "name":
                metadata["name"] = value
            elif key == "description":
                metadata["description"] = value
            elif key == "version":
                metadata["version"] = value
            elif key == "tags":
                # Handle both inline list [a, b] and plain comma-separated
                value = value.strip("[]")
                metadata["tags"] = [t.strip().strip("\"'") for t in value.split(",") if t.strip()]

    return metadata


def register_skill_tools(mcp: FastMCP):
    """Register skills management tools with the MCP server."""

    @mcp.tool()
    async def find_skills(
        ctx: Context,
        skill_id: str | None = None,
        query: str | None = None,
        project_id: str | None = None,
        include_content: bool = False,
    ) -> str:
        """
        List, search, and retrieve skills.

        Args:
            skill_id: Get a specific skill by ID (returns full details including content)
            query: Search skills by name or description keyword
            project_id: List skills for a specific project (includes installation state)
            include_content: Include full skill content in list results (default: False)

        Returns:
            JSON with skill(s) data

        Examples:
            find_skills()  # List all skills
            find_skills(query="memory")  # Search by keyword
            find_skills(skill_id="sk-123")  # Get specific skill
            find_skills(project_id="proj-1")  # Skills for a project
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                # Single skill by ID
                if skill_id:
                    response = await client.get(urljoin(api_url, f"/api/skills/{skill_id}"))

                    if response.status_code == 200:
                        skill = response.json()
                        return json.dumps({"success": True, "skill": skill})
                    elif response.status_code == 404:
                        return MCPErrorFormatter.format_error(
                            error_type="not_found",
                            message=f"Skill {skill_id} not found",
                            suggestion="Verify the skill ID is correct",
                            http_status=404,
                        )
                    else:
                        return MCPErrorFormatter.from_http_error(response, "get skill")

                # Skills for a specific project
                if project_id:
                    response = await client.get(urljoin(api_url, f"/api/projects/{project_id}/skills"))

                    if response.status_code == 200:
                        data = response.json()
                        skills = data.get("all_skills", [])
                        optimized = [optimize_skill_response(s, include_content) for s in skills]
                        return json.dumps({
                            "success": True,
                            "skills": optimized,
                            "count": len(optimized),
                            "project_id": project_id,
                        })
                    else:
                        return MCPErrorFormatter.from_http_error(response, "list project skills")

                # List all skills
                response = await client.get(urljoin(api_url, "/api/skills"))

                if response.status_code == 200:
                    data = response.json()
                    skills = data.get("skills", [])

                    # Client-side keyword filter
                    if query:
                        query_lower = query.lower()
                        skills = [
                            s for s in skills
                            if query_lower in s.get("name", "").lower()
                            or query_lower in s.get("description", "").lower()
                        ]

                    optimized = [optimize_skill_response(s, include_content) for s in skills]

                    return json.dumps({
                        "success": True,
                        "skills": optimized,
                        "count": len(optimized),
                        "query": query,
                    })
                else:
                    return MCPErrorFormatter.from_http_error(response, "list skills")

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, "find skills")
        except Exception as e:
            logger.error(f"Error finding skills: {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, "find skills")

    @mcp.tool()
    async def manage_skills(
        ctx: Context,
        action: str,
        # For sync
        local_skills: list | None = None,
        system_fingerprint: str | None = None,
        system_name: str | None = None,
        project_id: str | None = None,
        # For upload / validate
        skill_content: str | None = None,
        skill_name: str | None = None,
        # For install / remove
        skill_id: str | None = None,
        system_id: str | None = None,
    ) -> str:
        """
        Manage skills: sync, upload, validate, install, remove, or bootstrap.

        Args:
            action: "sync" | "upload" | "validate" | "install" | "remove" | "bootstrap"
            local_skills: Array of local skill objects for sync (each with name, content_hash, version)
            system_fingerprint: Unique fingerprint identifying this system (for sync)
            system_name: Human-readable name for this system (for sync)
            project_id: Project ID for sync/install/remove context
            skill_content: Full skill file content (for upload/validate)
            skill_name: Skill name override (for upload, otherwise parsed from content)
            skill_id: Skill ID (for install/remove)
            system_id: System ID (for install/remove)

        Returns:
            JSON with action result

        Examples:
            manage_skills("validate", skill_content="---\\nname: my-skill\\n---\\n# Content")
            manage_skills("upload", skill_content="---\\nname: my-skill\\n---\\n# Content")
            manage_skills("install", skill_id="sk-1", project_id="proj-1", system_id="sys-1")
            manage_skills("remove", skill_id="sk-1", project_id="proj-1", system_id="sys-1")
            manage_skills("sync", local_skills=[...], system_fingerprint="fp-abc", project_id="proj-1")
        """
        try:
            api_url = get_api_url()
            timeout = get_default_timeout()

            async with httpx.AsyncClient(timeout=timeout) as client:
                if action == "validate":
                    return await _handle_validate(client, api_url, skill_content)

                elif action == "upload":
                    return await _handle_upload(client, api_url, skill_content, skill_name)

                elif action == "sync":
                    return await _handle_sync(
                        client, api_url, local_skills, system_fingerprint, system_name, project_id
                    )

                elif action == "install":
                    return await _handle_install(client, api_url, skill_id, project_id, system_id)

                elif action == "remove":
                    return await _handle_remove(client, api_url, skill_id, project_id, system_id)

                elif action == "bootstrap":
                    return await _handle_bootstrap(
                        client, api_url, system_fingerprint, system_name, project_id
                    )

                else:
                    return MCPErrorFormatter.format_error(
                        "invalid_action",
                        f"Unknown action: {action}. Valid actions: sync, upload, validate, install, remove, bootstrap",
                    )

        except httpx.RequestError as e:
            return MCPErrorFormatter.from_exception(e, f"{action} skill")
        except Exception as e:
            logger.error(f"Error managing skills ({action}): {e}", exc_info=True)
            return MCPErrorFormatter.from_exception(e, f"{action} skill")


async def _handle_validate(client: httpx.AsyncClient, api_url: str, skill_content: str | None) -> str:
    """Validate skill content without persisting."""
    if not skill_content:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "skill_content is required for validate action",
        )

    response = await client.post(
        urljoin(api_url, "/api/skills/validate"),
        json={"content": skill_content},
    )

    if response.status_code == 200:
        return json.dumps({"success": True, **response.json()})
    else:
        return MCPErrorFormatter.from_http_error(response, "validate skill")


async def _handle_upload(
    client: httpx.AsyncClient, api_url: str, skill_content: str | None, skill_name: str | None
) -> str:
    """Upload or update a skill from content."""
    if not skill_content:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "skill_content is required for upload action",
        )

    # Parse frontmatter for metadata
    metadata = _parse_yaml_frontmatter(skill_content)
    name = skill_name or metadata.get("name")
    if not name:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "Skill name is required. Provide skill_name parameter or include 'name' in YAML frontmatter.",
        )

    description = metadata.get("description", "")

    create_payload = {
        "name": name,
        "description": description,
        "content": skill_content,
        "created_by": "mcp-upload",
    }

    # Try to create
    response = await client.post(urljoin(api_url, "/api/skills"), json=create_payload)

    if response.status_code in (200, 201):
        result = response.json()
        return json.dumps({
            "success": True,
            "skill": result.get("skill", result),
            "message": "Skill uploaded successfully",
            "created": True,
        })

    elif response.status_code == 409:
        # Skill already exists - find it by name and update
        list_response = await client.get(urljoin(api_url, "/api/skills"))
        if list_response.status_code != 200:
            return MCPErrorFormatter.from_http_error(list_response, "find existing skill for update")

        skills = list_response.json().get("skills", [])
        existing = next((s for s in skills if s.get("name") == name), None)

        if not existing:
            return MCPErrorFormatter.format_error(
                "conflict",
                f"Skill '{name}' reported as existing (409) but could not be found by name",
                suggestion="Try deleting the conflicting skill first, then re-upload",
            )

        existing_id = existing["id"]
        update_payload = {
            "content": skill_content,
            "updated_by": "mcp-upload",
        }
        if description:
            update_payload["description"] = description

        update_response = await client.put(
            urljoin(api_url, f"/api/skills/{existing_id}"),
            json=update_payload,
        )

        if update_response.status_code == 200:
            result = update_response.json()
            return json.dumps({
                "success": True,
                "skill": result.get("skill", result),
                "message": f"Skill '{name}' updated (already existed)",
                "created": False,
            })
        else:
            return MCPErrorFormatter.from_http_error(update_response, "update existing skill")

    else:
        return MCPErrorFormatter.from_http_error(response, "upload skill")


async def _handle_sync(
    client: httpx.AsyncClient,
    api_url: str,
    local_skills: list | None,
    system_fingerprint: str | None,
    system_name: str | None,
    project_id: str | None,
) -> str:
    """Sync local skills with the remote registry via the project sync endpoint."""
    if local_skills is None:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "local_skills array is required for sync action",
        )

    if not system_fingerprint:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "system_fingerprint is required for sync action",
        )

    if not project_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "project_id is required for sync action",
        )

    local_list = local_skills

    payload = {
        "fingerprint": system_fingerprint,
        "local_skills": local_list,
    }
    if system_name:
        payload["system_name"] = system_name

    response = await client.post(
        urljoin(api_url, f"/api/projects/{project_id}/sync"),
        json=payload,
    )

    if response.status_code != 200:
        return MCPErrorFormatter.from_http_error(response, "sync system with project")

    data = response.json()
    system = data.get("system", {})

    return json.dumps({
        "success": True,
        "system": system,
        "pending_install": data.get("pending_install", []),
        "pending_remove": data.get("pending_remove", []),
        "local_changes": data.get("local_changes", []),
        "unknown_local": data.get("unknown_local", []),
        "in_sync": data.get("in_sync", []),
        "message": (
            f"Sync complete: {len(data.get('in_sync', []))} in sync, "
            f"{len(data.get('pending_install', []))} to install, "
            f"{len(data.get('local_changes', []))} with local changes, "
            f"{len(data.get('unknown_local', []))} unknown local"
        ),
    })


async def _handle_install(
    client: httpx.AsyncClient, api_url: str, skill_id: str | None, project_id: str | None, system_id: str | None
) -> str:
    """Install a skill for a project."""
    if not skill_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "skill_id is required for install action",
        )
    if not project_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "project_id is required for install action",
        )

    if not system_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "system_id is required for install action",
        )

    payload = {"system_ids": [system_id]}

    response = await client.post(
        urljoin(api_url, f"/api/projects/{project_id}/skills/{skill_id}/install"),
        json=payload,
    )

    if response.status_code in (200, 201):
        result = response.json()
        return json.dumps({
            "success": True,
            "message": result.get("message", f"Skill {skill_id} install queued for project {project_id}"),
        })
    else:
        return MCPErrorFormatter.from_http_error(response, "install skill")


async def _handle_remove(
    client: httpx.AsyncClient, api_url: str, skill_id: str | None, project_id: str | None, system_id: str | None
) -> str:
    """Remove a skill from a project."""
    if not skill_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "skill_id is required for remove action",
        )
    if not project_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "project_id is required for remove action",
        )

    if not system_id:
        return MCPErrorFormatter.format_error(
            "validation_error",
            "system_id is required for remove action",
        )

    payload = {"system_ids": [system_id]}

    response = await client.post(
        urljoin(api_url, f"/api/projects/{project_id}/skills/{skill_id}/remove"),
        json=payload,
    )

    if response.status_code == 200:
        result = response.json()
        return json.dumps({
            "success": True,
            "message": result.get("message", f"Skill {skill_id} removal queued for project {project_id}"),
        })
    else:
        return MCPErrorFormatter.from_http_error(response, "remove skill")


async def _handle_bootstrap(
    client: httpx.AsyncClient,
    api_url: str,
    system_fingerprint: str | None,
    system_name: str | None,
    project_id: str | None,
) -> str:
    """Fetch all skills with content and optionally register the system with a project."""
    # Fetch all skills with full content
    response = await client.get(urljoin(api_url, "/api/skills"), params={"include_content": True})

    if response.status_code != 200:
        return MCPErrorFormatter.from_http_error(response, "fetch skills for bootstrap")

    data = response.json()
    raw_skills = data.get("skills", [])

    # Normalize: keep only name, display_name, content per skill
    skills = [
        {
            "name": s.get("name", ""),
            "display_name": s.get("display_name", ""),
            "content": s.get("content", ""),
        }
        for s in raw_skills
    ]

    # Register system with project when both fingerprint and project_id are provided
    system = None
    if system_fingerprint and project_id:
        payload: dict = {
            "fingerprint": system_fingerprint,
            "local_skills": [],
        }
        if system_name:
            payload["system_name"] = system_name

        sync_response = await client.post(
            urljoin(api_url, f"/api/projects/{project_id}/sync"),
            json=payload,
        )

        if sync_response.status_code == 200:
            system = sync_response.json().get("system")

    return json.dumps({
        "success": True,
        "skills": skills,
        "system": system,
        "install_path": "~/.claude/skills",
        "message": f"Bootstrap complete: {len(skills)} skill(s) ready to install",
    })
