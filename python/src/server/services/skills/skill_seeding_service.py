"""Seed bundled SKILL.md files into the archon_skills database table on startup.

On each server start this service scans the integrations/claude-code/skills/
directory tree, computes a content hash for every SKILL.md it finds, and
upserts into the registry:

  - new skill   → create (version 1)
  - unchanged   → skip
  - changed     → update (version bumped by 1)

This removes the need for a manual "upload" step when bundled skills change.
"""

import re
from pathlib import Path
from typing import Any

from src.server.config.logfire_config import get_logger
from src.server.services.skills.skill_service import SkillService

logger = get_logger(__name__)

_FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)
_FIELD_RE = re.compile(r"^(\w+)\s*:\s*(.+)$", re.MULTILINE)


def _parse_frontmatter(content: str) -> dict[str, str]:
    """Return a dict of key→value pairs from the YAML frontmatter block.

    Only simple scalar fields (key: value) are extracted; nested YAML is
    intentionally ignored because SKILL.md files only use flat metadata.
    Returns an empty dict when no frontmatter block is found.
    """
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return {}
    fm_block = match.group(1)
    return {m.group(1): m.group(2).strip() for m in _FIELD_RE.finditer(fm_block)}


class SkillSeedingService:
    """Upserts bundled SKILL.md files into the archon_skills registry."""

    def __init__(self, skill_service: SkillService | None = None) -> None:
        self.skill_service = skill_service or SkillService()

    @staticmethod
    def default_skills_dir() -> Path:
        """Return the absolute path to the bundled skills directory.

        Walks up the directory tree from this file's location until it finds
        an ancestor that contains integrations/claude-code/skills/. This works
        for both local development (python/ is an intermediate directory) and
        Docker (python/ is stripped, /app is the root).
        """
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "integrations" / "claude-code" / "skills"
            if candidate.is_dir():
                return candidate
        # Fall back to a sensible guess — caller handles missing path gracefully
        return Path(__file__).parents[5] / "integrations" / "claude-code" / "skills"

    def seed_skills(self, skills_dir: Path | None = None) -> dict[str, int]:
        """Scan skills_dir and upsert every SKILL.md into the registry.

        Args:
            skills_dir: Directory to scan. Defaults to ``default_skills_dir()``.

        Returns:
            Counts dict with keys ``created``, ``updated``, ``skipped``, ``errors``.
        """
        if skills_dir is None:
            skills_dir = self.default_skills_dir()

        counts: dict[str, int] = {"created": 0, "updated": 0, "skipped": 0, "errors": 0}

        if not skills_dir.exists():
            logger.warning(f"Skills directory does not exist, skipping seed: {skills_dir}")
            return counts

        for entry in sorted(skills_dir.iterdir()):
            if not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.exists():
                continue
            try:
                self._seed_one(skill_md, counts)
            except Exception:
                logger.error(
                    f"Failed to seed skill from {skill_md}",
                    exc_info=True,
                )
                counts["errors"] += 1

        logger.info(
            f"Skill seeding complete: {counts['created']} created, "
            f"{counts['updated']} updated, {counts['skipped']} skipped, "
            f"{counts['errors']} errors"
        )
        return counts

    def _seed_one(self, skill_md: Path, counts: dict[str, int]) -> None:
        """Upsert a single SKILL.md into the registry.

        Args:
            skill_md: Absolute path to the SKILL.md file.
            counts: Mutable counts dict updated in place.
        """
        content = skill_md.read_text(encoding="utf-8")
        frontmatter = _parse_frontmatter(content)

        name = frontmatter.get("name")
        if not name:
            logger.warning(f"No 'name' in frontmatter, skipping: {skill_md}")
            counts["skipped"] += 1
            return

        description = frontmatter.get("description", "")
        content_hash = SkillService.compute_content_hash(content)
        existing: dict[str, Any] | None = self.skill_service.find_by_name(name)

        if existing is None:
            self.skill_service.create_skill(
                name,
                description,
                content,
                created_by="archon-seeder",
            )
            logger.info(f"Created skill: {name}")
            counts["created"] += 1
            return

        if existing["content_hash"] == content_hash:
            logger.debug(f"Skill unchanged, skipping: {name}")
            counts["skipped"] += 1
            return

        self.skill_service.update_skill(
            existing["id"],
            content,
            new_version=existing["current_version"] + 1,
            updated_by="archon-seeder",
            description=description or None,
        )
        logger.info(f"Updated skill: {name} -> v{existing['current_version'] + 1}")
        counts["updated"] += 1
