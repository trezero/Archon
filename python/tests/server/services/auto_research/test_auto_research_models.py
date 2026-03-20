"""Unit tests for auto_research Pydantic models and Protocol."""

import pytest
from pydantic import ValidationError

from src.server.models.auto_research import (
    AutoResearchIteration,
    AutoResearchJob,
    AutoResearchJobWithIterations,
    AutoResearchTarget,
    EvalResult,
    EvalSignalResult,
    EvalSuiteDefinition,
    EvalSuiteSummary,
    SignalDefinition,
    TestCaseDefinition,
)


class TestSignalDefinition:
    def test_defaults(self):
        sig = SignalDefinition(description="covers edge cases")
        assert sig.weight == 1.0
        assert sig.critical is False
        assert sig.description == "covers edge cases"

    def test_custom_values(self):
        sig = SignalDefinition(weight=2.5, critical=True, description="must pass")
        assert sig.weight == 2.5
        assert sig.critical is True

    def test_missing_description_raises(self):
        with pytest.raises(ValidationError):
            SignalDefinition()


class TestTestCaseDefinition:
    def _make(self, **kwargs):
        defaults = {
            "id": "tc-1",
            "name": "Test greeting",
            "input": "Hello",
            "signals": {"greets_user": SignalDefinition(description="says hello")},
        }
        defaults.update(kwargs)
        return TestCaseDefinition(**defaults)

    def test_basic(self):
        tc = self._make()
        assert tc.id == "tc-1"
        assert "greets_user" in tc.signals

    def test_empty_signals_allowed(self):
        tc = self._make(signals={})
        assert tc.signals == {}

    def test_missing_required_field_raises(self):
        with pytest.raises(ValidationError):
            TestCaseDefinition(id="x", name="y", signals={})  # missing input


class TestEvalSuiteDefinition:
    def _make_suite(self, **kwargs):
        defaults = {
            "id": "suite-1",
            "name": "My Suite",
            "target_file": "prompts/system.txt",
            "mutation_guidance": "Focus on conciseness",
            "test_cases": [],
        }
        defaults.update(kwargs)
        return EvalSuiteDefinition(**defaults)

    def test_defaults(self):
        suite = self._make_suite()
        assert suite.description == ""
        assert suite.model is None

    def test_with_all_fields(self):
        suite = self._make_suite(description="desc", model="claude-3-5-sonnet-20241022")
        assert suite.description == "desc"
        assert suite.model == "claude-3-5-sonnet-20241022"

    def test_missing_required_raises(self):
        with pytest.raises(ValidationError):
            EvalSuiteDefinition(id="x", name="y")  # missing target_file, mutation_guidance


class TestEvalSuiteSummary:
    def test_basic(self):
        summary = EvalSuiteSummary(
            id="suite-1",
            name="My Suite",
            description="",
            target_file="prompts/system.txt",
            test_case_count=5,
        )
        assert summary.test_case_count == 5


class TestEvalSignalResult:
    def test_basic(self):
        result = EvalSignalResult(value=True, weight=1.5, critical=False)
        assert result.reasoning is None

    def test_with_reasoning(self):
        result = EvalSignalResult(value=False, weight=1.0, critical=True, reasoning="Too verbose")
        assert result.reasoning == "Too verbose"


class TestEvalResult:
    def _make(self, scalar_score=0.8, pass_status=True):
        signals = {
            "greets_user": EvalSignalResult(value=True, weight=1.0, critical=False),
        }
        return EvalResult(signals=signals, scalar_score=scalar_score, pass_status=pass_status)

    def test_basic(self):
        result = self._make()
        assert result.scalar_score == 0.8
        assert result.pass_status is True

    def test_failed(self):
        result = self._make(scalar_score=0.2, pass_status=False)
        assert result.pass_status is False


class TestAutoResearchJob:
    def _make_job(self, **kwargs):
        defaults = {
            "id": "job-abc",
            "eval_suite_id": "suite-1",
            "status": "running",
            "target_file": "prompts/system.txt",
            "baseline_payload": "You are a helpful assistant.",
            "max_iterations": 10,
            "completed_iterations": 0,
            "created_at": "2026-03-20T00:00:00Z",
        }
        defaults.update(kwargs)
        return AutoResearchJob(**defaults)

    def test_defaults(self):
        job = self._make_job()
        assert job.baseline_score is None
        assert job.best_payload is None
        assert job.best_score is None
        assert job.model is None
        assert job.error_message is None
        assert job.completed_at is None

    def test_with_results(self):
        job = self._make_job(
            baseline_score=0.6,
            best_payload="You are a concise assistant.",
            best_score=0.85,
            completed_iterations=5,
        )
        assert job.best_score == 0.85


class TestAutoResearchIteration:
    def test_basic(self):
        iteration = AutoResearchIteration(
            id="iter-1",
            job_id="job-abc",
            iteration_number=1,
            payload="You are helpful.",
            scalar_score=0.75,
            signals={"greets_user": {"value": True, "weight": 1.0, "critical": False}},
            is_frontier=True,
            created_at="2026-03-20T00:01:00Z",
        )
        assert iteration.is_frontier is True
        assert iteration.scalar_score == 0.75


class TestAutoResearchJobWithIterations:
    def test_inherits_job_fields(self):
        job = AutoResearchJobWithIterations(
            id="job-abc",
            eval_suite_id="suite-1",
            status="completed",
            target_file="prompts/system.txt",
            baseline_payload="You are a helpful assistant.",
            max_iterations=5,
            completed_iterations=5,
            created_at="2026-03-20T00:00:00Z",
        )
        assert job.iterations == []

    def test_with_iterations(self):
        iteration = AutoResearchIteration(
            id="iter-1",
            job_id="job-abc",
            iteration_number=1,
            payload="You are concise.",
            scalar_score=0.9,
            signals={},
            is_frontier=True,
            created_at="2026-03-20T00:01:00Z",
        )
        job = AutoResearchJobWithIterations(
            id="job-abc",
            eval_suite_id="suite-1",
            status="completed",
            target_file="prompts/system.txt",
            baseline_payload="You are a helpful assistant.",
            max_iterations=5,
            completed_iterations=1,
            created_at="2026-03-20T00:00:00Z",
            iterations=[iteration],
        )
        assert len(job.iterations) == 1
        assert job.iterations[0].scalar_score == 0.9


class TestAutoResearchTargetProtocol:
    """Verify Protocol structural checking works correctly."""

    def test_valid_implementation_passes_isinstance_check(self):
        """A class implementing all protocol methods passes runtime isinstance check."""

        class ConcreteTarget:
            @property
            def id(self) -> str:
                return "target-1"

            @property
            def payload(self) -> str:
                return "You are helpful."

            async def mutate(self, current_payload: str, history: list) -> str:
                return current_payload + " Be concise."

            async def execute(self, payload: str) -> list:
                return []

            async def evaluate(self, test_case, llm_output: str):
                return EvalResult(signals={}, scalar_score=1.0, pass_status=True)

            def accept(self, current_best, candidate) -> bool:
                return candidate.scalar_score > current_best.scalar_score

        target = ConcreteTarget()
        assert isinstance(target, AutoResearchTarget)

    def test_incomplete_implementation_fails_isinstance_check(self):
        """A class missing protocol methods fails runtime isinstance check."""

        class IncompleteTarget:
            @property
            def id(self) -> str:
                return "target-1"

            # missing: payload, mutate, execute, evaluate, accept

        target = IncompleteTarget()
        assert not isinstance(target, AutoResearchTarget)
