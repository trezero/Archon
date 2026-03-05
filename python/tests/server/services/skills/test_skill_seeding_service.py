"""
Unit tests for SkillSeedingService.

Tests upsert logic (create / skip / update) for bundled SKILL.md files,
using tmp_path for a temporary skills directory and MagicMock for SkillService.
"""

import textwrap
from pathlib import Path
from unittest.mock import MagicMock, call

import pytest

from src.server.services.skills.skill_seeding_service import SkillSeedingService
from src.server.services.skills.skill_service import SkillService

# ── Fixtures & Helpers ───────────────────────────────────────────────────────

SAMPLE_SKILL_MD = textwrap.dedent("""\
    ---
    name: archon-memory
    description: Manage long-term knowledge memory via Archon RAG.
    ---

    # Archon Memory

    Some content here.
""")


def _make_skill_dir(base: Path, skill_name: str, content: str) -> Path:
    """Create a skill subdirectory with a SKILL.md file."""
    skill_dir = base / skill_name
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(content)
    return skill_dir


@pytest.fixture
def mock_skill_service():
    """Return a MagicMock standing in for SkillService."""
    return MagicMock(spec=SkillService)


@pytest.fixture
def service(mock_skill_service):
    """Create a SkillSeedingService with the mocked SkillService."""
    return SkillSeedingService(skill_service=mock_skill_service)


# ── Tests ────────────────────────────────────────────────────────────────────


class TestSeedOneCreatePath:
    def test_creates_new_skill_when_not_in_registry(self, service, mock_skill_service, tmp_path):
        """When find_by_name returns None, create_skill is called with correct args."""
        mock_skill_service.find_by_name.return_value = None
        mock_skill_service.create_skill.return_value = {"id": "abc123", "name": "archon-memory"}

        _make_skill_dir(tmp_path, "archon-memory", SAMPLE_SKILL_MD)

        counts = service.seed_skills(tmp_path)

        mock_skill_service.find_by_name.assert_called_once_with("archon-memory")
        mock_skill_service.create_skill.assert_called_once_with(
            "archon-memory",
            "Manage long-term knowledge memory via Archon RAG.",
            SAMPLE_SKILL_MD,
            created_by="archon-seeder",
        )
        assert counts == {"created": 1, "updated": 0, "skipped": 0, "errors": 0}


class TestSeedOneSkipPath:
    def test_skips_skill_when_hash_unchanged(self, service, mock_skill_service, tmp_path):
        """When the content hash matches the registry, neither create nor update is called."""
        content_hash = SkillService.compute_content_hash(SAMPLE_SKILL_MD)
        mock_skill_service.find_by_name.return_value = {
            "id": "abc123",
            "name": "archon-memory",
            "content_hash": content_hash,
            "current_version": 1,
        }

        _make_skill_dir(tmp_path, "archon-memory", SAMPLE_SKILL_MD)

        counts = service.seed_skills(tmp_path)

        mock_skill_service.create_skill.assert_not_called()
        mock_skill_service.update_skill.assert_not_called()
        assert counts == {"created": 0, "updated": 0, "skipped": 1, "errors": 0}


class TestSeedOneUpdatePath:
    def test_updates_skill_when_hash_changed(self, service, mock_skill_service, tmp_path):
        """When the content hash differs, update_skill is called with new_version bumped by 1."""
        mock_skill_service.find_by_name.return_value = {
            "id": "abc123",
            "name": "archon-memory",
            "content_hash": "old-hash-does-not-match",
            "current_version": 2,
        }
        mock_skill_service.update_skill.return_value = {"id": "abc123"}

        _make_skill_dir(tmp_path, "archon-memory", SAMPLE_SKILL_MD)

        counts = service.seed_skills(tmp_path)

        mock_skill_service.update_skill.assert_called_once_with(
            "abc123",
            SAMPLE_SKILL_MD,
            new_version=3,
            updated_by="archon-seeder",
            description="Manage long-term knowledge memory via Archon RAG.",
        )
        mock_skill_service.create_skill.assert_not_called()
        assert counts == {"created": 0, "updated": 1, "skipped": 0, "errors": 0}


class TestSeedSkipsDirectoryWithoutSkillMd:
    def test_skips_directory_without_skill_md(self, service, mock_skill_service, tmp_path):
        """A subdirectory that contains no SKILL.md is silently skipped."""
        empty_dir = tmp_path / "no-skill-here"
        empty_dir.mkdir()

        counts = service.seed_skills(tmp_path)

        mock_skill_service.find_by_name.assert_not_called()
        assert counts == {"created": 0, "updated": 0, "skipped": 0, "errors": 0}


class TestSeedSkipsSkillWithNoName:
    def test_skips_skill_with_no_name_in_frontmatter(self, service, mock_skill_service, tmp_path):
        """A SKILL.md that lacks a 'name' field in frontmatter is skipped (no DB call)."""
        no_name_md = textwrap.dedent("""\
            # Just a plain markdown file

            No frontmatter at all.
        """)
        _make_skill_dir(tmp_path, "nameless-skill", no_name_md)

        counts = service.seed_skills(tmp_path)

        mock_skill_service.find_by_name.assert_not_called()
        assert counts == {"created": 0, "updated": 0, "skipped": 1, "errors": 0}


class TestSeedMultipleSkills:
    def test_seeds_multiple_skills(self, service, mock_skill_service, tmp_path):
        """All skills in subdirectories are processed; create_skill called once per new skill."""
        mock_skill_service.find_by_name.return_value = None
        mock_skill_service.create_skill.return_value = {"id": "new-id"}

        for skill_name in ("skill-alpha", "skill-beta", "skill-gamma"):
            skill_md = textwrap.dedent(f"""\
                ---
                name: {skill_name}
                description: Description for {skill_name}.
                ---

                Content for {skill_name}.
            """)
            _make_skill_dir(tmp_path, skill_name, skill_md)

        counts = service.seed_skills(tmp_path)

        assert mock_skill_service.create_skill.call_count == 3
        assert counts == {"created": 3, "updated": 0, "skipped": 0, "errors": 0}


class TestSeedContinuesOnError:
    def test_continues_on_error_for_one_skill(self, service, mock_skill_service, tmp_path):
        """An error processing one skill is caught; remaining skills are still processed."""
        # Two skills: first raises, second succeeds
        call_count = 0

        def find_by_name_side_effect(name):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise RuntimeError("DB connection lost")
            return None

        mock_skill_service.find_by_name.side_effect = find_by_name_side_effect
        mock_skill_service.create_skill.return_value = {"id": "new-id"}

        for skill_name in ("skill-one", "skill-two"):
            skill_md = textwrap.dedent(f"""\
                ---
                name: {skill_name}
                description: A skill.
                ---

                Content.
            """)
            _make_skill_dir(tmp_path, skill_name, skill_md)

        counts = service.seed_skills(tmp_path)

        assert counts["errors"] == 1
        assert counts["created"] == 1
        assert counts["created"] + counts["errors"] == 2


class TestDefaultDirResolvesCorrectly:
    def test_default_dir_resolves_correctly(self, service):
        """default_skills_dir() should end with integrations/claude-code/skills."""
        default_dir = service.default_skills_dir()
        parts = default_dir.parts
        assert parts[-3:] == ("integrations", "claude-code", "skills")
