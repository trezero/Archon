"""Tests for A2UIService."""

from unittest.mock import AsyncMock, patch

import pytest

from src.server.services.generative_ui.a2ui_models import A2UIComponent, A2UIGenerationResponse
from src.server.services.generative_ui.a2ui_service import A2UIService


@pytest.fixture
def service():
    client = AsyncMock()
    return A2UIService(client=client)


class TestGenerateApprovalComponents:
    @pytest.mark.asyncio
    async def test_standard_type_uses_template(self, service):
        """Standard approval types should return deterministic templates, not call LLM."""
        with patch(
            "src.server.services.workflow.approval_templates.build_approval_payload"
        ) as mock_build:
            mock_build.return_value = [{"type": "a2ui.StatCard", "id": "s1", "props": {}}]
            result = await service.generate_approval_components("some output", "plan_review")
            assert result is not None
            assert result[0]["type"] == "a2ui.StatCard"
            # LLM client should NOT have been called
            service._client.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_custom_type_calls_llm(self, service):
        """Custom approval type should fall through to A2UI service."""
        with patch(
            "src.server.services.workflow.approval_templates.build_approval_payload"
        ) as mock_build:
            mock_build.return_value = None  # Not a standard type
            service._available = True
            service._client.generate.return_value = A2UIGenerationResponse(
                components=[A2UIComponent(type="a2ui.ExecutiveSummary", id="e1", props={"title": "Custom"})]
            )
            result = await service.generate_approval_components("output", "custom")
            assert result is not None
            assert result[0]["type"] == "a2ui.ExecutiveSummary"

    @pytest.mark.asyncio
    async def test_custom_type_returns_none_when_unavailable(self, service):
        """When A2UI service is down, custom type returns None (graceful degradation)."""
        with patch(
            "src.server.services.workflow.approval_templates.build_approval_payload"
        ) as mock_build:
            mock_build.return_value = None
            service._available = False
            result = await service.generate_approval_components("output", "custom")
            assert result is None
