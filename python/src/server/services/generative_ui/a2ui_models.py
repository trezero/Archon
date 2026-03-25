"""Pydantic models for A2UI component specs.

Python representation of the A2UI JSON protocol. These validate
responses from the Second Brain service — not a duplication of logic.
"""

from typing import Any

from pydantic import BaseModel, Field


class A2UIComponent(BaseModel):
    type: str = Field(description="Component type, e.g. 'a2ui.StatCard'")
    id: str = Field(description="Unique component ID")
    props: dict[str, Any] = Field(default_factory=dict)
    children: list["A2UIComponent"] | None = None
    layout: dict[str, Any] | None = None
    zone: str | None = None
    styling: dict[str, Any] | None = None


class A2UIGenerationRequest(BaseModel):
    content: str
    context: str | None = None
    content_type: str | None = None


class A2UIGenerationResponse(BaseModel):
    components: list[A2UIComponent]
    analysis: dict[str, Any] | None = None
