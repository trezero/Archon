"""Scan report generation for the Local Project Scanner."""

import csv
import io
import os
from datetime import datetime, timezone
from typing import Any

from src.server.config.logfire_config import get_logger
from src.server.config.scanner_config import SCANNER_PROJECTS_ROOT

logger = get_logger(__name__)


async def generate_scan_report(
    scan_id: str,
    supabase_client,
) -> tuple[bool, dict[str, Any]]:
    """Generate a post-scan CSV report and summary.

    Returns (success, {"csv_path": "...", "summary": "..."})
    """
    try:
        scan_resp = (
            supabase_client.table("archon_scan_results")
            .select("*")
            .eq("id", scan_id)
            .execute()
        )
        if not scan_resp.data:
            return False, {"error": "Scan not found"}

        scan = scan_resp.data[0]

        projects_resp = (
            supabase_client.table("archon_scan_projects")
            .select("*")
            .eq("scan_id", scan_id)
            .order("created_at")
            .execute()
        )
        projects = projects_resp.data or []

        # Build summary stats
        status_counts: dict[str, int] = {}
        non_github_repos: list[str] = []
        no_remote_repos: list[str] = []
        errors: list[str] = []
        crawls_queued = 0

        for p in projects:
            status = p.get("apply_status", "pending")
            status_counts[status] = status_counts.get(status, 0) + 1

            if status == "skipped":
                err = p.get("error_message", "")
                if "Non-GitHub" in err:
                    url = p.get("git_remote_url", "unknown")
                    non_github_repos.append(f"{url} ({p['directory_name']})")
                elif "No remote" in err:
                    no_remote_repos.append(p["directory_name"])

            if status == "failed":
                errors.append(f"{p['directory_name']}: {p.get('error_message', 'Unknown error')}")

            if status == "created" and p.get("github_url"):
                crawls_queued += 1

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        groups = scan.get("project_groups", 0)

        summary_lines = [
            "# Archon Local Project Scanner Report",
            f"# Scan ID: {scan_id}",
            f"# Directory: {scan['directory_path']}",
            f"# Date: {now}",
            "#",
            "# === Summary ===",
            f"# Total directories scanned: {scan.get('total_found', 0)}",
            f"# Git repositories found: {len(projects)}",
            f"# Project groups detected: {groups}",
            "#",
            "# === Results ===",
            f"# Created:              {status_counts.get('created', 0)}",
            f"# Skipped (existing):   {status_counts.get('skipped', 0) + status_counts.get('duplicate_skipped', 0)}",
        ]

        if non_github_repos:
            summary_lines.append(
                f"# Skipped (non-GitHub):  {len(non_github_repos)}  ({', '.join(non_github_repos[:5])})"
            )
        if no_remote_repos:
            summary_lines.append(
                f"# Skipped (no remote):   {len(no_remote_repos)}  ({', '.join(no_remote_repos[:5])})"
            )

        summary_lines.extend([
            f"# Failed:                {status_counts.get('failed', 0)}",
            "#",
            "# === Crawls ===",
            f"# README crawls queued:  {crawls_queued}",
            f"# Estimated crawl time:  ~{crawls_queued} minutes (3 concurrent)",
        ])

        if errors:
            summary_lines.append("#")
            summary_lines.append("# === Errors ===")
            for err in errors:
                summary_lines.append(f"# {err}")
        else:
            summary_lines.extend(["#", "# === Errors ===", "# (none)"])

        summary_text = "\n".join(summary_lines)

        # Build CSV
        csv_buffer = io.StringIO()
        writer = csv.writer(csv_buffer)

        for line in summary_lines:
            csv_buffer.write(line + "\n")
        csv_buffer.write("#\n")

        writer.writerow([
            "directory_name",
            "host_path",
            "github_url",
            "group_name",
            "detected_languages",
            "status",
            "archon_project_id",
            "crawl_status",
            "error",
            "description",
        ])

        for p in projects:
            status = p.get("apply_status", "pending")
            if p.get("already_in_archon") and status == "pending":
                display_status = "skipped_existing"
            elif status == "skipped":
                err = p.get("error_message", "")
                if "Non-GitHub" in err:
                    display_status = "skipped_non_github"
                elif "No remote" in err:
                    display_status = "skipped_no_remote"
                else:
                    display_status = "skipped_filtered"
            else:
                display_status = status

            crawl_status = "n/a"
            if status == "created" and p.get("github_url"):
                crawl_status = "queued"
            elif status == "created" and not p.get("github_url"):
                crawl_status = "skipped"

            writer.writerow([
                p.get("directory_name", ""),
                p.get("host_path", ""),
                p.get("github_url", ""),
                p.get("group_name", ""),
                ",".join(p.get("detected_languages", [])),
                display_status,
                p.get("archon_project_id", ""),
                crawl_status,
                p.get("error_message", ""),
                "",
            ])

        csv_filename = f".archon-scan-report-{scan_id}.csv"
        csv_path = os.path.join(SCANNER_PROJECTS_ROOT, csv_filename)

        try:
            with open(csv_path, "w", newline="") as f:
                f.write(csv_buffer.getvalue())
            logger.info(f"Scan report written to {csv_path}")
        except OSError as e:
            logger.warning(f"Could not write CSV report to {csv_path}: {e}")
            csv_path = None

        return True, {
            "csv_path": csv_path,
            "summary": summary_text,
        }

    except Exception as e:
        logger.error(f"Failed to generate scan report: {e}", exc_info=True)
        return False, {"error": str(e)}
