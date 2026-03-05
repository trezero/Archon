"""Test include_content query param on GET /api/skills."""
import asyncio
from unittest.mock import MagicMock, patch

import pytest


def test_list_skills_calls_list_skills_without_param():
    """Without include_content, list_skills() is called (not list_skills_full)."""
    with patch("src.server.api_routes.skills_api.SkillService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_skills.return_value = [{"id": "s1", "name": "test"}]

        from src.server.api_routes.skills_api import list_skills

        result = asyncio.run(list_skills(include_content=False))

        instance.list_skills.assert_called_once()
        instance.list_skills_full.assert_not_called()
        assert result["count"] == 1


def test_list_skills_calls_list_skills_full_with_param():
    """With include_content=True, list_skills_full() is called."""
    with patch("src.server.api_routes.skills_api.SkillService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_skills_full.return_value = [{"id": "s1", "name": "test", "content": "---\n..."}]

        from src.server.api_routes.skills_api import list_skills

        result = asyncio.run(list_skills(include_content=True))

        instance.list_skills_full.assert_called_once()
        instance.list_skills.assert_not_called()
        assert result["count"] == 1
