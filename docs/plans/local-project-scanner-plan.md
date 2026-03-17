# Local Project Scanner — Feature Plan

## Overview

The **Local Project Scanner** enables a user to point Archon at a directory on their local filesystem (e.g. `~/projects/`), automatically discover all Git/GitHub repositories within it, and bulk-create Archon projects for each one — following a user-approved setup template. This eliminates the tedious process of manually creating and configuring each project one at a time.

---

## Problem Statement

Users with many local projects (10, 50, 100+) currently must:
1. Create each Archon project manually via the UI
2. Configure knowledge sources for each one individually
3. Run `/archon-setup` in each project directory separately

This is prohibitively slow for users with large project collections. The Local Project Scanner solves this by scanning a directory, detecting GitHub repos, and batch-creating Archon projects with a shared configuration template.

---

## Architecture

### System Flow

```
┌─────────────┐     POST /api/scanner/scan      ┌──────────────────┐
│  Frontend    │ ──────────────────────────────→  │  Scanner API     │
│  ScannerView │                                  │  (api_routes/)   │
└─────────────┘                                   └────────┬─────────┘
       │                                                   │
       │  GET /api/scanner/results/{scan_id}               │
       │◄──────────────────────────────────────────────────┘
       │                                                   │
       │  POST /api/scanner/apply                          ▼
       │ ─────────────────────────────────────→  ┌──────────────────┐
       │                                         │  Scanner Service │
       │                                         │  (services/)     │
       │  GET /api/progress/{operation_id}       └────────┬─────────┘
       │◄─────────────────────────────────────            │
       │                                          ┌───────┴────────┐
       │                                          │                │
       │                                    ┌─────▼─────┐  ┌──────▼──────┐
       │                                    │ Project    │  │ Knowledge   │
       │                                    │ Service    │  │ Crawl API   │
       │                                    └───────────┘  └─────────────┘
```

### Key Constraint: Filesystem Access

Archon's backend runs inside Docker by default. The scanner needs filesystem access to the host machine's project directories. Two approaches:

**Option A — MCP Tool (Recommended)**
The scanner runs as an MCP tool invoked from Claude Code, which already has filesystem access. The MCP tool scans the directory, extracts Git metadata, and sends the results to the Archon API for project creation.

**Option B — Mounted Volume**
The user mounts their projects directory into the Docker container. The backend scans directly. This requires Docker config changes and is less flexible.

**Recommendation**: Use a **hybrid approach**:
- A new **MCP tool** (`scan_local_projects`) handles filesystem scanning since Claude Code already has local access
- The **Archon API** handles the bulk project creation and knowledge source setup
- The **Frontend UI** provides a template editor and lets users review/approve scan results before applying

This keeps filesystem concerns in the MCP layer (which is already on the host) and bulk orchestration in the server.

---

## Component Breakdown

### 1. Backend: Scanner Service (`python/src/server/services/scanner/`)

**New files:**
- `scanner_service.py` — Core scanning and project creation logic
- `git_detector.py` — Git repository detection and GitHub metadata extraction
- `scan_template.py` — Pydantic models for scan templates

#### `git_detector.py`

Detects Git repositories in a directory and extracts metadata:

```python
@dataclass
class DetectedProject:
    directory_name: str        # Folder name (e.g. "my-app")
    absolute_path: str         # Full path on disk
    git_remote_url: str | None # origin remote URL
    github_owner: str | None   # Parsed from remote URL
    github_repo: str | None    # Parsed from remote URL
    github_url: str | None     # Normalized https URL
    default_branch: str | None # HEAD branch
    has_readme: bool           # README.md exists
    has_package_json: bool     # Node.js project indicator
    has_pyproject: bool        # Python project indicator
    languages: list[str]       # Detected from file extensions
    already_in_archon: bool    # Matched to existing project by github_url or title
    existing_project_id: str | None  # If already exists
```

Logic:
- Walk one level deep in the target directory
- For each subdirectory, check for `.git/`
- Parse `.git/config` or run `git remote get-url origin` to extract remote URL
- Parse GitHub owner/repo from remote URL (handles `https://` and `git@` formats)
- Check for README, package.json, pyproject.toml to detect project type
- Cross-reference with existing Archon projects to flag duplicates

#### `scan_template.py`

Defines the configuration template users approve before bulk creation:

