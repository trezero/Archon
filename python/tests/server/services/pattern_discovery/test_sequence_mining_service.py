"""Tests for SequenceMiningService — PrefixSpan temporal pattern detection."""

from unittest.mock import MagicMock

import pytest

from src.server.services.pattern_discovery.sequence_mining_service import SequenceMiningService


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    return SequenceMiningService(supabase_client=mock_supabase)


def _make_event(
    event_id: str,
    repo_url: str,
    action_verb: str,
    target_object: str,
    created_at: str,
) -> dict:
    """Build a fake normalized activity_events row."""
    return {
        "id": event_id,
        "repo_url": repo_url,
        "action_verb": action_verb,
        "target_object": target_object,
        "created_at": created_at,
        "normalized_at": "2024-01-10T10:00:00+00:00",
    }


class TestBuildSequencesByRepoWeek:
    def test_groups_events_by_repo_and_week(self, service):
        """Events from the same repo in the same ISO week form a single sequence."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "login", "2024-01-08T10:00:00+00:00"),
            _make_event("e2", "https://github.com/org/repo-a", "add", "tests", "2024-01-09T12:00:00+00:00"),
            _make_event("e3", "https://github.com/org/repo-b", "refactor", "auth", "2024-01-08T15:00:00+00:00"),
        ]
        sequences = service._build_sequences_by_repo_week(events)

        assert len(sequences) == 2  # Two groups: repo-a week 2, repo-b week 2
        # Each sequence is a list of "verb:object" strings
        assert any(len(seq) == 2 for seq in sequences)  # repo-a has 2 events
        assert any(len(seq) == 1 for seq in sequences)  # repo-b has 1 event

    def test_different_weeks_produce_separate_sequences(self, service):
        """Same repo but different ISO weeks → different sequences."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "login", "2024-01-08T10:00:00+00:00"),  # week 2
            _make_event("e2", "https://github.com/org/repo-a", "add", "tests", "2024-01-15T12:00:00+00:00"),  # week 3
        ]
        sequences = service._build_sequences_by_repo_week(events)
        assert len(sequences) == 2

    def test_events_ordered_by_created_at_within_group(self, service):
        """Events within a group are sorted chronologically."""
        events = [
            _make_event("e2", "https://github.com/org/repo-a", "add", "tests", "2024-01-09T12:00:00+00:00"),
            _make_event("e1", "https://github.com/org/repo-a", "fix", "login", "2024-01-08T10:00:00+00:00"),
        ]
        sequences = service._build_sequences_by_repo_week(events)
        assert len(sequences) == 1
        seq = sequences[0]
        assert seq[0] == "fix:login"
        assert seq[1] == "add:tests"

    def test_items_formatted_as_verb_colon_object(self, service):
        """Each item in a sequence is formatted as 'action_verb:target_object'."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "deploy", "service", "2024-01-08T10:00:00+00:00"),
        ]
        sequences = service._build_sequences_by_repo_week(events)
        assert sequences == [["deploy:service"]]

    def test_empty_events_returns_empty_list(self, service):
        """No events → no sequences."""
        sequences = service._build_sequences_by_repo_week([])
        assert sequences == []

    def test_falls_back_to_project_id_when_no_repo_url(self, service):
        """Events without repo_url use project_id as the grouping key."""
        events = [
            {
                "id": "e1",
                "repo_url": None,
                "project_id": "proj-123",
                "action_verb": "update",
                "target_object": "schema",
                "created_at": "2024-01-08T10:00:00+00:00",
                "normalized_at": "2024-01-10T10:00:00+00:00",
            },
            {
                "id": "e2",
                "repo_url": None,
                "project_id": "proj-123",
                "action_verb": "migrate",
                "target_object": "database",
                "created_at": "2024-01-08T11:00:00+00:00",
                "normalized_at": "2024-01-10T10:00:00+00:00",
            },
        ]
        sequences = service._build_sequences_by_repo_week(events)
        assert len(sequences) == 1
        assert len(sequences[0]) == 2


class TestFilterCrossRepo:
    def test_keeps_patterns_present_in_enough_repos(self, service):
        """Patterns appearing in >= min_repos repos are kept."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e2", "https://github.com/org/repo-a", "deploy", "service", "2024-01-08T11:00:00+00:00"),
            _make_event("e3", "https://github.com/org/repo-b", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e4", "https://github.com/org/repo-b", "deploy", "service", "2024-01-08T11:00:00+00:00"),
        ]
        # PrefixSpan-style: (support, [item1, item2])
        patterns = [(2, ["fix:bug", "deploy:service"])]
        result = service._filter_cross_repo(patterns, events, min_repos=2)

        assert len(result) == 1
        assert result[0]["sequence"] == ["fix:bug", "deploy:service"]
        assert result[0]["support"] == 2
        assert len(result[0]["repos"]) == 2
        assert result[0]["length"] == 2

    def test_removes_patterns_below_min_repos(self, service):
        """Patterns only in one repo are excluded when min_repos=2."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e2", "https://github.com/org/repo-a", "deploy", "service", "2024-01-08T11:00:00+00:00"),
        ]
        patterns = [(2, ["fix:bug", "deploy:service"])]
        result = service._filter_cross_repo(patterns, events, min_repos=2)
        assert result == []

    def test_empty_patterns_returns_empty_list(self, service):
        """No patterns → empty result."""
        result = service._filter_cross_repo([], [], min_repos=2)
        assert result == []

    def test_single_item_pattern_filtered_correctly(self, service):
        """Single-item patterns are checked across repos correctly."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e2", "https://github.com/org/repo-b", "fix", "bug", "2024-01-09T10:00:00+00:00"),
            _make_event("e3", "https://github.com/org/repo-c", "fix", "bug", "2024-01-10T10:00:00+00:00"),
        ]
        patterns = [(3, ["fix:bug"])]
        result = service._filter_cross_repo(patterns, events, min_repos=2)
        assert len(result) == 1
        assert len(result[0]["repos"]) == 3


