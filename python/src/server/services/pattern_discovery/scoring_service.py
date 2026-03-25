"""Pattern scoring and threshold evaluation."""

from typing import Any

from ...config.logfire_config import get_logger

logger = get_logger(__name__)

# Thresholds for pattern acceptance
MIN_FINAL_SCORE = 0.3
FREQUENCY_WEIGHT = 0.4
CROSS_REPO_WEIGHT = 0.35
AUTOMATION_WEIGHT = 0.25


class ScoringService:
    def score_pattern(self, pattern: dict[str, Any]) -> dict[str, Any]:
        """Score a pattern candidate.

        Input pattern dict has: sequence, support, repos, length (from SequenceMiningService)
        or: intent_key, event_count, repos (from ClusteringService)

        Returns scored pattern with frequency_score, cross_repo_score,
        automation_potential, final_score.
        """
        support = pattern.get("support", pattern.get("event_count", 0))
        repos = pattern.get("repos", [])
        length = pattern.get("length", len(pattern.get("sequence", [])))

        # Frequency: log-normalized support count (cap at 1.0)
        frequency_score = min(1.0, support / 20.0)

        # Cross-repo: proportion of repos (cap at 1.0, bonus for 3+)
        repo_count = len(repos)
        cross_repo_score = min(1.0, repo_count / 5.0) if repo_count > 1 else 0.0

        # Automation potential: longer sequences = more automatable
        automation_potential = min(1.0, length / 5.0) if length >= 2 else 0.2

        # Weighted final score
        final_score = (
            frequency_score * FREQUENCY_WEIGHT
            + cross_repo_score * CROSS_REPO_WEIGHT
            + automation_potential * AUTOMATION_WEIGHT
        )

        return {
            **pattern,
            "frequency_score": round(frequency_score, 3),
            "cross_repo_score": round(cross_repo_score, 3),
            "automation_potential": round(automation_potential, 3),
            "final_score": round(final_score, 3),
        }

    def filter_above_threshold(self, scored_patterns: list[dict], threshold: float = MIN_FINAL_SCORE) -> list[dict]:
        """Return only patterns above the minimum score threshold."""
        return [p for p in scored_patterns if p.get("final_score", 0) >= threshold]

    def score_and_filter(self, patterns: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Score all patterns and filter by threshold."""
        scored = [self.score_pattern(p) for p in patterns]
        return self.filter_above_threshold(scored)