```python
class ScanTemplate(BaseModel):
    """Template controlling how scanned projects are created in Archon"""

    # Project creation settings
    auto_create_projects: bool = True         # Create Archon projects for each repo
    skip_existing: bool = True                # Skip repos already in Archon

    # Knowledge source settings
    crawl_github_readme: bool = True          # Crawl the GitHub README as a knowledge source
    crawl_github_docs: bool = False           # Crawl /docs folder if present
    knowledge_type: str = "technical"         # "technical" or "business"

    # Project metadata
    set_github_repo: bool = True              # Set github_repo field on project
    generate_description: bool = False        # Use AI to generate description from README
    auto_tag_languages: bool = True           # Add detected languages as project tags

    # Filtering
    include_patterns: list[str] = []          # Glob patterns to include (empty = all)
    exclude_patterns: list[str] = []          # Glob patterns to exclude
    require_github_remote: bool = False       # Only include repos with GitHub remotes
```

#### `scanner_service.py`

Orchestrates the full scan → review → apply pipeline:

```python
class ScannerService:
    async def scan_directory(self, path: str) -> ScanResult:
        """Scan a directory and return detected projects"""

    async def apply_scan(
        self,
        scan_result: ScanResult,
        template: ScanTemplate,
        progress_id: str
    ) -> ApplyResult:
        """Create Archon projects for selected scan results using template"""

    async def _create_project_from_scan(
        self,
        detected: DetectedProject,
        template: ScanTemplate
    ) -> str:  # Returns project_id
        """Create a single Archon project from a detected repo"""

    async def _setup_knowledge_sources(
        self,
        project_id: str,
        detected: DetectedProject,
        template: ScanTemplate
    ) -> None:
        """Initiate knowledge source crawling based on template"""
```

### 2. Backend: Scanner API (`python/src/server/api_routes/scanner_api.py`)

New REST endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/scanner/scan` | Initiate a directory scan |
| `GET` | `/api/scanner/results/{scan_id}` | Get scan results |
| `POST` | `/api/scanner/apply` | Apply template to selected projects |
| `GET` | `/api/scanner/templates` | Get saved templates |
| `POST` | `/api/scanner/templates` | Save a template |

**Request/Response Models:**

```python
class ScanRequest(BaseModel):
    directory_path: str                     # Path to scan
    depth: int = 1                          # How deep to scan (1 = immediate children only)

class ScanResult(BaseModel):
    scan_id: str                            # UUID for this scan
    directory_path: str
    projects: list[DetectedProject]
    total_found: int
    already_in_archon: int
    new_projects: int
    scanned_at: str                         # ISO timestamp

class ApplyRequest(BaseModel):
    scan_id: str                            # Reference to scan results
    template: ScanTemplate                  # Configuration template
    selected_projects: list[str] | None     # directory_names to include (None = all new)

class ApplyResult(BaseModel):
    operation_id: str                       # Progress tracking ID
    created: int
    skipped: int
    failed: int
    details: list[dict]                     # Per-project status
```

### 3. MCP Tool: `scan_local_projects`

**File:** `python/src/mcp_server/features/scanner/scanner_tools.py`

New MCP tool that Claude Code can invoke:

```python
@mcp.tool()
async def scan_local_projects(
    directory: str,
    depth: int = 1
) -> dict:
    """
    Scan a local directory for Git/GitHub projects.

    Returns a list of detected repositories with metadata including
    GitHub URLs, detected languages, and whether they already exist in Archon.
    """
```

This tool:
1. Scans the filesystem (it runs on the host machine via MCP)
2. Detects Git repos and extracts metadata
3. Calls the Archon API to check for existing projects
4. Returns structured results for display or for `apply_scan_template`

Second MCP tool for applying:

```python
@mcp.tool()
async def apply_scan_template(
    scan_results: list[dict],
    template: dict,
    selected_projects: list[str] | None = None
) -> dict:
    """
    Apply a setup template to scanned projects, creating Archon projects
    and initiating knowledge source crawling for each.
    """
