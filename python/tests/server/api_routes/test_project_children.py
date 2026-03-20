"""Tests for sub-project navigation backend features."""
import pytest
from unittest.mock import MagicMock, patch


class TestParentProjectClearing:
    """Test that PUT /api/projects/{id} can clear parent_project_id."""

    @pytest.mark.asyncio
    async def test_explicit_null_clears_parent(self):
        """Sending parent_project_id=null should clear the field."""
        from src.server.api_routes.projects_api import UpdateProjectRequest

        request = UpdateProjectRequest.model_validate({"parent_project_id": None})
        assert "parent_project_id" in request.model_fields_set

    def test_omitted_field_not_in_fields_set(self):
        """Omitting parent_project_id should NOT include it in model_fields_set."""
        from src.server.api_routes.projects_api import UpdateProjectRequest

        request = UpdateProjectRequest.model_validate({"title": "Updated"})
        assert "parent_project_id" not in request.model_fields_set

    def test_explicit_value_in_fields_set(self):
        """Sending a UUID for parent_project_id should include it in model_fields_set."""
        from src.server.api_routes.projects_api import UpdateProjectRequest

        request = UpdateProjectRequest.model_validate(
            {"parent_project_id": "550e8400-e29b-41d4-a716-446655440000"}
        )
        assert "parent_project_id" in request.model_fields_set
        assert request.parent_project_id == "550e8400-e29b-41d4-a716-446655440000"


class TestGetProjectChildren:
    """Test GET /api/projects/{id}/children endpoint."""

    def test_get_children_returns_list(self):
        """Service method should return child projects for a parent."""
        from src.server.services.projects.project_service import ProjectService

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.data = [
            {
                "id": "child-1",
                "title": "Child Project",
                "description": "A child",
                "tags": ["tag1"],
                "parent_project_id": "parent-1",
            }
        ]

        mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value = (
            mock_response
        )

        service = ProjectService(mock_client)
        success, result = service.get_project_children("parent-1")

        assert success is True
        assert len(result["children"]) == 1
        assert result["children"][0]["id"] == "child-1"

    def test_get_children_empty(self):
        """No children returns empty list."""
        from src.server.services.projects.project_service import ProjectService

        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_response.data = []
        mock_client.table.return_value.select.return_value.eq.return_value.execute.return_value = (
            mock_response
        )

        service = ProjectService(mock_client)
        success, result = service.get_project_children("parent-with-no-children")

        assert success is True
        assert result["children"] == []
