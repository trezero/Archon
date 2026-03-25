"""Sequence mining service using PrefixSpan for temporal workflow pattern detection.

Finds frequent subsequences in (action_verb, target_object) tuples grouped by
repository per ISO week. Filters for patterns with sufficient support across
multiple repositories, surfacing cross-repo workflow patterns.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from prefixspan import PrefixSpan

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class SequenceMiningService:
    """Mines frequent action sequences from normalized activity events."""

    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def mine_sequences(
        self,
        lookback_days: int = 30,
        min_support: int = 3,
        min_repos: int = 2,
    ) -> tuple[bool, dict[str, Any]]:
        """Find frequent action sequences across repositories.

        Queries normalized events from the last lookback_days, groups them into
        per-repo-per-week sequences, runs PrefixSpan to find frequent subsequences,
        then filters for patterns that appear in at least min_repos distinct repos.

        Returns (True, result_dict) on success or (False, error_dict) on failure.
        """
        try:
            cutoff = (datetime.now(UTC) - timedelta(days=lookback_days)).isoformat()
            result = (
                self.supabase_client.table("activity_events")
                .select("id, repo_url, project_id, action_verb, target_object, created_at")
                .not_("normalized_at", "is", None)
                .not_("action_verb", "is", None)
                .gte("created_at", cutoff)
                .execute()
            )
            events: list[dict] = result.data or []

            if not events:
                return True, {"patterns": [], "total_sequences": 0, "filtered_count": 0}

            sequences = self._build_sequences_by_repo_week(events)
            total_sequences = len(sequences)

            if not sequences:
                return True, {"patterns": [], "total_sequences": 0, "filtered_count": 0}

            # PrefixSpan requires sequences of length >= 1; skip empty ones
            valid_sequences = [s for s in sequences if len(s) >= 1]
            ps = PrefixSpan(valid_sequences)
            ps.minlen = 2
            ps.maxlen = 10
            frequent = ps.frequent(min_support)

            filtered = self._filter_cross_repo(frequent, events, min_repos)

            return True, {
                "patterns": filtered,
                "total_sequences": total_sequences,
                "filtered_count": len(filtered),
            }

        except Exception:
            logger.exception("mine_sequences failed", exc_info=True)
            return False, {"error": "Failed to mine sequences from activity events"}

    def _build_sequences_by_repo_week(self, events: list[dict]) -> list[list[str]]:
        """Group events by (repo_url or project_id, ISO week) and sort chronologically.

        Returns a list of sequences where each sequence is a list of
        "action_verb:target_object" strings ordered by created_at.
        """
        groups: dict[tuple[str, str], list[dict]] = {}

        for event in events:
            repo_key = event.get("repo_url") or event.get("project_id") or "unknown"
            try:
                dt = datetime.fromisoformat(event["created_at"].replace("Z", "+00:00"))
            except (ValueError, AttributeError, KeyError):
                continue
            iso_week = f"{dt.isocalendar().year}-W{dt.isocalendar().week:02d}"
            group_key = (repo_key, iso_week)
            groups.setdefault(group_key, []).append(event)

        sequences: list[list[str]] = []
        for group_events in groups.values():
            group_events.sort(key=lambda e: e.get("created_at", ""))
            sequence = [
                f"{e['action_verb']}:{e['target_object']}"
                for e in group_events
                if e.get("action_verb") and e.get("target_object")
            ]
            if sequence:
                sequences.append(sequence)

        return sequences

    def _filter_cross_repo(
        self,
        patterns: list[tuple[int, list[str]]],
        events: list[dict],
        min_repos: int,
    ) -> list[dict[str, Any]]:
        """Filter PrefixSpan patterns by minimum distinct-repo presence.

        For each pattern, determines which repos contain ALL items in the sequence
        (as a subsequence). Keeps only patterns present in >= min_repos repos.

        Returns a list of dicts with keys: sequence, support, repos, length.
        """
        if not patterns:
            return []

        # Build a per-repo set of (action_verb:target_object) items for quick lookup
        # and a per-repo list of ordered items for subsequence checking
        repo_sequences: dict[str, list[str]] = {}
        for event in events:
            repo_key = event.get("repo_url") or event.get("project_id") or "unknown"
            item = f"{event.get('action_verb', '')}:{event.get('target_object', '')}"
            if event.get("action_verb") and event.get("target_object"):
                repo_sequences.setdefault(repo_key, []).append(item)

        filtered: list[dict[str, Any]] = []
        for support, sequence in patterns:
            repos_with_pattern: list[str] = []
            for repo, repo_items in repo_sequences.items():
                if _is_subsequence(sequence, repo_items):
                    repos_with_pattern.append(repo)
            if len(repos_with_pattern) >= min_repos:
                filtered.append({
                    "sequence": sequence,
                    "support": support,
                    "repos": repos_with_pattern,
                    "length": len(sequence),
                })

        return filtered


def _is_subsequence(pattern: list[str], items: list[str]) -> bool:
    """Return True if pattern is a subsequence of items (order-preserving)."""
    it = iter(items)
    return all(item in it for item in pattern)
