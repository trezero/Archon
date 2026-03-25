"""Tests for NormalizationService — Haiku-based intent extraction and embedding."""

import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.pattern_discovery.normalization_service import (
    ANTHROPIC_MODEL,
    DAILY_CAP,
    NormalizationService,
)


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    svc = NormalizationService(supabase_client=mock_supabase)
    # Reset daily counter for each test
    svc._daily_count = 0
    svc._last_reset_date = None
    return svc


def _make_event(event_id: str, raw_content: str) -> dict:
    """Helper to build a fake activity_events row."""
    return {
        "id": event_id,
        "event_type": "git_commit",
        "raw_content": raw_content,
        "normalized_at": None,
    }


class TestNormalizeBatch:
    @pytest.mark.asyncio
    async def test_processes_events_and_updates_db(self, service, mock_supabase):
        """normalize_batch extracts tuples via Anthropic, generates embeddings, and updates rows."""
        events = [
            _make_event("evt-1", "Fix login validation bug"),
            _make_event("evt-2", "Add user settings page"),
        ]

        haiku_response = json.dumps([
            {"action_verb": "fix", "target_object": "login validation", "trigger_context": "bug report"},
            {"action_verb": "add", "target_object": "user settings page", "trigger_context": "feature request"},
        ])

        mock_message = MagicMock()
        mock_message.content = [MagicMock(text=haiku_response)]

        mock_anthropic = MagicMock()
        mock_anthropic.messages.create = AsyncMock(return_value=mock_message)

        fake_embedding = [0.1] * 1536
        mock_generate_embedding = AsyncMock(return_value=fake_embedding)

        with (
            patch.object(service, "_get_anthropic_client", return_value=mock_anthropic),
            patch.object(service, "_generate_embedding", mock_generate_embedding),
        ):
            # Mock the DB update chain
            builder = MagicMock()
            builder.update.return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[{"id": "evt-1"}])
            mock_supabase.table.return_value = builder

            success, result = await service.normalize_batch(events)

        assert success is True
        assert result["normalized"] == 2
        assert result["failed"] == 0

        # Verify Anthropic was called once (batch of 2 < batch_size of 50)
        mock_anthropic.messages.create.assert_awaited_once()

        # Verify embeddings were generated for each event
        assert mock_generate_embedding.await_count == 2

        # Verify DB update was called for each event
        assert mock_supabase.table.call_count == 2

    @pytest.mark.asyncio
    async def test_respects_daily_cap(self, service, mock_supabase):
        """normalize_batch returns early when daily cap is reached."""
        service._daily_count = DAILY_CAP
        service._last_reset_date = datetime.now(UTC).strftime("%Y-%m-%d")

        events = [_make_event("evt-1", "Some commit message")]

        success, result = await service.normalize_batch(events)

        assert success is True
        assert result["normalized"] == 0
        assert result["skipped"] == "daily_cap_reached"

        # No API calls should have been made
        mock_supabase.table.assert_not_called()

    @pytest.mark.asyncio
    async def test_daily_cap_resets_on_new_day(self, service, mock_supabase):
        """Daily counter resets when the date changes."""
        service._daily_count = DAILY_CAP
        service._last_reset_date = "2020-01-01"  # A past date

        events = [_make_event("evt-1", "Fix auth bug")]

        haiku_response = json.dumps([
            {"action_verb": "fix", "target_object": "auth", "trigger_context": "bug report"},
        ])

        mock_message = MagicMock()
        mock_message.content = [MagicMock(text=haiku_response)]

        mock_anthropic = MagicMock()
        mock_anthropic.messages.create = AsyncMock(return_value=mock_message)

        fake_embedding = [0.1] * 1536

        with (
            patch.object(service, "_get_anthropic_client", return_value=mock_anthropic),
            patch.object(service, "_generate_embedding", AsyncMock(return_value=fake_embedding)),
        ):
            builder = MagicMock()
            builder.update.return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[{"id": "evt-1"}])
            mock_supabase.table.return_value = builder

            success, result = await service.normalize_batch(events)

        assert success is True
        assert result["normalized"] == 1

    @pytest.mark.asyncio
    async def test_splits_into_batches(self, service, mock_supabase):
        """normalize_batch splits large event lists into batches of batch_size."""
        # Create 5 events, use batch_size=2 so we get 3 Anthropic calls
        events = [_make_event(f"evt-{i}", f"Commit message {i}") for i in range(5)]

        def _make_haiku_response(count):
            items = [
                {"action_verb": "update", "target_object": f"item {i}", "trigger_context": "routine"}
                for i in range(count)
            ]
            return json.dumps(items)

        mock_anthropic = MagicMock()
        call_count = 0

        async def _fake_create(**kwargs):
            nonlocal call_count
            # Determine batch size from prompt (count numbered items)
            prompt = kwargs.get("messages", [{}])[0].get("content", "")
            # Count how many numbered items are in the prompt
            batch_items = prompt.count(". ") if prompt else 2
            # Use expected batch counts: 2, 2, 1
            expected_counts = [2, 2, 1]
            count = expected_counts[call_count] if call_count < len(expected_counts) else 1
            call_count += 1
            msg = MagicMock()
            msg.content = [MagicMock(text=_make_haiku_response(count))]
            return msg

        mock_anthropic.messages.create = AsyncMock(side_effect=_fake_create)

        fake_embedding = [0.1] * 1536

        with (
            patch.object(service, "_get_anthropic_client", return_value=mock_anthropic),
            patch.object(service, "_generate_embedding", AsyncMock(return_value=fake_embedding)),
        ):
            builder = MagicMock()
            builder.update.return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[{"id": "x"}])
            mock_supabase.table.return_value = builder

            success, result = await service.normalize_batch(events, batch_size=2)

        assert success is True
        assert result["normalized"] == 5
        # 3 Anthropic calls: ceil(5/2) = 3
        assert mock_anthropic.messages.create.await_count == 3

    @pytest.mark.asyncio
    async def test_handles_anthropic_failure_gracefully(self, service, mock_supabase):
        """normalize_batch counts failures when Anthropic returns an error."""
        events = [_make_event("evt-1", "Some commit")]

        mock_anthropic = MagicMock()
        mock_anthropic.messages.create = AsyncMock(side_effect=Exception("API error"))

        with patch.object(service, "_get_anthropic_client", return_value=mock_anthropic):
            success, result = await service.normalize_batch(events)

        assert success is True
        assert result["normalized"] == 0
        assert result["failed"] == 1

    @pytest.mark.asyncio
    async def test_handles_empty_events_list(self, service, mock_supabase):
        """normalize_batch returns immediately for empty input."""
        success, result = await service.normalize_batch([])

        assert success is True
        assert result["normalized"] == 0
        assert result["failed"] == 0

    @pytest.mark.asyncio
    async def test_embedding_failure_still_updates_db(self, service, mock_supabase):
        """When embedding generation fails, the event is still updated with None embedding."""
        events = [_make_event("evt-1", "Fix auth bug")]

        haiku_response = json.dumps([
            {"action_verb": "fix", "target_object": "auth", "trigger_context": "bug report"},
        ])

        mock_message = MagicMock()
        mock_message.content = [MagicMock(text=haiku_response)]

        mock_anthropic = MagicMock()
        mock_anthropic.messages.create = AsyncMock(return_value=mock_message)

        with (
            patch.object(service, "_get_anthropic_client", return_value=mock_anthropic),
            patch.object(service, "_generate_embedding", AsyncMock(return_value=None)),
        ):
            builder = MagicMock()
            builder.update.return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[{"id": "evt-1"}])
            mock_supabase.table.return_value = builder

            success, result = await service.normalize_batch(events)

        assert success is True
        assert result["normalized"] == 1

        # Verify the update was called with None embedding
        update_call = builder.update.call_args[0][0]
        assert update_call["intent_embedding"] is None
        assert update_call["action_verb"] == "fix"
        assert update_call["target_object"] == "auth"
        assert update_call["trigger_context"] == "bug report"
        assert "normalized_at" in update_call

    @pytest.mark.asyncio
    async def test_increments_daily_count(self, service, mock_supabase):
        """normalize_batch increments daily count after processing."""
        events = [
            _make_event("evt-1", "Fix bug"),
            _make_event("evt-2", "Add feature"),
        ]

        haiku_response = json.dumps([
            {"action_verb": "fix", "target_object": "bug", "trigger_context": "routine"},
            {"action_verb": "add", "target_object": "feature", "trigger_context": "feature request"},
        ])

        mock_message = MagicMock()
        mock_message.content = [MagicMock(text=haiku_response)]

        mock_anthropic = MagicMock()
        mock_anthropic.messages.create = AsyncMock(return_value=mock_message)

        with (
            patch.object(service, "_get_anthropic_client", return_value=mock_anthropic),
            patch.object(service, "_generate_embedding", AsyncMock(return_value=[0.1] * 1536)),
        ):
            builder = MagicMock()
            builder.update.return_value = builder
            builder.eq.return_value = builder
            builder.execute.return_value = MagicMock(data=[{"id": "x"}])
            mock_supabase.table.return_value = builder

            await service.normalize_batch(events)

        assert service._daily_count == 2


