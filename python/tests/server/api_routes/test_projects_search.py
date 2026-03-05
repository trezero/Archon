"""Tests for GET /api/projects?q= search parameter."""
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from src.server.main import app


@pytest.fixture
def test_client():
    return TestClient(app)


def test_list_projects_without_q_returns_all(test_client, mock_projects):
    with patch("src.server.api_routes.projects_api.ProjectService") as MockService, \
         patch("src.server.api_routes.projects_api.SourceLinkingService"):
        mock_svc = MockService.return_value
        mock_svc.list_projects.return_value = (True, {"projects": mock_projects})
        response = test_client.get("/api/projects?include_content=false")
        assert response.status_code == 200
        assert len(response.json()["projects"]) == 3


def test_list_projects_q_filters_by_title(test_client, mock_projects):
    with patch("src.server.api_routes.projects_api.ProjectService") as MockService, \
         patch("src.server.api_routes.projects_api.SourceLinkingService"):
        mock_svc = MockService.return_value
        mock_svc.list_projects.return_value = (True, {"projects": mock_projects})
        response = test_client.get("/api/projects?include_content=false&q=recipe")
        assert response.status_code == 200
        projects = response.json()["projects"]
        assert all("recipe" in p["title"].lower() for p in projects)


def test_list_projects_q_case_insensitive(test_client, mock_projects):
    with patch("src.server.api_routes.projects_api.ProjectService") as MockService, \
         patch("src.server.api_routes.projects_api.SourceLinkingService"):
        mock_svc = MockService.return_value
        mock_svc.list_projects.return_value = (True, {"projects": mock_projects})
        response = test_client.get("/api/projects?include_content=false&q=RECIPE")
        assert response.status_code == 200
        projects = response.json()["projects"]
        assert len(projects) > 0


@pytest.fixture
def mock_projects():
    return [
        {"id": "1", "title": "RecipeRaiders", "description": ""},
        {"id": "2", "title": "RecipeManager", "description": ""},
        {"id": "3", "title": "WeatherApp", "description": ""},
    ]
