"""Integration test: end-to-end scan → apply with mock filesystem."""

import configparser
import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

from src.server.services.scanner.git_detector import GitDetector
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
    mock.not_ = MagicMock()
    mock.not_.is_.return_value = mock
    mock.execute.return_value = MagicMock(data=data if data is not None else [], count=0)
    return mock


def _create_project_dir(base_path: str, name: str, remote_url: str | None = None,
                         readme: str | None = None, files: dict | None = None):
    """Create a realistic project directory with .git and optional files."""
    path = os.path.join(base_path, name)
    os.makedirs(path, exist_ok=True)

    # .git/
    git_dir = os.path.join(path, ".git")
    os.makedirs(git_dir, exist_ok=True)
    with open(os.path.join(git_dir, "HEAD"), "w") as f:
        f.write("ref: refs/heads/main\n")

    config = configparser.ConfigParser()
    if remote_url:
        config.add_section('remote "origin"')
        config.set('remote "origin"', "url", remote_url)
    with open(os.path.join(git_dir, "config"), "w") as f:
        config.write(f)

    if readme:
        with open(os.path.join(path, "README.md"), "w") as f:
            f.write(readme)

    if files:
        for fname, content in files.items():
            fpath = os.path.join(path, fname)
            os.makedirs(os.path.dirname(fpath), exist_ok=True) if "/" in fname else None
            with open(fpath, "w") as f:
                f.write(content if isinstance(content, str) else json.dumps(content))

    return path


