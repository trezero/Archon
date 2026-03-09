#!/usr/bin/env python3
"""SessionStart hook — inject Archon context into the new conversation.

Runs on SessionStart (startup, clear, compact). Outputs a context block to
stdout that Claude Code injects into the system prompt.

Also flushes any stale buffer left by a previous crashed session.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

# Add plugin src directory to path so imports work regardless of cwd
_PLUGIN_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_PLUGIN_ROOT))

from src.archon_client import ArchonClient
from src.session_tracker import SessionTracker

_BUFFER_PATH = ".claude/archon-memory-buffer.jsonl"
_TIMEOUT_SECONDS = 5


def _setup_message() -> str:
    return """<archon-setup-needed>
Archon is not configured for this project. Run the Archon setup script to enable
session memory, smart code exploration, and project context injection.

  bash <(curl -s https://your-archon-instance/setup)  # or see Archon docs

Until configured, smart_search / smart_outline / smart_unfold tools are still available.
</archon-setup-needed>"""


def _format_context(sessions: list[dict], tasks: list[dict], knowledge: dict, leaveoff: dict | None = None) -> str:
    parts: list[str] = ["<archon-context>"]

    # LeaveOff Point goes first — most important context
    if leaveoff:
        component = leaveoff.get("component", "Unknown")
        updated = leaveoff.get("updated_at", "")[:10] if leaveoff.get("updated_at") else ""
        content = leaveoff.get("content", "")
        next_steps = leaveoff.get("next_steps", [])
        references = leaveoff.get("references", [])

        parts.append("\n## LeaveOff Point (Last Session State)")
        parts.append(f"**Component:** {component}")
        parts.append(f"**Updated:** {updated}")
        if content:
            parts.append(f"\n{content}")
        if next_steps:
            parts.append("\n### Next Steps")
            for step in next_steps:
                parts.append(f"- {step}")
        if references:
            parts.append("\n### References")
            for ref in references:
                parts.append(f"- {ref}")

    if sessions:
        parts.append("\n## Recent Sessions")
        for s in sessions[:5]:
            summary = s.get("summary", "No summary")
            started = s.get("started_at", "")[:10] if s.get("started_at") else ""
            parts.append(f"- [{started}] {summary}")

    if tasks:
        parts.append("\n## Active Tasks")
        for t in tasks[:10]:
            status = t.get("status", "")
            title = t.get("title", t.get("name", "Untitled"))
            parts.append(f"- [{status}] {title}")

    sources = knowledge.get("sources", [])
    if sources:
        parts.append(f"\n## Knowledge Sources ({len(sources)} indexed)")
        for src in sources[:5]:
            name = src.get("name", src.get("url", "Unknown"))
            parts.append(f"- {name}")

    if len(parts) == 1:
        parts.append("\nNo recent context available.")

    parts.append("\n</archon-context>")
    return "\n".join(parts)


async def main() -> None:
    client = ArchonClient()

    if not client.is_configured():
        print(_setup_message())
        return

    tracker = SessionTracker(buffer_path=_BUFFER_PATH)
    tracker.start_session()

    # Flush stale buffer from a previous crashed session (best-effort)
    if tracker.has_stale_buffer():
        try:
            await asyncio.wait_for(tracker.flush_stale(client), timeout=3.0)
        except Exception:
            pass

    # Fetch context in parallel with a total timeout
    try:
        sessions, tasks, knowledge, leaveoff = await asyncio.wait_for(
            asyncio.gather(
                client.get_recent_sessions(limit=5),
                client.get_active_tasks(limit=10),
                client.get_knowledge_status(),
                client.get_leaveoff_point(),
                return_exceptions=True,
            ),
            timeout=_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        print("<!-- archon-memory: Archon unreachable (timeout), skipping context -->")
        return
    except Exception:
        return

    # Replace exceptions from gather with empty defaults
    if isinstance(sessions, Exception):
        sessions = []
    if isinstance(tasks, Exception):
        tasks = []
    if isinstance(knowledge, Exception):
        knowledge = {}
    if isinstance(leaveoff, Exception):
        leaveoff = None

    print(_format_context(sessions, tasks, knowledge, leaveoff))  # type: ignore[arg-type]

    # Postman environment sync (API mode only, best-effort)
    try:
        postman_mode = await asyncio.wait_for(client.get_postman_sync_mode(), timeout=2.0)
        if postman_mode == "api":
            env_path = Path.cwd() / ".env"
            if env_path.is_file():
                env_content = env_path.read_text(encoding="utf-8")
                state_path = Path.cwd() / ".claude" / "archon-state.json"
                system_name = "default"
                if state_path.is_file():
                    state = json.loads(state_path.read_text(encoding="utf-8"))
                    system_name = state.get("system_name", "default")
                await asyncio.wait_for(
                    client.sync_postman_environment(system_name, env_content),
                    timeout=3.0,
                )
    except Exception:
        pass  # Best-effort, don't block session start


if __name__ == "__main__":
    asyncio.run(main())