class TestBuildExtractionPrompt:
    def test_formats_events_as_numbered_list(self, service):
        """_build_extraction_prompt creates a numbered list of raw_content values."""
        events = [
            _make_event("evt-1", "Fix login validation bug"),
            _make_event("evt-2", "Add user settings page"),
            _make_event("evt-3", "Refactor database queries for performance"),
        ]

        prompt = service._build_extraction_prompt(events)

        assert "1. Fix login validation bug" in prompt
        assert "2. Add user settings page" in prompt
        assert "3. Refactor database queries for performance" in prompt

    def test_includes_extraction_instructions(self, service):
        """_build_extraction_prompt includes instructions for the model."""
        events = [_make_event("evt-1", "Fix something")]

        prompt = service._build_extraction_prompt(events)

        assert "action_verb" in prompt
        assert "target_object" in prompt
        assert "trigger_context" in prompt
        assert "JSON" in prompt

    def test_handles_single_event(self, service):
        """_build_extraction_prompt works with a single event."""
        events = [_make_event("evt-1", "Deploy to production")]

        prompt = service._build_extraction_prompt(events)

        assert "1. Deploy to production" in prompt


class TestGenerateEmbedding:
    @pytest.mark.asyncio
    async def test_returns_embedding_vector(self, service):
        """_generate_embedding calls OpenAI and returns a vector."""
        fake_embedding = [0.1, 0.2, 0.3] * 512  # 1536 dims

        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=fake_embedding)]

        mock_openai = MagicMock()
        mock_openai.embeddings.create = AsyncMock(return_value=mock_response)

        with patch.object(service, "_get_openai_client", return_value=mock_openai):
            result = await service._generate_embedding("fix login validation bug report")

        assert result == fake_embedding
        mock_openai.embeddings.create.assert_awaited_once()

        # Verify correct model was used
        call_kwargs = mock_openai.embeddings.create.call_args[1]
        assert call_kwargs["model"] == "text-embedding-3-small"

    @pytest.mark.asyncio
    async def test_returns_none_on_failure(self, service):
        """_generate_embedding returns None when the API call fails."""
        mock_openai = MagicMock()
        mock_openai.embeddings.create = AsyncMock(side_effect=Exception("API key invalid"))

        with patch.object(service, "_get_openai_client", return_value=mock_openai):
            result = await service._generate_embedding("some text")

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_empty_text(self, service):
        """_generate_embedding returns None for empty input."""
        result = await service._generate_embedding("")

        assert result is None
