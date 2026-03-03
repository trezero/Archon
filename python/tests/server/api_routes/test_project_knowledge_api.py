"""
Tests for the project knowledge-sources API endpoint.

Verifies that GET /api/projects/{project_id}/knowledge-sources is routed correctly
and returns the expected response shape.
"""

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


@pytest.fixture
def mock_summary_response():
    """Mock response from KnowledgeSummaryService.get_summaries."""
    return {
        "items": [
            {
                "id": "source-1",
                "title": "Test Source",
                "url": "https://example.com",
                "knowledge_type": "website",
                "document_count": 5,
                "code_example_count": 2,
            }
        ],
        "pagination": {
            "total": 1,
            "page": 1,
            "per_page": 20,
            "pages": 1,
        },
    }


def test_project_knowledge_sources_endpoint_exists(client, mock_summary_response):
    """Test that the endpoint is routed correctly (not 404)."""
    with patch(
        "src.server.api_routes.projects_api.KnowledgeSummaryService"
    ) as MockService:
        mock_instance = MockService.return_value
        mock_instance.get_summaries = AsyncMock(return_value=mock_summary_response)

        response = client.get("/api/projects/test-project-id/knowledge-sources")

        # The endpoint should exist (not 404). It may return 200 or 500 depending
        # on whether the mocked service is wired correctly, but never 404.
        assert response.status_code != 404, (
            f"Expected endpoint to exist (not 404), got {response.status_code}"
        )


def test_project_knowledge_sources_returns_correct_shape(client, mock_summary_response):
    """Test that the endpoint returns the correct response shape when the service succeeds."""
    with patch(
        "src.server.api_routes.projects_api.KnowledgeSummaryService"
    ) as MockService:
        mock_instance = MockService.return_value
        mock_instance.get_summaries = AsyncMock(return_value=mock_summary_response)

        response = client.get("/api/projects/test-project-id/knowledge-sources")

        assert response.status_code == 200
        data = response.json()
        assert "items" in data
        assert "pagination" in data
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == "source-1"
        assert data["pagination"]["total"] == 1


def test_project_knowledge_sources_passes_project_id(client, mock_summary_response):
    """Test that project_id is passed to the service correctly."""
    with patch(
        "src.server.api_routes.projects_api.KnowledgeSummaryService"
    ) as MockService:
        mock_instance = MockService.return_value
        mock_instance.get_summaries = AsyncMock(return_value=mock_summary_response)

        client.get("/api/projects/my-project-123/knowledge-sources")

        mock_instance.get_summaries.assert_called_once_with(
            page=1,
            per_page=20,
            knowledge_type=None,
            search=None,
            project_id="my-project-123",
        )


def test_project_knowledge_sources_with_query_params(client, mock_summary_response):
    """Test that query parameters are forwarded to the service."""
    with patch(
        "src.server.api_routes.projects_api.KnowledgeSummaryService"
    ) as MockService:
        mock_instance = MockService.return_value
        mock_instance.get_summaries = AsyncMock(return_value=mock_summary_response)

        client.get(
            "/api/projects/proj-1/knowledge-sources"
            "?page=2&per_page=10&knowledge_type=website&search=docs"
        )

        mock_instance.get_summaries.assert_called_once_with(
            page=2,
            per_page=10,
            knowledge_type="website",
            search="docs",
            project_id="proj-1",
        )


def test_project_knowledge_sources_clamps_pagination(client, mock_summary_response):
    """Test that page and per_page are clamped to valid ranges."""
    with patch(
        "src.server.api_routes.projects_api.KnowledgeSummaryService"
    ) as MockService:
        mock_instance = MockService.return_value
        mock_instance.get_summaries = AsyncMock(return_value=mock_summary_response)

        # page=0 should be clamped to 1, per_page=200 should be clamped to 100
        client.get("/api/projects/proj-1/knowledge-sources?page=0&per_page=200")

        mock_instance.get_summaries.assert_called_once_with(
            page=1,
            per_page=100,
            knowledge_type=None,
            search=None,
            project_id="proj-1",
        )


def test_knowledge_summary_endpoint_accepts_project_id(client, mock_summary_response):
    """Test that the existing /api/knowledge-items/summary endpoint accepts project_id."""
    with patch(
        "src.server.api_routes.knowledge_api.KnowledgeSummaryService"
    ) as MockService:
        mock_instance = MockService.return_value
        mock_instance.get_summaries = AsyncMock(return_value=mock_summary_response)

        response = client.get("/api/knowledge-items/summary?project_id=proj-abc")

        assert response.status_code == 200
        mock_instance.get_summaries.assert_called_once()
        call_kwargs = mock_instance.get_summaries.call_args[1]
        assert call_kwargs["project_id"] == "proj-abc"
