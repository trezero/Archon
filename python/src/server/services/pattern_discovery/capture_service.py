"""Capture service for ingesting activity events from multiple sources.

Ingests events from git commits, agent conversations, and workflow completions.
Each event is stored in the `activity_events` table with `normalized_at = NULL`,
marking it as pending normalization by the downstream NormalizationService.
"""

import subprocess
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class CaptureService:
    """Ingests raw activity events from git, conversations, and workflow runs."""

    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    async def capture_git_commits(
        self,
        project_id: str,
        repo_path: str,
        since_days: int = 7,
    ) -> tuple[bool, dict[str, Any]]:
        """Parse recent git commits and insert them as activity events.

        Runs `git log --oneline` via subprocess, parses each line into a
        commit hash and message, and bulk-inserts rows into `activity_events`.

        Args:
            project_id: Project these commits belong to.
            repo_path: Absolute path to the git repository.
            since_days: How far back to look for commits.

        Returns:
            (success, result) tuple. On success result contains {"captured": int}.
        """
        try:
            proc = subprocess.run(
                ["git", "log", "--oneline", f"--since={since_days} days ago"],
                capture_output=True,
                text=True,
                cwd=repo_path,
            )

            if proc.returncode != 0:
                error_msg = proc.stderr.strip() or f"git log exited with code {proc.returncode}"
                logger.error(f"git log failed in {repo_path}: {error_msg}")
                return False, {"error": error_msg}

            lines = [line.strip() for line in proc.stdout.strip().splitlines() if line.strip()]

            if not lines:
                logger.info(f"No commits found in {repo_path} for the last {since_days} days")
                return True, {"captured": 0}

            rows: list[dict[str, Any]] = []
            for line in lines:
                parts = line.split(" ", 1)
                commit_hash = parts[0]
                message = parts[1] if len(parts) > 1 else ""

                rows.append({
                    "event_type": "git_commit",
                    "project_id": project_id,
                    "raw_content": message,
                    "metadata": {
                        "commit_hash": commit_hash,
                        "repo_path": repo_path,
                    },
                })

            response = self.supabase_client.table("activity_events").insert(rows).execute()
            captured = len(response.data) if response.data else len(rows)

            logger.info(f"Captured {captured} git commits from {repo_path}")
            return True, {"captured": captured}

        except Exception as e:
            logger.error(f"Error capturing git commits from {repo_path}: {e}", exc_info=True)
            return False, {"error": f"Failed to capture git commits: {str(e)}"}

    async def capture_workflow_completion(
        self,
        workflow_run_id: str,
    ) -> tuple[bool, dict[str, Any]]:
        """Capture a completed workflow run as an activity event.

        Reads the run record from `workflow_runs` and its nodes from
        `workflow_nodes`, then inserts a single `activity_events` row
        summarizing the workflow execution.

        Args:
            workflow_run_id: ID of the completed workflow run.

        Returns:
            (success, result) tuple. On success result contains {"event_id": str}.
        """
        try:
            run_response = (
                self.supabase_client.table("workflow_runs")
                .select("id, status, workflow_id")
                .eq("id", workflow_run_id)
                .execute()
            )

            if not run_response.data:
                return False, {"error": f"Workflow run {workflow_run_id} not found"}

            run = run_response.data[0]

            nodes_response = (
                self.supabase_client.table("workflow_nodes")
                .select("id, node_id, state, output")
                .eq("workflow_run_id", workflow_run_id)
                .execute()
            )

            nodes = nodes_response.data or []
            node_summaries = [
                f"{n['node_id']}: {n['state']}" for n in nodes
            ]
            raw_content = f"Workflow run {workflow_run_id} ({run['status']}): " + "; ".join(node_summaries)

            event_row = {
                "event_type": "workflow_completion",
                "raw_content": raw_content,
                "metadata": {
                    "run_id": workflow_run_id,
                    "workflow_id": run.get("workflow_id"),
                    "node_count": len(nodes),
                    "status": run["status"],
                },
            }

            insert_response = (
                self.supabase_client.table("activity_events")
                .insert(event_row)
                .execute()
            )

            event_id = insert_response.data[0]["id"] if insert_response.data else None
            logger.info(f"Captured workflow completion event for run {workflow_run_id}")
            return True, {"event_id": event_id}

        except Exception as e:
            logger.error(
                f"Error capturing workflow completion for {workflow_run_id}: {e}",
                exc_info=True,
            )
            return False, {"error": f"Failed to capture workflow completion: {str(e)}"}

    async def capture_conversation(
        self,
        conversation_id: str,
    ) -> tuple[bool, dict[str, Any]]:
        """Capture an agent conversation as an activity event (stub).

        The actual `chat_messages` table query is a placeholder — this method
        creates a stub event with the conversation_id in metadata. Once the
        chat_messages schema is finalized, this will be expanded to pull
        actual message content.

        Args:
            conversation_id: Identifier for the conversation to capture.

        Returns:
            (success, result) tuple. On success result contains {"event_id": str}.
        """
        try:
            event_row = {
                "event_type": "conversation",
                "raw_content": f"Conversation {conversation_id}",
                "metadata": {
                    "conversation_id": conversation_id,
                },
            }

            insert_response = (
                self.supabase_client.table("activity_events")
                .insert(event_row)
                .execute()
            )

            event_id = insert_response.data[0]["id"] if insert_response.data else None
            logger.info(f"Captured conversation event for {conversation_id}")
            return True, {"event_id": event_id}

        except Exception as e:
            logger.error(
                f"Error capturing conversation {conversation_id}: {e}",
                exc_info=True,
            )
            return False, {"error": f"Failed to capture conversation: {str(e)}"}

    async def get_pending_events(
        self,
        limit: int = 50,
    ) -> tuple[bool, dict[str, Any]]:
        """Return activity events that have not yet been normalized.

        Queries `activity_events` where `normalized_at IS NULL`, ordered
        by `created_at` ascending so the oldest events are processed first.

        Args:
            limit: Maximum number of pending events to return.

        Returns:
            (success, result) tuple. On success result contains {"events": list}.
        """
        try:
            response = (
                self.supabase_client.table("activity_events")
                .select("*")
                .is_("normalized_at", "null")
                .order("created_at")
                .limit(limit)
                .execute()
            )

            events = response.data or []
            logger.info(f"Found {len(events)} pending events for normalization")
            return True, {"events": events}

        except Exception as e:
            logger.error(f"Error fetching pending events: {e}", exc_info=True)
            return False, {"error": f"Failed to fetch pending events: {str(e)}"}
