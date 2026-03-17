"""Git repository detector with smart recurse algorithm."""

import configparser
import json
import os
import re
from dataclasses import dataclass, field

from src.server.config.logfire_config import get_logger

from .url_normalizer import extract_github_owner_repo, normalize_github_url

logger = get_logger(__name__)

SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv",
    ".cache", ".npm", ".nvm", "dist", "build", ".tox",
    "vendor", "target", ".gradle", "Pods",
}

LANGUAGE_EXTENSIONS = {
    ".py": "python", ".js": "javascript", ".ts": "typescript",
    ".tsx": "typescript", ".jsx": "javascript", ".rs": "rust",
    ".go": "go", ".java": "java", ".rb": "ruby", ".php": "php",
    ".cs": "csharp", ".cpp": "cpp", ".c": "c", ".swift": "swift",
    ".kt": "kotlin", ".scala": "scala", ".dart": "dart",
    ".vue": "vue", ".svelte": "svelte",
}

PROJECT_INDICATORS = {
    "package.json": "node",
    "pyproject.toml": "python",
    "setup.py": "python",
    "requirements.txt": "python",
    "Cargo.toml": "rust",
    "go.mod": "go",
    "pom.xml": "java",
    "build.gradle": "java",
    "Gemfile": "ruby",
    "composer.json": "php",
    "Package.swift": "swift",
    "pubspec.yaml": "dart",
}

INFRA_MARKERS = {
    "docker-compose.yml": "docker",
    "docker-compose.yaml": "docker",
    "Dockerfile": "docker",
    ".github/workflows": "github-actions",
    ".gitlab-ci.yml": "gitlab-ci",
    "firebase.json": "firebase",
    ".firebaserc": "firebase",
    "vercel.json": "vercel",
    "netlify.toml": "netlify",
    "serverless.yml": "serverless",
    "terraform": "terraform",
    "k8s": "kubernetes",
    "Makefile": "make",
    ".env.example": "env-config",
    "supabase": "supabase",
    "prisma": "prisma",
    ".github/dependabot.yml": "dependabot",
}

DEPENDENCY_EXTRACTORS = {
    "package.json": "npm",
    "pyproject.toml": "pip",
    "requirements.txt": "pip",
    "Cargo.toml": "cargo",
    "go.mod": "go",
    "pom.xml": "maven",
    "build.gradle": "gradle",
}

README_EXCERPT_LENGTH = 5000


@dataclass
class DetectedProject:
    directory_name: str
    absolute_path: str
    host_path: str
    git_remote_url: str | None = None
    github_owner: str | None = None
    github_repo_name: str | None = None
    github_url: str | None = None
    default_branch: str | None = None
    has_readme: bool = False
    readme_content: str | None = None
    readme_excerpt: str | None = None
    detected_languages: list[str] = field(default_factory=list)
    project_indicators: list[str] = field(default_factory=list)
    dependencies: dict[str, list[str]] | None = None
    infra_markers: list[str] = field(default_factory=list)
    is_project_group: bool = False
    group_name: str | None = None


@dataclass
class ScanSummary:
    directory_path: str
    host_path: str
    projects: list[DetectedProject] = field(default_factory=list)
    project_groups: list[str] = field(default_factory=list)
    total_found: int = 0
    skipped_dirs: list[str] = field(default_factory=list)


