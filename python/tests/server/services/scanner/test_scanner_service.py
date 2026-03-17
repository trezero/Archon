"""Tests for the Scanner Service."""

import json
import os
import tempfile
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.server.services.scanner.scan_template import ScanTemplate
from src.server.services.scanner.scanner_service import ScannerService


def _make_chain_mock(data=None):
    """Create a chainable mock that returns itself for all query methods."""
    mock = MagicMock()
    for method in (
        "insert", "select", "update", "delete", "upsert",
        "eq", "neq", "lt", "in_", "is_", "limit", "order",
    ):
        getattr(mock, method).return_value = mock
    # not_ is special — it's a property-like namespace
    mock.not_ = MagicMock()
    mock.not_.is_.return_value = mock
    mock.execute.return_value = MagicMock(data=data if data is not None else [], count=0)
    return mock


@pytest.fixture
def mock_supabase():
    """Create a mock Supabase client with per-table chain mocks."""
    client = MagicMock()
    _tables: dict[str, MagicMock] = {}

    def _table(name):
        if name not in _tables:
            _tables[name] = _make_chain_mock()
        return _tables[name]

    client.table = MagicMock(side_effect=_table)
    client._tables = _tables  # expose for test setup
    return client


@pytest.fixture
def scanner_service(mock_supabase):
    return ScannerService(supabase_client=mock_supabase)


class TestScannerServiceDisabledCheck:
    @patch("src.server.services.scanner.scanner_service.SCANNER_ENABLED", False)
    @pytest.mark.asyncio
    async def test_scan_disabled(self, scanner_service):
        success, result = await scanner_service.scan_directory("/projects", "~/projects", "sys-id")
        assert success is False
        assert "not enabled" in result["error"]

    @patch("src.server.services.scanner.scanner_service.SCANNER_ENABLED", False)
    @pytest.mark.asyncio
    async def test_apply_disabled(self, scanner_service):
        success, result = await scanner_service.apply_scan(
            "scan-id", ScanTemplate(), None, None, "fp", "name", "progress-id"
        )
        assert success is False
        assert "not enabled" in result["error"]


