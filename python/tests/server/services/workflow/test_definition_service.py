"""Tests for DefinitionService."""

from unittest.mock import MagicMock

import pytest

from src.server.services.workflow.definition_service import DefinitionService


SAMPLE_YAML = """name: test-workflow
description: A test workflow
provider: claude
model: sonnet

nodes:
  - id: step-one
    command: create-branch
    context: fresh

  - id: step-two
    command: planning
    depends_on: [step-one]
"""


@pytest.fixture
def mock_supabase():
    return MagicMock()


@pytest.fixture
def service(mock_supabase):
    return DefinitionService(supabase_client=mock_supabase)


class TestCreateDefinition:
    def test_create_stores_yaml_and_parsed(self, service, mock_supabase):
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "def_1", "name": "test-workflow", "version": 1}
        ]
        success, result = service.create_definition(
            name="test-workflow",
            yaml_content=SAMPLE_YAML,
            description="A test workflow",
        )
        assert success is True
        insert_data = mock_supabase.table.return_value.insert.call_args[0][0]
        assert insert_data["name"] == "test-workflow"
        assert insert_data["yaml_content"] == SAMPLE_YAML
        assert "nodes" in insert_data["parsed_definition"]

    def test_create_rejects_invalid_yaml(self, service):
        success, result = service.create_definition(
            name="bad",
            yaml_content="not: valid: yaml: {{{{",
        )
        assert success is False
        assert "error" in result


class TestValidateYaml:
    def test_valid_yaml_with_nodes(self, service):
        success, result = service.validate_yaml(SAMPLE_YAML)
        assert success is True
        assert len(result["node_ids"]) == 2
        assert "step-one" in result["node_ids"]

    def test_missing_nodes_key(self, service):
        success, result = service.validate_yaml("name: test\ndescription: no nodes")
        assert success is False
        assert "nodes" in result["error"].lower()

    def test_duplicate_node_ids(self, service):
        yaml = "name: test\nnodes:\n  - id: dupe\n    command: a\n  - id: dupe\n    command: b"
        success, result = service.validate_yaml(yaml)
        assert success is False
        assert "duplicate" in result["error"].lower()

    def test_missing_node_id(self, service):
        yaml = "name: test\nnodes:\n  - command: a"
        success, result = service.validate_yaml(yaml)
        assert success is False


class TestListDefinitions:
    def test_list_returns_latest(self, service, mock_supabase):
        mock_supabase.table.return_value.select.return_value.eq.return_value.is_.return_value.order.return_value.execute.return_value.data = [
            {"id": "def_1", "name": "wf-1", "version": 1},
        ]
        success, result = service.list_definitions()
        assert success is True
        assert len(result["definitions"]) == 1
