# Journey Test — Local Project Scanner (Bulk Onboarding)

## User Persona

**Alex** is a senior developer with 30+ local repositories in `~/projects/`. Alex has been using
Archon for one project and wants to onboard everything at once rather than running `/archon-setup`
in each project individually.

Alex's projects directory looks like this:

```
~/projects/
├── standalone-api/              # GitHub repo (Node.js + Express)
├── ml-pipeline/                 # GitHub repo (Python + Docker)
├── personal-site/               # GitHub repo (Next.js + Vercel)
├── local-experiments/           # No git remote (local only)
├── company-internal/            # GitLab repo (not GitHub)
├── RecipeRaiders_Complete/      # NOT a git repo — project group
│   ├── RecipeRaiders/           # GitHub repo (React + Firebase)
│   ├── reciperaiders-dashboard/ # GitHub repo (React admin panel)
│   ├── reciperaiders-api/       # GitHub repo (Python FastAPI)
│   └── SEOMarketingAutomation/  # GitHub repo (Python)
├── archon/                      # GitHub repo (already in Archon)
└── node_modules/                # NOT a git repo, skip
```

**Machine:** `DEV_WORKSTATION` (Ubuntu 22.04, WSL2)
**Archon instance:** `http://localhost:3737` (local Docker deployment)

---

## Prerequisites

Before starting this journey, the following must already be in place:

- [ ] Archon stack running (`docker compose up --build -d`)
- [ ] Archon MCP server accessible at `http://localhost:8051`
- [ ] Claude Code CLI installed
- [ ] At least one project already set up with `/archon-setup` (system registered)
- [ ] Archon MCP endpoint configured globally (`claude mcp add archon ...`)
- [ ] The `archon` project already exists in Archon (for duplicate detection testing)

---

## Phase 0 — Enable the Scanner

### 0.1 Configure the Docker Volume Mount

The scanner needs read/write access to the projects directory via a Docker bind mount.

1. Open `.env` at the Archon root directory
2. Add or update these two lines:

```bash
PROJECTS_DIRECTORY=~/projects
SCANNER_ENABLED=true
```

3. Restart Docker:

```bash
docker compose down && docker compose up --build -d
```

**Expected:** Docker starts without errors. The `archon-server` container has
`/projects` mounted from `~/projects` on the host.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 0.1a | `.env` has `PROJECTS_DIRECTORY` | Line present with correct path | |
| 0.1b | `.env` has `SCANNER_ENABLED=true` | Line present | |
| 0.1c | Docker starts clean | No errors in `docker compose logs archon-server` | |
| 0.1d | Volume mount works | `docker exec archon-server ls /projects` shows project directories | |

### 0.2 Verify Scanner API is Enabled

```bash
curl -s http://localhost:8181/api/scanner/templates | python3 -m json.tool
```

**Expected:** Returns `{"templates": []}` (empty list, but 200 OK — scanner is enabled).

If scanner is disabled, this returns 503 with an error message about enabling.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 0.2a | Scanner API responds | 200 OK, not 503 | |

---

## Phase 1 — Scan the Projects Directory

### 1.1 Invoke the Scanner via Claude Code

Open Claude Code from **any project that already has Archon MCP configured** (or from any
directory if MCP is configured globally).

> "Scan my local projects directory for Git repositories that aren't in Archon yet."

Claude Code should invoke the `scan_local_projects` MCP tool.

**Expected behavior:**
1. Claude reads `archon-state.json` to get `system_fingerprint`
2. Calls `scan_local_projects(system_fingerprint="...")`
3. The scanner backend scans `/projects/` inside the Docker container
4. Returns a JSON result with scan_id, project list, and summary

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.1a | MCP tool invoked | `scan_local_projects` appears in tool call | |
| 1.1b | system_fingerprint passed | Non-empty string from archon-state.json | |
| 1.1c | Scan completes without error | No error response from MCP tool | |
| 1.1d | scan_id returned | Non-empty UUID string | |

### 1.2 Verify Scan Results — Summary Statistics

Claude should display a summary like:

