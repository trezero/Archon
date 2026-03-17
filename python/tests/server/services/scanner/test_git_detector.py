"""Tests for the Git detector module."""

import json
import os
import tempfile

import pytest

from src.server.services.scanner.git_detector import (
    INFRA_MARKERS,
    SKIP_DIRS,
    DetectedProject,
    GitDetector,
    ScanSummary,
)


@pytest.fixture
def temp_projects():
    """Create a temporary projects directory structure for testing."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


def _create_git_repo(path: str, remote_url: str | None = None, readme: str | None = None):
    """Create a minimal .git directory structure."""
    git_dir = os.path.join(path, ".git")
    os.makedirs(git_dir, exist_ok=True)

    # Write HEAD
    with open(os.path.join(git_dir, "HEAD"), "w") as f:
        f.write("ref: refs/heads/main\n")

    # Write config with optional remote
    config = configparser.ConfigParser()
    if remote_url:
        config.add_section('remote "origin"')
        config.set('remote "origin"', "url", remote_url)

    with open(os.path.join(git_dir, "config"), "w") as f:
        config.write(f)

    # Write README if provided
    if readme is not None:
        with open(os.path.join(path, "README.md"), "w") as f:
            f.write(readme)


import configparser


class TestGitDetectorScan:
    def test_detect_single_repo(self, temp_projects):
        repo_path = os.path.join(temp_projects, "my-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path, "https://github.com/user/my-app.git", "# My App\nHello")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 1
        assert len(summary.projects) == 1
        assert summary.projects[0].directory_name == "my-app"
        assert summary.projects[0].github_url == "https://github.com/user/my-app"
        assert summary.projects[0].has_readme is True
        assert summary.projects[0].readme_content == "# My App\nHello"
        assert summary.projects[0].default_branch == "main"

    def test_detect_multiple_repos(self, temp_projects):
        for name in ["app-a", "app-b", "app-c"]:
            path = os.path.join(temp_projects, name)
            os.makedirs(path)
            _create_git_repo(path, f"https://github.com/user/{name}.git")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 3
        names = [p.directory_name for p in summary.projects]
        assert sorted(names) == ["app-a", "app-b", "app-c"]

    def test_skip_non_git_dirs(self, temp_projects):
        # Regular directory without .git
        os.makedirs(os.path.join(temp_projects, "not-a-repo"))
        # File, not directory
        with open(os.path.join(temp_projects, "file.txt"), "w") as f:
            f.write("hello")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 0

    def test_skip_dirs_in_skip_list(self, temp_projects):
        for skip_name in ["node_modules", ".cache", "__pycache__"]:
            path = os.path.join(temp_projects, skip_name)
            os.makedirs(path)
            _create_git_repo(path, "https://github.com/user/fake.git")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 0
        assert len(summary.skipped_dirs) >= 3

    def test_skip_hidden_dirs(self, temp_projects):
        path = os.path.join(temp_projects, ".hidden-repo")
        os.makedirs(path)
        _create_git_repo(path, "https://github.com/user/hidden.git")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 0

    def test_project_group_detection(self, temp_projects):
        group_path = os.path.join(temp_projects, "MyGroup")
        os.makedirs(group_path)

        for name in ["sub-app-1", "sub-app-2"]:
            path = os.path.join(group_path, name)
            os.makedirs(path)
            _create_git_repo(path, f"https://github.com/user/{name}.git")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 2
        assert "MyGroup" in summary.project_groups
        for p in summary.projects:
            assert p.group_name == "MyGroup"

    def test_group_dir_with_git_is_regular_project(self, temp_projects):
        """If a dir has .git AND contains subdirs with .git, treat as regular project."""
        path = os.path.join(temp_projects, "combo")
        os.makedirs(path)
        _create_git_repo(path, "https://github.com/user/combo.git")

        # Add a subdirectory with .git
        sub_path = os.path.join(path, "sub")
        os.makedirs(sub_path)
        _create_git_repo(sub_path, "https://github.com/user/sub.git")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        # combo should be detected as a regular project, not a group
        assert summary.total_found == 1
        assert summary.projects[0].directory_name == "combo"
        assert len(summary.project_groups) == 0

    def test_directory_not_found(self, temp_projects):
        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        with pytest.raises(FileNotFoundError):
            detector.scan(subdirectory="nonexistent")

    def test_no_remote(self, temp_projects):
        repo_path = os.path.join(temp_projects, "local-only")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)  # No remote

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 1
        assert summary.projects[0].git_remote_url is None
        assert summary.projects[0].github_url is None

    def test_non_github_remote(self, temp_projects):
        repo_path = os.path.join(temp_projects, "gitlab-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path, "https://gitlab.com/user/gitlab-app.git")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 1
        assert summary.projects[0].git_remote_url == "https://gitlab.com/user/gitlab-app.git"
        assert summary.projects[0].github_url is None

    def test_host_path_mapping(self, temp_projects):
        repo_path = os.path.join(temp_projects, "my-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.projects[0].host_path == "~/projects/my-app"

    def test_subdirectory_scan(self, temp_projects):
        sub_path = os.path.join(temp_projects, "subdir")
        os.makedirs(sub_path)
        repo_path = os.path.join(sub_path, "my-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan(subdirectory="subdir")

        assert summary.total_found == 1
        assert summary.projects[0].directory_name == "my-app"


class TestProjectIndicators:
    def test_detect_node_project(self, temp_projects):
        repo_path = os.path.join(temp_projects, "node-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "package.json"), "w") as f:
            json.dump({"name": "node-app", "dependencies": {"react": "^18.0.0"}}, f)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "node" in summary.projects[0].project_indicators

    def test_detect_python_project(self, temp_projects):
        repo_path = os.path.join(temp_projects, "py-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "pyproject.toml"), "w") as f:
            f.write("[project]\nname = 'py-app'\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "python" in summary.projects[0].project_indicators


class TestDependencyExtraction:
    def test_extract_npm_dependencies(self, temp_projects):
        repo_path = os.path.join(temp_projects, "npm-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "package.json"), "w") as f:
            json.dump({
                "dependencies": {"react": "^18.0.0", "next": "^14.0.0"},
                "devDependencies": {"vitest": "^1.0.0"},
            }, f)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        deps = summary.projects[0].dependencies
        assert deps is not None
        assert "npm" in deps
        assert "react" in deps["npm"]
        assert "next" in deps["npm"]
        assert "vitest" in deps["npm"]

    def test_extract_requirements_txt(self, temp_projects):
        repo_path = os.path.join(temp_projects, "pip-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "requirements.txt"), "w") as f:
            f.write("fastapi>=0.100\npydantic\n# comment\nuvicorn[standard]>=0.20\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        deps = summary.projects[0].dependencies
        assert deps is not None
        assert "pip" in deps
        assert "fastapi" in deps["pip"]
        assert "pydantic" in deps["pip"]
        assert "uvicorn" in deps["pip"]

    def test_no_deps_returns_none(self, temp_projects):
        repo_path = os.path.join(temp_projects, "bare-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.projects[0].dependencies is None


class TestInfraMarkers:
    def test_detect_docker(self, temp_projects):
        repo_path = os.path.join(temp_projects, "docker-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "Dockerfile"), "w") as f:
            f.write("FROM python:3.12\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "docker" in summary.projects[0].infra_markers

    def test_detect_github_actions(self, temp_projects):
        repo_path = os.path.join(temp_projects, "ci-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        workflows_dir = os.path.join(repo_path, ".github", "workflows")
        os.makedirs(workflows_dir)
        with open(os.path.join(workflows_dir, "ci.yml"), "w") as f:
            f.write("name: CI\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "github-actions" in summary.projects[0].infra_markers

    def test_detect_makefile(self, temp_projects):
        repo_path = os.path.join(temp_projects, "make-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "Makefile"), "w") as f:
            f.write("all:\n\techo hello\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "make" in summary.projects[0].infra_markers


class TestLanguageDetection:
    def test_detect_python_files(self, temp_projects):
        repo_path = os.path.join(temp_projects, "py-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "main.py"), "w") as f:
            f.write("print('hello')\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "python" in summary.projects[0].detected_languages

    def test_detect_typescript(self, temp_projects):
        repo_path = os.path.join(temp_projects, "ts-app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        with open(os.path.join(repo_path, "index.ts"), "w") as f:
            f.write("console.log('hello');\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "typescript" in summary.projects[0].detected_languages

    def test_detect_from_src_dir(self, temp_projects):
        repo_path = os.path.join(temp_projects, "app")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)
        src_dir = os.path.join(repo_path, "src")
        os.makedirs(src_dir)
        with open(os.path.join(src_dir, "main.rs"), "w") as f:
            f.write("fn main() {}\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert "rust" in summary.projects[0].detected_languages


class TestReadmeReading:
    def test_read_readme_content(self, temp_projects):
        repo_path = os.path.join(temp_projects, "readme-app")
        os.makedirs(repo_path)
        readme_text = "# My App\n\nThis is a great app."
        _create_git_repo(repo_path, readme=readme_text)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.projects[0].has_readme is True
        assert summary.projects[0].readme_content == readme_text
        assert summary.projects[0].readme_excerpt == readme_text

    def test_readme_excerpt_truncation(self, temp_projects):
        repo_path = os.path.join(temp_projects, "long-readme")
        os.makedirs(repo_path)
        long_text = "x" * 10000
        _create_git_repo(repo_path, readme=long_text)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.projects[0].readme_content == long_text
        assert len(summary.projects[0].readme_excerpt) == 5000

    def test_no_readme(self, temp_projects):
        repo_path = os.path.join(temp_projects, "no-readme")
        os.makedirs(repo_path)
        _create_git_repo(repo_path)

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.projects[0].has_readme is False
        assert summary.projects[0].readme_content is None


class TestGitSubmodule:
    def test_skip_git_submodule(self, temp_projects):
        """A .git file (not directory) indicates a submodule — should be skipped."""
        repo_path = os.path.join(temp_projects, "submodule-dir")
        os.makedirs(repo_path)
        # Write .git as a file (submodule pointer)
        with open(os.path.join(repo_path, ".git"), "w") as f:
            f.write("gitdir: ../.git/modules/submodule-dir\n")

        detector = GitDetector(projects_root=temp_projects, host_root="~/projects")
        summary = detector.scan()

        assert summary.total_found == 0
        assert any("submodule" in s for s in summary.skipped_dirs)
