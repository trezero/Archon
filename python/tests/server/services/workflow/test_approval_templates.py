"""Tests for deterministic approval templates."""

import pytest

from src.server.services.workflow.approval_templates import build_approval_payload


PLAN_OUTPUT = """## Rate Limiting Implementation Plan

### Summary
Add token bucket rate limiting to all API endpoints.

### Steps
1. Add Redis dependency
2. Create rate limiter middleware
3. Configure per-endpoint limits

### Stats
- Files to modify: 5
- Estimated complexity: Medium
"""


class TestBuildApprovalPayload:
    def test_plan_review_returns_components(self):
        result = build_approval_payload("plan_review", PLAN_OUTPUT)
        assert result is not None
        types = [c["type"] for c in result]
        assert "a2ui.ExecutiveSummary" in types

    def test_pr_review_returns_components(self):
        pr_output = "## PR: Add auth\n\nFiles changed: 3\n+120 -45\n\n```python\ndef login():\n    pass\n```"
        result = build_approval_payload("pr_review", pr_output)
        assert result is not None
        types = [c["type"] for c in result]
        assert "a2ui.StatCard" in types

    def test_deploy_gate_returns_components(self):
        deploy_output = "## Deploy to Production\n\nEnvironment: prod\nBuild: passing\n\n- [ ] DB migrated\n- [x] Tests pass"
        result = build_approval_payload("deploy_gate", deploy_output)
        assert result is not None
        types = [c["type"] for c in result]
        assert "a2ui.StatCard" in types

    def test_custom_returns_none(self):
        result = build_approval_payload("custom", "anything")
        assert result is None

    def test_unknown_type_returns_none(self):
        result = build_approval_payload("unknown_type", "anything")
        assert result is None