class TestEndToEndScanAndApply:
    """Integration test simulating a full scan → apply workflow."""

    @pytest.mark.asyncio
    async def test_scan_discovers_projects_and_groups(self):
        """Test that scanning discovers standalone repos and project groups."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create standalone projects
            _create_project_dir(
                tmpdir, "standalone-app",
                remote_url="https://github.com/user/standalone-app.git",
                readme="# Standalone App\nA standalone application.",
                files={
                    "package.json": json.dumps({
                        "dependencies": {"react": "^18.0.0", "next": "^14.0.0"}
                    }),
                    "Dockerfile": "FROM node:18\n",
                },
            )

            _create_project_dir(
                tmpdir, "python-tool",
                remote_url="git@github.com:user/python-tool.git",
                readme="# Python Tool\nA CLI tool.",
                files={
                    "requirements.txt": "click>=8.0\nrich\n",
                    "main.py": "print('hello')\n",
                },
            )

            # Create a project group
            group_dir = os.path.join(tmpdir, "MyApps")
            os.makedirs(group_dir)

            _create_project_dir(
                group_dir, "app-frontend",
                remote_url="https://github.com/user/app-frontend.git",
                readme="# App Frontend",
                files={"package.json": json.dumps({"dependencies": {"vue": "^3.0"}})},
            )

            _create_project_dir(
                group_dir, "app-backend",
                remote_url="https://github.com/user/app-backend.git",
                readme="# App Backend",
                files={"requirements.txt": "fastapi\nuvicorn\n", "Makefile": "run:\n"},
            )

            # Non-git directory (should be skipped)
            os.makedirs(os.path.join(tmpdir, "random-folder"))

            # Scan
            detector = GitDetector(projects_root=tmpdir, host_root="~/projects")
            summary = detector.scan()

            # Verify scan results
            assert summary.total_found == 4
            assert len(summary.project_groups) == 1
            assert "MyApps" in summary.project_groups

            # Check standalone projects
            standalone = next(p for p in summary.projects if p.directory_name == "standalone-app")
            assert standalone.github_url == "https://github.com/user/standalone-app"
            assert standalone.has_readme is True
            assert "node" in standalone.project_indicators
            assert "docker" in standalone.infra_markers
            assert standalone.dependencies is not None
            assert "react" in standalone.dependencies.get("npm", [])
            assert standalone.group_name is None

            # Check python project
            py_tool = next(p for p in summary.projects if p.directory_name == "python-tool")
            assert py_tool.github_url == "https://github.com/user/python-tool"
            assert "python" in py_tool.detected_languages
            assert py_tool.dependencies is not None
            assert "click" in py_tool.dependencies.get("pip", [])

            # Check group projects
            frontend = next(p for p in summary.projects if p.directory_name == "app-frontend")
            assert frontend.group_name == "MyApps"
            assert frontend.github_url == "https://github.com/user/app-frontend"

            backend = next(p for p in summary.projects if p.directory_name == "app-backend")
            assert backend.group_name == "MyApps"
            assert "make" in backend.infra_markers

    @pytest.mark.asyncio
    async def test_config_files_written_correctly(self):
        """Test that apply writes correct config files to each project."""
        with tempfile.TemporaryDirectory() as tmpdir:
            project_path = _create_project_dir(
                tmpdir, "my-project",
                remote_url="https://github.com/user/my-project.git",
                readme="# My Project",
            )

            # Create service with mocks
            mock_supabase = MagicMock()
            tables: dict[str, MagicMock] = {}

            def _table(name):
                if name not in tables:
                    tables[name] = _make_chain_mock()
                return tables[name]

            mock_supabase.table = MagicMock(side_effect=_table)

            service = ScannerService(supabase_client=mock_supabase)
            template = ScanTemplate(
                archon_api_url="http://myhost:9999",
                archon_mcp_url="http://myhost:9051",
                install_extensions=False,  # Skip tarball download
                crawl_github_readme=False,
            )

            # Write config files
            await service._write_project_config_files(
                project_path=project_path,
                project_id="proj-abc-123",
                system_fingerprint="fp-test-xyz",
                system_name="TEST_MACHINE",
                system_id="sys-001",
                template=template,
                extensions_hash="hash-abc",
            )

            # Write settings
            await service._write_settings_local(project_path)

            # Update gitignore
            await service._update_gitignore(project_path)

            # Verify archon-config.json
            config_path = os.path.join(project_path, ".claude", "archon-config.json")
            with open(config_path) as f:
                config = json.load(f)
            assert config["archon_api_url"] == "http://myhost:9999"
            assert config["archon_mcp_url"] == "http://myhost:9051"
            assert config["project_id"] == "proj-abc-123"
            assert config["installed_by"] == "scanner"
            assert config["extensions_hash"] == "hash-abc"

            # Verify archon-state.json
            state_path = os.path.join(project_path, ".claude", "archon-state.json")
            with open(state_path) as f:
                state = json.load(f)
            assert state["system_fingerprint"] == "fp-test-xyz"
            assert state["system_name"] == "TEST_MACHINE"
            assert state["archon_project_id"] == "proj-abc-123"

            # Verify settings.local.json
            settings_path = os.path.join(project_path, ".claude", "settings.local.json")
            with open(settings_path) as f:
                settings = json.load(f)
            assert "PostToolUse" in settings["hooks"]

            # Verify .gitignore
            gitignore_path = os.path.join(project_path, ".gitignore")
            with open(gitignore_path) as f:
                gitignore = f.read()
            assert "# Archon" in gitignore
            assert ".claude/plugins/" in gitignore
            assert ".claude/archon-config.json" in gitignore

    @pytest.mark.asyncio
    async def test_duplicate_detection(self):
        """Test that existing projects are detected as duplicates."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _create_project_dir(
                tmpdir, "existing-app",
                remote_url="https://github.com/user/existing-app.git",
            )
            _create_project_dir(
                tmpdir, "new-app",
                remote_url="https://github.com/user/new-app.git",
            )

            detector = GitDetector(projects_root=tmpdir, host_root="~/projects")
            summary = detector.scan()
            assert summary.total_found == 2

            # Simulate cross-reference with existing projects
            existing_urls = {"https://github.com/user/existing-app": "existing-id-123"}

            new_count = 0
            existing_count = 0
            for p in summary.projects:
                if p.github_url and p.github_url in existing_urls:
                    existing_count += 1
                else:
                    new_count += 1

            assert existing_count == 1
            assert new_count == 1

    @pytest.mark.asyncio
    async def test_non_github_repos_detected_but_flagged(self):
        """Test that non-GitHub repos are detected but have no github_url."""
        with tempfile.TemporaryDirectory() as tmpdir:
            _create_project_dir(
                tmpdir, "gitlab-app",
                remote_url="https://gitlab.com/user/gitlab-app.git",
            )
            _create_project_dir(
                tmpdir, "github-app",
                remote_url="https://github.com/user/github-app.git",
            )

            detector = GitDetector(projects_root=tmpdir, host_root="~/projects")
            summary = detector.scan()

            gitlab = next(p for p in summary.projects if p.directory_name == "gitlab-app")
            github = next(p for p in summary.projects if p.directory_name == "github-app")

            assert gitlab.git_remote_url == "https://gitlab.com/user/gitlab-app.git"
            assert gitlab.github_url is None  # Non-GitHub

            assert github.git_remote_url == "https://github.com/user/github-app.git"
            assert github.github_url == "https://github.com/user/github-app"

    @pytest.mark.asyncio
    async def test_template_defaults(self):
        """Test that default template has sensible defaults."""
        template = ScanTemplate()

        assert template.archon_api_url == "http://localhost:8181"
        assert template.archon_mcp_url == "http://localhost:8051"
        assert template.skip_existing is True
        assert template.create_group_parents is True
        assert template.require_github_remote is True
        assert template.crawl_github_readme is True
        assert template.install_extensions is True
        assert template.write_config_files is True
        assert template.update_gitignore is True

    @pytest.mark.asyncio
    async def test_template_serialization(self):
        """Test that template can be serialized/deserialized."""
        template = ScanTemplate(
            archon_api_url="http://custom:9999",
            require_github_remote=False,
            exclude_patterns=["test-*"],
        )

        data = template.model_dump()
        restored = ScanTemplate(**data)

        assert restored.archon_api_url == "http://custom:9999"
        assert restored.require_github_remote is False
        assert restored.exclude_patterns == ["test-*"]
