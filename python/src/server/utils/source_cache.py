"""
In-memory cache for project → source_id mappings.

Used by _resolve_project_source_filter() in knowledge_api.py to avoid
repeated DB queries during search. Cache is invalidated when sources or
project hierarchy changes.
"""

import time

from ..config.logfire_config import get_logger

logger = get_logger(__name__)

# Cache: key = "{project_id}:{include_parent}" → (source_ids, timestamp)
_source_cache: dict[str, tuple[list[str], float]] = {}
_CACHE_TTL = 300  # 5 minutes


def get_cached_project_sources(project_id: str, include_parent: bool) -> tuple[list[str] | None, bool]:
    """Check cache for project sources.

    Returns:
        (source_ids, hit) — source_ids is None on cache miss.
    """
    cache_key = f"{project_id}:{include_parent}"
    now = time.time()

    if cache_key in _source_cache:
        cached_ids, cached_at = _source_cache[cache_key]
        if now - cached_at < _CACHE_TTL:
            return cached_ids, True

    return None, False


def set_cached_project_sources(project_id: str, include_parent: bool, source_ids: list[str]) -> None:
    """Store project sources in cache."""
    cache_key = f"{project_id}:{include_parent}"
    _source_cache[cache_key] = (source_ids, time.time())


def invalidate_source_cache(project_id: str | None = None) -> None:
    """Invalidate cache entries.

    Args:
        project_id: If provided, only invalidate entries for this project.
                    If None, clear entire cache.
    """
    if project_id:
        keys_to_remove = [k for k in _source_cache if k.startswith(f"{project_id}:")]
        for k in keys_to_remove:
            del _source_cache[k]
        if keys_to_remove:
            logger.debug(f"Invalidated {len(keys_to_remove)} source cache entries for project {project_id}")
    else:
        count = len(_source_cache)
        _source_cache.clear()
        if count:
            logger.debug(f"Cleared entire source cache ({count} entries)")