```
Scan complete!
- Total repositories found: 9
- New projects: 7
- Already in Archon: 1 (archon)
- Project groups: 1 (RecipeRaiders_Complete)
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.2a | Total count correct | Matches actual git repos in ~/projects | |
| 1.2b | Already-in-Archon detected | `archon` flagged as existing (matched by GitHub URL) | |
| 1.2c | Project group detected | `RecipeRaiders_Complete` identified as a group | |
| 1.2d | Group children found | 4 repos inside RecipeRaiders_Complete | |

### 1.3 Verify Scan Results — Per-Project Details

Each project in the results should include:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.3a | `standalone-api` | `github_url` present, `detected_languages: ["javascript"]`, `project_indicators: ["node"]` | |
| 1.3b | `ml-pipeline` | `infra_markers` includes `"docker"`, `project_indicators: ["python"]` | |
| 1.3c | `personal-site` | `infra_markers` includes `"vercel"` if `vercel.json` exists | |
| 1.3d | `local-experiments` | `github_url: null`, `git_remote_url: null` (no remote) | |
| 1.3e | `company-internal` | `git_remote_url` is GitLab URL, `github_url: null` | |
| 1.3f | `RecipeRaiders` | `group_name: "RecipeRaiders_Complete"`, `has_readme: true` | |
| 1.3g | `archon` | `already_in_archon: true`, `existing_project_id` is a UUID | |
| 1.3h | `node_modules` | NOT in results (in skip list) | |

### 1.4 Verify Dependency and Infrastructure Capture

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.4a | npm deps extracted | `standalone-api` has `dependencies.npm` with package names | |
| 1.4b | pip deps extracted | `ml-pipeline` has `dependencies.pip` with package names | |
| 1.4c | Docker detected | Projects with `Dockerfile` or `docker-compose.yml` have `"docker"` in `infra_markers` | |
| 1.4d | GitHub Actions detected | Projects with `.github/workflows/` have `"github-actions"` in `infra_markers` | |
| 1.4e | README excerpt present | Projects with README.md have `readme_excerpt` (first 5000 chars) | |

### 1.5 Verify Non-GitHub and No-Remote Handling

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.5a | GitLab repo detected | `company-internal` has `git_remote_url` but `github_url: null` | |
| 1.5b | No-remote repo detected | `local-experiments` has both fields null | |
| 1.5c | Both still in scan results | Not filtered out during scan — only during apply | |

### 1.6 Verify Scan Persisted to Database

```bash
# Check scan_results table
curl -s http://localhost:8181/api/scanner/results/<SCAN_ID> | python3 -m json.tool
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.6a | Scan result in DB | `status: "pending"`, `total_found` matches | |
| 1.6b | Projects in DB | All detected projects have rows in response | |
| 1.6c | Expiry set | `expires_at` is ~24 hours from `created_at` | |

---

## Phase 2 — AI Description Generation

### 2.1 Claude Generates Descriptions

After receiving scan results with README excerpts, Claude Code should generate descriptions.

> "Generate a short 1-2 sentence description for each new project based on their READMEs."

**Expected:** Claude reads the `readme_excerpt` for each project and generates concise descriptions.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 2.1a | Descriptions generated | Claude produces descriptions for projects with READMEs | |
| 2.1b | No-README projects | Skipped or given generic description based on project indicators | |
| 2.1c | Quality check | Descriptions accurately reflect project purpose from README | |

### 2.2 User Reviews and Approves

Claude should present the project list with descriptions for user confirmation before applying.

> "Here are the 7 new projects I'll set up in Archon:
> 1. standalone-api — A REST API for managing inventory data with Express.js
> 2. ml-pipeline — Machine learning data processing pipeline using scikit-learn
> ..."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 2.2a | Confirmation prompt | Claude asks user to confirm before proceeding | |
| 2.2b | All new projects listed | 7 projects (excluding `archon` which is existing) | |
| 2.2c | Descriptions shown | Each project has its AI-generated description | |
| 2.2d | Existing projects noted | `archon` mentioned as "already in Archon, will be skipped" | |

---

## Phase 3 — Apply the Scan Template

### 3.1 Apply with Default Template

After user confirms:

> "Yes, go ahead and set them all up."