class TestMineSequences:
    def _mock_supabase_response(self, mock_supabase, events: list[dict]):
        """Wire mock_supabase to return given events from the chained query."""
        mock_result = MagicMock()
        mock_result.data = events

        mock_gte = MagicMock()
        mock_gte.execute.return_value = mock_result

        mock_not_is2 = MagicMock()
        mock_not_is2.gte.return_value = mock_gte

        mock_not_is1 = MagicMock()
        mock_not_is1.not_.return_value = mock_not_is2  # second not_ call
        # but we chain not_ on first call too
        mock_not_is1.gte.return_value = mock_gte

        mock_select = MagicMock()
        # Chain: .not_("normalized_at", "is", None).not_("action_verb", "is", None).gte(...)
        chain2 = MagicMock()
        chain2.gte.return_value = mock_gte

        chain1 = MagicMock()
        chain1.not_.return_value = chain2

        mock_select.not_.return_value = chain1
        mock_supabase.table.return_value.select.return_value = mock_select

    def test_returns_patterns_from_multi_repo_events(self, service, mock_supabase):
        """mine_sequences finds patterns that appear in 2+ repos."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e2", "https://github.com/org/repo-a", "deploy", "service", "2024-01-08T11:00:00+00:00"),
            _make_event("e3", "https://github.com/org/repo-b", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e4", "https://github.com/org/repo-b", "deploy", "service", "2024-01-08T11:00:00+00:00"),
            _make_event("e5", "https://github.com/org/repo-c", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e6", "https://github.com/org/repo-c", "deploy", "service", "2024-01-08T11:00:00+00:00"),
        ]
        self._mock_supabase_response(mock_supabase, events)

        success, result = service.mine_sequences(lookback_days=30, min_support=3, min_repos=2)

        assert success is True
        assert "patterns" in result
        assert "total_sequences" in result
        assert "filtered_count" in result
        assert result["total_sequences"] == 3  # 3 repo-week groups
        assert isinstance(result["patterns"], list)

    def test_returns_empty_patterns_for_no_events(self, service, mock_supabase):
        """Empty event set → empty patterns."""
        self._mock_supabase_response(mock_supabase, [])

        success, result = service.mine_sequences()

        assert success is True
        assert result["patterns"] == []
        assert result["total_sequences"] == 0
        assert result["filtered_count"] == 0

    def test_returns_failure_on_db_error(self, service, mock_supabase):
        """Database error → returns (False, error dict)."""
        mock_supabase.table.return_value.select.side_effect = RuntimeError("DB connection failed")

        success, result = service.mine_sequences()

        assert success is False
        assert "error" in result

    def test_result_dict_has_required_keys(self, service, mock_supabase):
        """Successful result always has patterns, total_sequences, filtered_count."""
        self._mock_supabase_response(mock_supabase, [])

        success, result = service.mine_sequences()

        assert success is True
        assert set(result.keys()) >= {"patterns", "total_sequences", "filtered_count"}

    def test_pattern_dicts_have_required_fields(self, service, mock_supabase):
        """Each pattern dict has sequence, support, repos, length fields."""
        events = [
            _make_event("e1", "https://github.com/org/repo-a", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e2", "https://github.com/org/repo-a", "deploy", "service", "2024-01-08T11:00:00+00:00"),
            _make_event("e3", "https://github.com/org/repo-b", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e4", "https://github.com/org/repo-b", "deploy", "service", "2024-01-08T11:00:00+00:00"),
            _make_event("e5", "https://github.com/org/repo-c", "fix", "bug", "2024-01-08T10:00:00+00:00"),
            _make_event("e6", "https://github.com/org/repo-c", "deploy", "service", "2024-01-08T11:00:00+00:00"),
        ]
        self._mock_supabase_response(mock_supabase, events)

        success, result = service.mine_sequences(min_support=3, min_repos=2)

        assert success is True
        for pattern in result["patterns"]:
            assert "sequence" in pattern
            assert "support" in pattern
            assert "repos" in pattern
            assert "length" in pattern
            assert isinstance(pattern["sequence"], list)
            assert isinstance(pattern["repos"], list)

    def test_filtered_count_matches_patterns_length(self, service, mock_supabase):
        """filtered_count in result equals len(patterns)."""
        self._mock_supabase_response(mock_supabase, [])

        success, result = service.mine_sequences()

        assert result["filtered_count"] == len(result["patterns"])
