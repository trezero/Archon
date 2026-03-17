"""Scanner service for bulk project onboarding."""

import asyncio
import hashlib
import json
import os
import tarfile
import tempfile
from datetime import datetime, timezone
from typing import Any

import httpx

from src.server.config.logfire_config import get_logger
from src.server.config.scanner_config import SCANNER_ENABLED, SCANNER_PROJECTS_ROOT
from src.server.utils import get_supabase_client
from src.server.utils.progress.progress_tracker import ProgressTracker

from .git_detector import GitDetector
from .scan_template import ScanTemplate
from .url_normalizer import normalize_github_url

logger = get_logger(__name__)

GITIGNORE_ENTRIES = [
    "# Archon",
    ".claude/plugins/",
    ".claude/skills/",
    ".claude/archon-config.json",
    ".claude/archon-state.json",
    ".claude/archon-memory-buffer.jsonl",
    ".claude/settings.local.json",
    ".archon/",
]

SETUP_SECONDS_PER_PROJECT = 2
CRAWL_MINUTES_PER_PROJECT = 1
MAX_CONCURRENT_CRAWLS = 3


class ScannerService:
    """Service for scanning directories and bulk-creating Archon projects."""

    def __init__(self, supabase_client=None):
        self.supabase_client = supabase_client or get_supabase_client()

    def _check_enabled(self) -> tuple[bool, dict[str, Any]] | None:
        """Check if scanner is enabled. Returns error tuple if disabled, None if OK."""
        if not SCANNER_ENABLED:
            return False, {
                "error": "Scanner is not enabled. Set SCANNER_ENABLED=true and "
                "PROJECTS_DIRECTORY in your .env file, then restart Docker."
            }
        return None

    async def scan_directory(
        self,
        container_path: str,
        host_path: str,
        system_id: str,
    ) -> tuple[bool, dict[str, Any]]:
        """Scan a directory for Git repos, cross-reference with existing Archon projects,
        and persist results to archon_scan_results + archon_scan_projects tables.
        """
        check = self._check_enabled()
        if check:
            return check

        try:
            detector = GitDetector(
                projects_root=SCANNER_PROJECTS_ROOT,
                host_root=host_path or "~/projects",
            )
            subdirectory = None
            if container_path and container_path != SCANNER_PROJECTS_ROOT:
                subdirectory = os.path.relpath(container_path, SCANNER_PROJECTS_ROOT)

            scan_summary = await asyncio.to_thread(detector.scan, subdirectory)

            existing_urls = self._get_existing_project_urls()

            scan_data = {
                "directory_path": host_path or "~/projects",
                "system_id": system_id,
                "total_found": scan_summary.total_found,
                "project_groups": len(scan_summary.project_groups),
                "status": "pending",
            }

            response = self.supabase_client.table("archon_scan_results").insert(scan_data).execute()
            if not response.data:
                return False, {"error": "Failed to create scan result record"}

            scan_id = response.data[0]["id"]

            new_count = 0
            existing_count = 0
            project_records = []

            for project in scan_summary.projects:
                already_in = False
                existing_pid = None

                if project.github_url and project.github_url in existing_urls:
                    already_in = True
                    existing_pid = existing_urls[project.github_url]
                    existing_count += 1
                else:
                    new_count += 1

                record = {
                    "scan_id": scan_id,
                    "directory_name": project.directory_name,
                    "absolute_path": project.absolute_path,
                    "host_path": project.host_path,
                    "git_remote_url": project.git_remote_url,
                    "github_owner": project.github_owner,
                    "github_repo_name": project.github_repo_name,
                    "github_url": project.github_url,
                    "default_branch": project.default_branch,
                    "has_readme": project.has_readme,
                    "readme_content": project.readme_content,
                    "readme_excerpt": project.readme_excerpt,
                    "detected_languages": project.detected_languages,
                    "project_indicators": project.project_indicators,
                    "dependencies": project.dependencies or {},
                    "infra_markers": project.infra_markers,
                    "is_project_group": project.is_project_group,
                    "group_name": project.group_name,
                    "already_in_archon": already_in,
                    "existing_project_id": existing_pid,
                    "selected": not already_in,
                }
                project_records.append(record)

            if project_records:
                insert_resp = (
                    self.supabase_client.table("archon_scan_projects")
                    .insert(project_records)
                    .execute()
                )
                if not insert_resp.data:
                    return False, {"error": "Failed to insert scan project records"}
                project_records = insert_resp.data

            self.supabase_client.table("archon_scan_results").update({
                "new_projects": new_count,
                "already_in_archon": existing_count,
            }).eq("id", scan_id).execute()

            projects_response = []
            for rec in project_records:
                projects_response.append({
                    "id": rec["id"],
                    "directory_name": rec["directory_name"],
                    "host_path": rec["host_path"],
                    "github_url": rec.get("github_url"),
                    "detected_languages": rec.get("detected_languages", []),
                    "project_indicators": rec.get("project_indicators", []),
                    "dependencies": rec.get("dependencies"),
                    "infra_markers": rec.get("infra_markers", []),
                    "has_readme": rec.get("has_readme", False),
                    "readme_excerpt": rec.get("readme_excerpt"),
                    "is_project_group": rec.get("is_project_group", False),
                    "group_name": rec.get("group_name"),
                    "already_in_archon": rec.get("already_in_archon", False),
                    "existing_project_id": rec.get("existing_project_id"),
                })

            return True, {
                "scan_id": scan_id,
                "summary": {
                    "directory_path": scan_summary.host_path,
                    "total_found": scan_summary.total_found,
                    "new_projects": new_count,
                    "already_in_archon": existing_count,
                    "project_groups": len(scan_summary.project_groups),
                    "group_names": scan_summary.project_groups,
                    "skipped_dirs": scan_summary.skipped_dirs,
                },
                "projects": projects_response,
            }

        except FileNotFoundError as e:
            return False, {"error": str(e)}
        except PermissionError as e:
            return False, {"error": str(e)}
        except Exception as e:
            logger.error(f"Scan failed: {e}", exc_info=True)
            return False, {"error": f"Scan failed: {str(e)}"}

    async def apply_scan(
        self,
        scan_id: str,
        template: ScanTemplate,
        selected_project_ids: list[str] | None,
        descriptions: dict[str, str] | None,
        system_fingerprint: str,
        system_name: str,
        progress_id: str,
    ) -> tuple[bool, dict[str, Any]]:
        """Apply template to selected projects from a scan."""
        check = self._check_enabled()
        if check:
            return check

        try:
            scan_resp = (
                self.supabase_client.table("archon_scan_results")
                .select("*")
                .eq("id", scan_id)
                .execute()
            )
            if not scan_resp.data:
                return False, {"error": "Scan not found"}

            scan = scan_resp.data[0]
            if scan["status"] == "expired":
                return False, {"error": "Scan expired. Please run a new scan."}

            expires_at = scan.get("expires_at")
            if expires_at:
                from dateutil.parser import parse as parse_date
                if parse_date(expires_at) < datetime.now(timezone.utc):
                    self.supabase_client.table("archon_scan_results").update(
                        {"status": "expired"}
                    ).eq("id", scan_id).execute()
                    return False, {"error": "Scan expired. Please run a new scan."}

            query = (
                self.supabase_client.table("archon_scan_projects")
                .select("*")
                .eq("scan_id", scan_id)
            )
            if selected_project_ids:
                query = query.in_("id", selected_project_ids)

            projects_resp = query.execute()
            if not projects_resp.data:
                return False, {"error": "No projects found for this scan"}

            all_projects = projects_resp.data

            projects_to_process = []
            already_done = 0
            for p in all_projects:
                if p["apply_status"] == "created":
                    already_done += 1
                    continue
                if p["already_in_archon"] and template.skip_existing:
                    continue
                if template.require_github_remote and not p.get("github_url"):
                    self.supabase_client.table("archon_scan_projects").update({
                        "apply_status": "skipped",
                        "error_message": "Non-GitHub remote" if p.get("git_remote_url") else "No remote",
                    }).eq("id", p["id"]).execute()
                    continue
                projects_to_process.append(p)

            total = len(projects_to_process)
            if total == 0 and already_done > 0:
                return True, {
                    "operation_id": progress_id,
                    "created": already_done,
                    "skipped": 0,
                    "failed": 0,
                    "message": f"All {already_done} projects already set up (resume detected).",
                }

            tracker = ProgressTracker(progress_id, operation_type="scanner")
            tracker.start()
            tracker.update(progress=0, message=f"Setting up {total} projects...")

            cached_tarball = None
            extensions_hash = None
            if template.install_extensions:
                try:
                    cached_tarball, extensions_hash = await self._cache_extensions_tarball(template)
                except Exception as e:
                    tracker.error(f"Failed to download extensions: {e}")
                    return False, {
                        "error": f"Could not download extensions from {template.archon_mcp_url}: {e}"
                    }

            self.supabase_client.table("archon_scan_results").update({
                "template": template.model_dump(),
                "status": "applied",
                "applied_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", scan_id).execute()

            created = 0
            skipped = 0
            failed = 0
            crawls_queued = 0

            group_parent_ids: dict[str, str] = {}
            if template.create_group_parents:
                group_names = {p["group_name"] for p in projects_to_process if p.get("group_name")}
                for gname in group_names:
                    parent_id = await self._create_group_parent(gname)
                    if parent_id:
                        group_parent_ids[gname] = parent_id

            for i, scan_project in enumerate(projects_to_process):
                progress_pct = int(((i + already_done) / (total + already_done)) * 90) + 5
                project_name = scan_project["directory_name"]

                tracker.update(
                    progress=progress_pct,
                    message=f"[{i + 1}/{total}] Setting up {project_name}...",
                )

                parent_id = group_parent_ids.get(scan_project.get("group_name", ""))
                desc = (descriptions or {}).get(project_name)

                success, result = await self._setup_single_project(
                    scan_project=scan_project,
                    template=template,
                    description=desc,
                    system_fingerprint=system_fingerprint,
                    system_name=system_name,
                    parent_project_id=parent_id,
                    cached_tarball=cached_tarball,
                    extensions_hash=extensions_hash,
                )

                if success:
                    created += 1
                    if result.get("crawl_queued"):
                        crawls_queued += 1
                    self.supabase_client.table("archon_scan_projects").update({
                        "apply_status": "created",
                        "archon_project_id": result.get("project_id"),
                    }).eq("id", scan_project["id"]).execute()
                    tracker.update(
                        progress=progress_pct,
                        message=f"[{i + 1}/{total}] Created: {project_name}",
                    )
                else:
                    failed += 1
                    error_msg = result.get("error", "Unknown error")
                    self.supabase_client.table("archon_scan_projects").update({
                        "apply_status": "failed",
                        "error_message": error_msg,
                    }).eq("id", scan_project["id"]).execute()
                    tracker.update(
                        progress=progress_pct,
                        message=f"[{i + 1}/{total}] Failed: {project_name} ({error_msg})",
                    )

            from .scan_report import generate_scan_report
            report_success, report_result = await generate_scan_report(
                scan_id, self.supabase_client
            )

            tracker.complete(
                message=f"Done: {created} created, {skipped} skipped, {failed} failed. "
                f"{crawls_queued} crawls queued.",
            )

            if cached_tarball and os.path.isfile(cached_tarball):
                try:
                    os.unlink(cached_tarball)
                except OSError:
                    pass

            return True, {
                "operation_id": progress_id,
                "created": created + already_done,
                "skipped": skipped,
                "failed": failed,
                "crawls_queued": crawls_queued,
                "report_csv_path": report_result.get("csv_path") if report_success else None,
                "report_summary": report_result.get("summary") if report_success else None,
            }

        except Exception as e:
            logger.error(f"Apply failed: {e}", exc_info=True)
            return False, {"error": f"Apply failed: {str(e)}"}

    async def _setup_single_project(
        self,
        scan_project: dict,
        template: ScanTemplate,
        description: str | None,
        system_fingerprint: str,
        system_name: str,
        parent_project_id: str | None = None,
        cached_tarball: str | None = None,
        extensions_hash: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Set up a single project — equivalent to running /archon-setup in that directory."""
        project_name = scan_project["directory_name"]
        project_path = scan_project["absolute_path"]

        try:
            # Step 1: Check for duplicate (idempotent)
            github_url = scan_project.get("github_url")
            if github_url:
                existing = self._find_project_by_github_url(github_url)
                if existing:
                    logger.info(f"Project {project_name} already exists (id={existing}), reusing")
                    await self._write_and_install(
                        project_path, existing, system_fingerprint, system_name,
                        template, cached_tarball, extensions_hash,
                    )
                    return True, {"project_id": existing, "crawl_queued": False}

            # Step 2: Create Archon project
            tags = []
            if template.auto_tag_languages:
                tags.extend(scan_project.get("detected_languages", []))
            tags.extend(scan_project.get("infra_markers", []))

            metadata = {}
            deps = scan_project.get("dependencies")
            if deps:
                metadata["dependencies"] = deps
            if scan_project.get("group_name"):
                metadata["project_group"] = scan_project["group_name"]

            project_data = {
                "title": project_name,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "docs": [],
                "features": [],
                "data": [],
            }
            if description:
                project_data["description"] = description
            if github_url and template.set_github_repo:
                project_data["github_repo"] = github_url
            if parent_project_id:
                project_data["parent_project_id"] = parent_project_id
            if tags:
                project_data["tags"] = tags
            if metadata:
                project_data["metadata"] = metadata

            resp = self.supabase_client.table("archon_projects").insert(project_data).execute()
            if not resp.data:
                return False, {"error": f"Failed to create project {project_name}"}

            project_id = resp.data[0]["id"]
            logger.info(f"Created project {project_name} (id={project_id})")

            # Step 3: Register system for project
            await self._register_system_for_project(project_id, system_fingerprint)

            # Step 4-7: Write config files, install extensions, update gitignore
            await self._write_and_install(
                project_path, project_id, system_fingerprint, system_name,
                template, cached_tarball, extensions_hash,
            )

            # Step 8: Ingest local README as knowledge document
            crawl_queued = False
            readme_content = scan_project.get("readme_content")
            if readme_content:
                await self._ingest_readme_as_document(project_id, project_name, readme_content)

            # Step 9: Start GitHub README crawl
            if template.crawl_github_readme and github_url:
                try:
                    await self._start_readme_crawl(project_id, github_url, template)
                    crawl_queued = True
                except Exception as e:
                    logger.warning(f"Crawl failed for {project_name}: {e}")

            return True, {"project_id": project_id, "crawl_queued": crawl_queued}

        except Exception as e:
            logger.error(f"Failed to set up {project_name}: {e}", exc_info=True)
            return False, {"error": str(e)}

    async def _write_and_install(
        self,
        project_path: str,
        project_id: str,
        system_fingerprint: str,
        system_name: str,
        template: ScanTemplate,
        cached_tarball: str | None,
        extensions_hash: str | None,
    ) -> None:
        """Write config files, install extensions, update gitignore."""
        system_id = self._get_system_id(system_fingerprint)

        if template.write_config_files:
            await self._write_project_config_files(
                project_path, project_id, system_fingerprint, system_name,
                system_id, template, extensions_hash,
            )

        if template.write_settings_local:
            await self._write_settings_local(project_path)

        if template.install_extensions and cached_tarball:
            await self._install_extensions(project_path, cached_tarball)

        if template.update_gitignore:
            await self._update_gitignore(project_path)

    async def _write_project_config_files(
        self,
        project_path: str,
        project_id: str,
        system_fingerprint: str,
        system_name: str,
        system_id: str | None,
        template: ScanTemplate,
        extensions_hash: str | None = None,
    ) -> None:
        """Write .claude/ config files into the project directory."""
        claude_dir = os.path.join(project_path, ".claude")
        os.makedirs(claude_dir, exist_ok=True)

        now = datetime.now(timezone.utc).isoformat()

        config = {
            "archon_api_url": template.archon_api_url,
            "archon_mcp_url": template.archon_mcp_url,
            "project_id": project_id,
            "project_title": os.path.basename(project_path),
            "machine_id": hashlib.md5(system_fingerprint.encode()).hexdigest()[:16],
            "install_scope": "project",
            "installed_at": now,
            "installed_by": "scanner",
        }
        if extensions_hash:
            config["extensions_hash"] = extensions_hash
            config["extensions_installed_at"] = now

        config_path = os.path.join(claude_dir, "archon-config.json")
        with open(config_path, "w") as f:
            json.dump(config, f, indent=4)

        state = {
            "system_fingerprint": system_fingerprint,
            "system_name": system_name,
            "archon_project_id": project_id,
        }
        state_path = os.path.join(claude_dir, "archon-state.json")
        with open(state_path, "w") as f:
            json.dump(state, f, indent=4)

    async def _write_settings_local(self, project_path: str) -> None:
        """Write .claude/settings.local.json with PostToolUse hook."""
        claude_dir = os.path.join(project_path, ".claude")
        os.makedirs(claude_dir, exist_ok=True)

        settings = {
            "hooks": {
                "PostToolUse": [
                    {
                        "matcher": ".*",
                        "hooks": [
                            {
                                "type": "command",
                                "command": "~/.claude/plugins/archon-memory/scripts/observation_hook.sh",
                            }
                        ],
                    }
                ]
            }
        }

        settings_path = os.path.join(claude_dir, "settings.local.json")
        with open(settings_path, "w") as f:
            json.dump(settings, f, indent=4)

    async def _install_extensions(self, project_path: str, cached_tarball_path: str) -> None:
        """Extract cached extensions tarball into project's .claude/skills/ directory."""
        skills_dir = os.path.join(project_path, ".claude", "skills")
        os.makedirs(skills_dir, exist_ok=True)

        with tarfile.open(cached_tarball_path, "r:gz") as tar:
            tar.extractall(path=skills_dir)

    async def _update_gitignore(self, project_path: str) -> None:
        """Append Archon entries to .gitignore if not already present."""
        gitignore_path = os.path.join(project_path, ".gitignore")

        existing_lines = set()
        if os.path.isfile(gitignore_path):
            with open(gitignore_path, "r") as f:
                existing_lines = {line.strip() for line in f}

        new_entries = [e for e in GITIGNORE_ENTRIES if e.strip() not in existing_lines]

        if new_entries:
            with open(gitignore_path, "a") as f:
                if existing_lines and "" not in existing_lines:
                    f.write("\n")
                f.write("\n".join(new_entries) + "\n")

    async def _cache_extensions_tarball(self, template: ScanTemplate) -> tuple[str, str]:
        """Download extensions tarball once. Returns (path, sha256_hash)."""
        url = f"{template.archon_mcp_url}/archon-setup/extensions.tar.gz"
        timeout = httpx.Timeout(60.0, connect=10.0)

        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url)
            response.raise_for_status()

        content = response.content
        sha256_hash = hashlib.sha256(content).hexdigest()

        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".tar.gz")
        tmp.write(content)
        tmp.close()

        return tmp.name, sha256_hash

    async def _register_system_for_project(
        self,
        project_id: str,
        system_fingerprint: str,
    ) -> None:
        """Register the system for a project via the sync mechanism."""
        try:
            system = self._get_system_by_fingerprint(system_fingerprint)
            if not system:
                logger.warning(f"System not registered for fingerprint {system_fingerprint[:8]}...")
                return

            system_id = system["id"]

            self.supabase_client.table("archon_project_systems").upsert({
                "project_id": project_id,
                "system_id": system_id,
                "last_seen": datetime.now(timezone.utc).isoformat(),
            }, on_conflict="project_id,system_id").execute()

        except Exception as e:
            logger.warning(f"Failed to register system for project {project_id}: {e}")

    async def _ingest_readme_as_document(
        self,
        project_id: str,
        project_name: str,
        readme_content: str,
    ) -> None:
        """Store full README as a document in the knowledge base."""
        try:
            existing = (
                self.supabase_client.table("documents")
                .select("id")
                .eq("metadata->>origin", "scanner")
                .eq("metadata->>project_id", project_id)
                .eq("metadata->>file", "README.md")
                .limit(1)
                .execute()
            )
            if existing.data:
                logger.info(f"README already ingested for {project_name}")
                return

            doc_data = {
                "content": readme_content,
                "metadata": {
                    "origin": "scanner",
                    "file": "README.md",
                    "project_id": project_id,
                    "project_name": project_name,
                },
                "source": project_name,
            }

            self.supabase_client.table("documents").insert(doc_data).execute()
            logger.info(f"Ingested README for {project_name}")

        except Exception as e:
            logger.warning(f"Failed to ingest README for {project_name}: {e}")

    async def _start_readme_crawl(
        self,
        project_id: str,
        github_url: str,
        template: ScanTemplate,
    ) -> None:
        """Start a GitHub README crawl for a project."""
        try:
            readme_url = f"{github_url}#readme"
            existing = (
                self.supabase_client.table("sources")
                .select("id")
                .eq("url", readme_url)
                .limit(1)
                .execute()
            )
            if existing.data:
                return

            from src.server.config.service_discovery import get_api_url
            api_url = get_api_url()
            timeout = httpx.Timeout(30.0, connect=5.0)

            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{api_url}/api/knowledge-items/crawl",
                    json={
                        "url": readme_url,
                        "project_id": project_id,
                        "crawl_type": "normal",
                        "max_pages": 1,
                        "knowledge_type": template.knowledge_type,
                    },
                )
                if resp.status_code not in (200, 201, 202):
                    logger.warning(
                        f"Crawl request failed for {github_url}: {resp.status_code} {resp.text}"
                    )

        except Exception as e:
            logger.warning(f"Failed to start crawl for {github_url}: {e}")

    async def _create_group_parent(self, group_name: str) -> str | None:
        """Create a parent Archon project for a project group. Returns project_id."""
        try:
            existing = (
                self.supabase_client.table("archon_projects")
                .select("id")
                .eq("title", group_name)
                .is_("github_repo", "null")
                .limit(1)
                .execute()
            )
            if existing.data:
                return existing.data[0]["id"]

            resp = self.supabase_client.table("archon_projects").insert({
                "title": group_name,
                "description": f"Project group: {group_name}",
                "docs": [],
                "features": [],
                "data": [],
                "tags": ["project-group"],
                "metadata": {"is_group_parent": True},
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }).execute()

            if resp.data:
                return resp.data[0]["id"]
            return None

        except Exception as e:
            logger.warning(f"Failed to create group parent {group_name}: {e}")
            return None

    def _get_existing_project_urls(self) -> dict[str, str]:
        """Fetch all existing project github_urls mapped to project IDs."""
        try:
            resp = (
                self.supabase_client.table("archon_projects")
                .select("id, github_repo")
                .not_.is_("github_repo", "null")
                .execute()
            )
            url_map = {}
            for p in resp.data or []:
                normalized = normalize_github_url(p.get("github_repo"))
                if normalized:
                    url_map[normalized] = p["id"]
            return url_map
        except Exception as e:
            logger.warning(f"Failed to fetch existing project URLs: {e}")
            return {}

    def _find_project_by_github_url(self, github_url: str) -> str | None:
        """Find an existing project by normalized github_url. Returns project_id or None."""
        try:
            resp = (
                self.supabase_client.table("archon_projects")
                .select("id, github_repo")
                .not_.is_("github_repo", "null")
                .execute()
            )
            for p in resp.data or []:
                if normalize_github_url(p.get("github_repo")) == github_url:
                    return p["id"]
            return None
        except Exception:
            return None

    def _get_system_by_fingerprint(self, fingerprint: str) -> dict | None:
        """Look up system by fingerprint."""
        try:
            resp = (
                self.supabase_client.table("archon_systems")
                .select("*")
                .eq("fingerprint", fingerprint)
                .limit(1)
                .execute()
            )
            return resp.data[0] if resp.data else None
        except Exception:
            return None

    def _get_system_id(self, fingerprint: str) -> str | None:
        """Get system ID from fingerprint."""
        system = self._get_system_by_fingerprint(fingerprint)
        return system["id"] if system else None

    async def get_scan_results(self, scan_id: str) -> tuple[bool, dict[str, Any]]:
        """Fetch scan results from database."""
        try:
            scan_resp = (
                self.supabase_client.table("archon_scan_results")
                .select("*")
                .eq("id", scan_id)
                .execute()
            )
            if not scan_resp.data:
                return False, {"error": "Scan not found"}

            projects_resp = (
                self.supabase_client.table("archon_scan_projects")
                .select("*")
                .eq("scan_id", scan_id)
                .order("created_at")
                .execute()
            )

            return True, {
                "scan": scan_resp.data[0],
                "projects": projects_resp.data or [],
            }

        except Exception as e:
            logger.error(f"Failed to get scan results: {e}")
            return False, {"error": str(e)}

    async def estimate_apply_time(
        self,
        scan_id: str,
        template: ScanTemplate,
        selected_count: int | None = None,
    ) -> dict[str, Any]:
        """Estimate how long the apply phase will take."""
        if selected_count is None:
            resp = (
                self.supabase_client.table("archon_scan_projects")
                .select("id", count="exact")
                .eq("scan_id", scan_id)
                .eq("already_in_archon", False)
                .execute()
            )
            selected_count = resp.count or 0

        setup_seconds = selected_count * SETUP_SECONDS_PER_PROJECT
        crawl_count = selected_count if template.crawl_github_readme else 0
        crawl_batches = (
            (crawl_count + MAX_CONCURRENT_CRAWLS - 1) // MAX_CONCURRENT_CRAWLS
            if crawl_count else 0
        )
        crawl_minutes = crawl_batches * CRAWL_MINUTES_PER_PROJECT

        total_minutes = (setup_seconds / 60) + crawl_minutes

        warning = None
        if crawl_count > 10:
            warning = (
                f"{crawl_count} crawls at {MAX_CONCURRENT_CRAWLS} concurrent = "
                f"~{crawl_minutes:.0f} minutes"
            )

        return {
            "estimated_minutes": round(total_minutes, 1),
            "project_creation_seconds": setup_seconds,
            "crawl_minutes": crawl_minutes,
            "warning": warning,
        }

    # Template CRUD

    def list_templates(self, system_id: str | None = None) -> tuple[bool, dict[str, Any]]:
        """List saved scanner templates."""
        try:
            query = self.supabase_client.table("archon_scanner_templates").select("*")
            if system_id:
                query = query.eq("system_id", system_id)
            resp = query.order("created_at", desc=True).execute()
            return True, {"templates": resp.data or []}
        except Exception as e:
            return False, {"error": str(e)}

    def save_template(
        self,
        name: str,
        template: ScanTemplate,
        description: str | None = None,
        is_default: bool = False,
        system_id: str | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """Save a scanner template."""
        try:
            data = {
                "name": name,
                "template": template.model_dump(),
                "description": description,
                "is_default": is_default,
                "system_id": system_id,
            }
            resp = self.supabase_client.table("archon_scanner_templates").insert(data).execute()
            if not resp.data:
                return False, {"error": "Failed to save template"}
            return True, {"template": resp.data[0]}
        except Exception as e:
            return False, {"error": str(e)}

    def delete_template(self, template_id: str) -> tuple[bool, dict[str, Any]]:
        """Delete a scanner template."""
        try:
            self.supabase_client.table("archon_scanner_templates").delete().eq(
                "id", template_id
            ).execute()
            return True, {"deleted": template_id}
        except Exception as e:
            return False, {"error": str(e)}