class GitDetector:
    """Detects Git repositories using a smart two-level recurse algorithm."""

    def __init__(self, projects_root: str = "/projects", host_root: str = "~/projects"):
        self.projects_root = projects_root
        self.host_root = host_root

    def scan(self, subdirectory: str | None = None) -> ScanSummary:
        """Scan for Git repositories using smart two-level recurse.

        Pass 1: Scan immediate children
          - Has .git/ → detected project
          - No .git/ → potential project group

        Pass 2: For each potential group, scan ITS immediate children
          - If any child has .git/ → group parent; add git children as projects
          - If none → skip entirely
        """
        scan_path = self.projects_root
        host_path = self.host_root
        if subdirectory:
            scan_path = os.path.join(self.projects_root, subdirectory)
            host_path = os.path.join(self.host_root, subdirectory)

        if not os.path.isdir(scan_path):
            raise FileNotFoundError(f"Directory not found: {host_path}")

        summary = ScanSummary(directory_path=scan_path, host_path=host_path)
        potential_groups: list[str] = []

        # Pass 1: Scan immediate children
        try:
            entries = sorted(os.listdir(scan_path))
        except PermissionError as e:
            raise PermissionError(f"Permission denied reading directory: {host_path}") from e

        for entry in entries:
            if entry in SKIP_DIRS or entry.startswith("."):
                summary.skipped_dirs.append(f"{entry} (skip list or hidden)")
                continue

            entry_path = os.path.join(scan_path, entry)
            if not os.path.isdir(entry_path):
                continue

            git_dir = os.path.join(entry_path, ".git")
            if os.path.isdir(git_dir):
                # This is a git repo
                project = self._detect_project(entry_path, entry)
                summary.projects.append(project)
            elif os.path.isfile(git_dir):
                # .git file = submodule pointer, skip
                summary.skipped_dirs.append(f"{entry} (git submodule)")
            else:
                # Potential project group
                potential_groups.append(entry)

        # Pass 2: Check potential groups
        for group_name in potential_groups:
            group_path = os.path.join(scan_path, group_name)
            group_projects: list[DetectedProject] = []

            try:
                group_entries = sorted(os.listdir(group_path))
            except PermissionError:
                summary.skipped_dirs.append(f"{group_name} (permission denied)")
                continue

            for child in group_entries:
                if child in SKIP_DIRS or child.startswith("."):
                    continue
                child_path = os.path.join(group_path, child)
                if not os.path.isdir(child_path):
                    continue
                child_git = os.path.join(child_path, ".git")
                if os.path.isdir(child_git):
                    project = self._detect_project(child_path, child, group_name=group_name)
                    group_projects.append(project)

            if group_projects:
                summary.project_groups.append(group_name)
                summary.projects.extend(group_projects)
            else:
                summary.skipped_dirs.append(f"{group_name} (no git repos found)")

        summary.total_found = len(summary.projects)
        return summary

    def _detect_project(
        self,
        project_path: str,
        directory_name: str,
        group_name: str | None = None,
    ) -> DetectedProject:
        """Detect a single project's metadata from its directory."""
        # Build host path from container path
        relative = os.path.relpath(project_path, self.projects_root)
        host_path = os.path.join(self.host_root, relative)

        project = DetectedProject(
            directory_name=directory_name,
            absolute_path=project_path,
            host_path=host_path,
            group_name=group_name,
        )

        # Parse git config for remote URL
        self._parse_git_config(project)

        # Parse GitHub info from remote
        if project.git_remote_url:
            project.github_url = normalize_github_url(project.git_remote_url)
            owner, repo = extract_github_owner_repo(project.git_remote_url)
            project.github_owner = owner
            project.github_repo_name = repo

        # Read README
        self._read_readme(project)

        # Detect languages (shallow — top-level files only)
        self._detect_languages(project)

        # Detect project indicators
        self._detect_project_indicators(project)

        # Extract dependencies
        self._extract_dependencies(project)

        # Check infrastructure markers
        self._detect_infra_markers(project)

        # Read default branch
        self._read_default_branch(project)

        return project

    def _parse_git_config(self, project: DetectedProject) -> None:
        """Parse .git/config to extract origin remote URL."""
        config_path = os.path.join(project.absolute_path, ".git", "config")
        if not os.path.isfile(config_path):
            return

        try:
            config = configparser.ConfigParser()
            config.read(config_path)
            if config.has_section('remote "origin"'):
                url = config.get('remote "origin"', "url", fallback=None)
                if url:
                    project.git_remote_url = url.strip()
        except Exception as e:
            logger.warning(f"Failed to parse git config for {project.directory_name}: {e}")

    def _read_readme(self, project: DetectedProject) -> None:
        """Read README.md content (full + excerpt)."""
        readme_names = ["README.md", "readme.md", "README.MD", "Readme.md"]
        for name in readme_names:
            readme_path = os.path.join(project.absolute_path, name)
            if os.path.isfile(readme_path):
                try:
                    with open(readme_path, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
                    project.has_readme = True
                    project.readme_content = content
                    project.readme_excerpt = content[:README_EXCERPT_LENGTH]
                except Exception as e:
                    logger.warning(f"Failed to read README for {project.directory_name}: {e}")
                return

    def _detect_languages(self, project: DetectedProject) -> None:
        """Detect languages from file extensions in top-level directory."""
        languages = set()
        try:
            for entry in os.listdir(project.absolute_path):
                if entry.startswith("."):
                    continue
                _, ext = os.path.splitext(entry)
                if ext in LANGUAGE_EXTENSIONS:
                    languages.add(LANGUAGE_EXTENSIONS[ext])
            # Also check src/ if it exists
            src_path = os.path.join(project.absolute_path, "src")
            if os.path.isdir(src_path):
                for entry in os.listdir(src_path):
                    _, ext = os.path.splitext(entry)
                    if ext in LANGUAGE_EXTENSIONS:
                        languages.add(LANGUAGE_EXTENSIONS[ext])
        except Exception as e:
            logger.warning(f"Failed to detect languages for {project.directory_name}: {e}")
        project.detected_languages = sorted(languages)

    def _detect_project_indicators(self, project: DetectedProject) -> None:
        """Detect project type from marker files."""
        indicators = set()
        for marker_file, indicator in PROJECT_INDICATORS.items():
            if os.path.exists(os.path.join(project.absolute_path, marker_file)):
                indicators.add(indicator)
        project.project_indicators = sorted(indicators)

    def _extract_dependencies(self, project: DetectedProject) -> None:
        """Extract dependency names from manifest files."""
        deps: dict[str, list[str]] = {}

        for manifest, ecosystem in DEPENDENCY_EXTRACTORS.items():
            manifest_path = os.path.join(project.absolute_path, manifest)
            if not os.path.isfile(manifest_path):
                continue

            try:
                if manifest == "package.json":
                    extracted = self._extract_npm_deps(manifest_path)
                elif manifest == "pyproject.toml":
                    extracted = self._extract_pyproject_deps(manifest_path)
                elif manifest == "requirements.txt":
                    extracted = self._extract_requirements_deps(manifest_path)
                elif manifest == "Cargo.toml":
                    extracted = self._extract_cargo_deps(manifest_path)
                elif manifest == "go.mod":
                    extracted = self._extract_go_deps(manifest_path)
                elif manifest == "pom.xml":
                    extracted = self._extract_maven_deps(manifest_path)
                elif manifest == "build.gradle":
                    extracted = self._extract_gradle_deps(manifest_path)
                else:
                    continue

                if extracted:
                    if ecosystem in deps:
                        # Merge, dedup
                        existing = set(deps[ecosystem])
                        existing.update(extracted)
                        deps[ecosystem] = sorted(existing)
                    else:
                        deps[ecosystem] = sorted(extracted)
            except Exception as e:
                logger.warning(f"Failed to extract {ecosystem} deps from {project.directory_name}: {e}")

        project.dependencies = deps if deps else None

    def _extract_npm_deps(self, path: str) -> list[str]:
        """Extract dependency names from package.json."""
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        names = set()
        for key in ("dependencies", "devDependencies"):
            if key in data and isinstance(data[key], dict):
                names.update(data[key].keys())
        return sorted(names)

    def _extract_pyproject_deps(self, path: str) -> list[str]:
        """Extract dependency names from pyproject.toml."""
        # Simple regex-based extraction to avoid toml dependency
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()

        names = set()
        # Match [project.dependencies] section
        in_deps = False
        for line in content.split("\n"):
            stripped = line.strip()
            if stripped == "[project.dependencies]" or stripped == "dependencies = [":
                in_deps = True
                continue
            if in_deps:
                if stripped.startswith("[") and not stripped.startswith('"'):
                    break
                if stripped == "]":
                    in_deps = False
                    continue
                # Extract package name from lines like "fastapi>=0.100" or '"fastapi>=0.100",'
                cleaned = stripped.strip('"\'[], ')
                if cleaned and not cleaned.startswith("#"):
                    # Extract just the package name (before any version specifier)
                    name = re.split(r"[>=<!~\s;]", cleaned)[0].strip()
                    if name:
                        names.add(name)
        return sorted(names)

    def _extract_requirements_deps(self, path: str) -> list[str]:
        """Extract package names from requirements.txt."""
        names = set()
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or line.startswith("-"):
                    continue
                # Extract package name before version specifier
                name = re.split(r"[>=<!~\s;\[]", line)[0].strip()
                if name:
                    names.add(name)
        return sorted(names)

    def _extract_cargo_deps(self, path: str) -> list[str]:
        """Extract dependency names from Cargo.toml."""
        names = set()
        in_deps = False
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped in ("[dependencies]", "[dev-dependencies]", "[build-dependencies]"):
                    in_deps = True
                    continue
                if stripped.startswith("[") and in_deps:
                    # Check for [dependencies.foo] style
                    if ".dependencies." in stripped or stripped == "[dependencies]":
                        continue
                    in_deps = False
                    continue
                if in_deps and "=" in stripped:
                    name = stripped.split("=")[0].strip()
                    if name and not name.startswith("#"):
                        names.add(name)
        return sorted(names)

    def _extract_go_deps(self, path: str) -> list[str]:
        """Extract module paths from go.mod require block."""
        names = set()
        in_require = False
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith("require ("):
                    in_require = True
                    continue
                if stripped == ")" and in_require:
                    in_require = False
                    continue
                if in_require and stripped and not stripped.startswith("//"):
                    # Module path is the first word
                    parts = stripped.split()
                    if parts:
                        names.add(parts[0])
                elif stripped.startswith("require ") and "(" not in stripped:
                    parts = stripped.split()
                    if len(parts) >= 2:
                        names.add(parts[1])
        return sorted(names)

    def _extract_maven_deps(self, path: str) -> list[str]:
        """Extract artifactId values from pom.xml dependencies."""
        names = set()
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            # Simple regex for <artifactId> within <dependency> blocks
            for match in re.finditer(r"<dependency>.*?</dependency>", content, re.DOTALL):
                dep_block = match.group()
                aid_match = re.search(r"<artifactId>(.*?)</artifactId>", dep_block)
                if aid_match:
                    names.add(aid_match.group(1))
        except Exception:
            pass
        return sorted(names)

    def _extract_gradle_deps(self, path: str) -> list[str]:
        """Extract dependency strings from build.gradle."""
        names = set()
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    stripped = line.strip()
                    # Match implementation/api/compile/testImplementation lines
                    match = re.match(
                        r"(?:implementation|api|compile|testImplementation|testCompile)"
                        r"""[\s(]+['"]([^'"]+)['"]""",
                        stripped,
                    )
                    if match:
                        dep = match.group(1)
                        # Extract artifact name from group:artifact:version
                        parts = dep.split(":")
                        if len(parts) >= 2:
                            names.add(f"{parts[0]}:{parts[1]}")
                        else:
                            names.add(dep)
        except Exception:
            pass
        return sorted(names)

    def _detect_infra_markers(self, project: DetectedProject) -> None:
        """Check for infrastructure marker files/directories."""
        markers = set()
        for marker_path, marker_name in INFRA_MARKERS.items():
            full_path = os.path.join(project.absolute_path, marker_path)
            if os.path.exists(full_path):
                markers.add(marker_name)
        project.infra_markers = sorted(markers)

    def _read_default_branch(self, project: DetectedProject) -> None:
        """Read the default branch from .git/HEAD."""
        head_path = os.path.join(project.absolute_path, ".git", "HEAD")
        if not os.path.isfile(head_path):
            return
        try:
            with open(head_path, "r") as f:
                content = f.read().strip()
            if content.startswith("ref: refs/heads/"):
                project.default_branch = content.replace("ref: refs/heads/", "")
        except Exception:
            pass
