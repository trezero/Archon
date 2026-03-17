#!/usr/bin/env python3
"""Stop hook — flush the session observation buffer to Archon and materialize LeaveOffPoint.md.

Runs when Claude Code ends a session (Stop event). Reads the local JSONL buffer,
sends all observations to Archon as a single batch, then clears the buffer.
Also fetches the current LeaveOff point and writes it to .archon/knowledge/LeaveOffPoint.md
so the next session has local access to it.

If Archon is unreachable the buffer is left intact for flush_stale() on next start.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# Add plugin src directory to path
_PLUGIN_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_PLUGIN_ROOT))

from src.archon_client import ArchonClient
from src.session_tracker import SessionTracker

_BUFFER_PATH = ".claude/archon-memory-buffer.jsonl"
_TIMEOUT_SECONDS = 8
_LEAVEOFF_DIR = ".archon/knowledge"
_LEAVEOFF_FILE = "LeaveOffPoint.md"


def _materialize_leaveoff(leaveoff: dict) -> None:
    """Write a LeaveOffPoint.md file into .archon/knowledge/ in the project root.

    The file uses YAML-style frontmatter and markdown body so it can be read
    by both humans and the session_start_hook.
    """
    dir_path = Path.cwd() / _LEAVEOFF_DIR
    dir_path.mkdir(parents=True, exist_ok=True)
    file_path = dir_path / _LEAVEOFF_FILE

    project_id = leaveoff.get("project_id", "")
    component = leaveoff.get("component", "")
    updated_at = leaveoff.get("updated_at", "")
    machine_id = leaveoff.get("machine_id", "")
    system_name = leaveoff.get("system_name", "")
    git_clean = leaveoff.get("git_clean")
    content = leaveoff.get("content", "")
    next_steps = leaveoff.get("next_steps") or []
    references = leaveoff.get("references") or []

    lines: list[str] = []
    lines.append("---")
    lines.append(f"project_id: {project_id}")
    lines.append(f"component: {component}")
    lines.append(f"updated_at: {updated_at}")
    lines.append(f"machine_id: {machine_id}")
    lines.append(f"system_name: {system_name}")
    if git_clean is not None:
        lines.append(f"git_clean: {str(git_clean).lower()}")
    lines.append("---")
    lines.append("")
    lines.append(content)

    if next_steps:
        lines.append("")
        lines.append("## Next Steps")
        for step in next_steps:
            lines.append(f"- {step}")

    if references:
        lines.append("")
        lines.append("## References")
        for ref in references:
            lines.append(f"- {ref}")

    lines.append("")
    file_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"archon-memory: LeaveOffPoint.md materialized at {file_path}", file=sys.stderr)


async def main() -> None:
    client = ArchonClient()
    tracker = SessionTracker(buffer_path=_BUFFER_PATH)

    # ── Flush observation buffer ────────────────────────────────────────────
    if tracker.has_stale_buffer():
        if not client.is_configured():
            # Leave buffer intact so it can be flushed when Archon is configured
            print("archon-memory: Archon not configured — buffer preserved", file=sys.stderr)
        else:
            tracker.session_id = tracker.session_id or "session-end-flush"
            tracker.started_at = tracker.started_at or ""
            try:
                success = await asyncio.wait_for(tracker.flush(client), timeout=_TIMEOUT_SECONDS)
                if success:
                    print("archon-memory: session flushed to Archon", file=sys.stderr)
                else:
                    print("archon-memory: flush failed — buffer preserved for next session", file=sys.stderr)
            except asyncio.TimeoutError:
                print("archon-memory: Archon unreachable (timeout) — buffer preserved", file=sys.stderr)
            except Exception as e:
                print(f"archon-memory: unexpected error during flush: {e}", file=sys.stderr)

    # ── Materialize LeaveOffPoint.md locally ────────────────────────────────
    if client.is_configured():
        try:
            leaveoff = await asyncio.wait_for(client.get_leaveoff_point(), timeout=5.0)
            if leaveoff:
                _materialize_leaveoff(leaveoff)
        except asyncio.TimeoutError:
            print("archon-memory: timeout fetching LeaveOff point", file=sys.stderr)
        except Exception as e:
            print(f"archon-memory: error materializing LeaveOffPoint.md: {e}", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(main())