```

### 4. Frontend: Scanner Feature (`archon-ui-main/src/features/scanner/`)

New vertical slice feature following existing patterns:

```
src/features/scanner/
├── components/
│   ├── ScanDirectoryForm.tsx       # Path input + scan button
│   ├── ScanResultsList.tsx         # List of detected projects with checkboxes
│   ├── ScanResultCard.tsx          # Individual project card (name, remote, languages, status)
│   ├── ScanTemplateEditor.tsx      # Template configuration form
│   ├── ScanApplyProgress.tsx       # Progress tracking during bulk creation
│   └── index.ts
├── hooks/
│   └── useScannerQueries.ts        # Query keys, scan/apply mutations
├── services/
│   └── scannerService.ts           # API calls
├── types/
│   └── index.ts                    # TypeScript types
└── views/
    └── ScannerView.tsx             # Main view orchestrating the 3-step flow
```

#### UI Flow (3-Step Wizard)

**Step 1: Scan**
- Text input for directory path (e.g. `~/projects`)
- "Scan" button
- Shows loading spinner during scan
- Displays count of found repos

**Step 2: Review & Select**
- List of detected projects with checkboxes (all checked by default)
- Each card shows: folder name, GitHub URL, detected languages, status badges
- Status badges: "New" (green), "Already in Archon" (yellow, unchecked by default), "No Remote" (gray)
- Filter/search within results
- Summary bar: "23 selected of 47 found"

**Step 3: Configure & Apply**
- Template editor form with the `ScanTemplate` fields
- "Save as Default Template" option
- Review summary: "Will create 23 projects, crawl 23 GitHub READMEs"
- "Apply" button → progress tracking using existing `useProgress` pattern
- Per-project status updates as they're created

#### Query Hooks

```typescript
export const scannerKeys = {
  all: ["scanner"] as const,
  scan: (scanId: string) => [...scannerKeys.all, "scan", scanId] as const,
  templates: () => [...scannerKeys.all, "templates"] as const,
};

