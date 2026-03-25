"""Tests for SuggestionService — pattern suggestion listing, acceptance, and dismissal."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.pattern_discovery.suggestion_service import SuggestionService


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    return SuggestionService(supabase_client=mock_supabase)


class TestListSuggestions:
    def test_returns_patterns_filtered_by_status(self, service, mock_supabase):
        patterns = [
            {"id": "p1", "pattern_name": "Deploy & Test", "final_score": 0.8, "status": "pending_review"},
            {"id": "p2", "pattern_name": "Lint & Fix", "final_score": 0.6, "status": "pending_review"},
        ]

        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=patterns)
        mock_supabase.table.return_value = builder

        success, result = service.list_suggestions(status="pending_review", limit=20)

        assert success is True
        assert len(result["suggestions"]) == 2
        assert result["suggestions"][0]["id"] == "p1"

        mock_supabase.table.assert_called_with("discovered_patterns")
        builder.eq.assert_called_once_with("status", "pending_review")
        builder.order.assert_called_once_with("final_score", desc=True)
        builder.limit.assert_called_once_with(20)

    def test_respects_custom_limit(self, service, mock_supabase):
        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=[])
        mock_supabase.table.return_value = builder

        service.list_suggestions(status="accepted", limit=5)

        builder.eq.assert_called_once_with("status", "accepted")
        builder.limit.assert_called_once_with(5)

    def test_returns_error_on_db_failure(self, service, mock_supabase):
        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.side_effect = Exception("Connection refused")
        mock_supabase.table.return_value = builder

        success, result = service.list_suggestions()

        assert success is False
        assert "error" in result


class TestAcceptSuggestion:
    def test_creates_workflow_definition_and_updates_pattern(self, service, mock_supabase):
        pattern = {
            "id": "p1",
            "pattern_name": "Deploy & Test",
            "description": "Auto deploy and test flow",
            "suggested_yaml": "name: deploy-and-test\nnodes:\n  - id: deploy\n    command: deploy",
            "final_score": 0.8,
        }

        created_definition = {
            "id": "def-1",
            "name": "Deploy & Test",
            "yaml_content": pattern["suggested_yaml"],
            "origin": "pattern_discovery",
        }

        call_count = {"value": 0}

        def _table(name):
            builder = MagicMock(name=f"table({name})")
            for method in ("select", "insert", "update", "delete"):
                getattr(builder, method).return_value = builder
            builder.eq.return_value = builder
            builder.is_.return_value = builder
            builder.order.return_value = builder
            builder.limit.return_value = builder

            if name == "discovered_patterns":
                if call_count["value"] == 0:
                    # First call: fetch the pattern
                    builder.execute.return_value = MagicMock(data=[pattern])
                    call_count["value"] += 1
                else:
                    # Subsequent calls: update the pattern
                    builder.execute.return_value = MagicMock(data=[{**pattern, "status": "accepted"}])
            elif name == "workflow_definitions":
                builder.execute.return_value = MagicMock(data=[created_definition])
            return builder

        mock_supabase.table.side_effect = _table

        success, result = service.accept_suggestion("p1")

        assert success is True
        assert result["definition"]["id"] == "def-1"

    def test_uses_customized_yaml_when_provided(self, service, mock_supabase):
        pattern = {
            "id": "p1",
            "pattern_name": "Deploy & Test",
            "description": "Auto deploy and test flow",
            "suggested_yaml": "name: original\nnodes:\n  - id: step1\n    command: original",
            "final_score": 0.8,
        }

        custom_yaml = "name: customized\nnodes:\n  - id: step1\n    command: custom"

        created_definition = {
            "id": "def-2",
            "name": "Deploy & Test",
            "yaml_content": custom_yaml,
            "origin": "pattern_discovery",
        }

        insert_called_with = {}

        def _table(name):
            builder = MagicMock(name=f"table({name})")
            for method in ("select", "update", "delete"):
                getattr(builder, method).return_value = builder
            builder.eq.return_value = builder
            builder.is_.return_value = builder
            builder.order.return_value = builder
            builder.limit.return_value = builder

            if name == "discovered_patterns":
                builder.execute.return_value = MagicMock(data=[pattern])
            elif name == "workflow_definitions":
                def capture_insert(data):
                    insert_called_with.update(data)
                    builder_inner = MagicMock()
                    builder_inner.execute.return_value = MagicMock(data=[created_definition])
                    return builder_inner
                builder.insert = capture_insert
                builder.execute.return_value = MagicMock(data=[created_definition])
            return builder

        mock_supabase.table.side_effect = _table

        success, result = service.accept_suggestion("p1", customized_yaml=custom_yaml)

        assert success is True
        # Verify the custom YAML was used, not the suggested one
        assert insert_called_with.get("yaml_content") == custom_yaml

    def test_pattern_not_found_returns_error(self, service, mock_supabase):
        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=[])
        mock_supabase.table.return_value = builder

        success, result = service.accept_suggestion("nonexistent-id")

        assert success is False
        assert "error" in result


class TestDismissSuggestion:
    def test_updates_status_and_decays_score(self, service, mock_supabase):
        pattern = {
            "id": "p1",
            "pattern_name": "Deploy & Test",
            "final_score": 0.8,
            "feedback_delta": None,
        }

        update_called_with = {}

        def _table(name):
            builder = MagicMock(name=f"table({name})")
            for method in ("select", "delete"):
                getattr(builder, method).return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[pattern])

            def capture_update(data):
                update_called_with.update(data)
                inner = MagicMock()
                inner.eq.return_value = inner
                inner.execute.return_value = MagicMock(data=[{**pattern, **data}])
                return inner
            builder.update = capture_update
            return builder

        mock_supabase.table.side_effect = _table

        success, result = service.dismiss_suggestion("p1", reason="Not useful")

        assert success is True
        # Verify status was set to dismissed
        assert update_called_with["status"] == "dismissed"
        # Verify score was decayed by 0.5x
        assert update_called_with["final_score"] == pytest.approx(0.4)
        # Verify feedback_delta contains the reason
        assert update_called_with["feedback_delta"]["reason"] == "Not useful"

    def test_dismiss_without_reason(self, service, mock_supabase):
        pattern = {
            "id": "p1",
            "pattern_name": "Some Pattern",
            "final_score": 0.6,
            "feedback_delta": None,
        }

        update_called_with = {}

        def _table(name):
            builder = MagicMock(name=f"table({name})")
            for method in ("select", "delete"):
                getattr(builder, method).return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[pattern])

            def capture_update(data):
                update_called_with.update(data)
                inner = MagicMock()
                inner.eq.return_value = inner
                inner.execute.return_value = MagicMock(data=[{**pattern, **data}])
                return inner
            builder.update = capture_update
            return builder

        mock_supabase.table.side_effect = _table

        success, result = service.dismiss_suggestion("p1")

        assert success is True
        assert update_called_with["status"] == "dismissed"
        assert update_called_with["final_score"] == pytest.approx(0.3)
        # feedback_delta should still have the action recorded
        assert update_called_with["feedback_delta"]["action"] == "dismissed"

    def test_pattern_not_found_returns_error(self, service, mock_supabase):
        builder = MagicMock()
        builder.select.return_value = builder
        builder.eq.return_value = builder
        builder.execute.return_value = MagicMock(data=[])
        mock_supabase.table.return_value = builder

        success, result = service.dismiss_suggestion("nonexistent-id")

        assert success is False
        assert "error" in result


class TestRunDiscoveryPipeline:
    @pytest.mark.asyncio
    async def test_runs_full_pipeline_and_returns_stats(self, service, mock_supabase):
        """Verify the pipeline orchestrates capture, normalize, mine, cluster, score, generate, store."""
        with (
            patch.object(service, "_run_capture", new_callable=AsyncMock, return_value={"captured": 5}),
            patch.object(service, "_run_normalization", new_callable=AsyncMock, return_value={"normalized": 5, "failed": 0}),
            patch.object(service, "_run_mining", return_value={"patterns": 3}),
            patch.object(service, "_run_clustering", new_callable=AsyncMock, return_value={"clusters": 2}),
            patch.object(service, "_run_scoring_and_generation", new_callable=AsyncMock, return_value={"stored": 2}),
        ):
            success, result = await service.run_discovery_pipeline()

        assert success is True
        assert "capture" in result
        assert "normalization" in result
        assert "mining" in result
        assert "clustering" in result
        assert "scoring_and_generation" in result

    @pytest.mark.asyncio
    async def test_pipeline_returns_error_on_failure(self, service, mock_supabase):
        with patch.object(
            service,
            "_run_capture",
            new_callable=AsyncMock,
            side_effect=Exception("Capture failed"),
        ):
            success, result = await service.run_discovery_pipeline()

        assert success is False
        assert "error" in result
