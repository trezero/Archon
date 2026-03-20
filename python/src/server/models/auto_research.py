"""Data models for the Auto Research feature — iterative prompt optimization via eval suites."""

from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel, Field


class SignalDefinition(BaseModel):
    """A single evaluation signal within a test case."""

    weight: float = 1.0
    critical: bool = False
    description: str


class TestCaseDefinition(BaseModel):
    """A single test case within an eval suite."""

    id: str
    name: str
    input: str
    signals: dict[str, SignalDefinition]


class EvalSuiteDefinition(BaseModel):
    """Complete definition of an evaluation suite loaded from a JSON file."""

    id: str
    name: str
    description: str = ""
    target_file: str
    model: str | None = None
    mutation_guidance: str
    test_cases: list[TestCaseDefinition]


class EvalSuiteSummary(BaseModel):
    """Lightweight summary of an eval suite for listing purposes."""

    id: str
    name: str
    description: str
    target_file: str
    test_case_count: int


class EvalSignalResult(BaseModel):
    """Result for a single signal evaluation."""

    value: bool
    weight: float
    critical: bool
    reasoning: str | None = None


class EvalResult(BaseModel):
    """Aggregated evaluation result across all signals for a single test case run."""

    signals: dict[str, EvalSignalResult]
    scalar_score: float
    pass_status: bool


class AutoResearchJob(BaseModel):
    """Auto research job record matching the database schema."""

    id: str
    eval_suite_id: str
    status: str
    target_file: str
    baseline_payload: str
    baseline_score: float | None = None
    best_payload: str | None = None
    best_score: float | None = None
    max_iterations: int
    completed_iterations: int
    model: str | None = None
    error_message: str | None = None
    created_at: str
    completed_at: str | None = None


class AutoResearchIteration(BaseModel):
    """Single iteration record within an auto research job."""

    id: str
    job_id: str
    iteration_number: int
    payload: str
    scalar_score: float
    signals: dict[str, Any]
    is_frontier: bool
    created_at: str


class AutoResearchJobWithIterations(AutoResearchJob):
    """Auto research job with its full iteration history."""

    iterations: list[AutoResearchIteration] = Field(default_factory=list)


@runtime_checkable
class AutoResearchTarget(Protocol):
    """Protocol that all auto research targets must implement.

    A target encapsulates the thing being optimized (e.g. a system prompt file),
    including how to mutate it, execute it against test cases, and evaluate outputs.
    """

    @property
    def id(self) -> str:
        """Unique identifier for this target (e.g. file path or slug)."""
        ...

    @property
    def payload(self) -> str:
        """Current payload content (e.g. the system prompt text)."""
        ...

    async def mutate(self, current_payload: str, history: list[dict]) -> str:
        """Generate a mutated candidate payload.

        Args:
            current_payload: The current best payload to mutate from.
            history: List of previous iteration results for context.

        Returns:
            The mutated payload string.
        """
        ...

    async def execute(self, payload: str) -> list[tuple[TestCaseDefinition, str]]:
        """Execute the payload against all test cases and return LLM outputs.

        Args:
            payload: The payload to evaluate (e.g. system prompt).

        Returns:
            List of (test_case, llm_output) pairs.
        """
        ...

    async def evaluate(self, test_case: TestCaseDefinition, llm_output: str) -> EvalResult:
        """Evaluate a single LLM output against a test case's signals.

        Args:
            test_case: The test case definition including signal criteria.
            llm_output: The raw output from the LLM for this test case.

        Returns:
            EvalResult with per-signal results and aggregate scalar score.
        """
        ...

    def accept(self, current_best: EvalResult, candidate: EvalResult) -> bool:
        """Decide whether to accept a candidate result as the new best.

        Args:
            current_best: The best eval result seen so far.
            candidate: The candidate result to compare against.

        Returns:
            True if the candidate should replace the current best.
        """
        ...
