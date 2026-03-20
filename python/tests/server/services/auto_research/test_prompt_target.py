"""Unit tests for PromptTarget."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.models.auto_research import (
    EvalResult,
    EvalSignalResult,
    EvalSuiteDefinition,
    SignalDefinition,
    TestCaseDefinition,
)
from src.server.services.auto_research.prompt_target import PromptTarget


def _make_suite(target_file: str = "/tmp/test_prompt.txt", model: str | None = None) -> EvalSuiteDefinition:
    """Create a minimal EvalSuiteDefinition for testing."""
    return EvalSuiteDefinition(
        id="suite-1",
        name="Test Suite",
        description="A test suite",
        target_file=target_file,
        model=model,
        mutation_guidance="Make the prompt better",
        test_cases=[
            TestCaseDefinition(
                id="tc-1",
                name="Test case 1",
                input="Hello world",
                signals={
                    "has_greeting": SignalDefinition(description="Has greeting", weight=1.0, critical=False),
                    "is_concise": SignalDefinition(description="Is concise", weight=1.0, critical=True),
                },
            ),
        ],
    )


def _make_eval_result(scalar_score: float, signals: dict[str, tuple[bool, float, bool]] | None = None) -> EvalResult:
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


class TestPromptTargetInit:
    """Tests for PromptTarget initialization."""

    def test_reads_target_file(self, tmp_path):
        """PromptTarget reads the target file content on init."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("You are a helpful assistant.", encoding="utf-8")

        suite = _make_suite(target_file=str(prompt_file))
        target = PromptTarget(suite)

        assert target.payload == "You are a helpful assistant."

    def test_id_returns_suite_id(self, tmp_path):
        """The id property returns the suite ID."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("prompt", encoding="utf-8")

        suite = _make_suite(target_file=str(prompt_file))
        target = PromptTarget(suite)

        assert target.id == "suite-1"

    def test_raises_on_missing_file(self):
        """PromptTarget raises FileNotFoundError if the target file does not exist."""
        suite = _make_suite(target_file="/nonexistent/path/prompt.txt")
        with pytest.raises(FileNotFoundError, match="Target file not found"):
            PromptTarget(suite)


class TestPromptTargetMutate:
    """Tests for PromptTarget.mutate."""

    @pytest.mark.asyncio
    async def test_calls_mutate_prompt(self, tmp_path):
        """mutate() delegates to mutate_prompt with suite's guidance and model."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("original prompt", encoding="utf-8")

        suite = _make_suite(target_file=str(prompt_file), model="openai:gpt-4o")
        target = PromptTarget(suite)

        with patch("src.server.services.auto_research.prompt_target.mutate_prompt", new_callable=AsyncMock) as mock_mut:
            mock_mut.return_value = "improved prompt"
            result = await target.mutate("current payload", [{"iteration": 1, "score": 0.5}])

        assert result == "improved prompt"
        mock_mut.assert_called_once_with(
            current_payload="current payload",
            history=[{"iteration": 1, "score": 0.5}],
            guidance="Make the prompt better",
            model="openai:gpt-4o",
        )


