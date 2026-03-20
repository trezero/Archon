"""Unit tests for the evaluation agent."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.models.auto_research import EvalResult, SignalDefinition, TestCaseDefinition
from src.server.services.auto_research.evaluator import (
    EvaluationOutput,
    SignalEvaluation,
    _build_eval_result,
    _calculate_scalar_score,
    evaluate_output,
)


def _make_test_case(**signal_overrides) -> TestCaseDefinition:
    """Build a minimal TestCaseDefinition for testing."""
    signals = {
        "has_greeting": SignalDefinition(description="Output contains a greeting", weight=1.0, critical=False),
        "is_concise": SignalDefinition(description="Output is under 50 words", weight=2.0, critical=False),
        "mentions_name": SignalDefinition(description="Output mentions the user's name", weight=1.0, critical=True),
    }
    signals.update(signal_overrides)
    return TestCaseDefinition(
        id="tc-1",
        name="Greeting test",
        input="Say hello to Alice.",
        signals=signals,
    )


class TestEvaluateOutput:
    """Tests for the evaluate_output async function."""

    @pytest.mark.asyncio
    async def test_returns_eval_result(self):
        """evaluate_output returns a valid EvalResult."""
        test_case = _make_test_case()
        llm_output = "Hello Alice! How can I help you today?"

        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=True, reasoning="Says Hello"),
                "is_concise": SignalEvaluation(value=True, reasoning="Only 8 words"),
                "mentions_name": SignalEvaluation(value=True, reasoning="Says Alice"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await evaluate_output(test_case, llm_output)

        assert isinstance(result, EvalResult)
        assert set(result.signals.keys()) == {"has_greeting", "is_concise", "mentions_name"}

    @pytest.mark.asyncio
    async def test_correct_signal_values(self):
        """Signal values and weights are mapped correctly from the agent output."""
        test_case = _make_test_case()
        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=True, reasoning="Has greeting"),
                "is_concise": SignalEvaluation(value=False, reasoning="Too long"),
                "mentions_name": SignalEvaluation(value=True, reasoning="Name present"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await evaluate_output(test_case, "Hello Alice! " + "word " * 100)

        assert result.signals["has_greeting"].value is True
        assert result.signals["is_concise"].value is False
        assert result.signals["mentions_name"].value is True

        # Weight from signal definition should be preserved
        assert result.signals["is_concise"].weight == 2.0
        assert result.signals["mentions_name"].critical is True

    @pytest.mark.asyncio
    async def test_correct_scalar_score(self):
        """Scalar score is calculated correctly: sum(value*weight) / sum(weights).

        Signals: has_greeting(True, w=1), is_concise(False, w=2), mentions_name(True, w=1)
        Expected: (1*1 + 0*2 + 1*1) / (1+2+1) = 2/4 = 0.5
        """
        test_case = _make_test_case()
        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=True, reasoning="ok"),
                "is_concise": SignalEvaluation(value=False, reasoning="too long"),
                "mentions_name": SignalEvaluation(value=True, reasoning="ok"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await evaluate_output(test_case, "Hello Alice!")

        assert result.scalar_score == pytest.approx(0.5)
        assert result.pass_status is True  # 0.5 >= 0.5

    @pytest.mark.asyncio
    async def test_pass_status_true_when_score_above_threshold(self):
        """pass_status is True when scalar_score >= 0.5."""
        test_case = _make_test_case()
        # All signals passing → score = 1.0
        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=True, reasoning="ok"),
                "is_concise": SignalEvaluation(value=True, reasoning="ok"),
                "mentions_name": SignalEvaluation(value=True, reasoning="ok"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await evaluate_output(test_case, "Hello Alice!")

        assert result.scalar_score == pytest.approx(1.0)
        assert result.pass_status is True

    @pytest.mark.asyncio
    async def test_pass_status_false_when_score_below_threshold(self):
        """pass_status is False when scalar_score < 0.5."""
        test_case = _make_test_case()
        # All signals failing → score = 0.0
        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=False, reasoning="no"),
                "is_concise": SignalEvaluation(value=False, reasoning="no"),
                "mentions_name": SignalEvaluation(value=False, reasoning="no"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await evaluate_output(test_case, "Goodbye.")

        assert result.scalar_score == pytest.approx(0.0)
        assert result.pass_status is False

    @pytest.mark.asyncio
    async def test_missing_signal_treated_as_false(self):
        """When the LLM omits a signal from its response, it is treated as False."""
        test_case = _make_test_case()
        # Agent only returns 2 of 3 signals
        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=True, reasoning="ok"),
                # is_concise is missing
                "mentions_name": SignalEvaluation(value=True, reasoning="ok"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await evaluate_output(test_case, "Hello Alice!")

        # All 3 signals should be in the result
        assert "is_concise" in result.signals
        assert result.signals["is_concise"].value is False
        assert result.signals["is_concise"].weight == 2.0

    @pytest.mark.asyncio
    async def test_uses_default_model_when_none(self):
        """When model=None, the agent is constructed with the default model."""
        test_case = _make_test_case()
        agent_eval_output = EvaluationOutput(
            signals={
                "has_greeting": SignalEvaluation(value=True, reasoning="ok"),
                "is_concise": SignalEvaluation(value=True, reasoning="ok"),
                "mentions_name": SignalEvaluation(value=True, reasoning="ok"),
            }
        )

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            await evaluate_output(test_case, "Hello Alice!", model=None)

        call_kwargs = MockAgent.call_args
        model_arg = call_kwargs.kwargs.get("model") or (
            call_kwargs.args[0] if call_kwargs.args else None
        )
        assert model_arg == "openai:gpt-4o-mini"

    @pytest.mark.asyncio
    async def test_uses_provided_model(self):
        """When a model string is given, it is passed to the Agent constructor."""
        test_case = _make_test_case()
        agent_eval_output = EvaluationOutput(signals={})

        with patch("src.server.services.auto_research.evaluator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = agent_eval_output
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            await evaluate_output(test_case, "output", model="anthropic:claude-3-5-haiku-latest")

        call_kwargs = MockAgent.call_args
        model_arg = call_kwargs.kwargs.get("model") or (
            call_kwargs.args[0] if call_kwargs.args else None
        )
        assert model_arg == "anthropic:claude-3-5-haiku-latest"


class TestBuildEvalResult:
    """Tests for the internal _build_eval_result helper."""

    def _make_agent_output(self, **signal_values: bool) -> EvaluationOutput:
        return EvaluationOutput(
            signals={name: SignalEvaluation(value=val, reasoning="test") for name, val in signal_values.items()}
        )

    def test_all_signals_present(self):
        """All test case signals appear in the result."""
        test_case = _make_test_case()
        agent_output = self._make_agent_output(has_greeting=True, is_concise=True, mentions_name=True)

        result = _build_eval_result(test_case, agent_output)

        assert set(result.signals.keys()) == {"has_greeting", "is_concise", "mentions_name"}

    def test_missing_signal_defaults_to_false(self):
        """Missing signal in agent output defaults to False with placeholder reasoning."""
        test_case = _make_test_case()
        agent_output = self._make_agent_output(has_greeting=True)  # only 1 of 3

        result = _build_eval_result(test_case, agent_output)

        assert result.signals["is_concise"].value is False
        assert result.signals["mentions_name"].value is False
        assert "not evaluated" in result.signals["is_concise"].reasoning.lower()

    def test_weight_copied_from_definition(self):
        """Signal weights are taken from the test case definition, not the agent output."""
        test_case = _make_test_case()
        agent_output = self._make_agent_output(has_greeting=True, is_concise=True, mentions_name=True)

        result = _build_eval_result(test_case, agent_output)

        assert result.signals["is_concise"].weight == 2.0
        assert result.signals["has_greeting"].weight == 1.0

    def test_critical_flag_copied_from_definition(self):
        """The critical flag is taken from the test case definition."""
        test_case = _make_test_case()
        agent_output = self._make_agent_output(has_greeting=True, is_concise=True, mentions_name=True)

        result = _build_eval_result(test_case, agent_output)

        assert result.signals["mentions_name"].critical is True
        assert result.signals["has_greeting"].critical is False


class TestCalculateScalarScore:
    """Tests for the internal _calculate_scalar_score helper."""

    def _make_signals(self, values_and_weights: list[tuple[bool, float]]):
        from src.server.models.auto_research import EvalSignalResult

        return {
            f"sig_{i}": EvalSignalResult(value=val, weight=w, critical=False)
            for i, (val, w) in enumerate(values_and_weights)
        }

    def test_all_passing_equal_weights(self):
        """All signals passing with equal weights → score = 1.0."""
        signals = self._make_signals([(True, 1.0), (True, 1.0), (True, 1.0)])
        assert _calculate_scalar_score(signals) == pytest.approx(1.0)

    def test_all_failing_equal_weights(self):
        """All signals failing → score = 0.0."""
        signals = self._make_signals([(False, 1.0), (False, 1.0)])
        assert _calculate_scalar_score(signals) == pytest.approx(0.0)

    def test_mixed_equal_weights(self):
        """Half passing, half failing, equal weights → score = 0.5."""
        signals = self._make_signals([(True, 1.0), (False, 1.0)])
        assert _calculate_scalar_score(signals) == pytest.approx(0.5)

    def test_weighted_score(self):
        """Weighted score calculation: (T*w1 + F*w2) / (w1+w2).

        True(w=3) + False(w=1) → (1*3 + 0*1) / (3+1) = 3/4 = 0.75
        """
        signals = self._make_signals([(True, 3.0), (False, 1.0)])
        assert _calculate_scalar_score(signals) == pytest.approx(0.75)

    def test_empty_signals(self):
        """Empty signal dict → score = 0.0."""
        assert _calculate_scalar_score({}) == pytest.approx(0.0)

    def test_three_signals_weighted(self):
        """Verifies the task spec example: has_greeting(T,1) + is_concise(F,2) + mentions_name(T,1).

        Expected: (1*1 + 0*2 + 1*1) / (1+2+1) = 2/4 = 0.5
        """
        signals = self._make_signals([(True, 1.0), (False, 2.0), (True, 1.0)])
        assert _calculate_scalar_score(signals) == pytest.approx(0.5)
