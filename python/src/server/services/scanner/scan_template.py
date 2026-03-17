"""Scan template and request/response models for the Local Project Scanner."""

from pydantic import BaseModel


class ScanTemplate(BaseModel):
    """Template controlling how scanned projects are set up in Archon."""

    # Archon connection (user-overridable for non-default ports)
    archon_api_url: str = "http://localhost:8181"
    archon_mcp_url: str = "http://localhost:8051"

    # Project creation
    skip_existing: bool = True
    create_group_parents: bool = True
    set_github_repo: bool = True
    auto_tag_languages: bool = True

    # Knowledge sources
    crawl_github_readme: bool = True
    crawl_github_docs: bool = False
    knowledge_type: str = "technical"

    # Setup files (replicating archon-setup)
    write_config_files: bool = True
    write_settings_local: bool = True
    install_extensions: bool = True
    update_gitignore: bool = True

    # Filtering
    include_patterns: list[str] = []
    exclude_patterns: list[str] = []
    require_github_remote: bool = True


class ScanRequest(BaseModel):
    directory_path: str | None = None  # Relative to mounted root; None = scan root
    system_fingerprint: str


class ScanProjectResponse(BaseModel):
    id: str
    directory_name: str
    host_path: str
    github_url: str | None = None
    detected_languages: list[str] = []
    project_indicators: list[str] = []
    dependencies: dict[str, list[str]] | None = None
    infra_markers: list[str] = []
    has_readme: bool = False
    readme_excerpt: str | None = None
    is_project_group: bool = False
    group_name: str | None = None
    already_in_archon: bool = False
    existing_project_id: str | None = None


class ScanResponse(BaseModel):
    scan_id: str
    directory_path: str
    total_found: int
    new_projects: int
    already_in_archon: int
    project_groups: int
    projects: list[ScanProjectResponse]


class ApplyRequest(BaseModel):
    scan_id: str
    template: ScanTemplate = ScanTemplate()
    selected_project_ids: list[str] | None = None
    descriptions: dict[str, str] | None = None
    system_fingerprint: str
    system_name: str


class ApplyResponse(BaseModel):
    operation_id: str
    estimated_minutes: float
    projects_to_create: int
    crawls_to_start: int


class EstimateRequest(BaseModel):
    scan_id: str
    template: ScanTemplate = ScanTemplate()
    selected_count: int | None = None


class EstimateResponse(BaseModel):
    estimated_minutes: float
    project_creation_seconds: float
    crawl_minutes: float
    warning: str | None = None


class TemplateSaveRequest(BaseModel):
    name: str
    description: str | None = None
    template: ScanTemplate
    is_default: bool = False
    system_id: str | None = None


class TemplateResponse(BaseModel):
    id: str
    name: str
    description: str | None = None
    template: ScanTemplate
    is_default: bool = False
    system_id: str | None = None
    created_at: str
    updated_at: str
