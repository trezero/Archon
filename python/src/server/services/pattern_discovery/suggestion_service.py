"""Suggestion service for surfacing discovered patterns and handling user actions.

Lists discovered patterns as suggestions, handles Accept/Customize/Dismiss actions,
and orchestrates the full discovery pipeline. Accepting a pattern creates a
workflow_definitions row with origin: pattern_discovery. Dismissing decays scores.
"""

from datetime import UTC, datetime
from typing import Any

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)


class SuggestionService:
    """Surfaces discovered patterns as suggestions and handles user feedback."""

    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def list_suggestions(
        self,
        status: str = "pending_review",
        limit: int = 20,
    ) -> tuple[bool, dict[str, Any]]:
        """List discovered patterns filtered by status, ordered by score descending.

        Args:
            status: Pattern status to filter by (pending_review, accepted, dismissed).
            limit: Maximum number of suggestions to return.

        Returns:
            (success, result) tuple. On success result contains {"suggestions": list}.
        """
        try:
            response = (
                self.supabase_client.table("discovered_patterns")
                .select("*")
                .eq("status", status)
                .order("final_score", desc=True)
                .limit(limit)
                .execute()
            )

            suggestions = response.data or []
            logger.info(f"Listed {len(suggestions)} suggestions with status={status}")
            return True, {"suggestions": suggestions}

        except Exception as e:
            logger.error(f"Error listing suggestions: {e}", exc_info=True)
            return False, {"error": f"Failed to list suggestions: {str(e)}"}

    def accept_suggestion(
        self,
        pattern_id: str,
        customized_yaml: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Accept a discovered pattern, creating a workflow definition from it.

        Creates a workflow_definitions row using the pattern's suggested_yaml
        (or customized_yaml if provided), then updates the pattern's status
        to "accepted" and records the accepted_workflow_id.

        Args:
            pattern_id: ID of the discovered pattern to accept.
            customized_yaml: Optional customized YAML to use instead of the suggested one.

        Returns:
            (success, result) tuple. On success result contains {"definition": dict}.
        """
        try:
            # Fetch the pattern
            pattern_response = (
                self.supabase_client.table("discovered_patterns")
                .select("*")
                .eq("id", pattern_id)
                .execute()
            )

            if not pattern_response.data:
                return False, {"error": f"Pattern {pattern_id} not found"}

            pattern = pattern_response.data[0]
            yaml_content = customized_yaml or pattern.get("suggested_yaml", "")

            if not yaml_content:
                return False, {"error": "No YAML content available for this pattern (neither suggested nor customized)"}

            # Create workflow definition from the pattern
            definition_data = {
                "name": pattern.get("pattern_name", "Discovered Pattern"),
                "description": pattern.get("description"),
                "yaml_content": yaml_content,
                "version": 1,
                "is_latest": True,
                "origin": "pattern_discovery",
                "tags": ["auto-discovered"],
            }

            def_response = (
                self.supabase_client.table("workflow_definitions")
                .insert(definition_data)
                .execute()
            )

            if not def_response.data:
                return False, {"error": "Failed to create workflow definition from pattern"}

            definition = def_response.data[0]

            # Update pattern status to accepted and link to the definition
            self.supabase_client.table("discovered_patterns").update({
                "status": "accepted",
                "accepted_workflow_id": definition["id"],
            }).eq("id", pattern_id).execute()

            logger.info(
                f"Accepted pattern {pattern_id} as workflow definition {definition['id']}"
            )
            return True, {"definition": definition}

        except Exception as e:
            logger.error(f"Error accepting suggestion {pattern_id}: {e}", exc_info=True)
            return False, {"error": f"Failed to accept suggestion: {str(e)}"}

    def dismiss_suggestion(
        self,
        pattern_id: str,
        reason: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Dismiss a discovered pattern, decaying its score.

        Updates the pattern's status to "dismissed", stores the reason in
        feedback_delta, and decays final_score by 0.5x so rediscovery
        requires stronger signal.

        Args:
            pattern_id: ID of the discovered pattern to dismiss.
            reason: Optional reason for dismissal.

        Returns:
            (success, result) tuple. On success result contains {"dismissed": pattern_id}.
        """
        try:
            # Fetch the pattern to get current score
            pattern_response = (
                self.supabase_client.table("discovered_patterns")
                .select("*")
                .eq("id", pattern_id)
                .execute()
            )

            if not pattern_response.data:
                return False, {"error": f"Pattern {pattern_id} not found"}

            pattern = pattern_response.data[0]
            current_score = pattern.get("final_score", 0)
            decayed_score = current_score * 0.5

            feedback_delta = {
                "action": "dismissed",
                "dismissed_at": datetime.now(UTC).isoformat(),
            }
            if reason:
                feedback_delta["reason"] = reason

            self.supabase_client.table("discovered_patterns").update({
                "status": "dismissed",
                "final_score": decayed_score,
                "feedback_delta": feedback_delta,
            }).eq("id", pattern_id).execute()

            logger.info(f"Dismissed pattern {pattern_id} (score {current_score} -> {decayed_score})")
            return True, {"dismissed": pattern_id, "decayed_score": decayed_score}

        except Exception as e:
            logger.error(f"Error dismissing suggestion {pattern_id}: {e}", exc_info=True)
            return False, {"error": f"Failed to dismiss suggestion: {str(e)}"}

    async def run_discovery_pipeline(self) -> tuple[bool, dict[str, Any]]:
        """Orchestrate the full discovery pipeline: capture -> normalize -> mine -> cluster -> score -> generate -> store.

        For beta, runs each service's main method in sequence and returns
        summary statistics for each stage.

        Returns:
            (success, result) tuple. On success result contains stats for each pipeline stage.
        """
        try:
            capture_result = await self._run_capture()
            normalization_result = await self._run_normalization()
            mining_result = self._run_mining()
            clustering_result = await self._run_clustering()
            scoring_gen_result = await self._run_scoring_and_generation()

            summary = {
                "capture": capture_result,
                "normalization": normalization_result,
                "mining": mining_result,
                "clustering": clustering_result,
                "scoring_and_generation": scoring_gen_result,
            }

            logger.info(f"Discovery pipeline complete: {summary}")
            return True, summary

        except Exception as e:
            logger.error(f"Discovery pipeline failed: {e}", exc_info=True)
            return False, {"error": f"Pipeline failed: {str(e)}"}

    async def _run_capture(self) -> dict[str, Any]:
        """Run the capture stage — fetch pending events from existing sources."""
        from .capture_service import CaptureService

        capture = CaptureService(supabase_client=self.supabase_client)
        success, result = await capture.get_pending_events(limit=100)
        if not success:
            return {"error": result.get("error", "Capture stage failed")}
        return {"captured": len(result.get("events", []))}

    async def _run_normalization(self) -> dict[str, Any]:
        """Run the normalization stage on pending events."""
        from .capture_service import CaptureService
        from .normalization_service import NormalizationService

        capture = CaptureService(supabase_client=self.supabase_client)
        normalizer = NormalizationService(supabase_client=self.supabase_client)

        success, pending = await capture.get_pending_events(limit=100)
        if not success:
            return {"error": pending.get("error", "Failed to fetch pending events")}

        events = pending.get("events", [])
        if not events:
            return {"normalized": 0, "failed": 0}

        success, result = await normalizer.normalize_batch(events)
        if not success:
            return {"error": result.get("error", "Normalization failed")}
        return result

    def _run_mining(self) -> dict[str, Any]:
        """Run the sequence mining stage."""
        from .sequence_mining_service import SequenceMiningService

        miner = SequenceMiningService(supabase_client=self.supabase_client)
        success, result = miner.mine_sequences()
        if not success:
            return {"error": result.get("error", "Mining failed")}
        return {"patterns": result.get("filtered_count", 0)}

    async def _run_clustering(self) -> dict[str, Any]:
        """Run the clustering stage."""
        from .clustering_service import ClusteringService

        clusterer = ClusteringService(supabase_client=self.supabase_client)
        success, result = await clusterer.find_clusters()
        if not success:
            return {"error": result.get("error", "Clustering failed")}
        return {"clusters": len(result.get("clusters", []))}

    async def _run_scoring_and_generation(self) -> dict[str, Any]:
        """Run scoring and YAML generation, then store discovered patterns.

        Combines results from mining and clustering, scores them, generates
        YAML for patterns above threshold, and inserts into discovered_patterns.
        """
        from .clustering_service import ClusteringService
        from .generation_service import GenerationService
        from .scoring_service import ScoringService
        from .sequence_mining_service import SequenceMiningService

        scorer = ScoringService()
        generator = GenerationService()
        miner = SequenceMiningService(supabase_client=self.supabase_client)
        clusterer = ClusteringService(supabase_client=self.supabase_client)

        # Gather raw patterns from both mining and clustering
        raw_patterns: list[dict[str, Any]] = []

        mine_ok, mine_result = miner.mine_sequences()
        if mine_ok:
            raw_patterns.extend(mine_result.get("patterns", []))

        cluster_ok, cluster_result = await clusterer.find_clusters()
        if cluster_ok:
            raw_patterns.extend(cluster_result.get("clusters", []))

        if not raw_patterns:
            return {"stored": 0}

        # Score and filter
        scored = scorer.score_and_filter(raw_patterns)
        stored_count = 0

        for pattern in scored:
            # Generate YAML for each pattern
            gen_ok, gen_result = await generator.generate_workflow_yaml(pattern)
            if not gen_ok:
                logger.warning(f"YAML generation failed for pattern: {gen_result.get('error')}")
                continue

            # Store discovered pattern
            row = {
                "pattern_name": gen_result.get("pattern_name", pattern.get("intent_key", "unnamed")),
                "description": f"Auto-discovered pattern with score {pattern['final_score']}",
                "pattern_type": "sequence" if "sequence" in pattern else "cluster",
                "sequence_pattern": pattern.get("sequence") or pattern.get("event_ids"),
                "repos_involved": pattern.get("repos", []),
                "frequency_score": pattern.get("frequency_score", 0),
                "cross_repo_score": pattern.get("cross_repo_score", 0),
                "automation_potential": pattern.get("automation_potential", 0),
                "final_score": pattern.get("final_score", 0),
                "suggested_yaml": gen_result.get("yaml"),
                "status": "pending_review",
            }

            try:
                self.supabase_client.table("discovered_patterns").insert(row).execute()
                stored_count += 1
            except Exception as e:
                logger.error(f"Failed to store discovered pattern: {e}", exc_info=True)

        return {"stored": stored_count}
