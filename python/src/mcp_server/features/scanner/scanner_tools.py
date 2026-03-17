"""Local Project Scanner MCP tools.

Provides two tools:
- scan_local_projects: Scan a directory for Git repositories
- apply_scan_template: Apply setup to scanned projects (bulk /archon-setup)
"""

import json
import logging
from urllib.parse import urljoin

import httpx
from mcp.server.fastmcp import Context, FastMCP

from src.mcp_server.utils.error_handling import MCPErrorFormatter
from src.mcp_server.utils.timeout_config import get_default_timeout
from src.server.config.service_discovery import get_api_url

logger = logging.getLogger(__name__)


def register_scanner_tools(mcp: FastMCP):
    """Register scanner tools with MCP server."""

    @mcp.tool()
    async def scan_local_projects(
        ctx: Context,
        system_fingerprint: str,
        directory_path: str | None = None,
    ) -> str:
        """Scan the mounted projects directory for Git repositories.

        Detects repos, extracts GitHub metadata, reads README content,
        identifies project groups (directories containing multiple repos),
        captures dependencies and infrastructure markers, and
        cross-references with existing Archon projects to flag duplicates.

        Args:
            system_fingerprint: Your system's fingerprint (from archon-state.json)
            directory_path: Subdirectory within mounted projects root (optional)

        Returns: JSON with scan_id, project list, and summary statistics.
                 Each project includes readme_excerpt for description generation.
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(120.0, connect=10.0)

            payload = {
                "system_fingerprint": system_fingerprint,
            }
            if directory_path:
                payload["directory_path"] = directory_path

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/scanner/scan"),
                    json=payload,
                )

                if response.status_code == 503:
                    return MCPErrorFormatter.format_error(
                        error_type="service_unavailable",
                        message="Scanner is not enabled",
                        suggestion="Set SCANNER_ENABLED=true and PROJECTS_DIRECTORY "
                        "in your .env file, then restart Docker.",
                    )

                if response.status_code != 200:
                    return MCPErrorFormatter.from_http_error(response, "scanning projects")

                result = response.json()

                # Build user-friendly summary
                summary = result.get("summary", {})
                projects = result.get("projects", [])

                output = {
                    "scan_id": result["scan_id"],
                    "summary": {
                        "total_found": summary.get("total_found", 0),
                        "new_projects": summary.get("new_projects", 0),
                        "already_in_archon": summary.get("already_in_archon", 0),
                        "project_groups": summary.get("project_groups", 0),
                        "group_names": summary.get("group_names", []),
                    },
                    "projects": [
                        {
                            "id": p["id"],
                            "directory_name": p["directory_name"],
                            "host_path": p["host_path"],
                            "github_url": p.get("github_url"),
                            "detected_languages": p.get("detected_languages", []),
                            "project_indicators": p.get("project_indicators", []),
                            "infra_markers": p.get("infra_markers", []),
                            "has_readme": p.get("has_readme", False),
                            "readme_excerpt": p.get("readme_excerpt"),
                            "is_project_group": p.get("is_project_group", False),
                            "group_name": p.get("group_name"),
                            "already_in_archon": p.get("already_in_archon", False),
                        }
                        for p in projects
                    ],
                }

                return json.dumps(output, indent=2)

        except httpx.ConnectError:
            return MCPErrorFormatter.format_error(
                error_type="connection_error",
                message="Cannot connect to Archon server",
                suggestion="Ensure Archon server is running and accessible",
            )
        except Exception as e:
            logger.error(f"Error in scan_local_projects: {e}", exc_info=True)
            return MCPErrorFormatter.format_error(
                error_type="internal_error",
                message=str(e),
                suggestion="Check Archon server logs for details",
            )

    @mcp.tool()
    async def apply_scan_template(
        ctx: Context,
        scan_id: str,
        system_fingerprint: str,
        system_name: str,
        selected_project_ids: list[str] | None = None,
        descriptions: dict[str, str] | None = None,
        template: dict | None = None,
    ) -> str:
        """Apply setup to scanned projects — equivalent to running /archon-setup
        in each project directory.

        Creates Archon projects, writes .claude/ config files, installs extensions,
        updates .gitignore, ingests READMEs into knowledge base, and starts
        knowledge source crawling for each selected project.

        If a previous apply was interrupted, this safely resumes from where it
        left off (all steps are idempotent).

        Args:
            scan_id: The scan_id from scan_local_projects
            system_fingerprint: Your system's fingerprint
            system_name: Your system's name
            selected_project_ids: Project IDs to include (None = all new projects)
            descriptions: Dict of directory_name -> AI-generated description
            template: Override template settings (None = use defaults)

        Returns: JSON with operation summary including created/skipped/failed counts
                 and scan report.
        """
        try:
            api_url = get_api_url()
            timeout = httpx.Timeout(600.0, connect=10.0)  # Long timeout for bulk operations

            payload: dict = {
                "scan_id": scan_id,
                "system_fingerprint": system_fingerprint,
                "system_name": system_name,
            }
            if selected_project_ids is not None:
                payload["selected_project_ids"] = selected_project_ids
            if descriptions is not None:
                payload["descriptions"] = descriptions
            if template is not None:
                payload["template"] = template

            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    urljoin(api_url, "/api/scanner/apply"),
                    json=payload,
                )

                if response.status_code == 503:
                    return MCPErrorFormatter.format_error(
                        error_type="service_unavailable",
                        message="Scanner is not enabled",
                        suggestion="Set SCANNER_ENABLED=true and PROJECTS_DIRECTORY "
                        "in your .env file, then restart Docker.",
                    )

                if response.status_code != 200:
                    return MCPErrorFormatter.from_http_error(response, "applying scan template")

                result = response.json()

                output = {
                    "success": True,
                    "created": result.get("created", 0),
                    "skipped": result.get("skipped", 0),
                    "failed": result.get("failed", 0),
                    "crawls_queued": result.get("crawls_queued", 0),
                    "report_csv_path": result.get("report_csv_path"),
                    "report_summary": result.get("report_summary"),
                }

                if result.get("message"):
                    output["message"] = result["message"]

                return json.dumps(output, indent=2)

        except httpx.ConnectError:
            return MCPErrorFormatter.format_error(
                error_type="connection_error",
                message="Cannot connect to Archon server",
                suggestion="Ensure Archon server is running and accessible",
            )
        except Exception as e:
            logger.error(f"Error in apply_scan_template: {e}", exc_info=True)
            return MCPErrorFormatter.format_error(
                error_type="internal_error",
                message=str(e),
                suggestion="Check Archon server logs for details",
            )
