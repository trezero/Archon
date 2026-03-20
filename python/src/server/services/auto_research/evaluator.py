"""Evaluation agent — scores an LLM output against a test case's signals."""

from pydantic import BaseModel
from pydantic_ai import Agent

from ...models.auto_research import EvalResult, EvalSignalResult, TestCaseDefinition

_DEFAULT_MODEL = "openai:gpt-4o-mini"

_SYSTEM_PROMPT = """\
You are a strict, objective evaluation judge. Your task is to assess an LLM output against a set
of named evaluation signals.

For each signal you will be given:
- A signal name (identifier)
- A description of what the signal checks for

You must evaluate whether the provided LLM output satisfies each signal and return a structured
response containing:
- value: true if the signal is satisfied, false otherwise
- reasoning: a brief explanation of your judgment (1-2 sentences)

Be strict and objective. Do not give partial credit — each signal is either satisfied (true)
or not satisfied (false). Evaluate only based on the actual output content.
"""


class SignalEvaluation(BaseModel):
    """Evaluation result for a single signal."""

    value: bool
    reasoning: str


class EvaluationOutput(BaseModel):
    """Structured output from the evaluation agent."""

    signals: dict[str, SignalEvaluation]


async def evaluate_output(
    test_case: TestCaseDefinition,
    llm_output: str,
    model: str | None = None,
) -> EvalResult:
    """Evaluate an LLM output against a test case's signals.

    Args:
        test_case: The test case definition including signal criteria and weights.
        llm_output: The raw output from the LLM to evaluate.
        model: PydanticAI model string (e.g. "openai:gpt-4o-mini"). Defaults to gpt-4o-mini.

    Returns:
        EvalResult with per-signal results, aggregate scalar score, and pass status.
    """
    resolved_model = model or _DEFAULT_MODEL

    agent: Agent[None, EvaluationOutput] = Agent(
        model=resolved_model,
        system_prompt=_SYSTEM_PROMPT,
        result_type=EvaluationOutput,
    )

    signal_descriptions = "\n".join(
        f"  - {name}: {signal.description}"
        for name, signal in test_case.signals.items()
    )

    user_message = f"""\
Evaluate the following LLM output against these signals:

Signals to evaluate:
{signal_descriptions}

LLM output to evaluate:
{llm_output}

Return your evaluation for every signal listed above."""

    result = await agent.run(user_message)
    agent_output: EvaluationOutput = result.data

    return _build_eval_result(test_case, agent_output)


def _build_eval_result(test_case: TestCaseDefinition, agent_output: EvaluationOutput) -> EvalResult:
    """Convert agent output into an EvalResult, merging signal weights from the test case definition.

    Signals missing from the agent output are treated as False (not satisfied).
    """
    signal_results: dict[str, EvalSignalResult] = {}

    for signal_name, signal_def in test_case.signals.items():
        agent_eval = agent_output.signals.get(signal_name)

        if agent_eval is not None:
            value = agent_eval.value
            reasoning = agent_eval.reasoning
        else:
            # Signal was omitted by the LLM — treat as not satisfied
            value = False
            reasoning = "Signal not evaluated by the judge."

        signal_results[signal_name] = EvalSignalResult(
            value=value,
            weight=signal_def.weight,
            critical=signal_def.critical,
            reasoning=reasoning,
        )

    scalar_score = _calculate_scalar_score(signal_results)
    pass_status = scalar_score >= 0.5

    return EvalResult(
        signals=signal_results,
        scalar_score=scalar_score,
        pass_status=pass_status,
    )


def _calculate_scalar_score(signals: dict[str, EvalSignalResult]) -> float:
    """Calculate weighted scalar score from signal results.

    Score = sum(signal_value * signal_weight) / sum(signal_weights)
    where signal_value is 1.0 if True, 0.0 if False.

    Returns 0.0 if there are no signals.
    """
    if not signals:
        return 0.0

    total_weight = sum(s.weight for s in signals.values())
    if total_weight == 0.0:
        return 0.0

    weighted_sum = sum((1.0 if s.value else 0.0) * s.weight for s in signals.values())
    return weighted_sum / total_weight
