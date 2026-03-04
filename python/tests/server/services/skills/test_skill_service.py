"""
Unit tests for SkillService.

Tests CRUD operations, version management, content hashing,
and project skill overrides using mocked Supabase client.
"""

from unittest.mock import MagicMock, call

import pytest

from src.server.services.skills.skill_service import SkillService


# ── Fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_supabase():
    """Create a mock Supabase client with chainable query methods."""
    client = MagicMock()

    # Each table() call returns a fresh query builder so tests
    # can configure different chains independently.
    def _table(name):
        builder = MagicMock(name=f"table({name})")
        # Chainable: select/insert/update/delete/upsert -> eq/neq/order/limit -> execute
        for method in ("select", "insert", "update", "delete", "upsert"):
            getattr(builder, method).return_value = builder
        builder.eq.return_value = builder
        builder.neq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        return builder

    client.table.side_effect = _table
    return client


@pytest.fixture
def service(mock_supabase):
    """Create a SkillService instance with mocked Supabase."""
    return SkillService(supabase_client=mock_supabase)


# ── Content Hashing ────────────────────────────────────────────────────────


class TestComputeContentHash:
    def test_returns_sha256_hex_digest(self):
        """Hash output should be a 64-character hex string (SHA-256)."""
        result = SkillService.compute_content_hash("hello world")
        assert isinstance(result, str)
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)

    def test_same_content_same_hash(self):
        """Identical content must produce the same hash."""
        content = "---\nname: my-skill\n---\n## Body"
        assert SkillService.compute_content_hash(content) == SkillService.compute_content_hash(content)

    def test_different_content_different_hash(self):
        """Different content must produce different hashes."""
        hash_a = SkillService.compute_content_hash("content A")
        hash_b = SkillService.compute_content_hash("content B")
        assert hash_a != hash_b


# ── create_skill ────────────────────────────────────────────────────────────


class TestCreateSkill:
    def test_inserts_skill_and_saves_version(self, service, mock_supabase):
        """create_skill should insert into skills table and save version 1."""
        skill_row = {
            "id": "skill-uuid-1",
            "name": "my-skill",
            "description": "A useful skill",
            "content": "# Skill content",
            "content_hash": SkillService.compute_content_hash("# Skill content"),
            "current_version": 1,
            "created_by": "user-1",
        }

        # Configure skills table insert
        skills_builder = MagicMock()
        skills_builder.insert.return_value = skills_builder
        skills_builder.execute.return_value = MagicMock(data=[skill_row])

        # Configure versions table insert
        versions_builder = MagicMock()
        versions_builder.insert.return_value = versions_builder
        versions_builder.execute.return_value = MagicMock(data=[{"id": "version-uuid-1"}])

        def _table(name):
            if name == "archon_skills":
                return skills_builder
            if name == "archon_skill_versions":
                return versions_builder
            return MagicMock()

        mock_supabase.table.side_effect = _table

        result = service.create_skill(
            name="my-skill",
            description="A useful skill",
            content="# Skill content",
            created_by="user-1",
        )

        assert result["id"] == "skill-uuid-1"
        assert result["name"] == "my-skill"
        assert result["current_version"] == 1

        # Verify insert was called on skills table
        skills_builder.insert.assert_called_once()
        insert_data = skills_builder.insert.call_args[0][0]
        assert insert_data["name"] == "my-skill"
        assert insert_data["current_version"] == 1
        assert insert_data["content_hash"] == SkillService.compute_content_hash("# Skill content")

        # Verify version was saved
        versions_builder.insert.assert_called_once()

    def test_create_skill_raises_on_empty_response(self, service, mock_supabase):
        """create_skill should raise RuntimeError when insert returns no data."""
        builder = MagicMock()
        builder.insert.return_value = builder
        builder.execute.return_value = MagicMock(data=[])

        mock_supabase.table.side_effect = lambda name: builder

        with pytest.raises(RuntimeError, match="Failed to create skill"):
            service.create_skill(
                name="bad-skill",
                description="Will fail",
                content="# Content",
                created_by="user-1",
            )


# ── list_skills ─────────────────────────────────────────────────────────────


