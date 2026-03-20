"""Prompt mutation agent — rewrites a prompt payload to improve evaluation performance."""


from pydantic_ai import Agent

_DEFAULT_MODEL = "openai:gpt-4o-mini"

_SYSTEM_PROMPT = """\
You are a prompt optimization specialist. Your task is to rewrite a given prompt to improve its
performance on an evaluation suite.

You will receive:
- The current prompt text
- A history of previous iteration results showing what has worked and what has not
- Mutation guidance specifying how to approach the rewrite

Your job is to produce a single rewritten prompt that:
1. Addresses the signals that failed in previous iterations
2. Preserves or improves signals that are already passing
3. Follows the mutation guidance closely
4. Returns only the complete rewritten prompt text — no explanations, no preamble, no markdown fencing
"""


async def mutate_prompt(
    current_payload: str,
    history: list[dict],
    guidance: str,
    model: str | None = None,
) -> str:
    """Rewrite a prompt payload to improve evaluation performance.

    Args:
        current_payload: The current prompt text to mutate.
        history: Previous iteration results showing scores and signal outcomes.
            Each entry has keys: iteration, score, signals (dict of signal_name -> bool).
        guidance: Specific instructions for how to mutate the prompt.
        model: PydanticAI model string (e.g. "openai:gpt-4o-mini"). Defaults to gpt-4o-mini.

    Returns:
        The complete rewritten prompt text.
    """
    resolved_model = model or _DEFAULT_MODEL

    agent: Agent[None, str] = Agent(
        model=resolved_model,
        system_prompt=_SYSTEM_PROMPT,
        result_type=str,
    )

    history_summary = _summarize_history(history)

    user_message = f"""\
Current prompt:
{current_payload}

Iteration history:
{history_summary}

Mutation guidance:
{guidance}

Rewrite the prompt now."""

    result = await agent.run(user_message)
    return result.data


def _summarize_history(history: list[dict]) -> str:
    """Format iteration history as a readable summary for the LLM."""
    if not history:
        return "No previous iterations — this is the first mutation attempt."

    lines: list[str] = []
    for entry in history:
        iteration = entry.get("iteration", "?")
        score = entry.get("score", 0.0)
        signals = entry.get("signals", {})

        passing = [name for name, val in signals.items() if val]
        failing = [name for name, val in signals.items() if not val]

        signal_summary = ""
        if passing:
            signal_summary += f" Passing: {', '.join(passing)}."
        if failing:
            signal_summary += f" Failing: {', '.join(failing)}."

        lines.append(f"  Iteration {iteration}: score={score:.2f}.{signal_summary}")

    return "\n".join(lines)