Claude should invoke `apply_scan_template` MCP tool.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.1a | MCP tool invoked | `apply_scan_template` called with correct scan_id | |
| 3.1b | system_fingerprint passed | Matches the scan's fingerprint | |
| 3.1c | system_name passed | e.g., `"DEV_WORKSTATION"` | |
| 3.1d | descriptions passed | Dict of `directory_name -> description` | |

### 3.2 Verify Default Template Behavior

With `require_github_remote: true` (default), the following should be filtered:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.2a | `local-experiments` skipped | Status `"skipped"`, error: `"No remote"` | |
| 3.2b | `company-internal` skipped | Status `"skipped"`, error: `"Non-GitHub remote"` | |
| 3.2c | `archon` skipped | Already in Archon — `"duplicate_skipped"` or not in selected list | |
| 3.2d | 6 projects created | standalone-api, ml-pipeline, personal-site, RecipeRaiders, reciperaiders-dashboard, reciperaiders-api, SEOMarketingAutomation (if all have GitHub remotes) | |

### 3.3 Verify Project Group Parent Creation

With `create_group_parents: true` (default):

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.3a | Group parent created | `RecipeRaiders_Complete` project exists in Archon | |
| 3.3b | Parent has no github_repo | `github_repo` is null | |
| 3.3c | Parent tagged | Tags include `"project-group"` | |
| 3.3d | Children linked | Child projects have `parent_project_id` set to the group parent | |
| 3.3e | Group metadata | Children have `metadata.project_group: "RecipeRaiders_Complete"` | |

### 3.4 Verify Per-Project Creation

For each created project, check in the Archon UI (Projects page) or via API:

```bash
curl -s http://localhost:8181/api/projects | python3 -m json.tool
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.4a | Project title | Matches directory name | |
| 3.4b | github_repo set | Normalized GitHub URL (e.g., `https://github.com/user/repo`) | |
| 3.4c | Description set | Matches the AI-generated description | |
| 3.4d | Tags include languages | e.g., `["javascript", "docker"]` for standalone-api | |
| 3.4e | Tags include infra | Infrastructure markers merged into tags | |
| 3.4f | Metadata has dependencies | `metadata.dependencies` contains extracted dep names | |

---

## Phase 4 — Verify Config Files Written

### 4.1 Check a Standalone Project

```bash
cd ~/projects/standalone-api
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.1a | `.claude/` directory exists | Created by scanner | |
| 4.1b | `archon-config.json` present | Valid JSON | |
| 4.1c | `archon-config.json` content | `archon_api_url`, `archon_mcp_url`, `project_id`, `installed_by: "scanner"` | |
| 4.1d | `archon-state.json` present | Valid JSON with `system_fingerprint`, `system_name`, `archon_project_id` | |
| 4.1e | `settings.local.json` present | Contains `hooks.PostToolUse` with observation hook command | |
| 4.1f | `.gitignore` updated | Contains `# Archon` section with `.claude/plugins/`, `.claude/skills/`, etc. | |
| 4.1g | Extensions installed | `.claude/skills/` directory exists with extension files | |

### 4.2 Check archon-config.json Details

```bash
cat ~/projects/standalone-api/.claude/archon-config.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.2a | `archon_api_url` | `"http://localhost:8181"` (from default template) | |
| 4.2b | `archon_mcp_url` | `"http://localhost:8051"` (from default template) | |
| 4.2c | `project_id` | Non-empty UUID matching the created project | |
| 4.2d | `installed_by` | `"scanner"` (not `"setup"`) | |
| 4.2e | `extensions_hash` | Non-empty SHA-256 hash string | |
| 4.2f | `extensions_installed_at` | ISO timestamp | |

### 4.3 Check archon-state.json Details

```bash
cat ~/projects/standalone-api/.claude/archon-state.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.3a | `system_fingerprint` | Matches fingerprint from /archon-setup | |
| 4.3b | `system_name` | `"DEV_WORKSTATION"` | |
| 4.3c | `archon_project_id` | Same UUID as archon-config.json's project_id | |

### 4.4 Check a Group Child Project

