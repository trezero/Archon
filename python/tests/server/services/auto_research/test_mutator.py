"""Unit tests for the prompt mutation agent."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.auto_research.mutator import _summarize_history, mutate_prompt


class TestMutatePrompt:
    """Tests for the mutate_prompt async function."""

    @pytest.mark.asyncio
    async def test_returns_string(self):
        """mutate_prompt returns the rewritten prompt string from the agent."""
        with patch("src.server.services.auto_research.mutator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "You are a concise and helpful assistant."
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            result = await mutate_prompt(
                current_payload="You are a helpful assistant.",
                history=[],
                guidance="Make it more concise.",
            )

        assert isinstance(result, str)
        assert result == "You are a concise and helpful assistant."

    @pytest.mark.asyncio
    async def test_uses_default_model_when_none(self):
        """When model=None, the agent is constructed with the default model string."""
        with patch("src.server.services.auto_research.mutator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "rewritten"
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            await mutate_prompt(
                current_payload="original",
                history=[],
                guidance="improve it",
                model=None,
            )

        call_kwargs = MockAgent.call_args
        assert call_kwargs is not None
        # model should be the default
        assert call_kwargs.kwargs.get("model") == "openai:gpt-4o-mini" or (
            len(call_kwargs.args) > 0 and call_kwargs.args[0] == "openai:gpt-4o-mini"
        )

    @pytest.mark.asyncio
    async def test_uses_provided_model(self):
        """When a model string is given, it is passed to the Agent constructor."""
        with patch("src.server.services.auto_research.mutator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "rewritten"
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            await mutate_prompt(
                current_payload="original",
                history=[],
                guidance="improve it",
                model="anthropic:claude-sonnet-4-6",
            )

        call_kwargs = MockAgent.call_args
        assert call_kwargs is not None
        model_arg = call_kwargs.kwargs.get("model") or (
            call_kwargs.args[0] if call_kwargs.args else None
        )
        assert model_arg == "anthropic:claude-sonnet-4-6"

    @pytest.mark.asyncio
    async def test_passes_history_in_user_message(self):
        """History is incorporated into the message sent to the agent."""
        with patch("src.server.services.auto_research.mutator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "rewritten"
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            history = [
                {"iteration": 1, "score": 0.4, "signals": {"has_steps": True, "identifies_files": False}},
                {"iteration": 2, "score": 0.6, "signals": {"has_steps": True, "identifies_files": True}},
            ]

            await mutate_prompt(
                current_payload="original prompt",
                history=history,
                guidance="focus on file identification",
            )

        run_call = mock_instance.run.call_args
        user_message = run_call.args[0] if run_call.args else run_call.kwargs.get("user_prompt", "")
        # History iterations should appear in the message
        assert "Iteration 1" in user_message or "iteration 1" in user_message.lower()
        assert "Iteration 2" in user_message or "iteration 2" in user_message.lower()

    @pytest.mark.asyncio
    async def test_passes_guidance_in_user_message(self):
        """Mutation guidance is included in the message sent to the agent."""
        guidance_text = "Emphasize clarity and numbered steps."
        with patch("src.server.services.auto_research.mutator.Agent") as MockAgent:
            mock_instance = MagicMock()
            mock_result = MagicMock()
            mock_result.data = "rewritten"
            mock_instance.run = AsyncMock(return_value=mock_result)
            MockAgent.return_value = mock_instance

            await mutate_prompt(
                current_payload="original prompt",
                history=[],
                guidance=guidance_text,
            )

        run_call = mock_instance.run.call_args
        user_message = run_call.args[0] if run_call.args else run_call.kwargs.get("user_prompt", "")
        assert guidance_text in user_message


class TestSummarizeHistory:
    """Tests for the internal _summarize_history helper."""

    def test_empty_history(self):
        summary = _summarize_history([])
        assert "No previous iterations" in summary

    def test_single_entry(self):
        history = [{"iteration": 1, "score": 0.75, "signals": {"greets_user": True, "is_concise": False}}]
        summary = _summarize_history(history)
        assert "Iteration 1" in summary
        assert "0.75" in summary
        assert "greets_user" in summary
        assert "is_concise" in summary

    def test_multiple_entries(self):
        history = [
            {"iteration": 1, "score": 0.5, "signals": {}},
            {"iteration": 2, "score": 0.8, "signals": {"a": True}},
        ]
        summary = _summarize_history(history)
        assert "Iteration 1" in summary
        assert "Iteration 2" in summary

    def test_missing_fields_are_handled(self):
        """Entries with missing keys should not raise."""
        history = [{}]  # completely empty entry
        summary = _summarize_history(history)
        assert "Iteration" in summary
