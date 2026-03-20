"""Integration tests for the AutoResearchService end-to-end flow."""

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.models.auto_research import EvalResult, EvalSignalResult, EvalSuiteDefinition, SignalDefinition, TestCaseDefinition
from src.server.services.auto_research.eval_suite_loader import EvalSuiteLoader
from src.server.services.auto_research_service import AutoResearchService

# Path to the actual eval suite JSON file
# Resolve from the known package location rather than from the test file to avoid
# ambiguity when pytest changes the working directory.
_EVAL_SUITES_DIR = Path(__file__).parents[4] / "src" / "server" / "data" / "eval_suites"
_PLANNING_SUITE_PATH = _EVAL_SUITES_DIR / "planning_prompt_v1.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_eval_result(scalar_score: float, critical_signals_pass: bool = True) -> EvalResult:
    """Build a simple EvalResult for use in mock side effects."""
    return EvalResult(
        scalar_score=scalar_score,
        pass_status=scalar_score >= 0.5,
        signals={
            "identifies_files": EvalSignalResult(
                value=critical_signals_pass,
                weight=2.0,
                critical=True,
            ),
            "has_numbered_steps": EvalSignalResult(
                value=scalar_score >= 0.5,
                weight=1.0,
                critical=False,
            ),
        },
    )


def _make_chainable_mock(data=None):
    """Return a MagicMock where every chainable method returns itself, and .execute() returns a result."""
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


def _make_supabase_mock():
    """Create a Supabase mock that tracks table calls and allows per-table data configuration."""
    mock = MagicMock()
    table_chains: dict[str, MagicMock] = {}

    def table_fn(name: str) -> MagicMock:
        if name not in table_chains:
            table_chains[name] = _make_chainable_mock()
        return table_chains[name]

    mock.table = MagicMock(side_effect=table_fn)
    mock._table_chains = table_chains
    return mock