// useScanDirectory() - mutation
// useScanResults(scanId) - query
// useApplyScan() - mutation
// useScanTemplates() - query
// useSaveScanTemplate() - mutation
```

### 5. Navigation Integration

Add "Scanner" to the main navigation or as a sub-item under Projects. Options:
- **Dedicated page**: `/scanner` with its own nav item (icon: `FolderSearch`)
- **Projects sub-action**: Button in ProjectHeader "Scan Local Projects" that opens a modal/drawer

**Recommendation**: Start with a dedicated page accessible from the sidebar. It's a distinct workflow that benefits from full-page real estate.

---

## Data Flow: End-to-End

1. **User navigates to Scanner page**
2. **User enters directory path** (e.g. `/home/user/projects`) → `POST /api/scanner/scan`
3. **Backend scans directory** → Returns `ScanResult` with list of `DetectedProject`s
4. **User reviews results** — checks/unchecks projects, sees duplicates highlighted
5. **User configures template** — toggles crawling options, metadata preferences
6. **User clicks "Apply"** → `POST /api/scanner/apply` with selected projects + template
7. **Backend creates projects** sequentially (to avoid overwhelming the DB):
   - For each selected project:
     a. Call `ProjectService.create_project()` with title, github_repo, tags
     b. If `crawl_github_readme` is enabled, initiate a crawl via `CrawlingService`
     c. If `set_github_repo` is enabled, set the github_repo URL
     d. Link knowledge sources via `SourceLinkingService`
   - Track progress via `ProgressTracker` (existing pattern)
8. **Frontend polls progress** via existing `GET /api/progress/{operation_id}` pattern
9. **User sees results** — success/failure per project, links to view created projects

---

## Edge Cases & Error Handling

### Scan Phase
- **Path doesn't exist** → Return clear error: "Directory not found: /path/to/dir"
- **Permission denied** → Return clear error with path
- **Empty directory** → Return empty results with message
- **Very large directory (1000+ subdirs)** → Limit scan depth, paginate results, warn user
- **Symlinks** → Follow symlinks for `.git/` detection but don't recurse into symlinked trees
- **Non-GitHub remotes (GitLab, Bitbucket)** → Still detect as Git repo, flag as "Non-GitHub" but include. Set `github_url: null`

### Apply Phase
- **Duplicate project name** → Append suffix (e.g. "my-app-2") or skip with warning
- **Crawl rate limiting** → Queue crawls with the existing `crawl_semaphore` (max 3 concurrent)
- **Partial failure** → Continue creating remaining projects. Report failures in results. Don't roll back successful creates.
- **User cancels mid-apply** → Stop creating new projects. Already-created ones persist (user can delete manually).
- **GitHub repo is private** → README crawl will fail gracefully. Project still created without knowledge source.

### Docker Context
- **Scanner API called from Docker container** → Path is inside container, not host. Either:
  - Require volume mount of projects dir
  - Or prefer MCP tool path (recommended) which runs on host
- **MCP tool approach** → Path is host-native, no Docker issues

---

## Implementation Order

### Phase 1: Core Backend (Tasks 1-4)
1. **Git detector module** — `git_detector.py` with `DetectedProject` dataclass and directory scanning logic
2. **Scan template models** — `scan_template.py` with Pydantic models
3. **Scanner service** — `scanner_service.py` with scan and apply logic
4. **Scanner API routes** — `scanner_api.py` with REST endpoints, registered in `main.py`

### Phase 2: MCP Integration (Task 5)
5. **MCP scanner tools** — `scan_local_projects` and `apply_scan_template` tools for Claude Code

### Phase 3: Frontend (Tasks 6-10)
6. **Types and services** — `types/index.ts` and `scannerService.ts`
7. **Query hooks** — `useScannerQueries.ts`
8. **Step 1 component** — `ScanDirectoryForm.tsx`
9. **Step 2 components** — `ScanResultsList.tsx` + `ScanResultCard.tsx`
10. **Step 3 components** — `ScanTemplateEditor.tsx` + `ScanApplyProgress.tsx`
11. **Main view** — `ScannerView.tsx` orchestrating the wizard
12. **Navigation** — Add scanner page to router and sidebar

### Phase 4: Polish (Tasks 13-14)
13. **Template persistence** — Save/load templates via API
14. **Tests** — Backend unit tests for git_detector, scanner_service; Frontend tests for hooks

---

## File Inventory

### New Files
| File | Purpose |
|------|---------|
| `python/src/server/services/scanner/__init__.py` | Module init |
| `python/src/server/services/scanner/git_detector.py` | Git repo detection |
| `python/src/server/services/scanner/scan_template.py` | Template models |
| `python/src/server/services/scanner/scanner_service.py` | Core orchestration |
| `python/src/server/api_routes/scanner_api.py` | REST endpoints |
| `python/src/mcp_server/features/scanner/__init__.py` | MCP module init |
| `python/src/mcp_server/features/scanner/scanner_tools.py` | MCP tools |
| `archon-ui-main/src/features/scanner/components/ScanDirectoryForm.tsx` | Path input |
| `archon-ui-main/src/features/scanner/components/ScanResultsList.tsx` | Results list |
| `archon-ui-main/src/features/scanner/components/ScanResultCard.tsx` | Result card |
| `archon-ui-main/src/features/scanner/components/ScanTemplateEditor.tsx` | Template form |
| `archon-ui-main/src/features/scanner/components/ScanApplyProgress.tsx` | Progress view |
| `archon-ui-main/src/features/scanner/components/index.ts` | Barrel export |
| `archon-ui-main/src/features/scanner/hooks/useScannerQueries.ts` | Query hooks |
| `archon-ui-main/src/features/scanner/services/scannerService.ts` | API service |
| `archon-ui-main/src/features/scanner/types/index.ts` | TypeScript types |
| `archon-ui-main/src/features/scanner/views/ScannerView.tsx` | Main view |
| `python/tests/server/services/scanner/test_git_detector.py` | Detector tests |
| `python/tests/server/services/scanner/test_scanner_service.py` | Service tests |

### Modified Files
| File | Change |
|------|--------|
| `python/src/server/main.py` | Register scanner_api router |
| `python/src/mcp_server/features/__init__.py` | Register scanner tools |
| `archon-ui-main/src/pages/` | Add ScannerPage |
| `archon-ui-main/src/App.tsx` (or router config) | Add /scanner route |
| Sidebar/navigation component | Add Scanner nav item |

---

## Questions & Decisions to Confirm

1. **Filesystem access strategy**: MCP tool (recommended) vs Docker volume mount vs both?
2. **Navigation placement**: Dedicated sidebar item vs sub-action under Projects?
3. **Template persistence**: Store in Supabase or local config file?
4. **Crawl scope**: Just README crawl, or also offer full GitHub docs crawl?
5. **AI description generation**: Include in v1 or defer? (Requires LLM provider configured)
6. **Archon Setup integration**: Should applying the scan also run the equivalent of `archonSetup` for each project (MCP registration, skill installation)?
