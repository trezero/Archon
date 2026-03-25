"""Normalization service for extracting intent tuples from activity events.

Calls Anthropic Haiku in batches to extract (action_verb, target_object, trigger_context)
tuples from raw event content. Generates embeddings of the normalized tuple using OpenAI
text-embedding-3-small, then updates each activity_events row with the extracted fields,
embedding, and a normalized_at timestamp.
"""

import json
import os
from datetime import UTC, datetime
from typing import Any

import anthropic
import openai

from src.server.utils import get_supabase_client

from ...config.logfire_config import get_logger

logger = get_logger(__name__)

DAILY_CAP = int(os.getenv("PATTERN_DISCOVERY_DAILY_CAP", "500"))
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"
EMBEDDING_MODEL = "text-embedding-3-small"


class NormalizationService:
    """Extracts intent tuples from raw activity events using Anthropic Haiku."""

    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()
        self._daily_count = 0
        self._last_reset_date: str | None = None

    def _get_anthropic_client(self) -> anthropic.AsyncAnthropic:
        """Create an Anthropic async client using the ANTHROPIC_API_KEY env var."""
        return anthropic.AsyncAnthropic()

    def _get_openai_client(self) -> openai.AsyncOpenAI:
        """Create an OpenAI async client using the OPENAI_API_KEY env var."""
        return openai.AsyncOpenAI()

    def _check_daily_cap(self) -> bool:
        """Check whether the daily event cap has been reached.

        Resets the counter when the calendar date changes (UTC).

        Returns:
            True if within cap, False if cap reached.
        """
        today = datetime.now(UTC).strftime("%Y-%m-%d")

        if self._last_reset_date != today:
            self._daily_count = 0
            self._last_reset_date = today

        return self._daily_count < DAILY_CAP

    async def normalize_batch(
        self,
        events: list[dict],
        batch_size: int = 50,
    ) -> tuple[bool, dict[str, Any]]:
        """Normalize a list of activity events by extracting intent tuples.

        Splits events into batches, calls Anthropic Haiku for extraction,
        generates OpenAI embeddings, and updates each row in activity_events.

        Args:
            events: Pending events (from CaptureService.get_pending_events()).
            batch_size: Maximum events per Anthropic API call.

        Returns:
            (success, result) tuple with normalized/failed counts.
        """
        if not events:
            return True, {"normalized": 0, "failed": 0}

        if not self._check_daily_cap():
            logger.info("Daily normalization cap reached, skipping batch")
            return True, {"normalized": 0, "skipped": "daily_cap_reached"}

        normalized_count = 0
        failed_count = 0

        # Split into batches
        for batch_start in range(0, len(events), batch_size):
            batch = events[batch_start : batch_start + batch_size]

            try:
                extracted = await self._extract_tuples(batch)
            except Exception as e:
                logger.error(f"Anthropic extraction failed for batch at offset {batch_start}: {e}", exc_info=True)
                failed_count += len(batch)
                continue

            # Process each extracted tuple
            for i, event in enumerate(batch):
                if i >= len(extracted):
                    logger.warning(f"No extraction result for event {event['id']} (index {i} >= {len(extracted)})")
                    failed_count += 1
                    continue

                extraction = extracted[i]
                action_verb = extraction.get("action_verb", "")
                target_object = extraction.get("target_object", "")
                trigger_context = extraction.get("trigger_context", "")

                # Generate embedding from the normalized tuple text
                tuple_text = f"{action_verb} {target_object} {trigger_context}"
                embedding = await self._generate_embedding(tuple_text)

                try:
                    self.supabase_client.table("activity_events").update({
                        "action_verb": action_verb,
                        "target_object": target_object,
                        "trigger_context": trigger_context,
                        "intent_embedding": embedding,
                        "normalized_at": datetime.now(UTC).isoformat(),
                    }).eq("id", event["id"]).execute()

                    normalized_count += 1
                    self._daily_count += 1

                except Exception as e:
                    logger.error(f"Failed to update event {event['id']}: {e}", exc_info=True)
                    failed_count += 1

        logger.info(f"Normalization complete: {normalized_count} normalized, {failed_count} failed")
        return True, {"normalized": normalized_count, "failed": failed_count}

    async def _extract_tuples(self, batch: list[dict]) -> list[dict[str, str]]:
        """Call Anthropic Haiku to extract intent tuples from a batch of events.

        Args:
            batch: List of activity event dicts with 'raw_content' fields.

        Returns:
            List of dicts with action_verb, target_object, trigger_context.

        Raises:
            Exception: On API or parsing failure.
        """
        prompt = self._build_extraction_prompt(batch)
        client = self._get_anthropic_client()

        response = await client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )

        response_text = response.content[0].text

        # Parse JSON response — handle markdown code fences if present
        cleaned = response_text.strip()
        if cleaned.startswith("```"):
            # Strip code fence markers
            lines = cleaned.split("\n")
            lines = lines[1:]  # Remove opening ```json or ```
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            cleaned = "\n".join(lines)

        parsed = json.loads(cleaned)

        if not isinstance(parsed, list):
            raise ValueError(f"Expected JSON array from Haiku, got {type(parsed).__name__}")

        return parsed

    def _build_extraction_prompt(self, events: list[dict]) -> str:
        """Build a prompt asking Haiku to extract intent tuples.

        Args:
            events: List of activity event dicts with 'raw_content' fields.

        Returns:
            Formatted prompt string.
        """
        numbered_events = "\n".join(
            f"{i + 1}. {event.get('raw_content', '')}" for i, event in enumerate(events)
        )

        return (
            "Extract intent tuples from these activity events. For each, return:\n"
            '- action_verb: the primary action (e.g., "add", "fix", "refactor", "deploy")\n'
            '- target_object: what was acted on (e.g., "auth middleware", "user model")\n'
            '- trigger_context: why/when (e.g., "bug report", "feature request", "routine")\n'
            "\n"
            "Events:\n"
            f"{numbered_events}\n"
            "\n"
            'Respond with a JSON array of objects: [{"action_verb": "...", "target_object": "...", "trigger_context": "..."}]'
        )

    async def _generate_embedding(self, text: str) -> list[float] | None:
        """Generate an embedding vector for the given text using OpenAI.

        Uses text-embedding-3-small model.

        Args:
            text: The normalized tuple string to embed.

        Returns:
            Embedding vector or None on failure.
        """
        if not text or not text.strip():
            return None

        try:
            client = self._get_openai_client()
            response = await client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=text,
            )
            return response.data[0].embedding

        except Exception as e:
            logger.error(f"Embedding generation failed for text '{text[:80]}...': {e}", exc_info=True)
            return None
