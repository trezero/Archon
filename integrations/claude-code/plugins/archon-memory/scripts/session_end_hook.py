#!/usr/bin/env python3
"""Stop hook — flush the session observation buffer to Archon.

Runs when Claude Code ends a session (Stop event). Reads the local JSONL buffer,
sends all observations to Archon as a single batch, then clears the buffer.

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


async def main() -> None:
    tracker = SessionTracker(buffer_path=_BUFFER_PATH)

    if not tracker.has_stale_buffer():
        # Nothing to flush
        return

    client = ArchonClient()
    if not client.is_configured():
        # Leave buffer intact so it can be flushed when Archon is configured
        return

    # Restore a session_id for the flush payload (use first obs or new uuid)
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


if __name__ == "__main__":
    asyncio.run(main())
