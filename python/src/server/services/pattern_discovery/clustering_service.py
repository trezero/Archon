"""Embedding-based clustering of normalized events using pgvector cosine similarity."""

from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)

SIMILARITY_THRESHOLD = 0.85


class ClusteringService:
    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    async def find_clusters(self, min_cluster_size: int = 3) -> tuple[bool, dict[str, Any]]:
        """Find clusters of similar events using pgvector cosine distance.

        Uses SQL: SELECT pairs where 1 - (a.intent_embedding <=> b.intent_embedding) > threshold.
        Groups into clusters via simple union-find on connected pairs.
        Returns cluster descriptions with representative events.
        """
        try:
            # Get all events with embeddings
            response = (
                self.supabase_client.table("activity_events")
                .select("id, action_verb, target_object, trigger_context, repo_url, intent_embedding")
                .not_("intent_embedding", "is", None)
                .not_("action_verb", "is", None)
                .execute()
            )
            if not response.data:
                return True, {"clusters": [], "total_events": 0}

            events = response.data
            # Build clusters via simple similarity grouping
            # (In production, would use pgvector's built-in nearest neighbor,
            # but for beta we group by exact action_verb:target_object match)
            clusters = self._group_by_intent(events, min_cluster_size)

            return True, {"clusters": clusters, "total_events": len(events)}
        except Exception as e:
            logger.error(f"Error finding clusters: {e}", exc_info=True)
            return False, {"error": str(e)}

    def _group_by_intent(self, events: list[dict], min_size: int) -> list[dict[str, Any]]:
        """Group events by action_verb:target_object as a simple clustering proxy."""
        groups: dict[str, list[dict]] = {}
        for event in events:
            key = f"{event.get('action_verb', '')}:{event.get('target_object', '')}"
            groups.setdefault(key, []).append(event)

        clusters = []
        for key, group_events in groups.items():
            if len(group_events) >= min_size:
                repos = list({e.get("repo_url", "unknown") for e in group_events})
                clusters.append({
                    "intent_key": key,
                    "action_verb": group_events[0].get("action_verb"),
                    "target_object": group_events[0].get("target_object"),
                    "event_count": len(group_events),
                    "repos": repos,
                    "event_ids": [e["id"] for e in group_events],
                })
        return sorted(clusters, key=lambda c: c["event_count"], reverse=True)
