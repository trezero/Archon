"""Test include_content query param on GET /api/extensions."""
import asyncio
from unittest.mock import MagicMock, patch

import pytest


def test_list_extensions_calls_list_extensions_without_param():
    """Without include_content, list_extensions() is called (not list_extensions_full)."""
    with patch("src.server.api_routes.extensions_api.ExtensionService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_extensions.return_value = [{"id": "s1", "name": "test"}]

        from src.server.api_routes.extensions_api import list_extensions

        result = asyncio.run(list_extensions(include_content=False))

        instance.list_extensions.assert_called_once()
        instance.list_extensions_full.assert_not_called()
        assert result["count"] == 1


def test_list_extensions_calls_list_extensions_full_with_param():
    """With include_content=True, list_extensions_full() is called."""
    with patch("src.server.api_routes.extensions_api.ExtensionService") as MockSvc:
        instance = MockSvc.return_value
        instance.list_extensions_full.return_value = [{"id": "s1", "name": "test", "content": "---\n..."}]

        from src.server.api_routes.extensions_api import list_extensions

        result = asyncio.run(list_extensions(include_content=True))

        instance.list_extensions_full.assert_called_once()
        instance.list_extensions.assert_not_called()
        assert result["count"] == 1
