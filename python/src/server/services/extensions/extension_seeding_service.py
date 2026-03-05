"""Seed bundled SKILL.md files into the archon_extensions database table on startup.

On each server start this service scans the integrations/claude-code/extensions/
directory tree, computes a content hash for every SKILL.md it finds, and
upserts into the registry:

  - new extension   → create (version 1)
  - unchanged       → skip
  - changed         → update (version bumped by 1)

This removes the need for a manual "upload" step when bundled extensions change.
"""

import re
from pathlib import Path
from typing import Any

from src.server.config.logfire_config import get_logger
from src.server.services.extensions.extension_service import ExtensionService

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


class ExtensionSeedingService:
    """Upserts bundled SKILL.md files into the archon_extensions registry."""

    def __init__(self, extension_service: ExtensionService | None = None) -> None:
        self.extension_service = extension_service or ExtensionService()

    @staticmethod
    def default_extensions_dir() -> Path:
        """Return the absolute path to the bundled extensions directory.

        Walks up the directory tree from this file's location until it finds
        an ancestor that contains integrations/claude-code/extensions/. This works
        for both local development (python/ is an intermediate directory) and
        Docker (python/ is stripped, /app is the root).
        """
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "integrations" / "claude-code" / "extensions"
            if candidate.is_dir():
                return candidate
        # Fall back to a sensible guess — caller handles missing path gracefully
        return Path(__file__).parents[5] / "integrations" / "claude-code" / "extensions"

    def seed_extensions(self, extensions_dir: Path | None = None) -> dict[str, int]:
        """Scan extensions_dir and upsert every SKILL.md into the registry.

        Args:
            extensions_dir: Directory to scan. Defaults to ``default_extensions_dir()``.

        Returns:
            Counts dict with keys ``created``, ``updated``, ``skipped``, ``errors``.
        """
        if extensions_dir is None:
            extensions_dir = self.default_extensions_dir()

        counts: dict[str, int] = {"created": 0, "updated": 0, "skipped": 0, "errors": 0}

        if not extensions_dir.exists():
            logger.warning(f"Extensions directory does not exist, skipping seed: {extensions_dir}")
            return counts

        for entry in sorted(extensions_dir.iterdir()):
            if not entry.is_dir():
                continue
            skill_md = entry / "SKILL.md"
            if not skill_md.exists():
                continue
            try:
                self._seed_one(skill_md, counts)
            except Exception:
                logger.error(
                    f"Failed to seed extension from {skill_md}",
                    exc_info=True,
                )
                counts["errors"] += 1

        logger.info(
            f"Extension seeding complete: {counts['created']} created, "
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
        content_hash = ExtensionService.compute_content_hash(content)
        existing: dict[str, Any] | None = self.extension_service.find_by_name(name)

        if existing is None:
            self.extension_service.create_extension(
                name,
                description,
                content,
                created_by="archon-seeder",
            )
            logger.info(f"Created extension: {name}")
            counts["created"] += 1
            return

        if existing["content_hash"] == content_hash:
            logger.debug(f"Extension unchanged, skipping: {name}")
            counts["skipped"] += 1
            return

        self.extension_service.update_extension(
            existing["id"],
            content,
            new_version=existing["current_version"] + 1,
            updated_by="archon-seeder",
            description=description or None,
        )
        logger.info(f"Updated extension: {name} -> v{existing['current_version'] + 1}")
        counts["updated"] += 1