```bash
cat ~/projects/RecipeRaiders_Complete/RecipeRaiders/.claude/archon-config.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.4a | Config written | File exists with valid JSON | |
| 4.4b | Project ID correct | Matches the RecipeRaiders project in Archon | |
| 4.4c | Extensions installed | `.claude/skills/` present | |

### 4.5 Verify .gitignore Idempotency

Run the scanner apply again (or manually check):

```bash
grep -c "# Archon" ~/projects/standalone-api/.gitignore
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.5a | No duplicate entries | `"# Archon"` appears exactly once | |
| 4.5b | Original entries preserved | Any pre-existing `.gitignore` entries still present | |

### 4.6 Verify Skipped Projects Have No Config Files

```bash
ls ~/projects/local-experiments/.claude/ 2>&1
ls ~/projects/company-internal/.claude/ 2>&1
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.6a | local-experiments | No `.claude/` directory (project was skipped) | |
| 4.6b | company-internal | No `.claude/` directory (project was skipped) | |

---

## Phase 5 — Verify Knowledge Base Ingestion

### 5.1 README Ingested as Knowledge Document

For each created project with a README, the scanner should have stored the full README
content in the Archon knowledge base.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 5.1a | Document exists | Query `documents` table for `metadata.origin = "scanner"` and `metadata.file = "README.md"` | |
| 5.1b | Content is full README | Not truncated to 5000 chars — full content stored | |
| 5.1c | Project linked | `metadata.project_id` matches the created project | |

### 5.2 GitHub README Crawl Queued

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 5.2a | Crawl sources created | Knowledge sources exist for each GitHub project's README URL | |
| 5.2b | Crawl URL format | `https://github.com/{owner}/{repo}#readme` | |
| 5.2c | Private repos handled | If crawl fails (404), project still created — only crawl fails | |

### 5.3 RAG Search Across Scanned Projects

In Claude Code, test searching across the newly ingested knowledge:

> "Search the Archon knowledge base for information about recipe management."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 5.3a | Results returned | RAG search finds content from RecipeRaiders README | |
| 5.3b | Cross-project search works | Results may include multiple RecipeRaiders sub-projects | |

---

## Phase 6 — Verify Scan Report

### 6.1 CSV Report Generated

The scanner should have generated a CSV report after apply completed.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 6.1a | CSV file exists | `~/projects/.archon-scan-report-<SCAN_ID>.csv` on host filesystem | |
| 6.1b | Claude displays summary | Human-readable summary shown in conversation | |

### 6.2 CSV Report Content

Open the CSV file:

```bash
cat ~/projects/.archon-scan-report-*.csv
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 6.2a | Header comments | Summary block at top starting with `# Archon Local Project Scanner Report` | |
| 6.2b | Scan ID in header | Matches the scan_id from Phase 1 | |
| 6.2c | Column headers | `directory_name,host_path,github_url,group_name,detected_languages,status,...` | |
| 6.2d | Created projects | Status `"created"` for each successfully set up project | |
| 6.2e | Skipped projects | Status `"skipped_non_github"` for GitLab repo, `"skipped_no_remote"` for local-only | |
| 6.2f | Existing projects | Status `"skipped_existing"` for archon | |
| 6.2g | Crawl status column | `"queued"` for created projects with GitHub URL, `"n/a"` otherwise | |
| 6.2h | Group names | RecipeRaiders sub-projects show `RecipeRaiders_Complete` in group_name column | |

### 6.3 Report API Endpoint

