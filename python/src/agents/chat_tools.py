"""ChatAgent tool implementations using MCPClient for data operations."""
from __future__ import annotations

import json
import logging
from typing import Any

from .mcp_client import get_mcp_client

logger = logging.getLogger(__name__)


def _to_json(result: Any) -> str:
    """Normalize an MCP result to a JSON string."""
    if isinstance(result, str):
        return result
    return json.dumps(result, default=str)


async def tool_search_knowledge_base(query: str, source_id: str | None = None, match_count: int = 5) -> str:
    """Search the knowledge base via RAG query."""
    client = await get_mcp_client()
    result = await client.perform_rag_query(query, source=source_id, match_count=match_count)
    return result  # perform_rag_query already returns a JSON string


async def tool_list_projects() -> str:
    """List all projects with their status, categories, and goals."""
    client = await get_mcp_client()
    result = await client.call_tool("find_projects")
    return _to_json(result)


async def tool_get_project_detail(project_id: str) -> str:
    """Get detailed information about a specific project."""
    client = await get_mcp_client()
    result = await client.call_tool("find_projects", project_id=project_id)
    return _to_json(result)


async def tool_list_tasks(project_id: str | None = None, status: str | None = None) -> str:
    """List tasks, optionally filtered by project or status."""
    client = await get_mcp_client()
    kwargs: dict[str, Any] = {}
    if project_id:
        kwargs["filter_by"] = "project"
        kwargs["filter_value"] = project_id
    elif status:
        kwargs["filter_by"] = "status"
        kwargs["filter_value"] = status
    result = await client.call_tool("find_tasks", **kwargs)
    return _to_json(result)


async def tool_get_task_detail(task_id: str) -> str:
    """Get detailed information about a specific task."""
    client = await get_mcp_client()
    result = await client.call_tool("find_tasks", task_id=task_id)
    return _to_json(result)


async def tool_list_documents(project_id: str) -> str:
    """List documents for a specific project."""
    client = await get_mcp_client()
    result = await client.call_tool("find_documents", project_id=project_id)
    return _to_json(result)


async def tool_get_session_history(query: str | None = None) -> str:
    """Search recent session history across machines."""
    client = await get_mcp_client()
    if query:
        result = await client.call_tool("archon_search_sessions", query=query)
    else:
        result = await client.call_tool("archon_search_sessions")
    return _to_json(result)


async def tool_search_code_examples(query: str) -> str:
    """Search for code examples in the knowledge base."""
    client = await get_mcp_client()
    result = await client.search_code_examples(query)
    return result  # search_code_examples already returns a JSON string


async def tool_suggest_project_category(
    project_name: str, description: str, existing_categories: list[str]
) -> str:
    """Returns context for the AI to suggest a category for the project."""
    return json.dumps({
        "project_name": project_name,
        "description": description,
        "existing_categories": existing_categories,
        "instruction": "Based on the project name, description, and existing categories, suggest the most appropriate category.",
    })
