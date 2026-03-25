"""High-level A2UI service used by HITL, chat, and knowledge features.

Delegates to deterministic templates for standard types,
falls back to the Second Brain LLM service for custom types.
"""

from typing import Any

from ...config.logfire_config import get_logger
from .a2ui_client import A2UIClient
from .a2ui_models import A2UIComponent, A2UIGenerationRequest, A2UIGenerationResponse

logger = get_logger(__name__)


class A2UIService:
    def __init__(self, client: A2UIClient | None = None):
        self._client = client or A2UIClient()
        self._available: bool | None = None

    async def is_available(self) -> bool:
        if self._available is None:
            self._available = await self._client.is_available()
        return self._available

    async def generate_approval_components(
        self,
        node_output: str,
        approval_type: str,
    ) -> list[dict[str, Any]] | None:
        """Generate A2UI components for an approval payload.

        Standard types use deterministic templates (no LLM).
        Custom type calls the Second Brain service.
        """
        # Defer to approval_templates for standard types
        from ..workflow.approval_templates import build_approval_payload

        components = build_approval_payload(approval_type, node_output)
        if components is not None:
            return components

        # Custom type: call Second Brain
        if not await self.is_available():
            logger.info("A2UI service unavailable, returning raw output for custom approval")
            return None

        request = A2UIGenerationRequest(
            content=node_output,
            context="workflow_approval",
            content_type=approval_type,
        )
        response = await self._client.generate(request)
        if response is None:
            return None
        return [c.model_dump() for c in response.components]
