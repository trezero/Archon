"""
Unit tests for ChatMessageService.
"""

import uuid
from datetime import datetime
from unittest.mock import MagicMock, call

import pytest

from src.server.services.chat.chat_message_service import ChatMessageService


@pytest.fixture
def mock_supabase():
    """Mock Supabase client."""
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    """ChatMessageService with mocked Supabase client."""
    return ChatMessageService(supabase_client=mock_supabase)


def _make_message(message_id=None, conversation_id=None, role="user", content="Hello"):
    """Helper to build a message dict."""
    return {
        "id": message_id or str(uuid.uuid4()),
        "conversation_id": conversation_id or str(uuid.uuid4()),
        "role": role,
        "content": content,
        "tool_calls": None,
        "tool_results": None,
        "model_used": None,
        "token_count": None,
        "created_at": datetime.now().isoformat(),
    }


class TestSaveMessage:
    def test_saves_basic_message_and_updates_conversation(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        msg = _make_message(conversation_id=conv_id, role="user", content="Hi")
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [msg]
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{}]

        success, result = service.save_message(conv_id, "user", "Hi")

        assert success is True
        assert "message" in result
        assert result["message"]["role"] == "user"
        assert result["message"]["content"] == "Hi"

        # Verify conversation updated_at was refreshed
        update_calls = mock_supabase.table.return_value.update.call_args_list
        assert len(update_calls) >= 1

    def test_includes_optional_fields_when_provided(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        tool_calls = [{"name": "search", "args": {}}]
        tool_results = [{"result": "found"}]
        msg = _make_message(conversation_id=conv_id, role="assistant")
        msg["tool_calls"] = tool_calls
        msg["tool_results"] = tool_results
        msg["model_used"] = "claude-3-5-sonnet"
        msg["token_count"] = 150

        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [msg]
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{}]

        success, result = service.save_message(
            conv_id,
            "assistant",
            "Here is what I found",
            tool_calls=tool_calls,
            tool_results=tool_results,
            model_used="claude-3-5-sonnet",
            token_count=150,
        )

        assert success is True
        insert_data = mock_supabase.table.return_value.insert.call_args[0][0]
        assert insert_data["tool_calls"] == tool_calls
        assert insert_data["tool_results"] == tool_results
        assert insert_data["model_used"] == "claude-3-5-sonnet"
        assert insert_data["token_count"] == 150

    def test_does_not_include_none_optional_fields(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        msg = _make_message(conversation_id=conv_id)
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [msg]
        mock_supabase.table.return_value.update.return_value.eq.return_value.execute.return_value.data = [{}]

        service.save_message(conv_id, "user", "Test")

        insert_data = mock_supabase.table.return_value.insert.call_args[0][0]
        assert "tool_calls" not in insert_data
        assert "tool_results" not in insert_data
        assert "model_used" not in insert_data
        assert "token_count" not in insert_data

    def test_returns_error_when_database_returns_no_data(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = []

        success, result = service.save_message("conv-id", "user", "Hello")

        assert success is False
        assert "error" in result

    def test_returns_error_on_exception(self, service, mock_supabase):
        mock_supabase.table.side_effect = Exception("DB connection failed")

        success, result = service.save_message("conv-id", "user", "Hello")

        assert success is False
        assert "error" in result

    def test_continues_when_conversation_update_fails(self, service, mock_supabase):
        """Message save succeeds even if conversation updated_at update fails."""
        conv_id = str(uuid.uuid4())
        msg = _make_message(conversation_id=conv_id)

        insert_mock = MagicMock()
        insert_mock.execute.return_value.data = [msg]

        update_mock = MagicMock()
        update_mock.eq.return_value.execute.side_effect = Exception("Update failed")

        def table_side_effect(table_name):
            t = MagicMock()
            if table_name == "chat_messages":
                t.insert.return_value = insert_mock
            else:
                t.update.return_value = update_mock
            return t

        mock_supabase.table.side_effect = table_side_effect

        success, result = service.save_message(conv_id, "user", "Hello")

        assert success is True
        assert "message" in result


class TestGetMessages:
    def test_returns_messages_ordered_by_created_at_asc(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        msgs = [
            _make_message(conversation_id=conv_id, content="First"),
            _make_message(conversation_id=conv_id, content="Second"),
        ]
        (
            mock_supabase.table.return_value
            .select.return_value
            .eq.return_value
            .order.return_value
            .range.return_value
            .execute.return_value.data
        ) = msgs

        success, result = service.get_messages(conv_id)

        assert success is True
        assert len(result["messages"]) == 2
        assert result["total_count"] == 2

        # Verify ordering was ascending
        order_call = mock_supabase.table.return_value.select.return_value.eq.return_value.order
        order_call.assert_called_once_with("created_at", desc=False)

    def test_applies_limit_and_offset(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        (
            mock_supabase.table.return_value
            .select.return_value
            .eq.return_value
            .order.return_value
            .range.return_value
            .execute.return_value.data
        ) = []

        service.get_messages(conv_id, limit=10, offset=20)

        range_call = (
            mock_supabase.table.return_value
            .select.return_value
            .eq.return_value
            .order.return_value
            .range
        )
        range_call.assert_called_once_with(20, 29)  # offset=20, offset+limit-1=29

    def test_returns_error_on_exception(self, service, mock_supabase):
        mock_supabase.table.side_effect = Exception("timeout")

        success, result = service.get_messages("conv-id")

        assert success is False
        assert "error" in result


class TestSearchMessages:
    def test_calls_rpc_and_returns_results(self, service, mock_supabase):
        results = [
            {
                "id": str(uuid.uuid4()),
                "conversation_id": str(uuid.uuid4()),
                "role": "user",
                "content": "How do I deploy?",
                "created_at": datetime.now().isoformat(),
                "conversation_title": "Deployment Chat",
            }
        ]
        mock_supabase.rpc.return_value.execute.return_value.data = results

        success, result = service.search_messages("deploy")

        assert success is True
        assert len(result["results"]) == 1
        assert result["total_count"] == 1
        mock_supabase.rpc.assert_called_once_with(
            "search_chat_messages", {"search_query": "deploy"}
        )

    def test_returns_empty_results_when_no_matches(self, service, mock_supabase):
        mock_supabase.rpc.return_value.execute.return_value.data = []

        success, result = service.search_messages("nonexistent query")

        assert success is True
        assert result["results"] == []
        assert result["total_count"] == 0

    def test_returns_error_on_exception(self, service, mock_supabase):
        mock_supabase.rpc.side_effect = Exception("RPC failed")

        success, result = service.search_messages("query")

        assert success is False
        assert "error" in result
