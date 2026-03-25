"""Tests for CaptureService — event ingestion from git, conversations, and workflows."""

from unittest.mock import MagicMock, patch

import pytest

from src.server.services.pattern_discovery.capture_service import CaptureService


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    return CaptureService(supabase_client=mock_supabase)


class TestCaptureGitCommits:
    @pytest.mark.asyncio
    async def test_parses_git_log_and_inserts_events(self, service, mock_supabase):
        git_output = "abc1234 Fix login validation\ndef5678 Add user settings page\n"

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout=git_output,
                stderr="",
            )

            # Mock the insert chain
            mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
                {"id": "evt-1"},
                {"id": "evt-2"},
            ]

            success, result = await service.capture_git_commits(
                project_id="proj-1",
                repo_path="/home/user/project",
                since_days=7,
            )

        assert success is True
        assert result["captured"] == 2

        # Verify subprocess was called with correct args
        mock_run.assert_called_once()
        call_args = mock_run.call_args
        assert "git" in call_args[0][0]
        assert "log" in call_args[0][0]
        assert "--oneline" in call_args[0][0]
        assert call_args[1]["cwd"] == "/home/user/project"

        # Verify insert was called with correct event data
        insert_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert len(insert_args) == 2
        assert insert_args[0]["event_type"] == "git_commit"
        assert insert_args[0]["project_id"] == "proj-1"
        assert insert_args[0]["raw_content"] == "Fix login validation"
        assert insert_args[0]["metadata"]["commit_hash"] == "abc1234"
        assert insert_args[0]["metadata"]["repo_path"] == "/home/user/project"

    @pytest.mark.asyncio
    async def test_empty_git_log_returns_zero_captured(self, service, mock_supabase):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

            success, result = await service.capture_git_commits(
                project_id="proj-1",
                repo_path="/home/user/project",
            )

        assert success is True
        assert result["captured"] == 0
        # Should not attempt insert when there are no commits
        mock_supabase.table.return_value.insert.assert_not_called()

    @pytest.mark.asyncio
    async def test_git_subprocess_failure_returns_error(self, service, mock_supabase):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=128,
                stdout="",
                stderr="fatal: not a git repository",
            )

            success, result = await service.capture_git_commits(
                project_id="proj-1",
                repo_path="/not/a/repo",
            )

        assert success is False
        assert "error" in result
        assert "not a git repository" in result["error"]

    @pytest.mark.asyncio
    async def test_since_days_parameter_passed_to_git(self, service, mock_supabase):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

            await service.capture_git_commits(
                project_id="proj-1",
                repo_path="/home/user/project",
                since_days=14,
            )

        call_args = mock_run.call_args[0][0]
        assert "--since=14 days ago" in call_args


class TestCaptureWorkflowCompletion:
    @pytest.mark.asyncio
    async def test_inserts_event_from_workflow_run_and_nodes(self, service, mock_supabase):
        # First call: query workflow_runs
        # Second call: query workflow_nodes
        # Third call: insert into activity_events
        run_data = [{"id": "wr-1", "status": "completed", "workflow_id": "wf-1"}]
        node_data = [
            {"id": "n1", "node_id": "step-one", "state": "completed", "output": "done"},
            {"id": "n2", "node_id": "step-two", "state": "completed", "output": "ok"},
        ]
        insert_data = [{"id": "evt-1"}]

        call_count = 0

        def _table(name):
            nonlocal call_count
            builder = MagicMock(name=f"table({name})")
            # Chain methods to return builder
            for method in ("select", "insert", "update", "delete"):
                getattr(builder, method).return_value = builder
            builder.eq.return_value = builder
            builder.order.return_value = builder

            if name == "workflow_runs":
                builder.execute.return_value = MagicMock(data=run_data)
            elif name == "workflow_nodes":
                builder.execute.return_value = MagicMock(data=node_data)
            elif name == "activity_events":
                builder.execute.return_value = MagicMock(data=insert_data)
            return builder

        mock_supabase.table.side_effect = _table

        success, result = await service.capture_workflow_completion(workflow_run_id="wr-1")

        assert success is True
        assert result["event_id"] == "evt-1"

    @pytest.mark.asyncio
    async def test_workflow_run_not_found_returns_error(self, service, mock_supabase):
        def _table(name):
            builder = MagicMock(name=f"table({name})")
            for method in ("select", "insert", "update", "delete"):
                getattr(builder, method).return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[])
            return builder

        mock_supabase.table.side_effect = _table

        success, result = await service.capture_workflow_completion(workflow_run_id="nonexistent")

        assert success is False
        assert "error" in result


class TestCaptureConversation:
    @pytest.mark.asyncio
    async def test_creates_stub_event_for_conversation(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "evt-1"}
        ]

        success, result = await service.capture_conversation(conversation_id="conv-42")

        assert success is True
        assert result["event_id"] == "evt-1"

        # Verify insert payload
        insert_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert insert_args["event_type"] == "conversation"
        assert insert_args["metadata"]["conversation_id"] == "conv-42"

    @pytest.mark.asyncio
    async def test_conversation_insert_failure_returns_error(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.side_effect = Exception(
            "DB insert failed"
        )

        success, result = await service.capture_conversation(conversation_id="conv-99")

        assert success is False
        assert "error" in result


class TestGetPendingEvents:
    @pytest.mark.asyncio
    async def test_returns_events_with_null_normalized_at(self, service, mock_supabase):
        pending = [
            {"id": "evt-1", "event_type": "git_commit", "normalized_at": None},
            {"id": "evt-2", "event_type": "conversation", "normalized_at": None},
        ]

        builder = MagicMock()
        builder.select.return_value = builder
        builder.is_.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=pending)
        mock_supabase.table.return_value = builder

        success, result = await service.get_pending_events(limit=50)

        assert success is True
        assert len(result["events"]) == 2
        assert result["events"][0]["id"] == "evt-1"

        # Verify correct table was queried
        mock_supabase.table.assert_called_with("activity_events")

        # Verify filter for NULL normalized_at
        builder.is_.assert_called_once_with("normalized_at", "null")

    @pytest.mark.asyncio
    async def test_respects_limit_parameter(self, service, mock_supabase):
        builder = MagicMock()
        builder.select.return_value = builder
        builder.is_.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.return_value = MagicMock(data=[])
        mock_supabase.table.return_value = builder

        await service.get_pending_events(limit=10)

        builder.limit.assert_called_once_with(10)

    @pytest.mark.asyncio
    async def test_query_failure_returns_error(self, service, mock_supabase):
        builder = MagicMock()
        builder.select.return_value = builder
        builder.is_.return_value = builder
        builder.order.return_value = builder
        builder.limit.return_value = builder
        builder.execute.side_effect = Exception("Connection refused")
        mock_supabase.table.return_value = builder

        success, result = await service.get_pending_events()

        assert success is False
        assert "error" in result
