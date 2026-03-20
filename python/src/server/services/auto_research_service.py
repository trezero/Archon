"""AutoResearchService — core orchestration for iterative prompt optimization."""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

from ..models.auto_research import (
    AutoResearchIteration,
    AutoResearchJob,
    AutoResearchJobWithIterations,
    EvalResult,
    EvalSignalResult,
)
from ..utils.progress.progress_tracker import ProgressTracker
from .auto_research.eval_suite_loader import EvalSuiteLoader
from .auto_research.prompt_target import PromptTarget
from .client_manager import get_supabase_client

logger = logging.getLogger(__name__)

JOBS_TABLE = "auto_research_jobs"
ITERATIONS_TABLE = "auto_research_iterations"


def _aggregate_eval_results(results: list[EvalResult]) -> EvalResult:
    """Aggregate multiple per-test-case EvalResults into a single EvalResult.

    - scalar_score: average of all test case scalar_scores
    - signals: merged by name; if the same signal appears in multiple test cases,
      average the boolean values (True=1, False=0) and keep the critical flag
    - pass_status: aggregate scalar_score >= 0.5
    """
    if not results:
        return EvalResult(signals={}, scalar_score=0.0, pass_status=False)

    # Average scalar score
    scalar_score = sum(r.scalar_score for r in results) / len(results)

    # Merge signals across test cases
    signal_accum: dict[str, dict] = {}
    for result in results:
        for name, signal in result.signals.items():
            if name not in signal_accum:
                signal_accum[name] = {
                    "values": [],
                    "weight": signal.weight,
                    "critical": signal.critical,
                    "reasoning": signal.reasoning,
                }
            signal_accum[name]["values"].append(1.0 if signal.value else 0.0)
            # Keep critical=True if any occurrence is critical
            if signal.critical:
                signal_accum[name]["critical"] = True

    merged_signals: dict[str, EvalSignalResult] = {}
    for name, acc in signal_accum.items():
        avg_value = sum(acc["values"]) / len(acc["values"])
        merged_signals[name] = EvalSignalResult(
            value=avg_value >= 0.5,
            weight=acc["weight"],
            critical=acc["critical"],
            reasoning=acc["reasoning"],
        )

    return EvalResult(
        signals=merged_signals,
        scalar_score=scalar_score,
        pass_status=scalar_score >= 0.5,
    )