class TestScanDirectory:
    @patch("src.server.services.scanner.scanner_service.SCANNER_ENABLED", True)
    @pytest.mark.asyncio
    async def test_scan_creates_records(self, scanner_service, mock_supabase):
        """Test that scan creates scan_results and scan_projects records."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a simple repo
            repo_path = os.path.join(tmpdir, "test-repo")
            os.makedirs(os.path.join(repo_path, ".git"))
            with open(os.path.join(repo_path, ".git", "HEAD"), "w") as f:
                f.write("ref: refs/heads/main\n")
            import configparser
            config = configparser.ConfigParser()
            config.add_section('remote "origin"')
            config.set('remote "origin"', "url", "https://github.com/user/test-repo.git")
            with open(os.path.join(repo_path, ".git", "config"), "w") as f:
                config.write(f)

            # Set up table mocks
            scan_results_mock = _make_chain_mock(data=[{"id": "scan-123"}])
            scan_projects_mock = _make_chain_mock(data=[{
                "id": "sp-1",
                "directory_name": "test-repo",
                "host_path": "~/projects/test-repo",
                "github_url": "https://github.com/user/test-repo",
                "detected_languages": [],
                "project_indicators": [],
                "dependencies": {},
                "infra_markers": [],
                "has_readme": False,
                "readme_excerpt": None,
                "is_project_group": False,
                "group_name": None,
                "already_in_archon": False,
                "existing_project_id": None,
            }])
            mock_supabase._tables["archon_scan_results"] = scan_results_mock
            mock_supabase._tables["archon_scan_projects"] = scan_projects_mock

            with patch.object(scanner_service, "_get_existing_project_urls", return_value={}):
                with patch(
                    "src.server.services.scanner.scanner_service.SCANNER_PROJECTS_ROOT",
                    tmpdir,
                ):
                    success, result = await scanner_service.scan_directory(
                        tmpdir, "~/projects", "sys-id"
                    )

            assert success is True
            assert result["scan_id"] == "scan-123"


class TestEstimateApplyTime:
    @pytest.mark.asyncio
    async def test_estimate_basic(self, scanner_service):
        template = ScanTemplate(crawl_github_readme=True)
        result = await scanner_service.estimate_apply_time("scan-id", template, selected_count=10)

        assert "estimated_minutes" in result
        assert "project_creation_seconds" in result
        assert "crawl_minutes" in result
        assert result["project_creation_seconds"] == 20  # 10 * 2s

    @pytest.mark.asyncio
    async def test_estimate_no_crawl(self, scanner_service):
        template = ScanTemplate(crawl_github_readme=False)
        result = await scanner_service.estimate_apply_time("scan-id", template, selected_count=10)

        assert result["crawl_minutes"] == 0

    @pytest.mark.asyncio
    async def test_estimate_large_warns(self, scanner_service):
        template = ScanTemplate(crawl_github_readme=True)
        result = await scanner_service.estimate_apply_time("scan-id", template, selected_count=50)

        assert result["warning"] is not None
        assert "50 crawls" in result["warning"]


class TestTemplateCRUD:
    def test_list_templates_empty(self, scanner_service, mock_supabase):
        mock_supabase.table.return_value.execute.return_value = MagicMock(data=[])
        success, result = scanner_service.list_templates()
        assert success is True
        assert result["templates"] == []

    def test_save_template(self, scanner_service, mock_supabase):
        template_data = {"id": "t-1", "name": "Default", "template": {}}
        mock_supabase._tables["archon_scanner_templates"] = _make_chain_mock(data=[template_data])

        success, result = scanner_service.save_template(
            name="Default",
            template=ScanTemplate(),
            description="A default template",
        )
        assert success is True
        assert result["template"]["name"] == "Default"

    def test_delete_template(self, scanner_service, mock_supabase):
        mock_supabase.table.return_value.execute.return_value = MagicMock(data=[])
        success, result = scanner_service.delete_template("t-1")
        assert success is True
        assert result["deleted"] == "t-1"


class TestConfigFileGeneration:
    @pytest.mark.asyncio
    async def test_write_config_files(self, scanner_service):
        with tempfile.TemporaryDirectory() as tmpdir:
            template = ScanTemplate(
                archon_api_url="http://localhost:8181",
                archon_mcp_url="http://localhost:8051",
            )

            with patch.object(scanner_service, "_get_system_id", return_value="sys-123"):
                await scanner_service._write_project_config_files(
                    project_path=tmpdir,
                    project_id="proj-123",
                    system_fingerprint="fp-abc",
                    system_name="TEST_PC",
                    system_id="sys-123",
                    template=template,
                    extensions_hash="hash-xyz",
                )

            # Check archon-config.json
            config_path = os.path.join(tmpdir, ".claude", "archon-config.json")
            assert os.path.isfile(config_path)
            with open(config_path) as f:
                config = json.load(f)
            assert config["project_id"] == "proj-123"
            assert config["archon_api_url"] == "http://localhost:8181"
            assert config["installed_by"] == "scanner"
            assert config["extensions_hash"] == "hash-xyz"

            # Check archon-state.json
            state_path = os.path.join(tmpdir, ".claude", "archon-state.json")
            assert os.path.isfile(state_path)
            with open(state_path) as f:
                state = json.load(f)
            assert state["system_fingerprint"] == "fp-abc"
            assert state["system_name"] == "TEST_PC"
            assert state["archon_project_id"] == "proj-123"

    @pytest.mark.asyncio
    async def test_write_settings_local(self, scanner_service):
        with tempfile.TemporaryDirectory() as tmpdir:
            await scanner_service._write_settings_local(tmpdir)

            settings_path = os.path.join(tmpdir, ".claude", "settings.local.json")
            assert os.path.isfile(settings_path)
            with open(settings_path) as f:
                settings = json.load(f)
            assert "hooks" in settings
            assert "PostToolUse" in settings["hooks"]


class TestGitignoreUpdate:
    @pytest.mark.asyncio
    async def test_creates_new_gitignore(self, scanner_service):
        with tempfile.TemporaryDirectory() as tmpdir:
            await scanner_service._update_gitignore(tmpdir)

            gitignore_path = os.path.join(tmpdir, ".gitignore")
            assert os.path.isfile(gitignore_path)
            with open(gitignore_path) as f:
                content = f.read()
            assert "# Archon" in content
            assert ".claude/plugins/" in content

    @pytest.mark.asyncio
    async def test_appends_to_existing_gitignore(self, scanner_service):
        with tempfile.TemporaryDirectory() as tmpdir:
            gitignore_path = os.path.join(tmpdir, ".gitignore")
            with open(gitignore_path, "w") as f:
                f.write("node_modules/\n")

            await scanner_service._update_gitignore(tmpdir)

            with open(gitignore_path) as f:
                content = f.read()
            assert "node_modules/" in content
            assert "# Archon" in content

    @pytest.mark.asyncio
    async def test_no_duplicate_entries(self, scanner_service):
        with tempfile.TemporaryDirectory() as tmpdir:
            gitignore_path = os.path.join(tmpdir, ".gitignore")
            with open(gitignore_path, "w") as f:
                f.write("# Archon\n.claude/plugins/\n")

            await scanner_service._update_gitignore(tmpdir)

            with open(gitignore_path) as f:
                content = f.read()
            # Count occurrences — should not have duplicates
            assert content.count(".claude/plugins/") == 1


class TestDuplicatePrevention:
    def test_get_existing_urls(self, scanner_service, mock_supabase):
        mock_supabase._tables["archon_projects"] = _make_chain_mock(data=[
            {"id": "p-1", "github_repo": "https://github.com/user/repo1.git"},
            {"id": "p-2", "github_repo": "git@github.com:user/repo2.git"},
        ])

        urls = scanner_service._get_existing_project_urls()
        assert "https://github.com/user/repo1" in urls
        assert "https://github.com/user/repo2" in urls
        assert urls["https://github.com/user/repo1"] == "p-1"

    def test_find_project_by_url(self, scanner_service, mock_supabase):
        mock_supabase._tables["archon_projects"] = _make_chain_mock(
            data=[{"id": "p-1", "github_repo": "https://github.com/user/my-repo"}]
        )

        result = scanner_service._find_project_by_github_url("https://github.com/user/my-repo")
        assert result == "p-1"

    def test_find_project_not_found(self, scanner_service, mock_supabase):
        mock_supabase._tables["archon_projects"] = _make_chain_mock(data=[])
        result = scanner_service._find_project_by_github_url("https://github.com/user/nonexistent")
        assert result is None