class TestListSkills:
    def test_returns_skills_without_content(self, service, mock_supabase):
        """list_skills should select specific fields excluding content."""
        skills_data = [
            {"id": "s1", "name": "skill-a", "description": "Desc A", "current_version": 1, "created_at": "2026-01-01"},
            {"id": "s2", "name": "skill-b", "description": "Desc B", "current_version": 2, "created_at": "2026-01-02"},
        ]

        builder = MagicMock()
        builder.select.return_value = builder
        builder.order.return_value = builder
        builder.execute.return_value = MagicMock(data=skills_data)

        mock_supabase.table.side_effect = lambda name: builder

        result = service.list_skills()

        assert len(result) == 2
        assert result[0]["name"] == "skill-a"
        assert result[1]["name"] == "skill-b"

        # Verify select was called with fields that exclude the full content column.
        # The select string may contain "content_hash" which is fine -- we check
        # that a bare "content" field (preceded by space or comma) is absent.
        builder.select.assert_called_once()
        select_arg = builder.select.call_args[0][0]
        fields = [f.strip() for f in select_arg.split(",")]
        assert "content" not in fields, "list_skills should not select the 'content' column"


# ── get_skill ───────────────────────────────────────────────────────────────


class TestGetSkill:
    def test_returns_full_skill_by_id(self, service, mock_supabase):
        """get_skill should return the full skill record including content."""
        skill_row = {
            "id": "s1",
            "name": "my-skill",
            "content": "# Full content",
            "current_version": 3,
        }

        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=[skill_row])

        mock_supabase.table.side_effect = lambda name: builder

        result = service.get_skill("s1")

        assert result is not None
        assert result["id"] == "s1"
        assert result["content"] == "# Full content"
        builder.select.assert_called_once_with("*")
        builder.eq.assert_called_once_with("id", "s1")

    def test_returns_none_for_missing_id(self, service, mock_supabase):
        """get_skill should return None when no skill is found."""
        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=[])

        mock_supabase.table.side_effect = lambda name: builder

        result = service.get_skill("nonexistent-id")

        assert result is None


# ── find_by_name ────────────────────────────────────────────────────────────


class TestFindByName:
    def test_finds_skill_by_name(self, service, mock_supabase):
        """find_by_name should look up a skill by its unique name."""
        skill_row = {"id": "s1", "name": "archon-memory", "content": "# Memory"}

        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=[skill_row])

        mock_supabase.table.side_effect = lambda name: builder

        result = service.find_by_name("archon-memory")

        assert result is not None
        assert result["name"] == "archon-memory"
        builder.eq.assert_called_once_with("name", "archon-memory")

    def test_returns_none_for_unknown_name(self, service, mock_supabase):
        """find_by_name should return None when no skill matches."""
        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=[])

        mock_supabase.table.side_effect = lambda name: builder

        result = service.find_by_name("nonexistent-skill")
        assert result is None


# ── update_skill ────────────────────────────────────────────────────────────


class TestUpdateSkill:
    def test_bumps_version_and_saves_history(self, service, mock_supabase):
        """update_skill should increment version and save to version history."""
        updated_row = {
            "id": "s1",
            "name": "my-skill",
            "content": "# Updated content",
            "content_hash": SkillService.compute_content_hash("# Updated content"),
            "current_version": 3,
        }

        # Configure skills table for update
        skills_builder = MagicMock()
        skills_builder.update.return_value = skills_builder
        skills_builder.eq.return_value = skills_builder
        skills_builder.execute.return_value = MagicMock(data=[updated_row])

        # Configure versions table for insert
        versions_builder = MagicMock()
        versions_builder.insert.return_value = versions_builder
        versions_builder.execute.return_value = MagicMock(data=[{"id": "v3"}])

        def _table(name):
            if name == "archon_skills":
                return skills_builder
            if name == "archon_skill_versions":
                return versions_builder
            return MagicMock()

        mock_supabase.table.side_effect = _table

        result = service.update_skill(
            skill_id="s1",
            content="# Updated content",
            new_version=3,
            updated_by="user-2",
        )

        assert result["current_version"] == 3
        assert result["content"] == "# Updated content"

        # Verify update was called
        skills_builder.update.assert_called_once()
        update_data = skills_builder.update.call_args[0][0]
        assert update_data["content"] == "# Updated content"
        assert update_data["current_version"] == 3
        assert "content_hash" in update_data
        assert "updated_at" in update_data

        # Verify version was saved
        versions_builder.insert.assert_called_once()

    def test_update_raises_on_empty_response(self, service, mock_supabase):
        """update_skill should raise RuntimeError when update returns no data."""
        builder = MagicMock()
        builder.update.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=[])

        mock_supabase.table.side_effect = lambda name: builder

        with pytest.raises(RuntimeError, match="Failed to update skill"):
            service.update_skill(
                skill_id="nonexistent",
                content="# Content",
                new_version=2,
                updated_by="user-1",
            )