```bash
curl -s http://localhost:8181/api/scanner/report/<SCAN_ID> | python3 -m json.tool
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 6.3a | Summary returned | `summary` field with human-readable text | |
| 6.3b | CSV path returned | `csv_path` field with file path | |

---

## Phase 7 — Duplicate Prevention and Idempotency

### 7.1 Re-Scan Does Not Duplicate

Run the scan again:

> "Scan my projects directory again."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 7.1a | Previously-created projects flagged | `already_in_archon: true` for all projects set up in Phase 3 | |
| 7.1b | archon still flagged | Still `already_in_archon: true` | |
| 7.1c | New project count is 0 | `new_projects: 0` (assuming no new repos added) | |

### 7.2 Re-Apply Is Safe (Crash Recovery)

If the user tries to apply the same scan again:

> "Apply the scan template to the scanned projects."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 7.2a | Resume detected | Message indicates all projects already set up | |
| 7.2b | No duplicate projects | No new projects created in Archon | |
| 7.2c | Config files intact | Existing `.claude/` files not corrupted | |

### 7.3 URL Normalization Deduplication

If the archon project in Archon has `github_repo: "git@github.com:coleam00/Archon.git"` and
the scanner finds `https://github.com/coleam00/Archon`, these should be matched as the same project.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 7.3a | SSH and HTTPS match | Same project, different URL formats → `already_in_archon: true` | |
| 7.3b | Case insensitive | `GitHub.com/User/Repo` matches `github.com/user/repo` | |
| 7.3c | .git suffix stripped | `repo.git` matches `repo` | |

---

## Phase 8 — Custom Template

### 8.1 Apply with Custom Settings

Test with a non-default template:

> "Set up my scanned projects but skip extensions installation and don't crawl GitHub READMEs."

Claude should call `apply_scan_template` with a custom template:
```json
{
  "install_extensions": false,
  "crawl_github_readme": false,
  "require_github_remote": false
}
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.1a | Custom template applied | Extensions not installed for these projects | |
| 8.1b | No crawls started | No knowledge source crawl jobs queued | |
| 8.1c | Non-GitHub included | `company-internal` (GitLab) and `local-experiments` now included | |

### 8.2 Save and Retrieve Templates

```bash
# Save a template
curl -s -X POST http://localhost:8181/api/scanner/templates \
  -H "Content-Type: application/json" \
  -d '{"name": "No Crawl", "template": {"crawl_github_readme": false}, "is_default": false}' \
  | python3 -m json.tool

# List templates
curl -s http://localhost:8181/api/scanner/templates | python3 -m json.tool
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.2a | Template saved | Returns template with `id` | |
| 8.2b | Template listed | Appears in templates list | |

### 8.3 Custom Archon URLs in Template

For users running Archon on non-default ports:

```json
{
  "archon_api_url": "http://archon.local:9999",
  "archon_mcp_url": "http://archon.local:9051"
}
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.3a | Custom URLs in config | `archon-config.json` reflects the custom URLs | |
| 8.3b | All projects consistent | Every project gets the same URLs from the template | |

---

## Phase 9 — Edge Cases

### 9.1 Scanner Disabled

Set `SCANNER_ENABLED=false` in `.env` and restart Docker.

```bash
curl -s http://localhost:8181/api/scanner/scan \
  -H "Content-Type: application/json" \
  -d '{"system_fingerprint": "test"}' \
  | python3 -m json.tool
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.1a | 503 returned | Status code 503 | |
| 9.1b | Clear error message | Explains how to enable scanner | |

### 9.2 Unregistered System

Use a fake fingerprint that doesn't match any registered system:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.2a | Error returned | "System not registered. Run /archon-setup in any project first." | |
| 9.2b | No scan created | No rows added to archon_scan_results | |

### 9.3 Large Directory Warning

If the projects directory has 500+ subdirectories:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.3a | Scan completes | Does not crash or timeout | |
| 9.3b | Warning present | Results include a warning about large directory | |

### 9.4 Expired Scan

Wait 24 hours (or manually set `expires_at` to a past timestamp in the DB), then try to apply:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.4a | Error returned | "Scan expired. Please run a new scan." | |
| 9.4b | Scan status updated | `status` set to `"expired"` in DB | |

### 9.5 Empty Directory

Point the scanner at an empty subdirectory:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.5a | No error | Scan completes successfully | |
| 9.5b | Zero results | `total_found: 0`, empty projects list | |

### 9.6 Permission Denied

If a subdirectory is not readable:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.6a | Clear error | Error message includes the specific path | |
| 9.6b | Other projects unaffected | If only one subdir is unreadable, others still scanned | |

---

## Phase 10 — Post-Scanner Workflow Validation

### 10.1 Open Claude Code in a Scanned Project

