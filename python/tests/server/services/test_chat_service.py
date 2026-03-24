"""
Unit tests for ChatService.
"""

import uuid
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from src.server.services.chat.chat_service import ChatService


@pytest.fixture
def mock_supabase():
    """Mock Supabase client."""
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    """ChatService with mocked Supabase client."""
    return ChatService(supabase_client=mock_supabase)


def _make_conversation(conversation_id=None, **kwargs):
    """Helper to build a conversation dict."""
    return {
        "id": conversation_id or str(uuid.uuid4()),
        "title": kwargs.get("title"),
        "project_id": kwargs.get("project_id"),
        "conversation_type": kwargs.get("conversation_type", "global"),
        "model_config": kwargs.get("model_config", {}),
        "action_mode": False,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
        "deleted_at": None,
        "metadata": {},
    }


class TestCreateConversation:
    def test_creates_global_conversation_without_project(self, service, mock_supabase):
        conv = _make_conversation(conversation_type="global")
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [conv]

        success, result = service.create_conversation(title="Test Chat")

        assert success is True
        assert "conversation" in result
        assert result["conversation"]["conversation_type"] == "global"

    def test_creates_project_conversation_when_project_id_given(self, service, mock_supabase):
        project_id = str(uuid.uuid4())
        conv = _make_conversation(project_id=project_id, conversation_type="project")
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [conv]

        success, result = service.create_conversation(project_id=project_id)

        assert success is True
        assert result["conversation"]["conversation_type"] == "project"
        # Verify project_id was passed in the insert data
        insert_call_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert insert_call_args["project_id"] == project_id
        assert insert_call_args["conversation_type"] == "project"

    def test_passes_model_config_when_provided(self, service, mock_supabase):
        model_cfg = {"model": "claude-3-5-sonnet", "temperature": 0.7}
        conv = _make_conversation(model_config=model_cfg)
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [conv]

        success, result = service.create_conversation(model_config=model_cfg)

        assert success is True
        insert_call_args = mock_supabase.table.return_value.insert.call_args[0][0]
        assert insert_call_args["model_config"] == model_cfg

    def test_returns_error_when_database_returns_no_data(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = []

        success, result = service.create_conversation(title="Test")

        assert success is False
        assert "error" in result

    def test_returns_error_on_exception(self, service, mock_supabase):
        mock_supabase.table.side_effect = Exception("DB connection failed")

        success, result = service.create_conversation(title="Test")

        assert success is False
        assert "error" in result


class TestListConversations:
    def test_lists_all_non_deleted_conversations(self, service, mock_supabase):
        convs = [_make_conversation(), _make_conversation()]
        (
            mock_supabase.table.return_value
            .select.return_value
            .is_.return_value
            .order.return_value
            .execute.return_value.data
        ) = convs

        success, result = service.list_conversations()

        assert success is True
        assert len(result["conversations"]) == 2
        assert result["total_count"] == 2

    def test_filters_by_project_id(self, service, mock_supabase):
        project_id = str(uuid.uuid4())
        convs = [_make_conversation(project_id=project_id)]
        chain = (
            mock_supabase.table.return_value
            .select.return_value
            .is_.return_value
            .order.return_value
        )
        chain.eq.return_value.execute.return_value.data = convs

        success, result = service.list_conversations(project_id=project_id)

        assert success is True
        chain.eq.assert_called_once_with("project_id", project_id)

    def test_filters_by_conversation_type(self, service, mock_supabase):
        convs = [_make_conversation(conversation_type="global")]
        chain = (
            mock_supabase.table.return_value
            .select.return_value
            .is_.return_value
            .order.return_value
        )
        chain.eq.return_value.execute.return_value.data = convs

        success, result = service.list_conversations(conversation_type="global")

        assert success is True
        chain.eq.assert_called_once_with("conversation_type", "global")

    def test_returns_error_on_exception(self, service, mock_supabase):
        mock_supabase.table.side_effect = Exception("timeout")

        success, result = service.list_conversations()

        assert success is False
        assert "error" in result


class TestGetConversation:
    def test_returns_conversation_when_found(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        conv = _make_conversation(conversation_id=conv_id)
        (
            mock_supabase.table.return_value
            .select.return_value
            .eq.return_value
            .is_.return_value
            .execute.return_value.data
        ) = [conv]

        success, result = service.get_conversation(conv_id)

        assert success is True
        assert result["conversation"]["id"] == conv_id

    def test_returns_error_when_not_found(self, service, mock_supabase):
        (
            mock_supabase.table.return_value
            .select.return_value
            .eq.return_value
            .is_.return_value
            .execute.return_value.data
        ) = []

        success, result = service.get_conversation("nonexistent-id")

        assert success is False
        assert "error" in result

    def test_returns_error_on_exception(self, service, mock_supabase):
        mock_supabase.table.side_effect = Exception("DB error")

        success, result = service.get_conversation("some-id")

        assert success is False
        assert "error" in result


class TestUpdateConversation:
    def test_updates_conversation_and_refreshes_updated_at(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        updated_conv = _make_conversation(conversation_id=conv_id, title="New Title")
        (
            mock_supabase.table.return_value
            .update.return_value
            .eq.return_value
            .execute.return_value.data
        ) = [updated_conv]

        success, result = service.update_conversation(conv_id, title="New Title")

        assert success is True
        assert "conversation" in result
        # Verify updated_at was included
        update_call_args = mock_supabase.table.return_value.update.call_args[0][0]
        assert "updated_at" in update_call_args
        assert update_call_args["title"] == "New Title"

    def test_returns_error_when_not_found(self, service, mock_supabase):
        (
            mock_supabase.table.return_value
            .update.return_value
            .eq.return_value
            .execute.return_value.data
        ) = []

        success, result = service.update_conversation("nonexistent-id", title="X")

        assert success is False
        assert "error" in result


class TestListCategories:
    def test_returns_distinct_categories(self, service, mock_supabase):
        rows = [
            {"project_category": "Backend"},
            {"project_category": "Frontend"},
            {"project_category": "Backend"},  # duplicate
        ]
        (
            mock_supabase.table.return_value
            .select.return_value
            .not_.is_.return_value
            .execute.return_value.data
        ) = rows

        success, result = service.list_categories()

        assert success is True
        assert set(result["categories"]) == {"Backend", "Frontend"}
        assert len(result["categories"]) == 2

    def test_returns_empty_list_when_no_categories(self, service, mock_supabase):
        (
            mock_supabase.table.return_value
            .select.return_value
            .not_.is_.return_value
            .execute.return_value.data
        ) = []

        success, result = service.list_categories()

        assert success is True
        assert result["categories"] == []


class TestDeleteConversation:
    def test_soft_deletes_conversation(self, service, mock_supabase):
        conv_id = str(uuid.uuid4())
        deleted_conv = _make_conversation(conversation_id=conv_id)
        deleted_conv["deleted_at"] = datetime.now().isoformat()
        (
            mock_supabase.table.return_value
            .update.return_value
            .eq.return_value
            .execute.return_value.data
        ) = [deleted_conv]

        success, result = service.delete_conversation(conv_id)

        assert success is True
        assert result["conversation_id"] == conv_id
        # Verify deleted_at was set
        update_call_args = mock_supabase.table.return_value.update.call_args[0][0]
        assert "deleted_at" in update_call_args

    def test_returns_error_when_not_found(self, service, mock_supabase):
        (
            mock_supabase.table.return_value
            .update.return_value
            .eq.return_value
            .execute.return_value.data
        ) = []

        success, result = service.delete_conversation("nonexistent-id")

        assert success is False
        assert "error" in result
