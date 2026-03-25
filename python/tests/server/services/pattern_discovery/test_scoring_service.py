"""Tests for ScoringService."""

import pytest

from src.server.services.pattern_discovery.scoring_service import ScoringService


@pytest.fixture
def service():
    return ScoringService()


class TestScorePattern:
    def test_high_frequency_high_score(self, service):
        pattern = {"sequence": ["a:b", "c:d", "e:f"], "support": 20, "repos": ["r1", "r2", "r3"], "length": 3}
        result = service.score_pattern(pattern)
        assert result["frequency_score"] == 1.0
        assert result["cross_repo_score"] > 0
        assert result["final_score"] > 0.5

    def test_single_repo_no_cross_repo_score(self, service):
        pattern = {"sequence": ["a:b"], "support": 5, "repos": ["r1"], "length": 1}
        result = service.score_pattern(pattern)
        assert result["cross_repo_score"] == 0.0

    def test_filter_above_threshold(self, service):
        patterns = [
            {"final_score": 0.5},
            {"final_score": 0.1},
            {"final_score": 0.8},
        ]
        filtered = service.filter_above_threshold(patterns, threshold=0.3)
        assert len(filtered) == 2

    def test_score_and_filter_pipeline(self, service):
        patterns = [
            {"sequence": ["a:b", "c:d"], "support": 15, "repos": ["r1", "r2"], "length": 2},
            {"sequence": ["x:y"], "support": 1, "repos": ["r1"], "length": 1},
        ]
        result = service.score_and_filter(patterns)
        # First should pass, second likely filtered
        assert all(p["final_score"] >= 0.3 for p in result)
