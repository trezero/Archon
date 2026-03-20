"""PromptTarget — implements AutoResearchTarget for file-based prompt optimization."""

import logging
from pathlib import Path

from pydantic_ai import Agent

from ...models.auto_research import (
    EvalResult,
    EvalSuiteDefinition,
    TestCaseDefinition,
)
from .evaluator import evaluate_output
from .mutator import mutate_prompt

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "openai:gpt-4o-mini"


class PromptTarget:
    """Implements the AutoResearchTarget protocol for file-based prompt optimization.

    Reads a target file as the prompt payload, mutates it via an LLM, executes it
    against test cases, and evaluates the outputs.
    """

    def __init__(self, suite: EvalSuiteDefinition) -> None:
        self._suite = suite
        target_path = Path(suite.target_file)
        if not target_path.exists():
            raise FileNotFoundError(f"Target file not found: {suite.target_file}")
        self._payload = target_path.read_text(encoding="utf-8")

    @property
    def id(self) -> str:
        return self._suite.id

    @property
    def payload(self) -> str:
        return self._payload

    async def mutate(self, current_payload: str, history: list[dict]) -> str:
        """Generate a mutated candidate payload via the mutation agent."""
        return await mutate_prompt(
            current_payload=current_payload,
            history=history,
            guidance=self._suite.mutation_guidance,
            model=self._suite.model,
        )

    async def execute(self, payload: str) -> list[tuple[TestCaseDefinition, str]]:
        """Execute the payload as a system prompt against all test cases.

        Creates a PydanticAI Agent with the payload as the system prompt and runs
        each test case's input through it, collecting outputs.
        """
        resolved_model = self._suite.model or _DEFAULT_MODEL

        agent: Agent[None, str] = Agent(
            model=resolved_model,
            system_prompt=payload,
            result_type=str,
        )

        results: list[tuple[TestCaseDefinition, str]] = []
        for test_case in self._suite.test_cases:
            run_result = await agent.run(test_case.input)
            results.append((test_case, run_result.data))

        return results

    async def evaluate(self, test_case: TestCaseDefinition, llm_output: str) -> EvalResult:
        """Evaluate a single LLM output against a test case's signals."""
        return await evaluate_output(
            test_case=test_case,
            llm_output=llm_output,
            model=self._suite.model,
        )

    def accept(self, current_best: EvalResult, candidate: EvalResult) -> bool:
        """Decide whether to accept a candidate result as the new best.

        Accepts if:
        1. The candidate's scalar_score is strictly greater than the current best's, AND
        2. No signal marked critical=True regresses from True to False.
        """
        if candidate.scalar_score <= current_best.scalar_score:
            return False

        # Check for critical signal regression
        for signal_name, candidate_signal in candidate.signals.items():
            if not candidate_signal.critical:
                continue
            best_signal = current_best.signals.get(signal_name)
            if best_signal is not None and best_signal.value is True and candidate_signal.value is False:
                logger.info(
                    "Rejecting candidate: critical signal '%s' regressed from True to False",
                    signal_name,
                )
                return False

        return True