class TestPromptTargetExecute:
    """Tests for PromptTarget.execute."""

    @pytest.mark.asyncio
    async def test_returns_test_case_output_pairs(self, tmp_path):
        """execute() runs each test case and returns (test_case, output) pairs."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("system prompt", encoding="utf-8")

        suite = _make_suite(target_file=str(prompt_file))
        target = PromptTarget(suite)

        with patch("src.server.services.auto_research.prompt_target.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "Hello! How are you?"
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            results = await target.execute("my system prompt")

        assert len(results) == 1
        test_case, output = results[0]
        assert test_case.id == "tc-1"
        assert output == "Hello! How are you?"

        # Agent constructed with payload as system_prompt
        MockAgent.assert_called_once()
        call_kwargs = MockAgent.call_args.kwargs
        assert call_kwargs["system_prompt"] == "my system prompt"

    @pytest.mark.asyncio
    async def test_uses_default_model_when_none(self, tmp_path):
        """When suite.model is None, execute uses the default model."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("prompt", encoding="utf-8")

        suite = _make_suite(target_file=str(prompt_file), model=None)
        target = PromptTarget(suite)

        with patch("src.server.services.auto_research.prompt_target.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "output"
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            await target.execute("payload")

        call_kwargs = MockAgent.call_args
        model_arg = call_kwargs.kwargs.get("model") or (call_kwargs.args[0] if call_kwargs.args else None)
        assert model_arg == "openai:gpt-4o-mini"

    @pytest.mark.asyncio
    async def test_runs_multiple_test_cases(self, tmp_path):
        """execute() runs all test cases in the suite."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("prompt", encoding="utf-8")

        suite = EvalSuiteDefinition(
            id="suite-multi",
            name="Multi-case",
            target_file=str(prompt_file),
            mutation_guidance="guidance",
            test_cases=[
                TestCaseDefinition(
                    id="tc-1", name="Case 1", input="input 1",
                    signals={"sig": SignalDefinition(description="d", weight=1.0)},
                ),
                TestCaseDefinition(
                    id="tc-2", name="Case 2", input="input 2",
                    signals={"sig": SignalDefinition(description="d", weight=1.0)},
                ),
            ],
        )
        target = PromptTarget(suite)

        with patch("src.server.services.auto_research.prompt_target.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_instance.run = AsyncMock(
                side_effect=[
                    MagicMock(data="output 1"),
                    MagicMock(data="output 2"),
                ]
            )
            MockAgent.return_value = mock_instance

            results = await target.execute("payload")

        assert len(results) == 2
        assert results[0][0].id == "tc-1"
        assert results[0][1] == "output 1"
        assert results[1][0].id == "tc-2"
        assert results[1][1] == "output 2"


class TestPromptTargetEvaluate:
    """Tests for PromptTarget.evaluate."""

    @pytest.mark.asyncio
    async def test_delegates_to_evaluate_output(self, tmp_path):
        """evaluate() delegates to evaluate_output with the suite's model."""
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("prompt", encoding="utf-8")

        suite = _make_suite(target_file=str(prompt_file), model="openai:gpt-4o")
        target = PromptTarget(suite)

        expected_eval = _make_eval_result(0.75)
        test_case = suite.test_cases[0]

        with patch(
            "src.server.services.auto_research.prompt_target.evaluate_output",
            new_callable=AsyncMock,
        ) as mock_eval:
            mock_eval.return_value = expected_eval
            result = await target.evaluate(test_case, "some output")

        assert result is expected_eval
        mock_eval.assert_called_once_with(
            test_case=test_case,
            llm_output="some output",
            model="openai:gpt-4o",
        )


class TestPromptTargetAccept:
    """Tests for PromptTarget.accept."""

    def _make_target(self, tmp_path):
        prompt_file = tmp_path / "prompt.txt"
        prompt_file.write_text("prompt", encoding="utf-8")
        suite = _make_suite(target_file=str(prompt_file))
        return PromptTarget(suite)

    def test_accepts_higher_score_no_regressions(self, tmp_path):
        """Accepts candidate with higher score and no critical regressions."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.5, {
            "sig_a": (True, 1.0, True),
            "sig_b": (True, 1.0, False),
        })
        candidate = _make_eval_result(0.8, {
            "sig_a": (True, 1.0, True),
            "sig_b": (True, 1.0, False),
        })

        assert target.accept(current, candidate) is True

    def test_rejects_lower_score(self, tmp_path):
        """Rejects candidate with lower score."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.8)
        candidate = _make_eval_result(0.5)

        assert target.accept(current, candidate) is False

    def test_rejects_equal_score(self, tmp_path):
        """Rejects candidate with equal score (must be strictly greater)."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.5)
        candidate = _make_eval_result(0.5)

        assert target.accept(current, candidate) is False

    def test_rejects_critical_regression(self, tmp_path):
        """Rejects candidate even with higher score if a critical signal regresses."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.5, {
            "critical_sig": (True, 1.0, True),
            "other_sig": (False, 1.0, False),
        })
        candidate = _make_eval_result(0.9, {
            "critical_sig": (False, 1.0, True),  # Regression on critical signal
            "other_sig": (True, 1.0, False),
        })

        assert target.accept(current, candidate) is False

    def test_accepts_non_critical_regression(self, tmp_path):
        """Accepts candidate with higher score even if a non-critical signal regresses."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.5, {
            "non_critical": (True, 1.0, False),
        })
        candidate = _make_eval_result(0.8, {
            "non_critical": (False, 1.0, False),  # Non-critical regression is allowed
        })

        assert target.accept(current, candidate) is True

    def test_accepts_when_critical_signal_was_already_false(self, tmp_path):
        """No regression if critical signal was already False in the current best."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.3, {
            "critical_sig": (False, 1.0, True),  # Already False
        })
        candidate = _make_eval_result(0.5, {
            "critical_sig": (False, 1.0, True),  # Still False — no regression
        })

        assert target.accept(current, candidate) is True

    def test_accepts_new_critical_signal_in_candidate(self, tmp_path):
        """A critical signal appearing only in the candidate (not in current_best) cannot regress."""
        target = self._make_target(tmp_path)

        current = _make_eval_result(0.3, {})  # No signals
        candidate = _make_eval_result(0.6, {
            "new_critical": (False, 1.0, True),
        })

        assert target.accept(current, candidate) is True
