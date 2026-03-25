"""HTTP client for the Second Brain's A2UI generation endpoint."""

import os
from typing import Any

import httpx

from ...config.logfire_config import get_logger
from .a2ui_models import A2UIGenerationRequest, A2UIGenerationResponse

logger = get_logger(__name__)

A2UI_SERVICE_URL = os.getenv("A2UI_SERVICE_URL", "http://trinity-a2ui:8054")
A2UI_TIMEOUT = float(os.getenv("A2UI_GENERATION_TIMEOUT", "10"))


class A2UIClient:
    """HTTP client to the Second Brain A2UI generation service."""

    def __init__(self, base_url: str | None = None, timeout: float | None = None):
        self.base_url = (base_url or A2UI_SERVICE_URL).rstrip("/")
        self.timeout = timeout or A2UI_TIMEOUT

    async def generate(self, request: A2UIGenerationRequest) -> A2UIGenerationResponse | None:
        """Call the A2UI generation endpoint. Returns None on any failure."""
        url = f"{self.base_url}/api/a2ui/generate"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, json=request.model_dump())
            if response.status_code != 200:
                logger.warning(f"A2UI service returned {response.status_code}")
                return None
            return A2UIGenerationResponse.model_validate(response.json())
        except httpx.ConnectError:
            logger.info("A2UI service not available (connection refused)")
            return None
        except httpx.TimeoutException:
            logger.warning("A2UI service timed out")
            return None
        except Exception as e:
            logger.warning(f"A2UI generation failed: {e}")
            return None

    async def is_available(self) -> bool:
        """Check if the A2UI service is reachable."""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                response = await client.get(f"{self.base_url}/health")
            return response.status_code == 200
        except Exception:
            return False