```bash
cd ~/projects/standalone-api
claude
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 10.1a | archon-context injected | SessionStart hook runs and injects `<archon-context>` | |
| 10.1b | Project recognized | Context shows `## Project: standalone-api` with correct project ID | |
| 10.1c | System registered | System is linked to this project | |
| 10.1d | Extensions available | Extension skills available in Claude Code | |
| 10.1e | Observation hook active | PostToolUse hook fires (check for `archon-memory-buffer.jsonl` creation) | |

### 10.2 Open Claude Code in a Group Child Project

```bash
cd ~/projects/RecipeRaiders_Complete/RecipeRaiders
claude
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 10.2a | Correct project context | Shows RecipeRaiders project, not the group parent | |
| 10.2b | Config files valid | archon-config.json and archon-state.json both correct | |

### 10.3 Verify Archon UI Shows All Projects

Open `http://localhost:3737` and navigate to Projects.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 10.3a | All created projects visible | standalone-api, ml-pipeline, personal-site, RecipeRaiders, etc. | |
| 10.3b | Group parent visible | RecipeRaiders_Complete listed as a project | |
| 10.3c | Descriptions shown | AI-generated descriptions appear on project cards | |
| 10.3d | Tags populated | Language and infrastructure tags visible | |

### 10.4 Verify Knowledge Sources in Archon UI

Navigate to Knowledge in the Archon UI.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 10.4a | Sources listed | GitHub README sources for each created project | |
| 10.4b | Crawl status | Shows processing/completed status for README crawls | |

---

## Phase 11 — Extension Version Tracking

### 11.1 Verify Extension Hash Consistency

All projects set up in a single scan should have the same extensions hash (they all
received the same tarball).

```bash
for dir in ~/projects/standalone-api ~/projects/ml-pipeline ~/projects/personal-site; do
  echo "$(basename $dir): $(cat $dir/.claude/archon-config.json | python3 -c 'import json,sys; print(json.load(sys.stdin).get("extensions_hash","N/A"))')"
done
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 11.1a | Hashes match | All projects from same scan have identical `extensions_hash` | |
| 11.1b | Timestamps close | `extensions_installed_at` within seconds of each other | |

---

## Phase 12 — Cleanup and Scan Expiry

### 12.1 Scan Result Cleanup

After 24 hours, expired scans should be cleaned up automatically.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 12.1a | Cleanup runs | Check server logs for "Cleaned up X expired scan(s)" | |
| 12.1b | Applied scans preserved | Scans with `status: "applied"` are NOT deleted | |
| 12.1c | Expired pending scans deleted | Unapplied scans past 24h are removed | |
| 12.1d | CASCADE delete | `archon_scan_projects` rows deleted along with parent scan | |

### 12.2 CSV Report Persists

Even after scan DB rows are cleaned up, the CSV file remains on disk.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 12.2a | CSV still on disk | `~/projects/.archon-scan-report-*.csv` still exists | |
| 12.2b | Created projects unaffected | Projects in Archon are permanent — not tied to scan lifecycle | |

---

## Test Results Summary

| Phase | Description | Checks | Pass | Fail | Skip |
|-------|-------------|--------|------|------|------|
| 0 | Enable Scanner | 5 | | | |
| 1 | Scan Directory | 20 | | | |
| 2 | AI Descriptions | 6 | | | |
| 3 | Apply Template | 14 | | | |
| 4 | Config Files | 14 | | | |
| 5 | Knowledge Base | 5 | | | |
| 6 | Scan Report | 11 | | | |
| 7 | Duplicate Prevention | 9 | | | |
| 8 | Custom Template | 7 | | | |
| 9 | Edge Cases | 10 | | | |
| 10 | Post-Scanner Workflow | 9 | | | |
| 11 | Extension Versions | 2 | | | |
| 12 | Cleanup & Expiry | 6 | | | |
| **Total** | | **118** | | | |

---

## Bugs Found

| # | Phase | Severity | Description | Status |
|---|-------|----------|-------------|--------|
| | | | | |

---

## Notes

- This journey assumes all Git repos have standard directory structures
- The scanner runs via Docker volume mount — file permissions depend on Docker config
- Private GitHub repos will have README crawl failures but projects are still created
- The scanner is designed as a one-time bulk onboarding tool; new projects use `/archon-setup`
