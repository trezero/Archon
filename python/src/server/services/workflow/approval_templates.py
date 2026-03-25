"""Deterministic approval templates for standard HITL approval types.

Stub — returns None for all types until real templates are implemented.
"""

from typing import Any


def build_approval_payload(approval_type: str, node_output: str) -> list[dict[str, Any]] | None:
    """Build A2UI components for a standard approval type.

    Returns None if the approval_type is not a recognized standard type,
    signalling the caller to fall back to LLM-based generation.
    """
    return None
