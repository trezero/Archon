"""Deterministic A2UI templates for standard approval types.

Parses node_output markdown to extract structured data, then
populates A2UI component JSON. No LLM calls — pure string parsing.
"""

import re
import uuid
from typing import Any

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


def _make_id() -> str:
    return str(uuid.uuid4())[:8]


def _extract_heading(text: str) -> str:
    """Extract first markdown heading or first line."""
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("#"):
            return re.sub(r"^#+\s*", "", line)
    return text.split("\n")[0][:100] if text else "Approval Required"


def _extract_summary(text: str) -> str:
    """Extract text between first heading and next heading or code block."""
    lines = text.split("\n")
    summary_lines = []
    past_heading = False
    for line in lines:
        if line.strip().startswith("#"):
            if past_heading:
                break
            past_heading = True
            continue
        if past_heading and line.strip().startswith("```"):
            break
        if past_heading and line.strip():
            summary_lines.append(line.strip())
    return " ".join(summary_lines[:5]) or text[:200]


def _extract_steps(text: str) -> list[dict[str, Any]]:
    """Extract numbered list items as steps."""
    steps = []
    for match in re.finditer(r"^\s*(\d+)\.\s+(.+)$", text, re.MULTILINE):
        steps.append({"step": int(match.group(1)), "title": match.group(2).strip()})
    return steps


def _extract_stats(text: str) -> dict[str, str]:
    """Extract key: value pairs from text."""
    stats = {}
    for match in re.finditer(r"^[-*]\s*(.+?):\s*(.+)$", text, re.MULTILINE):
        stats[match.group(1).strip()] = match.group(2).strip()
    # Also check for "Files changed: N" style
    for match in re.finditer(r"(\w[\w\s]+?):\s*(\d+\S*)", text):
        key = match.group(1).strip()
        if key not in stats:
            stats[key] = match.group(2).strip()
    return stats


def _extract_code_blocks(text: str) -> list[dict[str, str]]:
    """Extract fenced code blocks."""
    blocks = []
    for match in re.finditer(r"```(\w*)\n(.*?)```", text, re.DOTALL):
        blocks.append({"language": match.group(1) or "text", "code": match.group(2).strip()})
    return blocks


def _extract_checklist(text: str) -> list[dict[str, Any]]:
    """Extract markdown checklist items."""
    items = []
    for match in re.finditer(r"^\s*-\s*\[([ xX])\]\s*(.+)$", text, re.MULTILINE):
        items.append({"label": match.group(2).strip(), "checked": match.group(1).lower() == "x"})
    return items


def _build_plan_review(node_output: str) -> list[dict[str, Any]]:
    """Build A2UI components for plan_review approval type."""
    components: list[dict[str, Any]] = []
    title = _extract_heading(node_output)
    summary = _extract_summary(node_output)
    steps = _extract_steps(node_output)
    stats = _extract_stats(node_output)
    code_blocks = _extract_code_blocks(node_output)

    components.append({
        "type": "a2ui.ExecutiveSummary",
        "id": _make_id(),
        "props": {"title": title, "summary": summary, "highlights": list(stats.values())[:3]},
        "zone": "hero",
    })
    for step in steps[:10]:
        components.append({
            "type": "a2ui.StepCard",
            "id": _make_id(),
            "props": {"step": step["step"], "title": step["title"]},
            "zone": "content",
        })
    if stats:
        components.append({
            "type": "a2ui.StatCard",
            "id": _make_id(),
            "props": {"stats": [{"label": k, "value": v} for k, v in list(stats.items())[:4]]},
            "zone": "sidebar",
        })
    for block in code_blocks[:2]:
        components.append({
            "type": "a2ui.CodeBlock",
            "id": _make_id(),
            "props": {"language": block["language"], "code": block["code"]},
            "zone": "content",
        })
    return components


def _build_pr_review(node_output: str) -> list[dict[str, Any]]:
    """Build A2UI components for pr_review approval type."""
    components: list[dict[str, Any]] = []
    stats = _extract_stats(node_output)
    code_blocks = _extract_code_blocks(node_output)

    # Parse +/- stats from diff-style output
    additions = re.search(r"\+(\d+)", node_output)
    deletions = re.search(r"-(\d+)", node_output)
    stat_items = []
    if "Files changed" in stats or "files changed" in stats:
        stat_items.append({"label": "Files Changed", "value": stats.get("Files changed", stats.get("files changed", "?"))})
    if additions:
        stat_items.append({"label": "Additions", "value": f"+{additions.group(1)}"})
    if deletions:
        stat_items.append({"label": "Deletions", "value": f"-{deletions.group(1)}"})

    components.append({
        "type": "a2ui.StatCard",
        "id": _make_id(),
        "props": {"stats": stat_items or [{"label": "Review", "value": "PR ready"}]},
        "zone": "hero",
    })
    for block in code_blocks[:3]:
        components.append({
            "type": "a2ui.CodeBlock",
            "id": _make_id(),
            "props": {"language": block["language"], "code": block["code"]},
            "zone": "content",
        })
    return components


def _build_deploy_gate(node_output: str) -> list[dict[str, Any]]:
    """Build A2UI components for deploy_gate approval type."""
    components: list[dict[str, Any]] = []
    stats = _extract_stats(node_output)
    checklist = _extract_checklist(node_output)

    stat_items = [{"label": k, "value": v} for k, v in list(stats.items())[:4]]
    components.append({
        "type": "a2ui.StatCard",
        "id": _make_id(),
        "props": {"stats": stat_items or [{"label": "Deploy", "value": "Ready"}]},
        "zone": "hero",
    })
    for item in checklist:
        components.append({
            "type": "a2ui.ChecklistItem",
            "id": _make_id(),
            "props": {"label": item["label"], "checked": item["checked"]},
            "zone": "content",
        })
    if not checklist:
        components.append({
            "type": "a2ui.CalloutCard",
            "id": _make_id(),
            "props": {"message": "No pre-deploy checklist found in node output.", "severity": "info"},
            "zone": "sidebar",
        })
    return components


_BUILDERS = {
    "plan_review": _build_plan_review,
    "pr_review": _build_pr_review,
    "deploy_gate": _build_deploy_gate,
}


def build_approval_payload(approval_type: str, node_output: str) -> list[dict[str, Any]] | None:
    """Build A2UI component array for a given approval type.

    Returns None for unknown/custom types (caller should use LLM generation).
    """
    builder = _BUILDERS.get(approval_type)
    if builder is None:
        return None
    try:
        return builder(node_output)
    except Exception as e:
        logger.error(f"Error building {approval_type} template: {e}", exc_info=True)
        return None
