"""Background cleanup task for expired scan results."""

import asyncio
from datetime import datetime, timezone

from src.server.config.logfire_config import get_logger
from src.server.utils import get_supabase_client

logger = get_logger(__name__)

CLEANUP_INTERVAL_HOURS = 6


async def cleanup_expired_scans() -> int:
    """Delete scan results where expires_at < NOW().
    CASCADE deletes associated archon_scan_projects rows.

    Returns the number of deleted scans.
    """
    try:
        supabase = get_supabase_client()
        now = datetime.now(timezone.utc).isoformat()

        expired = (
            supabase.table("archon_scan_results")
            .select("id")
            .lt("expires_at", now)
            .neq("status", "applied")
            .execute()
        )

        if not expired.data:
            return 0

        count = len(expired.data)
        ids = [r["id"] for r in expired.data]

        for scan_id in ids:
            supabase.table("archon_scan_results").delete().eq("id", scan_id).execute()

        logger.info(f"Cleaned up {count} expired scan(s)")
        return count

    except Exception as e:
        logger.warning(f"Scan cleanup failed: {e}")
        return 0


async def start_cleanup_loop() -> None:
    """Run cleanup periodically. Call this on server startup."""
    await cleanup_expired_scans()

    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_HOURS * 3600)
        await cleanup_expired_scans()