class AutoResearchService:
    """Orchestrates iterative prompt optimization using eval suites."""

    def __init__(self, supabase_client=None) -> None:
        self.supabase = supabase_client or get_supabase_client()
        self.loader = EvalSuiteLoader()

    async def start_optimization(
        self, eval_suite_id: str, max_iterations: int, model: str | None = None
    ) -> tuple[str, str]:
        """Start an optimization job for the given eval suite.

        Args:
            eval_suite_id: The ID of the eval suite to optimize.
            max_iterations: Maximum number of mutation iterations to run.
            model: Optional model override for the eval suite.

        Returns:
            Tuple of (job_id, progress_id) — both are the same string.

        Raises:
            ValueError: If an optimization job is already running.
        """
        # Check for already-running jobs
        running = (
            self.supabase.table(JOBS_TABLE)
            .select("id")
            .eq("status", "running")
            .execute()
        )
        if running.data:
            raise ValueError("An optimization job is already running")

        # Load the eval suite
        suite = self.loader.load_suite(eval_suite_id)

        # Apply model override if provided
        if model is not None:
            suite = suite.model_copy(update={"model": model})

        # Read baseline prompt
        target = PromptTarget(suite)
        baseline_payload = target.payload

        # Create job in DB
        job_id = str(uuid.uuid4())
        now = datetime.now(UTC).isoformat()
        self.supabase.table(JOBS_TABLE).insert({
            "id": job_id,
            "eval_suite_id": eval_suite_id,
            "status": "running",
            "target_file": suite.target_file,
            "baseline_payload": baseline_payload,
            "max_iterations": max_iterations,
            "completed_iterations": 0,
            "model": suite.model,
            "created_at": now,
        }).execute()

        # Create progress tracker (progress_id == job_id)
        progress = ProgressTracker(progress_id=job_id, operation_type="auto_research")
        await progress.start()

        # Spawn background task
        asyncio.create_task(self._run_loop(job_id, target, max_iterations, suite.model, progress))

        return (job_id, job_id)

    async def _run_loop(
        self,
        job_id: str,
        target: PromptTarget,
        max_iterations: int,
        model: str | None,
        progress: ProgressTracker,
    ) -> None:
        """Core optimization loop. Runs as a background task."""
        try:
            # --- Baseline evaluation (iteration 0) ---
            baseline_outputs = await target.execute(target.payload)
            baseline_evals: list[EvalResult] = []
            for test_case, output in baseline_outputs:
                eval_result = await target.evaluate(test_case, output)
                baseline_evals.append(eval_result)

            baseline_aggregate = _aggregate_eval_results(baseline_evals)
            baseline_signals = {name: sig.value for name, sig in baseline_aggregate.signals.items()}

            # Save baseline iteration
            self.supabase.table(ITERATIONS_TABLE).insert({
                "id": str(uuid.uuid4()),
                "job_id": job_id,
                "iteration_number": 0,
                "payload": target.payload,
                "scalar_score": baseline_aggregate.scalar_score,
                "signals": baseline_signals,
                "is_frontier": True,
            }).execute()

            # Update job with baseline score
            self.supabase.table(JOBS_TABLE).update({
                "baseline_score": baseline_aggregate.scalar_score,
            }).eq("id", job_id).execute()

            current_best_payload = target.payload
            current_best_eval = baseline_aggregate
            history: list[dict] = []

            # --- Mutation iterations ---
            for i in range(1, max_iterations + 1):
                # Check if job was cancelled
                job_check = (
                    self.supabase.table(JOBS_TABLE)
                    .select("status")
                    .eq("id", job_id)
                    .single()
                    .execute()
                )
                if job_check.data.get("status") == "cancelled":
                    logger.info("Job %s was cancelled, stopping optimization loop", job_id)
                    await progress.update(status="cancelled", progress=100, log="Job cancelled by user")
                    return

                await progress.update(
                    status="optimizing",
                    progress=int(i / max_iterations * 100),
                    log=f"Iteration {i}/{max_iterations}",
                )

                # Mutate
                mutated_payload = await target.mutate(current_best_payload, history)

                # Execute
                outputs = await target.execute(mutated_payload)

                # Evaluate each test case
                evals: list[EvalResult] = []
                for test_case, output in outputs:
                    eval_result = await target.evaluate(test_case, output)
                    evals.append(eval_result)

                # Aggregate
                candidate_eval = _aggregate_eval_results(evals)
                candidate_signals = {name: sig.value for name, sig in candidate_eval.signals.items()}

                # Accept or reject
                accepted = target.accept(current_best_eval, candidate_eval)

                # Save iteration
                self.supabase.table(ITERATIONS_TABLE).insert({
                    "id": str(uuid.uuid4()),
                    "job_id": job_id,
                    "iteration_number": i,
                    "payload": mutated_payload,
                    "scalar_score": candidate_eval.scalar_score,
                    "signals": candidate_signals,
                    "is_frontier": accepted,
                }).execute()

                if accepted:
                    current_best_payload = mutated_payload
                    current_best_eval = candidate_eval
                    self.supabase.table(JOBS_TABLE).update({
                        "best_payload": mutated_payload,
                        "best_score": candidate_eval.scalar_score,
                    }).eq("id", job_id).execute()

                # Append to history
                history.append({
                    "iteration": i,
                    "score": candidate_eval.scalar_score,
                    "signals": candidate_signals,
                })

                # Update completed iterations
                self.supabase.table(JOBS_TABLE).update({
                    "completed_iterations": i,
                }).eq("id", job_id).execute()

            # --- Completion ---
            self.supabase.table(JOBS_TABLE).update({
                "status": "completed",
                "completed_at": datetime.now(UTC).isoformat(),
            }).eq("id", job_id).execute()

            await progress.complete()

        except Exception as e:
            logger.exception("Auto research job %s failed", job_id)
            self.supabase.table(JOBS_TABLE).update({
                "status": "failed",
                "error_message": str(e),
            }).eq("id", job_id).execute()
            await progress.error(str(e))

    async def get_job(self, job_id: str) -> AutoResearchJobWithIterations:
        """Get a job with its full iteration history."""
        job_result = (
            self.supabase.table(JOBS_TABLE)
            .select("*")
            .eq("id", job_id)
            .single()
            .execute()
        )
        iterations_result = (
            self.supabase.table(ITERATIONS_TABLE)
            .select("*")
            .eq("job_id", job_id)
            .order("iteration_number")
            .execute()
        )

        iterations = [AutoResearchIteration(**row) for row in iterations_result.data]
        return AutoResearchJobWithIterations(**job_result.data, iterations=iterations)

    async def list_jobs(self) -> list[AutoResearchJob]:
        """List all jobs ordered by creation date (newest first)."""
        result = (
            self.supabase.table(JOBS_TABLE)
            .select("*")
            .order("created_at", desc=True)
            .execute()
        )
        return [AutoResearchJob(**row) for row in result.data]

    async def apply_result(self, job_id: str) -> str:
        """Write the best payload from a completed job back to the target file.

        Args:
            job_id: The job ID whose best payload should be applied.

        Returns:
            The file path that was written to.

        Raises:
            ValueError: If the job is not completed or has no best_payload.
        """
        job_result = (
            self.supabase.table(JOBS_TABLE)
            .select("*")
            .eq("id", job_id)
            .single()
            .execute()
        )
        job = AutoResearchJob(**job_result.data)

        if job.status != "completed":
            raise ValueError(f"Job {job_id} is not completed (status: {job.status})")
        if not job.best_payload:
            raise ValueError(f"Job {job_id} has no best_payload to apply")

        target_path = Path(job.target_file)
        target_path.write_text(job.best_payload, encoding="utf-8")

        return job.target_file

    async def cancel_job(self, job_id: str) -> None:
        """Mark a job as cancelled in the database."""
        self.supabase.table(JOBS_TABLE).update({
            "status": "cancelled",
        }).eq("id", job_id).execute()

    @classmethod
    def recover_stale_jobs(cls, supabase_client) -> None:
        """Recover jobs left in 'running' state after a server restart.

        Marks all running jobs as failed with a descriptive error message.
        """
        result = (
            supabase_client.table(JOBS_TABLE)
            .select("id")
            .eq("status", "running")
            .execute()
        )
        for row in result.data:
            supabase_client.table(JOBS_TABLE).update({
                "status": "failed",
                "error_message": "Server restarted during optimization",
            }).eq("id", row["id"]).execute()