# ── delete_skill ────────────────────────────────────────────────────────────


class TestDeleteSkill:
    def test_deletes_skill_by_id(self, service, mock_supabase):
        """delete_skill should issue a delete query filtered by skill ID."""
        builder = MagicMock()
        builder.delete.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=[])

        mock_supabase.table.side_effect = lambda name: builder

        service.delete_skill("s1")

        mock_supabase.table.assert_called_with("archon_skills")
        builder.delete.assert_called_once()
        builder.eq.assert_called_once_with("id", "s1")


# ── get_versions ────────────────────────────────────────────────────────────


class TestGetVersions:
    def test_returns_version_history(self, service, mock_supabase):
        """get_versions should return version history ordered by version number descending."""
        versions_data = [
            {"id": "v2", "skill_id": "s1", "version_number": 2, "content_hash": "abc123"},
            {"id": "v1", "skill_id": "s1", "version_number": 1, "content_hash": "def456"},
        ]

        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.execute.return_value = MagicMock(data=versions_data)

        mock_supabase.table.side_effect = lambda name: builder

        result = service.get_versions("s1")

        assert len(result) == 2
        assert result[0]["version_number"] == 2
        assert result[1]["version_number"] == 1

        mock_supabase.table.assert_called_with("archon_skill_versions")
        builder.eq.assert_called_once_with("skill_id", "s1")
        builder.order.assert_called_once_with("version_number", desc=True)


# ── save_project_override ───────────────────────────────────────────────────


class TestSaveProjectOverride:
    def test_upserts_into_project_skills(self, service, mock_supabase):
        """save_project_override should upsert into archon_project_skills."""
        override_row = {
            "project_id": "proj-1",
            "skill_id": "s1",
            "custom_content": "# Custom instructions",
            "is_enabled": True,
        }

        builder = MagicMock()
        builder.upsert.return_value = builder
        builder.execute.return_value = MagicMock(data=[override_row])

        mock_supabase.table.side_effect = lambda name: builder

        result = service.save_project_override(
            project_id="proj-1",
            skill_id="s1",
            custom_content="# Custom instructions",
            is_enabled=True,
        )

        assert result["project_id"] == "proj-1"
        assert result["skill_id"] == "s1"

        mock_supabase.table.assert_called_with("archon_project_skills")
        builder.upsert.assert_called_once()
        upsert_data = builder.upsert.call_args[0][0]
        assert upsert_data["project_id"] == "proj-1"
        assert upsert_data["skill_id"] == "s1"
        assert upsert_data["custom_content"] == "# Custom instructions"
        assert upsert_data["is_enabled"] is True


# ── get_project_skills ──────────────────────────────────────────────────────


class TestGetProjectSkills:
    def test_returns_project_skills(self, service, mock_supabase):
        """get_project_skills should return skills linked to a project."""
        project_skills_data = [
            {"project_id": "proj-1", "skill_id": "s1", "is_enabled": True, "custom_content": None},
            {"project_id": "proj-1", "skill_id": "s2", "is_enabled": False, "custom_content": "# Override"},
        ]

        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=project_skills_data)

        mock_supabase.table.side_effect = lambda name: builder

        result = service.get_project_skills("proj-1")

        assert len(result) == 2
        mock_supabase.table.assert_called_with("archon_project_skills")
        builder.eq.assert_called_once_with("project_id", "proj-1")
