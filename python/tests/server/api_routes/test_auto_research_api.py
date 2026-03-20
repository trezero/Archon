"""Unit tests for auto-research API endpoints."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_job(job_id: str = "job-1", status: str = "completed") -> MagicMock:
    job = MagicMock()
    job.model_dump.return_value = {"id": job_id, "status": status}
    return job


def _make_job_with_iterations(job_id: str = "job-1") -> MagicMock:
    job = MagicMock()
    job.model_dump.return_value = {"id": job_id, "status": "completed", "iterations": []}
    return job


def _make_suite_summary(suite_id: str = "suite-1") -> MagicMock:
    summary = MagicMock()
    summary.model_dump.return_value = {"id": suite_id, "name": "Test Suite"}
    return summary


# ── GET /api/auto-research/suites ─────────────────────────────────────────────


def test_list_suites_returns_suites():
    """GET /suites returns list of available eval suites."""
    with patch("src.server.api_routes.auto_research_api.EvalSuiteLoader") as MockLoader:
        instance = MockLoader.return_value
        instance.list_suites.return_value = [_make_suite_summary("suite-1")]

        from src.server.api_routes.auto_research_api import list_suites

        result = asyncio.run(list_suites())

        assert result["success"] is True
        assert len(result["suites"]) == 1
        assert result["suites"][0]["id"] == "suite-1"


def test_list_suites_empty():
    """GET /suites returns empty list when no suites exist."""
    with patch("src.server.api_routes.auto_research_api.EvalSuiteLoader") as MockLoader:
        instance = MockLoader.return_value
        instance.list_suites.return_value = []

        from src.server.api_routes.auto_research_api import list_suites

        result = asyncio.run(list_suites())

        assert result["success"] is True
        assert result["suites"] == []


# ── POST /api/auto-research/start ─────────────────────────────────────────────


def test_start_optimization_success():
    """POST /start returns job_id and progress_id on success."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.start_optimization = AsyncMock(return_value=("job-abc", "job-abc"))

        from src.server.api_routes.auto_research_api import (
            StartOptimizationRequest,
            start_optimization,
        )

        req = StartOptimizationRequest(eval_suite_id="suite-1", max_iterations=5)
        result = asyncio.run(start_optimization(req))

        assert result["success"] is True
        assert result["job_id"] == "job-abc"
        assert result["progress_id"] == "job-abc"
        instance.start_optimization.assert_called_once_with(
            eval_suite_id="suite-1", max_iterations=5, model=None
        )


def test_start_optimization_409_when_job_already_running():
    """POST /start returns 409 when a job is already running."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.start_optimization = AsyncMock(
            side_effect=ValueError("An optimization job is already running")
        )

        from src.server.api_routes.auto_research_api import (
            StartOptimizationRequest,
            start_optimization,
        )

        req = StartOptimizationRequest(eval_suite_id="suite-1", max_iterations=3)

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(start_optimization(req))

        assert exc_info.value.status_code == 409
        assert "already running" in exc_info.value.detail


def test_start_optimization_with_model_override():
    """POST /start passes optional model override to service."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.start_optimization = AsyncMock(return_value=("job-xyz", "job-xyz"))

        from src.server.api_routes.auto_research_api import (
            StartOptimizationRequest,
            start_optimization,
        )

        req = StartOptimizationRequest(eval_suite_id="suite-2", max_iterations=10, model="claude-3-5-sonnet")
        asyncio.run(start_optimization(req))

        instance.start_optimization.assert_called_once_with(
            eval_suite_id="suite-2", max_iterations=10, model="claude-3-5-sonnet"
        )


# ── GET /api/auto-research/jobs ───────────────────────────────────────────────


def test_list_jobs_returns_jobs():
    """GET /jobs returns list of all jobs."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_jobs = AsyncMock(return_value=[_make_job("job-1"), _make_job("job-2")])

        from src.server.api_routes.auto_research_api import list_jobs

        result = asyncio.run(list_jobs())

        assert result["success"] is True
        assert len(result["jobs"]) == 2


def test_list_jobs_empty():
    """GET /jobs returns empty list when no jobs exist."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_jobs = AsyncMock(return_value=[])

        from src.server.api_routes.auto_research_api import list_jobs

        result = asyncio.run(list_jobs())

        assert result["success"] is True
        assert result["jobs"] == []


# ── GET /api/auto-research/jobs/{job_id} ──────────────────────────────────────


def test_get_job_success():
    """GET /jobs/{job_id} returns job detail with iterations."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.get_job = AsyncMock(return_value=_make_job_with_iterations("job-1"))

        from src.server.api_routes.auto_research_api import get_job

        result = asyncio.run(get_job("job-1"))

        assert result["success"] is True
        assert result["job"]["id"] == "job-1"
        instance.get_job.assert_called_once_with("job-1")


def test_get_job_404_when_not_found():
    """GET /jobs/{job_id} returns 404 for missing job."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.get_job = AsyncMock(side_effect=Exception("No rows returned"))

        from src.server.api_routes.auto_research_api import get_job

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(get_job("nonexistent-job"))

        assert exc_info.value.status_code == 404


# ── POST /api/auto-research/jobs/{job_id}/apply ───────────────────────────────


def test_apply_job_result_success():
    """POST /jobs/{job_id}/apply writes best payload and returns file path."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.apply_result = AsyncMock(return_value="/path/to/target.md")

        from src.server.api_routes.auto_research_api import apply_job_result

        result = asyncio.run(apply_job_result("job-1"))

        assert result["success"] is True
        assert result["file_path"] == "/path/to/target.md"
        instance.apply_result.assert_called_once_with("job-1")


def test_apply_job_result_400_when_not_completed():
    """POST /jobs/{job_id}/apply returns 400 when job is not completed."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.apply_result = AsyncMock(
            side_effect=ValueError("Job job-1 is not completed (status: running)")
        )

        from src.server.api_routes.auto_research_api import apply_job_result

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(apply_job_result("job-1"))

        assert exc_info.value.status_code == 400
        assert "not completed" in exc_info.value.detail


def test_apply_job_result_400_when_no_best_payload():
    """POST /jobs/{job_id}/apply returns 400 when job has no best_payload."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.apply_result = AsyncMock(
            side_effect=ValueError("Job job-1 has no best_payload to apply")
        )

        from src.server.api_routes.auto_research_api import apply_job_result

        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(apply_job_result("job-1"))

        assert exc_info.value.status_code == 400


# ── POST /api/auto-research/jobs/{job_id}/cancel ─────────────────────────────


def test_cancel_job_success():
    """POST /jobs/{job_id}/cancel marks job as cancelled."""
    with patch("src.server.api_routes.auto_research_api.AutoResearchService") as MockSvc:
        instance = MockSvc.return_value
        instance.cancel_job = AsyncMock(return_value=None)

        from src.server.api_routes.auto_research_api import cancel_job

        result = asyncio.run(cancel_job("job-1"))

        assert result["success"] is True
        instance.cancel_job.assert_called_once_with("job-1")


# ── Router registration ───────────────────────────────────────────────────────


def test_router_is_registered_in_main():
    """Verify the auto_research_router is registered with the FastAPI app."""
    # Import the app and check its routes include /api/auto-research paths
    with patch("src.server.main.initialize_credentials", new_callable=AsyncMock), \
         patch("src.server.main.setup_logfire"), \
         patch("src.server.main.initialize_crawler", new_callable=AsyncMock):
        from src.server.main import app

        routes = [route.path for route in app.routes]
        auto_research_routes = [r for r in routes if "auto-research" in r]
        assert len(auto_research_routes) > 0, "No auto-research routes found in app"
