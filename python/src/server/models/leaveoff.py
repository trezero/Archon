"""Pydantic models for LeaveOff Point API."""

from pydantic import BaseModel


class UpsertLeaveOffRequest(BaseModel):
    content: str
    next_steps: list[str]
    component: str | None = None
    references: list[str] | None = None
    machine_id: str | None = None
    last_session_id: str | None = None
    metadata: dict | None = None
    project_path: str | None = None
