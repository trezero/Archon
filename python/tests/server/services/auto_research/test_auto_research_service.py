"""Unit tests for AutoResearchService and _aggregate_eval_results."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.models.auto_research import (
    AutoResearchJob,
    AutoResearchJobWithIterations,
    EvalResult,
    EvalSignalResult,
    EvalSuiteDefinition,
    SignalDefinition,
    TestCaseDefinition,
)
from src.server.services.auto_research_service import (
    AutoResearchService,
    _aggregate_eval_results,
)


def _make_eval_result(
    scalar_score: float,
    signals: dict[str, tuple[bool, float, bool]] | None = None,
) -> EvalResult:
    """Create an EvalResult. signals is {name: (value, weight, critical)}."""
    if signals is None:
        signals = {}
    return EvalResult(
        scalar_score=scalar_score,
        pass_status=scalar_score >= 0.5,
        signals={
            name: EvalSignalResult(value=val, weight=w, critical=crit)
            for name, (val, w, crit) in signals.items()
        },
    )


def _make_suite() -> EvalSuiteDefinition:
    """Create a minimal EvalSuiteDefinition."""
    return EvalSuiteDefinition(
        id="suite-1",
        name="Test Suite",
        target_file="/tmp/prompt.txt",
        mutation_guidance="Be better",
        test_cases=[
            TestCaseDefinition(
                id="tc-1",
                name="Test case 1",
                input="Hello",
                signals={
                    "greeting": SignalDefinition(description="Has greeting", weight=1.0, critical=False),
                },
            ),
        ],
    )


def _mock_supabase():
    """Create a mock Supabase client with chainable table methods."""
    mock = MagicMock()

    def _make_chain(data=None):
        """Create a chainable mock that returns data on .execute()."""
        chain = MagicMock()
        chain.select.return_value = chain
        chain.insert.return_value = chain
        chain.update.return_value = chain
        chain.eq.return_value = chain
        chain.order.return_value = chain
        chain.single.return_value = chain
        chain.in_.return_value = chain
        exec_result = MagicMock()
        exec_result.data = data if data is not None else []
        chain.execute.return_value = exec_result
        return chain

    # Track table calls so tests can configure per-table behavior
    table_chains: dict[str, MagicMock] = {}

    def table_fn(name):
        if name not in table_chains:
            table_chains[name] = _make_chain()
        return table_chains[name]

    mock.table = MagicMock(side_effect=table_fn)
    mock._table_chains = table_chains
    return mock


class TestAggregateEvalResults:
    """Tests for _aggregate_eval_results."""

    def test_empty_results(self):
        """Empty list returns zero score and no signals."""
        result = _aggregate_eval_results([])
        assert result.scalar_score == 0.0
        assert result.pass_status is False
        assert result.signals == {}

    def test_single_result(self):
        """Single result returns itself unchanged."""
        r = _make_eval_result(0.75, {
            "sig_a": (True, 1.0, False),
            "sig_b": (False, 2.0, True),
        })
        agg = _aggregate_eval_results([r])

        assert agg.scalar_score == pytest.approx(0.75)
        assert agg.pass_status is True
        assert agg.signals["sig_a"].value is True
        assert agg.signals["sig_b"].value is False
        assert agg.signals["sig_b"].critical is True

    def test_averages_scalar_scores(self):
        """Average of scalar scores across multiple results."""
        r1 = _make_eval_result(0.4)
        r2 = _make_eval_result(0.8)
        agg = _aggregate_eval_results([r1, r2])

        assert agg.scalar_score == pytest.approx(0.6)
        assert agg.pass_status is True

    def test_merges_signals_by_name(self):
        """Signals with the same name across test cases are averaged."""
        r1 = _make_eval_result(0.5, {"shared": (True, 1.0, False)})
        r2 = _make_eval_result(0.5, {"shared": (False, 1.0, False)})
        agg = _aggregate_eval_results([r1, r2])

        # avg = 0.5, so value should be True (>= 0.5)
        assert agg.signals["shared"].value is True

    def test_signal_averaging_below_threshold(self):
        """When most occurrences are False, the averaged value is False."""
        r1 = _make_eval_result(0.5, {"sig": (True, 1.0, False)})
        r2 = _make_eval_result(0.5, {"sig": (False, 1.0, False)})
        r3 = _make_eval_result(0.5, {"sig": (False, 1.0, False)})
        agg = _aggregate_eval_results([r1, r2, r3])

        # avg = 1/3 = 0.333, below 0.5 threshold
        assert agg.signals["sig"].value is False

    def test_critical_flag_preserved(self):
        """If any occurrence of a signal is critical, the merged signal is critical."""
        r1 = _make_eval_result(0.5, {"sig": (True, 1.0, False)})
        r2 = _make_eval_result(0.5, {"sig": (True, 1.0, True)})
        agg = _aggregate_eval_results([r1, r2])

        assert agg.signals["sig"].critical is True

    def test_disjoint_signals(self):
        """Signals that appear in only one test case are included in the result."""
        r1 = _make_eval_result(0.5, {"only_in_r1": (True, 1.0, False)})
        r2 = _make_eval_result(0.5, {"only_in_r2": (False, 2.0, True)})
        agg = _aggregate_eval_results([r1, r2])

        assert "only_in_r1" in agg.signals
        assert "only_in_r2" in agg.signals
        assert agg.signals["only_in_r1"].value is True
        assert agg.signals["only_in_r2"].value is False

    def test_pass_status_threshold(self):
        """pass_status is True when average score >= 0.5."""
        r1 = _make_eval_result(0.49)
        r2 = _make_eval_result(0.51)
        agg = _aggregate_eval_results([r1, r2])

        assert agg.scalar_score == pytest.approx(0.5)
        assert agg.pass_status is True

    def test_pass_status_below_threshold(self):
        """pass_status is False when average score < 0.5."""
        r1 = _make_eval_result(0.2)
        r2 = _make_eval_result(0.3)
        agg = _aggregate_eval_results([r1, r2])

        assert agg.scalar_score == pytest.approx(0.25)
        assert agg.pass_status is False


class TestAutoResearchServiceInit:
    """Tests for AutoResearchService initialization."""

    def test_uses_provided_client(self):
        """Service uses the provided Supabase client."""
        mock_client = MagicMock()
        service = AutoResearchService(supabase_client=mock_client)
        assert service.supabase is mock_client

    def test_falls_back_to_get_supabase_client(self):
        """When no client is provided, calls get_supabase_client()."""
        with patch("src.server.services.auto_research_service.get_supabase_client") as mock_get:
            mock_get.return_value = MagicMock()
            service = AutoResearchService()
            mock_get.assert_called_once()
            assert service.supabase is mock_get.return_value


class TestConcurrencyGuard:
    """Tests for the running job concurrency check."""

    @pytest.mark.asyncio
    async def test_rejects_if_job_already_running(self):
        """start_optimization raises if a job is already running."""
        mock_sb = _mock_supabase()
        # Make the running check return a result
        running_chain = MagicMock()
        running_chain.select.return_value = running_chain
        running_chain.eq.return_value = running_chain
        exec_result = MagicMock()
        exec_result.data = [{"id": "existing-job"}]
        running_chain.execute.return_value = exec_result
        mock_sb.table = MagicMock(return_value=running_chain)

        service = AutoResearchService(supabase_client=mock_sb)

        with pytest.raises(ValueError, match="already running"):
            await service.start_optimization("suite-1", max_iterations=5)


class TestStartOptimization:
    """Tests for start_optimization."""

    @pytest.mark.asyncio
    async def test_returns_job_id_and_progress_id(self, tmp_path):
        """start_optimization returns matching job_id and progress_id."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("original prompt", encoding="utf-8")

        suite = _make_suite()
        suite = suite.model_copy(update={"target_file": str(prompt_file)})

        mock_sb = _mock_supabase()
        service = AutoResearchService(supabase_client=mock_sb)

        with (
            patch.object(service.loader, "load_suite", return_value=suite),
            patch("src.server.services.auto_research_service.ProgressTracker") as MockProgress,
            patch("src.server.services.auto_research_service.asyncio") as mock_asyncio,
        ):
            mock_progress_inst = MagicMock()
            mock_progress_inst.start = AsyncMock()
            MockProgress.return_value = mock_progress_inst
            mock_asyncio.create_task = MagicMock()

            job_id, progress_id = await service.start_optimization("suite-1", max_iterations=3)

        assert job_id == progress_id
        assert isinstance(job_id, str)
        assert len(job_id) > 0

    @pytest.mark.asyncio
    async def test_creates_job_in_db(self, tmp_path):
        """start_optimization inserts a job record into the database."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("original prompt", encoding="utf-8")

        suite = _make_suite()
        suite = suite.model_copy(update={"target_file": str(prompt_file)})

        mock_sb = _mock_supabase()
        service = AutoResearchService(supabase_client=mock_sb)

        with (
            patch.object(service.loader, "load_suite", return_value=suite),
            patch("src.server.services.auto_research_service.ProgressTracker") as MockProgress,
            patch("src.server.services.auto_research_service.asyncio") as mock_asyncio,
        ):
            mock_progress_inst = MagicMock()
            mock_progress_inst.start = AsyncMock()
            MockProgress.return_value = mock_progress_inst
            mock_asyncio.create_task = MagicMock()

            await service.start_optimization("suite-1", max_iterations=3)

        # Verify insert was called on the jobs table
        mock_sb.table.assert_any_call("auto_research_jobs")


class TestRunLoop:
    """Tests for _run_loop."""

    @pytest.mark.asyncio
    async def test_baseline_evaluation_and_iterations(self, tmp_path):
        """_run_loop evaluates baseline and runs all iterations."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("original prompt", encoding="utf-8")

        suite = _make_suite()
        suite = suite.model_copy(update={"target_file": str(prompt_file)})

        mock_sb = _mock_supabase()
        # Configure the job status check to return 'running'
        status_chain = MagicMock()
        status_chain.select.return_value = status_chain
        status_chain.eq.return_value = status_chain
        status_chain.single.return_value = status_chain
        status_exec = MagicMock()
        status_exec.data = {"status": "running"}
        status_chain.execute.return_value = status_exec

        # We need table to return different chains for different tables
        insert_chain = MagicMock()
        insert_chain.insert.return_value = insert_chain
        insert_chain.execute.return_value = MagicMock(data=[])

        update_chain = MagicMock()
        update_chain.update.return_value = update_chain
        update_chain.eq.return_value = update_chain
        update_chain.execute.return_value = MagicMock(data=[])

        call_count = {"jobs_calls": 0}

        def table_fn(name):
            if name == "auto_research_iterations":
                return insert_chain
            else:
                # For jobs table, alternate between status checks and updates
                call_count["jobs_calls"] += 1
                # Sometimes we need select (status check), sometimes update/insert
                combo = MagicMock()
                combo.select.return_value = status_chain
                combo.insert.return_value = insert_chain
                combo.update.return_value = update_chain
                return combo

        mock_sb.table = MagicMock(side_effect=table_fn)

        service = AutoResearchService(supabase_client=mock_sb)

        # Mock the target
        mock_target = MagicMock()
        mock_target.payload = "original prompt"

        baseline_eval = _make_eval_result(0.4, {"greeting": (True, 1.0, False)})
        candidate_eval = _make_eval_result(0.6, {"greeting": (True, 1.0, False)})

        tc = suite.test_cases[0]
        mock_target.execute = AsyncMock(side_effect=[
            [(tc, "baseline output")],  # baseline
            [(tc, "mutated output 1")],  # iteration 1
            [(tc, "mutated output 2")],  # iteration 2
        ])
        mock_target.evaluate = AsyncMock(side_effect=[
            baseline_eval,     # baseline
            candidate_eval,    # iteration 1
            candidate_eval,    # iteration 2
        ])
        mock_target.mutate = AsyncMock(side_effect=["mutated 1", "mutated 2"])
        mock_target.accept = MagicMock(side_effect=[True, False])

        mock_progress = MagicMock()
        mock_progress.start = AsyncMock()
        mock_progress.update = AsyncMock()
        mock_progress.complete = AsyncMock()
        mock_progress.error = AsyncMock()

        await service._run_loop(
            job_id="job-123",
            target=mock_target,
            max_iterations=2,
            model=None,
            progress=mock_progress,
        )

        # Baseline + 2 iterations = 3 execute calls
        assert mock_target.execute.call_count == 3
        # Baseline + 2 iterations = 3 evaluate calls
        assert mock_target.evaluate.call_count == 3
        # 2 mutations
        assert mock_target.mutate.call_count == 2
        # Progress completed
        mock_progress.complete.assert_called_once()
        # No errors
        mock_progress.error.assert_not_called()

    @pytest.mark.asyncio
    async def test_loop_handles_exception(self, tmp_path):
        """_run_loop marks job as failed on exception."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("prompt", encoding="utf-8")

        suite = _make_suite()
        suite = suite.model_copy(update={"target_file": str(prompt_file)})

        mock_sb = _mock_supabase()

        # Make table always return a chainable mock
        chain = MagicMock()
        chain.select.return_value = chain
        chain.insert.return_value = chain
        chain.update.return_value = chain
        chain.eq.return_value = chain
        chain.single.return_value = chain
        chain.execute.return_value = MagicMock(data={"status": "running"})
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)

        mock_target = MagicMock()
        mock_target.payload = "prompt"
        mock_target.execute = AsyncMock(side_effect=RuntimeError("LLM API failed"))

        mock_progress = MagicMock()
        mock_progress.start = AsyncMock()
        mock_progress.update = AsyncMock()
        mock_progress.complete = AsyncMock()
        mock_progress.error = AsyncMock()

        await service._run_loop(
            job_id="job-err",
            target=mock_target,
            max_iterations=3,
            model=None,
            progress=mock_progress,
        )

        # Error should be reported
        mock_progress.error.assert_called_once()
        error_msg = mock_progress.error.call_args[0][0]
        assert "LLM API failed" in error_msg


class TestGetJob:
    """Tests for get_job."""

    @pytest.mark.asyncio
    async def test_returns_job_with_iterations(self):
        """get_job returns an AutoResearchJobWithIterations."""
        mock_sb = MagicMock()

        job_chain = MagicMock()
        job_chain.select.return_value = job_chain
        job_chain.eq.return_value = job_chain
        job_chain.single.return_value = job_chain
        job_exec = MagicMock()
        job_exec.data = {
            "id": "job-1",
            "eval_suite_id": "suite-1",
            "status": "completed",
            "target_file": "/tmp/prompt.txt",
            "baseline_payload": "baseline",
            "max_iterations": 5,
            "completed_iterations": 5,
            "created_at": "2026-01-01T00:00:00",
        }
        job_chain.execute.return_value = job_exec

        iter_chain = MagicMock()
        iter_chain.select.return_value = iter_chain
        iter_chain.eq.return_value = iter_chain
        iter_chain.order.return_value = iter_chain
        iter_exec = MagicMock()
        iter_exec.data = [
            {
                "id": "iter-0",
                "job_id": "job-1",
                "iteration_number": 0,
                "payload": "baseline",
                "scalar_score": 0.4,
                "signals": {},
                "is_frontier": True,
                "created_at": "2026-01-01T00:00:01",
            },
        ]
        iter_chain.execute.return_value = iter_exec

        call_count = [0]

        def table_fn(name):
            call_count[0] += 1
            if name == "auto_research_jobs":
                return job_chain
            return iter_chain

        mock_sb.table = MagicMock(side_effect=table_fn)

        service = AutoResearchService(supabase_client=mock_sb)
        result = await service.get_job("job-1")

        assert isinstance(result, AutoResearchJobWithIterations)
        assert result.id == "job-1"
        assert len(result.iterations) == 1
        assert result.iterations[0].iteration_number == 0


class TestListJobs:
    """Tests for list_jobs."""

    @pytest.mark.asyncio
    async def test_returns_list_of_jobs(self):
        """list_jobs returns a list of AutoResearchJob."""
        mock_sb = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.order.return_value = chain
        exec_result = MagicMock()
        exec_result.data = [
            {
                "id": "job-1",
                "eval_suite_id": "suite-1",
                "status": "completed",
                "target_file": "/tmp/prompt.txt",
                "baseline_payload": "baseline",
                "max_iterations": 5,
                "completed_iterations": 5,
                "created_at": "2026-01-01T00:00:00",
            },
            {
                "id": "job-2",
                "eval_suite_id": "suite-2",
                "status": "running",
                "target_file": "/tmp/prompt2.txt",
                "baseline_payload": "baseline2",
                "max_iterations": 10,
                "completed_iterations": 3,
                "created_at": "2026-01-02T00:00:00",
            },
        ]
        chain.execute.return_value = exec_result
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)
        jobs = await service.list_jobs()

        assert len(jobs) == 2
        assert all(isinstance(j, AutoResearchJob) for j in jobs)
        assert jobs[0].id == "job-1"
        assert jobs[1].id == "job-2"


class TestApplyResult:
    """Tests for apply_result."""

    @pytest.mark.asyncio
    async def test_writes_best_payload_to_file(self, tmp_path):
        """apply_result writes the best_payload to the target file."""
        target_file = tmp_path / "prompt.txt"
        target_file.write_text("original", encoding="utf-8")

        mock_sb = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.single.return_value = chain
        exec_result = MagicMock()
        exec_result.data = {
            "id": "job-1",
            "eval_suite_id": "suite-1",
            "status": "completed",
            "target_file": str(target_file),
            "baseline_payload": "original",
            "best_payload": "improved prompt",
            "max_iterations": 5,
            "completed_iterations": 5,
            "created_at": "2026-01-01T00:00:00",
        }
        chain.execute.return_value = exec_result
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)
        result_path = await service.apply_result("job-1")

        assert result_path == str(target_file)
        assert target_file.read_text(encoding="utf-8") == "improved prompt"

    @pytest.mark.asyncio
    async def test_raises_if_not_completed(self):
        """apply_result raises if job is not completed."""
        mock_sb = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.single.return_value = chain
        exec_result = MagicMock()
        exec_result.data = {
            "id": "job-1",
            "eval_suite_id": "suite-1",
            "status": "running",
            "target_file": "/tmp/prompt.txt",
            "baseline_payload": "baseline",
            "max_iterations": 5,
            "completed_iterations": 3,
            "created_at": "2026-01-01T00:00:00",
        }
        chain.execute.return_value = exec_result
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)

        with pytest.raises(ValueError, match="not completed"):
            await service.apply_result("job-1")

    @pytest.mark.asyncio
    async def test_raises_if_no_best_payload(self):
        """apply_result raises if job has no best_payload."""
        mock_sb = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        chain.single.return_value = chain
        exec_result = MagicMock()
        exec_result.data = {
            "id": "job-1",
            "eval_suite_id": "suite-1",
            "status": "completed",
            "target_file": "/tmp/prompt.txt",
            "baseline_payload": "baseline",
            "best_payload": None,
            "max_iterations": 5,
            "completed_iterations": 5,
            "created_at": "2026-01-01T00:00:00",
        }
        chain.execute.return_value = exec_result
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)

        with pytest.raises(ValueError, match="no best_payload"):
            await service.apply_result("job-1")


class TestCancelJob:
    """Tests for cancel_job."""

    @pytest.mark.asyncio
    async def test_updates_status_to_cancelled(self):
        """cancel_job updates the job status in the database."""
        mock_sb = MagicMock()
        chain = MagicMock()
        chain.update.return_value = chain
        chain.eq.return_value = chain
        chain.execute.return_value = MagicMock(data=[])
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)
        await service.cancel_job("job-1")

        mock_sb.table.assert_called_with("auto_research_jobs")
        chain.update.assert_called_once_with({"status": "cancelled"})


class TestRecoverStaleJobs:
    """Tests for recover_stale_jobs classmethod."""

    def test_marks_running_jobs_as_failed(self):
        """recover_stale_jobs updates all running jobs to failed."""
        mock_sb = MagicMock()

        # Select chain for finding running jobs
        select_chain = MagicMock()
        select_chain.select.return_value = select_chain
        select_chain.eq.return_value = select_chain
        select_exec = MagicMock()
        select_exec.data = [{"id": "job-1"}, {"id": "job-2"}]
        select_chain.execute.return_value = select_exec

        # Update chain for marking as failed
        update_chain = MagicMock()
        update_chain.update.return_value = update_chain
        update_chain.eq.return_value = update_chain
        update_chain.execute.return_value = MagicMock(data=[])

        call_idx = [0]

        def table_fn(name):
            call_idx[0] += 1
            if call_idx[0] == 1:
                return select_chain
            return update_chain

        mock_sb.table = MagicMock(side_effect=table_fn)

        AutoResearchService.recover_stale_jobs(mock_sb)

        # Should have been called 3 times total: 1 select + 2 updates
        assert mock_sb.table.call_count == 3

    def test_no_stale_jobs(self):
        """recover_stale_jobs does nothing if no running jobs exist."""
        mock_sb = MagicMock()
        chain = MagicMock()
        chain.select.return_value = chain
        chain.eq.return_value = chain
        exec_result = MagicMock()
        exec_result.data = []
        chain.execute.return_value = exec_result
        mock_sb.table = MagicMock(return_value=chain)

        AutoResearchService.recover_stale_jobs(mock_sb)

        # Only the initial select query
        assert mock_sb.table.call_count == 1