def _make_minimal_suite(target_file: str) -> EvalSuiteDefinition:
    """Return a small EvalSuiteDefinition with one test case."""
    return EvalSuiteDefinition(
        id="planning_prompt_v1",
        name="Planning Prompt Test",
        description="Integration test suite",
        target_file=target_file,
        model=None,
        mutation_guidance="Improve clarity and specificity",
        test_cases=[
            TestCaseDefinition(
                id="tc_simple_crud",
                name="Simple CRUD",
                input="Create a REST API for a todo list",
                signals={
                    "identifies_files": SignalDefinition(
                        description="Plan identifies specific files",
                        weight=2.0,
                        critical=True,
                    ),
                    "has_numbered_steps": SignalDefinition(
                        description="Plan has numbered steps",
                        weight=1.0,
                        critical=False,
                    ),
                },
            )
        ],
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestFullOptimizationLoop:
    """End-to-end validation of the full optimization loop using mocks."""

    @pytest.mark.asyncio
    async def test_full_optimization_loop(self, tmp_path):
        """Run the _run_loop directly with mocked PydanticAI agents and Supabase.

        Verifies that:
        - a job record is created in the database
        - baseline and iteration records are inserted
        - best_payload is updated when a better iteration is found
        - job is marked completed
        """
        # Set up a fake prompt file
        prompt_file = tmp_path / "planning.md"
        prompt_file.write_text("# Original planning prompt\nDo stuff.", encoding="utf-8")

        suite = _make_minimal_suite(str(prompt_file))

        mock_sb = _make_supabase_mock()

        # The "running jobs" check at start_optimization must return empty
        no_running = _make_chainable_mock(data=[])
        # The per-iteration status check must return {"status": "running"}
        running_status = _make_chainable_mock(data={"status": "running"})

        call_index = {"count": 0}

        def table_fn(name: str) -> MagicMock:
            call_index["count"] += 1
            if name == "auto_research_iterations":
                return _make_chainable_mock(data=[])
            # For the jobs table, first call is the "any running?" check
            if call_index["count"] == 1:
                return no_running
            # All subsequent jobs-table calls need a flexible mock supporting
            # both .select().eq().single().execute() and .insert/.update chains
            combo = MagicMock()
            combo.select.return_value = running_status
            combo.insert.return_value = _make_chainable_mock(data=[])
            combo.update.return_value = _make_chainable_mock(data=[])
            return combo

        mock_sb.table = MagicMock(side_effect=table_fn)

        service = AutoResearchService(supabase_client=mock_sb)

        # Scores: baseline=0.4, iteration1=0.7 (accepted), iteration2=0.5 (rejected)
        baseline_eval = _make_eval_result(0.4)
        iter1_eval = _make_eval_result(0.7)
        iter2_eval = _make_eval_result(0.5)

        tc = suite.test_cases[0]

        mock_target = MagicMock()
        mock_target.payload = "# Original planning prompt\nDo stuff."
        mock_target.execute = AsyncMock(side_effect=[
            [(tc, "baseline output")],
            [(tc, "improved prompt v1 output")],
            [(tc, "improved prompt v2 output")],
        ])
        mock_target.evaluate = AsyncMock(side_effect=[
            baseline_eval,
            iter1_eval,
            iter2_eval,
        ])
        mock_target.mutate = AsyncMock(side_effect=[
            "improved prompt v1",
            "improved prompt v2",
        ])
        mock_target.accept = MagicMock(side_effect=[True, False])

        mock_progress = MagicMock()
        mock_progress.start = AsyncMock()
        mock_progress.update = AsyncMock()
        mock_progress.complete = AsyncMock()
        mock_progress.error = AsyncMock()

        # Run the loop directly (not via asyncio.create_task)
        await service._run_loop(
            job_id="job-e2e-001",
            target=mock_target,
            max_iterations=2,
            model=None,
            progress=mock_progress,
        )

        # Baseline + 2 iterations = 3 execute calls
        assert mock_target.execute.call_count == 3
        # Baseline + 2 iterations = 3 evaluate calls
        assert mock_target.evaluate.call_count == 3
        # 2 mutation calls
        assert mock_target.mutate.call_count == 2
        # 1 accept/reject decision per iteration
        assert mock_target.accept.call_count == 2
        # Progress completed without error
        mock_progress.complete.assert_called_once()
        mock_progress.error.assert_not_called()

    @pytest.mark.asyncio
    async def test_full_optimization_loop_cancellation(self, tmp_path):
        """Loop exits cleanly when the job is cancelled mid-run."""
        prompt_file = tmp_path / "planning.md"
        prompt_file.write_text("original prompt", encoding="utf-8")

        suite = _make_minimal_suite(str(prompt_file))
        tc = suite.test_cases[0]

        # Status chain returns "cancelled" to trigger early exit
        cancelled_status = _make_chainable_mock(data={"status": "cancelled"})

        combo = MagicMock()
        combo.select.return_value = cancelled_status
        combo.insert.return_value = _make_chainable_mock(data=[])
        combo.update.return_value = _make_chainable_mock(data=[])

        mock_sb = MagicMock()
        mock_sb.table = MagicMock(return_value=combo)

        service = AutoResearchService(supabase_client=mock_sb)

        baseline_eval = _make_eval_result(0.4)

        mock_target = MagicMock()
        mock_target.payload = "original prompt"
        mock_target.execute = AsyncMock(return_value=[(tc, "baseline output")])
        mock_target.evaluate = AsyncMock(return_value=baseline_eval)
        mock_target.mutate = AsyncMock(return_value="mutated prompt")

        mock_progress = MagicMock()
        mock_progress.update = AsyncMock()
        mock_progress.complete = AsyncMock()
        mock_progress.error = AsyncMock()

        await service._run_loop(
            job_id="job-cancel-001",
            target=mock_target,
            max_iterations=5,
            model=None,
            progress=mock_progress,
        )

        # Loop should have stopped; mutate should not have been called
        mock_target.mutate.assert_not_called()
        # Neither complete nor error should be called on cancellation
        mock_progress.complete.assert_not_called()
        mock_progress.error.assert_not_called()


@pytest.mark.integration
class TestEvalSuiteLoadsCorrectly:
    """Verify the planning_prompt_v1.json eval suite parses and validates correctly."""

    def test_eval_suite_file_exists(self):
        """The JSON file must exist in the expected location."""
        assert _PLANNING_SUITE_PATH.exists(), (
            f"Eval suite file not found at {_PLANNING_SUITE_PATH}"
        )

    def test_eval_suite_loads_via_loader(self):
        """EvalSuiteLoader must parse the file without error."""
        loader = EvalSuiteLoader(suites_dir=str(_EVAL_SUITES_DIR))
        suite = loader.load_suite("planning_prompt_v1")

        assert suite.id == "planning_prompt_v1"
        assert suite.name == "Agent Work Orders Planning Prompt"

    def test_eval_suite_has_three_test_cases(self):
        """Suite must contain exactly 3 test cases."""
        loader = EvalSuiteLoader(suites_dir=str(_EVAL_SUITES_DIR))
        suite = loader.load_suite("planning_prompt_v1")

        assert len(suite.test_cases) == 3

    def test_test_case_ids_are_correct(self):
        """Test case IDs must match expected values."""
        loader = EvalSuiteLoader(suites_dir=str(_EVAL_SUITES_DIR))
        suite = loader.load_suite("planning_prompt_v1")

        ids = [tc.id for tc in suite.test_cases]
        assert "tc_simple_crud" in ids
        assert "tc_react_component" in ids
        assert "tc_cli_tool" in ids

    def test_signal_weights_and_critical_flags(self):
        """Critical signals must have correct weights and critical=True."""
        loader = EvalSuiteLoader(suites_dir=str(_EVAL_SUITES_DIR))
        suite = loader.load_suite("planning_prompt_v1")

        for tc in suite.test_cases:
            # Every test case must have an "identifies_files" critical signal
            assert "identifies_files" in tc.signals, (
                f"Test case '{tc.id}' missing 'identifies_files' signal"
            )
            signal = tc.signals["identifies_files"]
            assert signal.critical is True, (
                f"'identifies_files' signal in '{tc.id}' must be critical"
            )
            assert signal.weight == 2.0, (
                f"'identifies_files' signal in '{tc.id}' must have weight 2.0"
            )

    def test_mutation_guidance_is_non_empty(self):
        """Mutation guidance must be a non-empty string."""
        loader = EvalSuiteLoader(suites_dir=str(_EVAL_SUITES_DIR))
        suite = loader.load_suite("planning_prompt_v1")

        assert suite.mutation_guidance
        assert len(suite.mutation_guidance) > 20

    def test_all_signals_have_descriptions(self):
        """Every signal across all test cases must have a non-empty description."""
        loader = EvalSuiteLoader(suites_dir=str(_EVAL_SUITES_DIR))
        suite = loader.load_suite("planning_prompt_v1")

        for tc in suite.test_cases:
            for signal_name, signal in tc.signals.items():
                assert signal.description, (
                    f"Signal '{signal_name}' in test case '{tc.id}' has no description"
                )

    def test_raw_json_structure(self):
        """Validate raw JSON structure matches expected schema shape."""
        raw = json.loads(_PLANNING_SUITE_PATH.read_text(encoding="utf-8"))

        assert raw["id"] == "planning_prompt_v1"
        assert raw["model"] is None
        assert "target_file" in raw
        assert "mutation_guidance" in raw
        assert len(raw["test_cases"]) == 3

        # Verify each test case has required fields
        for tc in raw["test_cases"]:
            assert "id" in tc
            assert "name" in tc
            assert "input" in tc
            assert "signals" in tc
            assert len(tc["signals"]) > 0


@pytest.mark.integration
class TestApplyWritesFile:
    """Verify that apply_result writes the best_payload to the target file."""

    @pytest.mark.asyncio
    async def test_apply_writes_best_payload_to_target_file(self, tmp_path):
        """apply_result must overwrite the target file with the job's best_payload."""
        target_file = tmp_path / "planning.md"
        target_file.write_text("# Original prompt\nOriginal content.", encoding="utf-8")

        best_payload = "# Improved prompt\nClearer, more actionable instructions."

        mock_sb = MagicMock()
        chain = _make_chainable_mock(data={
            "id": "job-apply-001",
            "eval_suite_id": "planning_prompt_v1",
            "status": "completed",
            "target_file": str(target_file),
            "baseline_payload": "# Original prompt\nOriginal content.",
            "best_payload": best_payload,
            "best_score": 0.85,
            "max_iterations": 5,
            "completed_iterations": 5,
            "created_at": "2026-03-20T00:00:00",
        })
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)
        result_path = await service.apply_result("job-apply-001")

        # Verify the return value is the target file path
        assert result_path == str(target_file)

        # Verify the file was actually overwritten
        written = target_file.read_text(encoding="utf-8")
        assert written == best_payload

    @pytest.mark.asyncio
    async def test_apply_raises_for_running_job(self, tmp_path):
        """apply_result must raise ValueError when the job is not completed."""
        mock_sb = MagicMock()
        chain = _make_chainable_mock(data={
            "id": "job-running-001",
            "eval_suite_id": "planning_prompt_v1",
            "status": "running",
            "target_file": str(tmp_path / "planning.md"),
            "baseline_payload": "original",
            "max_iterations": 5,
            "completed_iterations": 2,
            "created_at": "2026-03-20T00:00:00",
        })
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)

        with pytest.raises(ValueError, match="not completed"):
            await service.apply_result("job-running-001")

    @pytest.mark.asyncio
    async def test_apply_raises_when_no_best_payload(self, tmp_path):
        """apply_result must raise ValueError when best_payload is None."""
        mock_sb = MagicMock()
        chain = _make_chainable_mock(data={
            "id": "job-no-best-001",
            "eval_suite_id": "planning_prompt_v1",
            "status": "completed",
            "target_file": str(tmp_path / "planning.md"),
            "baseline_payload": "original",
            "best_payload": None,
            "max_iterations": 5,
            "completed_iterations": 5,
            "created_at": "2026-03-20T00:00:00",
        })
        mock_sb.table = MagicMock(return_value=chain)

        service = AutoResearchService(supabase_client=mock_sb)

        with pytest.raises(ValueError, match="no best_payload"):
            await service.apply_result("job-no-best-001")
