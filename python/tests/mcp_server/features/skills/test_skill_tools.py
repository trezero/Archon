"""Unit tests for skills management tools."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from mcp.server.fastmcp import Context

from src.mcp_server.features.skills.skill_tools import register_skill_tools


@pytest.fixture
def mock_mcp():
    """Create a mock MCP server for testing."""
    mock = MagicMock()
    mock._tools = {}

    def tool_decorator():
        def decorator(func):
            mock._tools[func.__name__] = func
            return func

        return decorator

    mock.tool = tool_decorator
    return mock


@pytest.fixture
def mock_context():
    """Create a mock context for testing."""
    return MagicMock(spec=Context)


@pytest.fixture
def registered_tools(mock_mcp):
    """Register tools and return the tool dict."""
    register_skill_tools(mock_mcp)
    return mock_mcp._tools


# --------------------------------------------------------------------------- #
# find_skills tests
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_find_skills_list_all(registered_tools, mock_context):
    """Test listing all skills."""
    find_skills = registered_tools["find_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "skills": [
            {"id": "sk-1", "name": "memory", "description": "Memory skill"},
            {"id": "sk-2", "name": "deploy", "description": "Deploy skill"},
        ],
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_skills(mock_context)

        data = json.loads(result)
        assert data["success"] is True
        assert data["count"] == 2
        assert len(data["skills"]) == 2


@pytest.mark.asyncio
async def test_find_skills_search_by_query(registered_tools, mock_context):
    """Test searching skills by keyword."""
    find_skills = registered_tools["find_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "skills": [
            {"id": "sk-1", "name": "memory", "description": "Persistent memory skill"},
            {"id": "sk-2", "name": "deploy", "description": "Deployment automation"},
        ],
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_skills(mock_context, query="memory")

        data = json.loads(result)
        assert data["success"] is True
        assert data["count"] == 1
        assert data["skills"][0]["name"] == "memory"


@pytest.mark.asyncio
async def test_find_skills_by_id(registered_tools, mock_context):
    """Test getting a specific skill by ID."""
    find_skills = registered_tools["find_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "id": "sk-1",
        "name": "memory",
        "description": "Memory skill",
        "content": "# Full content here",
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_skills(mock_context, skill_id="sk-1")

        data = json.loads(result)
        assert data["success"] is True
        assert data["skill"]["id"] == "sk-1"
        assert data["skill"]["content"] == "# Full content here"


@pytest.mark.asyncio
async def test_find_skills_by_id_not_found(registered_tools, mock_context):
    """Test getting a non-existent skill."""
    find_skills = registered_tools["find_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 404
    mock_response.text = "Not found"

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_skills(mock_context, skill_id="non-existent")

        data = json.loads(result)
        assert data["success"] is False
        assert data["error"]["type"] == "not_found"


@pytest.mark.asyncio
async def test_find_skills_for_project(registered_tools, mock_context):
    """Test listing skills for a specific project."""
    find_skills = registered_tools["find_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "skills": [
            {"id": "sk-1", "name": "memory", "description": "Memory skill", "installed": True},
        ],
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await find_skills(mock_context, project_id="proj-1")

        data = json.loads(result)
        assert data["success"] is True
        assert data["project_id"] == "proj-1"
        assert data["count"] == 1


# --------------------------------------------------------------------------- #
# manage_skills tests
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_manage_skills_validate(registered_tools, mock_context):
    """Test validating skill content."""
    manage_skills = registered_tools["manage_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "valid": True,
        "name": "test-skill",
        "warnings": [],
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(
            mock_context,
            action="validate",
            skill_content="---\nname: test-skill\n---\n# Content",
        )

        data = json.loads(result)
        assert data["success"] is True
        assert data["valid"] is True


@pytest.mark.asyncio
async def test_manage_skills_validate_missing_content(registered_tools, mock_context):
    """Test validate fails when content is missing."""
    manage_skills = registered_tools["manage_skills"]

    result = await manage_skills(mock_context, action="validate")

    data = json.loads(result)
    assert data["success"] is False
    assert "skill_content" in data["error"]["message"]


@pytest.mark.asyncio
async def test_manage_skills_upload_new(registered_tools, mock_context):
    """Test uploading a new skill."""
    manage_skills = registered_tools["manage_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 201
    mock_response.json.return_value = {
        "skill": {"id": "sk-new", "name": "my-skill"},
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(
            mock_context,
            action="upload",
            skill_content="---\nname: my-skill\ndescription: A skill\nversion: 1.0\n---\n# Content",
        )

        data = json.loads(result)
        assert data["success"] is True
        assert data["created"] is True
        assert data["skill"]["name"] == "my-skill"


@pytest.mark.asyncio
async def test_manage_skills_upload_conflict_updates(registered_tools, mock_context):
    """Test uploading a skill that already exists triggers an update."""
    manage_skills = registered_tools["manage_skills"]

    # First POST returns 409
    mock_conflict_response = MagicMock()
    mock_conflict_response.status_code = 409
    mock_conflict_response.json.return_value = {"detail": "Skill already exists"}
    mock_conflict_response.text = '{"detail": "Skill already exists"}'

    # GET /api/skills returns existing skill
    mock_list_response = MagicMock()
    mock_list_response.status_code = 200
    mock_list_response.json.return_value = {
        "skills": [{"id": "sk-existing", "name": "my-skill"}],
    }

    # PUT update succeeds
    mock_update_response = MagicMock()
    mock_update_response.status_code = 200
    mock_update_response.json.return_value = {
        "skill": {"id": "sk-existing", "name": "my-skill"},
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_conflict_response
        mock_async_client.get.return_value = mock_list_response
        mock_async_client.put.return_value = mock_update_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(
            mock_context,
            action="upload",
            skill_content="---\nname: my-skill\n---\n# Updated content",
        )

        data = json.loads(result)
        assert data["success"] is True
        assert data["created"] is False
        assert "updated" in data["message"].lower()


@pytest.mark.asyncio
async def test_manage_skills_upload_missing_name(registered_tools, mock_context):
    """Test upload fails when no name is provided or parseable."""
    manage_skills = registered_tools["manage_skills"]

    result = await manage_skills(
        mock_context,
        action="upload",
        skill_content="# Just content, no frontmatter",
    )

    data = json.loads(result)
    assert data["success"] is False
    assert "name" in data["error"]["message"].lower()


@pytest.mark.asyncio
async def test_manage_skills_install(registered_tools, mock_context):
    """Test installing a skill for a project."""
    manage_skills = registered_tools["manage_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "message": "Skill installed successfully",
        "installation": {"skill_id": "sk-1", "project_id": "proj-1"},
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(
            mock_context,
            action="install",
            skill_id="sk-1",
            project_id="proj-1",
            system_id="sys-1",
        )

        data = json.loads(result)
        assert data["success"] is True
        assert "installed" in data["message"].lower()


@pytest.mark.asyncio
async def test_manage_skills_install_missing_params(registered_tools, mock_context):
    """Test install fails without required parameters."""
    manage_skills = registered_tools["manage_skills"]

    # Missing skill_id
    result = await manage_skills(mock_context, action="install", project_id="proj-1")
    data = json.loads(result)
    assert data["success"] is False
    assert "skill_id" in data["error"]["message"]

    # Missing project_id
    result = await manage_skills(mock_context, action="install", skill_id="sk-1")
    data = json.loads(result)
    assert data["success"] is False
    assert "project_id" in data["error"]["message"]


@pytest.mark.asyncio
async def test_manage_skills_remove(registered_tools, mock_context):
    """Test removing a skill from a project."""
    manage_skills = registered_tools["manage_skills"]

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"message": "Skill removed"}

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(
            mock_context,
            action="remove",
            skill_id="sk-1",
            project_id="proj-1",
            system_id="sys-1",
        )

        data = json.loads(result)
        assert data["success"] is True


@pytest.mark.asyncio
async def test_manage_skills_invalid_action(registered_tools, mock_context):
    """Test that an invalid action returns an error."""
    manage_skills = registered_tools["manage_skills"]

    result = await manage_skills(mock_context, action="bogus")

    data = json.loads(result)
    assert data["success"] is False
    assert data["error"]["type"] == "invalid_action"


@pytest.mark.asyncio
async def test_manage_skills_sync(registered_tools, mock_context):
    """Test sync calls the project sync endpoint and returns correct field names."""
    manage_skills = registered_tools["manage_skills"]

    # POST /api/projects/{project_id}/sync returns sync report
    mock_sync_response = MagicMock()
    mock_sync_response.status_code = 200
    mock_sync_response.json.return_value = {
        "system": {"id": "sys-1", "name": "My Machine", "is_new": True},
        "in_sync": ["memory"],
        "local_changes": [],
        "pending_install": [{"skill_id": "sk-2", "name": "deploy", "content": "---\nname: deploy\n---\n"}],
        "pending_remove": [],
        "unknown_local": [{"name": "new-skill", "content_hash": "ccc"}],
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.post.return_value = mock_sync_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        local_skills = json.dumps([
            {"name": "memory", "content_hash": "aaa"},
            {"name": "new-skill", "content_hash": "ccc"},
        ])

        result = await manage_skills(
            mock_context,
            action="sync",
            local_skills=local_skills,
            system_fingerprint="fp-test",
            system_name="My Machine",
            project_id="proj-1",
        )

        data = json.loads(result)
        assert data["success"] is True
        assert data["system"]["id"] == "sys-1"
        assert data["system"]["is_new"] is True
        assert data["in_sync"] == ["memory"]
        assert len(data["pending_install"]) == 1
        assert data["pending_install"][0]["name"] == "deploy"
        assert len(data["unknown_local"]) == 1
        assert data["unknown_local"][0]["name"] == "new-skill"


@pytest.mark.asyncio
async def test_manage_skills_sync_missing_params(registered_tools, mock_context):
    """Test sync fails without required parameters."""
    manage_skills = registered_tools["manage_skills"]

    # Missing local_skills
    result = await manage_skills(mock_context, action="sync", system_fingerprint="fp")
    data = json.loads(result)
    assert data["success"] is False

    # Missing system_fingerprint
    result = await manage_skills(mock_context, action="sync", local_skills="[]")
    data = json.loads(result)
    assert data["success"] is False

    # Missing project_id
    result = await manage_skills(mock_context, action="sync", local_skills="[]", system_fingerprint="fp")
    data = json.loads(result)
    assert data["success"] is False


@pytest.mark.asyncio
async def test_manage_skills_bootstrap_basic(registered_tools, mock_context):
    """Bootstrap returns all skills and registers system when fingerprint+project provided."""
    manage_skills = registered_tools["manage_skills"]

    mock_skills_response = MagicMock()
    mock_skills_response.status_code = 200
    mock_skills_response.json.return_value = {
        "skills": [
            {"name": "archon-memory", "content": "---\nname: archon-memory\n---\n# Content", "display_name": "Archon Memory"},
            {"name": "archon-bootstrap", "content": "---\nname: archon-bootstrap\n---\n# Bootstrap", "display_name": "Archon Bootstrap"},
        ]
    }

    mock_sync_response = MagicMock()
    mock_sync_response.status_code = 200
    mock_sync_response.json.return_value = {
        "system": {"id": "sys-1", "name": "My Mac", "is_new": True},
        "in_sync": [], "pending_install": [], "pending_remove": [],
        "local_changes": [], "unknown_local": [],
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_skills_response
        mock_async_client.post.return_value = mock_sync_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(
            mock_context,
            action="bootstrap",
            system_fingerprint="fp-abc",
            system_name="My Mac",
            project_id="proj-1",
        )

        data = json.loads(result)
        assert data["success"] is True
        assert len(data["skills"]) == 2
        assert data["skills"][0]["name"] == "archon-memory"
        assert data["system"]["id"] == "sys-1"
        assert data["system"]["is_new"] is True
        assert data["install_path"] == "~/.claude/skills"
        assert "Bootstrap complete" in data["message"]


@pytest.mark.asyncio
async def test_manage_skills_bootstrap_no_project(registered_tools, mock_context):
    """Bootstrap without project_id skips sync call, still returns skills."""
    manage_skills = registered_tools["manage_skills"]

    mock_skills_response = MagicMock()
    mock_skills_response.status_code = 200
    mock_skills_response.json.return_value = {
        "skills": [{"name": "archon-memory", "content": "---\nname: archon-memory\n---\n# Content", "display_name": "Archon Memory"}]
    }

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_skills_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(mock_context, action="bootstrap")

        data = json.loads(result)
        assert data["success"] is True
        assert len(data["skills"]) == 1
        assert data["system"] is None
        mock_async_client.post.assert_not_called()


@pytest.mark.asyncio
async def test_manage_skills_bootstrap_not_invalid_action(registered_tools, mock_context):
    """'bootstrap' is now a valid action and must NOT return invalid_action error."""
    manage_skills = registered_tools["manage_skills"]

    mock_skills_response = MagicMock()
    mock_skills_response.status_code = 200
    mock_skills_response.json.return_value = {"skills": []}

    with patch("src.mcp_server.features.skills.skill_tools.httpx.AsyncClient") as mock_client:
        mock_async_client = AsyncMock()
        mock_async_client.get.return_value = mock_skills_response
        mock_client.return_value.__aenter__.return_value = mock_async_client

        result = await manage_skills(mock_context, action="bootstrap")
        data = json.loads(result)
        assert data.get("error", {}).get("type") != "invalid_action"
