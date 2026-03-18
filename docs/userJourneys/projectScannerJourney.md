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
- [ ] Python 3 available on the local machine (`python3 --version`)

---

## Phase 0 — Verify Prerequisites

### 0.1 Confirm Archon is Running

```bash
curl -s http://localhost:8181/health
```

**Expected:** Returns `{"status": "ok"}` or similar health response.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 0.1a | Archon API responds | 200 OK from health endpoint | |
| 0.1b | MCP server responds | `curl http://localhost:8051/health` returns 200 OK | |

### 0.2 Verify Scanner Script Endpoint

```bash
curl -s http://localhost:8181/api/scanner/script | head -1
```

**Expected:** First line is `#!/usr/bin/env python3` — the scanner script is downloadable.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 0.2a | Script endpoint responds | 200 OK, not 404 | |
| 0.2b | Script is valid Python | First line is `#!/usr/bin/env python3` | |

### 0.3 Verify Python Available Locally

```bash
python3 --version
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 0.3a | Python 3 available | Version 3.8 or higher | |

---

## Phase 1 — Scan the Projects Directory

### 1.1 Invoke the Scanner via the `/scan-projects` Skill

Open Claude Code from **any project that already has Archon MCP configured** (or from any
directory if MCP is configured globally).

> "Scan my local projects directory for Git repositories that aren't in Archon yet."

Claude Code should invoke the `/scan-projects` skill. The skill will:
1. Download `archon-scanner.py` from `GET /api/scanner/script`
2. Ask Alex which directory to scan
3. Run `python3 archon-scanner.py --scan ~/projects`
4. Parse and display the JSON results

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.1a | Skill invoked | `/scan-projects` skill appears in tool call | |
| 1.1b | Script downloaded | `archon-scanner.py` fetched from `GET /api/scanner/script` | |
| 1.1c | Directory prompt shown | Skill asks for the projects directory path | |
| 1.1d | Script runs successfully | `python3 archon-scanner.py --scan ~/projects` exits without error | |

### 1.2 Verify Scan Output — JSON Structure

The scanner script outputs JSON to stdout. The skill reads and parses this output.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.2a | Output is valid JSON | `json.loads(output)` succeeds | |
| 1.2b | `projects` key present | Top-level array of project objects | |
| 1.2c | `summary` key present | Top-level summary object with counts | |
| 1.2d | No scan_id in output | Client-side scanner has no DB persistence — no scan_id field | |

### 1.3 Verify Scan Results — Summary Statistics

Claude should display a summary like:

```
Scan complete!
- Total repositories found: 9
- New projects: 7
- Already in Archon: 1 (archon)
- Project groups detected: 1 (RecipeRaiders_Complete)
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.3a | Total count correct | Matches actual git repos in ~/projects | |
| 1.3b | Project group detected | `RecipeRaiders_Complete` identified as a group | |
| 1.3c | Group children found | 4 repos inside RecipeRaiders_Complete | |

### 1.4 Verify Scan Results — Per-Project Details

Each project object in the JSON should include:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.4a | `standalone-api` | `github_url` present, `detected_languages` includes `"javascript"` | |
| 1.4b | `ml-pipeline` | `infra_markers` includes `"docker"`, `detected_languages` includes `"python"` | |
| 1.4c | `personal-site` | `infra_markers` includes `"vercel"` if `vercel.json` exists | |
| 1.4d | `local-experiments` | `github_url: null`, `git_remote_url: null` (no remote) | |
| 1.4e | `company-internal` | `git_remote_url` is GitLab URL, `github_url: null` | |
| 1.4f | `RecipeRaiders` | `group_name: "RecipeRaiders_Complete"`, `has_readme: true` | |
| 1.4g | `node_modules` | NOT in results (in skip list) | |

### 1.5 Verify Dependency and Infrastructure Capture

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.5a | npm deps extracted | `standalone-api` has `dependencies.npm` with package names | |
| 1.5b | pip deps extracted | `ml-pipeline` has `dependencies.pip` with package names | |
| 1.5c | Docker detected | Projects with `Dockerfile` or `docker-compose.yml` have `"docker"` in `infra_markers` | |
| 1.5d | GitHub Actions detected | Projects with `.github/workflows/` have `"github-actions"` in `infra_markers` | |
| 1.5e | README excerpt present | Projects with README.md have `readme_excerpt` (first 5000 chars) | |

### 1.6 Verify Non-GitHub and No-Remote Handling

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 1.6a | GitLab repo detected | `company-internal` has `git_remote_url` but `github_url: null` | |
| 1.6b | No-remote repo detected | `local-experiments` has both fields null | |
| 1.6c | Both still in scan results | Not filtered during scan — decisions made during apply step | |

---

## Phase 2 — AI Description Generation

### 2.1 Claude Generates Descriptions

After receiving scan results with README excerpts, Claude Code should generate descriptions.

> "Generate a short 1-2 sentence description for each new project based on their READMEs."

**Expected:** Claude reads the `readme_excerpt` for each project and generates concise descriptions.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 2.1a | Descriptions generated | Claude produces descriptions for projects with READMEs | |
| 2.1b | No-README projects | Skipped or given generic description based on detected languages | |
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
| 2.2b | All new projects listed | Projects with GitHub remotes shown for creation | |
| 2.2c | Descriptions shown | Each project has its AI-generated description | |
| 2.2d | Existing projects noted | `archon` mentioned as "already in Archon, will be skipped" | |

---

## Phase 3 — Dedup and Create Projects

### 3.1 Skill Calls `find_projects` MCP for Deduplication

Before creating any project, the skill calls `find_projects` to get all existing Archon projects
and compares their `github_repo` URLs against the scanned projects' `github_url` fields.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.1a | `find_projects` MCP called | Tool call to `find_projects` visible | |
| 3.1b | URL comparison performed | Each scanned `github_url` checked against existing `github_repo` values | |
| 3.1c | `archon` flagged existing | `already_in_archon: true` for the `archon` repo (matched by GitHub URL) | |

### 3.2 URL Normalization During Dedup

The skill normalizes URLs before comparing so different formats match correctly.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.2a | SSH and HTTPS match | `git@github.com:coleam00/Archon.git` matches `https://github.com/coleam00/Archon` | |
| 3.2b | Case insensitive | `GitHub.com/User/Repo` matches `github.com/user/repo` | |
| 3.2c | `.git` suffix stripped | `repo.git` matches `repo` | |

### 3.3 Skill Filters and Creates via `manage_project` MCP

After dedup, the skill creates projects for new GitHub repos only (by default).

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.3a | `local-experiments` skipped | Not created — no GitHub remote | |
| 3.3b | `company-internal` skipped | Not created — GitLab remote, not GitHub | |
| 3.3c | `archon` skipped | Not created — already in Archon | |
| 3.3d | `manage_project` called per new project | One `manage_project(action="create")` call per new GitHub repo | |
| 3.3e | 6 projects created | standalone-api, ml-pipeline, personal-site, RecipeRaiders, reciperaiders-dashboard, reciperaiders-api, SEOMarketingAutomation | |

### 3.4 Verify Project Group Parent Creation

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.4a | Group parent created | `RecipeRaiders_Complete` project exists in Archon | |
| 3.4b | Parent has no github_repo | `github_repo` is null on the group parent | |
| 3.4c | Parent tagged | Tags include `"project-group"` | |
| 3.4d | Children linked | Child projects have `parent_project_id` set to the group parent | |

### 3.5 Verify Per-Project Fields in Archon

For each created project, check in the Archon UI (Projects page) or via API:

```bash
curl -s http://localhost:8181/api/projects | python3 -m json.tool
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 3.5a | Project title | Matches directory name | |
| 3.5b | `github_repo` set | Normalized GitHub URL (e.g., `https://github.com/user/repo`) | |
| 3.5c | Description set | Matches the AI-generated description | |
| 3.5d | Tags include languages | e.g., `["javascript", "docker"]` for standalone-api | |
| 3.5e | Tags include infra | Infrastructure markers merged into tags | |
| 3.5f | Metadata has dependencies | `metadata.dependencies` contains extracted dep names | |

---

## Phase 4 — Verify Config Files Written by Script

### 4.1 Apply Config Files via Script

After projects are created in Archon, the skill runs:

```bash
python3 archon-scanner.py --apply --payload-file /tmp/archon-scan-payload.json
```

The payload file contains the project IDs returned by the `manage_project` MCP calls.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.1a | `--apply` flag used | Script invoked with `--apply --payload-file` | |
| 4.1b | Payload file written | Temp file contains project ID mappings | |
| 4.1c | Script exits 0 | No errors from `--apply` run | |

### 4.2 Check a Standalone Project

```bash
cd ~/projects/standalone-api
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.2a | `.claude/` directory exists | Created by scanner | |
| 4.2b | `archon-config.json` present | Valid JSON | |
| 4.2c | `archon-config.json` content | Contains `archon_api_url`, `archon_mcp_url`, `project_id`, `installed_by: "scanner"` | |
| 4.2d | `archon-state.json` present | Valid JSON with `system_fingerprint`, `system_name`, `archon_project_id` | |
| 4.2e | `settings.local.json` present | Contains `hooks.PostToolUse` with observation hook command | |
| 4.2f | `.gitignore` updated | Contains `# Archon` section with `.claude/plugins/`, `.claude/skills/`, etc. | |

### 4.3 Check archon-config.json Details

```bash
cat ~/projects/standalone-api/.claude/archon-config.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.3a | `archon_api_url` | `"http://localhost:8181"` | |
| 4.3b | `archon_mcp_url` | `"http://localhost:8051"` | |
| 4.3c | `project_id` | Non-empty UUID matching the created project | |
| 4.3d | `installed_by` | `"scanner"` (not `"setup"`) | |

### 4.4 Check archon-state.json Details

```bash
cat ~/projects/standalone-api/.claude/archon-state.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.4a | `system_fingerprint` | Matches fingerprint from `/archon-setup` | |
| 4.4b | `system_name` | `"DEV_WORKSTATION"` | |
| 4.4c | `archon_project_id` | Same UUID as `archon-config.json`'s `project_id` | |

### 4.5 Check a Group Child Project

```bash
cat ~/projects/RecipeRaiders_Complete/RecipeRaiders/.claude/archon-config.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.5a | Config written | File exists with valid JSON | |
| 4.5b | Project ID correct | Matches the RecipeRaiders project in Archon | |
| 4.5c | `installed_by: "scanner"` | Scanner-provenance marker present | |

### 4.6 Verify .gitignore Idempotency

```bash
grep -c "# Archon" ~/projects/standalone-api/.gitignore
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.6a | No duplicate entries | `"# Archon"` appears exactly once | |
| 4.6b | Original entries preserved | Any pre-existing `.gitignore` entries still present | |

### 4.7 Verify Skipped Projects Have No Config Files

```bash
ls ~/projects/local-experiments/.claude/ 2>&1
ls ~/projects/company-internal/.claude/ 2>&1
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 4.7a | `local-experiments` | No `.claude/` directory (project was skipped) | |
| 4.7b | `company-internal` | No `.claude/` directory (project was skipped) | |

---

## Phase 5 — Verify Knowledge Base Ingestion

### 5.1 Skill Queues README Crawls via `manage_rag_source` MCP

For each created project with a GitHub URL, the skill calls `manage_rag_source` to queue
a README crawl.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 5.1a | `manage_rag_source` called | One call per created GitHub project | |
| 5.1b | Crawl URL format | `https://github.com/{owner}/{repo}#readme` | |
| 5.1c | Knowledge source created | Sources appear in Archon UI under Knowledge | |

### 5.2 Verify in Archon UI

Navigate to the Knowledge page at `http://localhost:3737`.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 5.2a | Sources listed | GitHub README sources for each created project visible | |
| 5.2b | Crawl status | Shows `processing` or `completed` status for README crawls | |
| 5.2c | Private repos handled | If crawl fails (404), project still created — only crawl fails | |

### 5.3 RAG Search Across Scanned Projects

In Claude Code, test searching across the newly ingested knowledge:

> "Search the Archon knowledge base for information about recipe management."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 5.3a | Results returned | RAG search finds content from RecipeRaiders README | |
| 5.3b | Cross-project search works | Results may include multiple RecipeRaiders sub-projects | |

---

## Phase 6 — Post-Scanner Workflow Validation

### 6.1 Open Claude Code in a Scanned Project

```bash
cd ~/projects/standalone-api
claude
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 6.1a | archon-context injected | SessionStart hook runs and injects `<archon-context>` | |
| 6.1b | Project recognized | Context shows `## Project: standalone-api` with correct project ID | |
| 6.1c | System registered | System is linked to this project | |
| 6.1d | Observation hook active | PostToolUse hook fires (check for `archon-memory-buffer.jsonl` creation) | |

### 6.2 Open Claude Code in a Group Child Project

```bash
cd ~/projects/RecipeRaiders_Complete/RecipeRaiders
claude
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 6.2a | Correct project context | Shows RecipeRaiders project, not the group parent | |
| 6.2b | Config files valid | `archon-config.json` and `archon-state.json` both readable and correct | |

### 6.3 Verify Archon UI Shows All Projects

Open `http://localhost:3737` and navigate to Projects.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 6.3a | All created projects visible | standalone-api, ml-pipeline, personal-site, RecipeRaiders, etc. | |
| 6.3b | Group parent visible | RecipeRaiders_Complete listed as a project | |
| 6.3c | Descriptions shown | AI-generated descriptions appear on project cards | |
| 6.3d | Tags populated | Language and infrastructure tags visible | |

---

## Phase 7 — Duplicate Prevention and Idempotency

### 7.1 Re-Run `/scan-projects` Does Not Duplicate

Run the skill again:

> "Scan my projects directory again."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 7.1a | Skill re-downloads script | Fresh `archon-scanner.py` fetched | |
| 7.1b | Scan runs successfully | Script exits without error | |
| 7.1c | `find_projects` called again | Dedup check runs against current Archon state | |
| 7.1d | All previously-created projects flagged | `already_in_archon: true` for all projects set up in Phase 3 | |
| 7.1e | `archon` still flagged | Still `already_in_archon: true` | |
| 7.1f | New project count is 0 | No new `manage_project` calls made (assuming no new repos added) | |

### 7.2 Re-Apply Is Safe

If the user asks to re-apply config files:

> "Write the config files again for my scanned projects."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 7.2a | No duplicate projects | No new projects created in Archon | |
| 7.2b | Config files intact | Existing `.claude/` files not corrupted by re-apply | |
| 7.2c | `.gitignore` not duplicated | `# Archon` section still appears exactly once | |

---

## Phase 8 — Edge Cases

### 8.1 Python Not Found

On a machine where `python3` is not installed:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.1a | Clear error shown | Skill reports "Python 3 is required. Please install it and try again." | |
| 8.1b | Instructions provided | Skill gives install instructions for the detected OS | |
| 8.1c | No partial state left | No temp files or partial Archon state created | |

### 8.2 Archon Not Running

Simulate by stopping Archon, then invoking `/scan-projects`:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.2a | Script download fails | Clear error: "Cannot reach Archon at http://localhost:8181" | |
| 8.2b | Skill aborts cleanly | Does not attempt to continue | |

### 8.3 Empty Directory

Point the scanner at an empty subdirectory:

```bash
mkdir ~/projects/empty-test
```

> "Scan ~/projects/empty-test"

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.3a | No error | Scan completes successfully | |
| 8.3b | Zero results | Summary shows `Total repositories found: 0` | |
| 8.3c | No MCP calls made | No `manage_project` calls (nothing to create) | |

### 8.4 Permission Denied

If a subdirectory is not readable:

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.4a | Clear error in output | Error message includes the specific unreadable path | |
| 8.4b | Other projects unaffected | If only one subdir is unreadable, others still scanned | |

### 8.5 Non-GitHub Remotes Handled Gracefully

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 8.5a | GitLab remote reported | `git_remote_url` present, `github_url: null` | |
| 8.5b | Skill explains skip | Claude tells user these repos were skipped and why | |
| 8.5c | User can override | If user requests it, skill can create projects for non-GitHub repos too | |

---

## Phase 9 — Multi-System Registration (Key New Test)

This phase validates the primary motivation for the client-side architecture: multiple machines
can run `/scan-projects` against the same Archon instance, each registering their own system's
projects independently.

### 9.1 Setup: Second System

Alex has a MacBook Pro (`MACBOOK_M1`) that also runs Claude Code and points at the same
Archon instance at `http://192.168.1.100:8181` (reachable over the local network).

The MacBook has a different set of local projects:

```
~/projects/
├── ios-client/          # GitHub repo (Swift + SwiftUI)
├── data-viz/            # GitHub repo (Python + Plotly)
├── archon/              # GitHub repo (same repo — already in Archon from DEV_WORKSTATION)
└── ml-pipeline/         # GitHub repo (same repo — already in Archon from DEV_WORKSTATION)
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.1a | `/archon-setup` run on MacBook | System `MACBOOK_M1` registered in Archon | |
| 9.1b | `archon-state.json` has unique fingerprint | Different `system_fingerprint` from DEV_WORKSTATION | |
| 9.1c | MCP endpoint configured | Archon MCP reachable from MacBook at `http://192.168.1.100:8051` | |

### 9.2 Run `/scan-projects` on MacBook

On the MacBook, invoke the skill:

> "Scan my local projects directory."

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.2a | Script downloaded from remote Archon | `GET http://192.168.1.100:8181/api/scanner/script` succeeds | |
| 9.2b | Scan runs locally on MacBook | Script scans MacBook's `~/projects/`, not DEV_WORKSTATION's | |
| 9.2c | `find_projects` called against same Archon | Dedup check sees projects created by DEV_WORKSTATION | |
| 9.2d | `archon` flagged existing | Matched by GitHub URL — already in Archon | |
| 9.2e | `ml-pipeline` flagged existing | Already in Archon from DEV_WORKSTATION scan | |
| 9.2f | `ios-client` flagged new | Not yet in Archon — created via `manage_project` | |
| 9.2g | `data-viz` flagged new | Not yet in Archon — created via `manage_project` | |

### 9.3 Verify Per-System Config Files

Config files written on the MacBook should contain the MacBook's system identity.

```bash
# On MACBOOK_M1
cat ~/projects/ios-client/.claude/archon-state.json
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.3a | `system_name` is `MACBOOK_M1` | Not `DEV_WORKSTATION` | |
| 9.3b | `system_fingerprint` is MacBook's | Different from DEV_WORKSTATION fingerprint | |
| 9.3c | `archon_project_id` matches Archon | UUID matches the project created from MacBook scan | |

### 9.4 Verify Both Systems See Their Own Projects

On DEV_WORKSTATION, shared repos that were scanned from MacBook should now also have
MacBook's config state — but DEV_WORKSTATION's existing config files are unaffected.

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.4a | `ml-pipeline` on MacBook gets config | `~/projects/ml-pipeline/.claude/archon-state.json` has `system_name: "MACBOOK_M1"` on MacBook | |
| 9.4b | DEV_WORKSTATION ml-pipeline unchanged | On DEV_WORKSTATION, `archon-state.json` still has `system_name: "DEV_WORKSTATION"` | |
| 9.4c | Archon project unchanged | `ml-pipeline` project in Archon has one entry — not duplicated | |

### 9.5 Verify No Cross-System Pollution

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.5a | `ios-client` not created on DEV_WORKSTATION | DEV_WORKSTATION scan did not create `ios-client` (it doesn't exist there) | |
| 9.5b | `standalone-api` not created on MacBook | MacBook scan did not create `standalone-api` (it doesn't exist on Mac) | |
| 9.5c | Project count correct | Archon now has 8 projects: 6 from DEV_WORKSTATION + 2 new from MacBook | |

### 9.6 Run `/scan-projects` on a Third System (Windows)

Alex's Windows desktop (`WIN_DESKTOP`) also has some local repos. The skill runs in
Claude Code on Windows (PowerShell or WSL2).

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 9.6a | Script downloads on Windows | `curl http://192.168.1.100:8181/api/scanner/script` works in PowerShell | |
| 9.6b | Script runs with `python` or `python3` | Skill detects Windows and uses correct Python command | |
| 9.6c | Config files use Windows paths | `archon-state.json` has correct paths for the Windows system | |
| 9.6d | System name is `WIN_DESKTOP` | Not `DEV_WORKSTATION` or `MACBOOK_M1` | |

---

## Phase 10 — Extension Version Tracking

### 10.1 Verify Extension Hash Consistency (Single-System)

All projects set up from a single scan invocation on the same machine should have the same
extensions installed (from the same Archon instance).

```bash
for dir in ~/projects/standalone-api ~/projects/ml-pipeline ~/projects/personal-site; do
  echo "$(basename $dir): $(python3 -c "import json; d=json.load(open('$dir/.claude/archon-config.json')); print(d.get('extensions_hash','N/A'))")"
done
```

| # | Check | Expected | Status |
|---|-------|----------|--------|
| 10.1a | Hashes match | All projects from same scan have identical `extensions_hash` | |
| 10.1b | Timestamps close | `extensions_installed_at` values within seconds of each other | |

---

## Test Results Summary

| Phase | Description | Checks | Pass | Fail | Skip |
|-------|-------------|--------|------|------|------|
| 0 | Verify Prerequisites | 5 | | | |
| 1 | Scan Directory | 17 | | | |
| 2 | AI Descriptions | 6 | | | |
| 3 | Dedup and Create Projects | 16 | | | |
| 4 | Config Files Written | 14 | | | |
| 5 | Knowledge Base Ingestion | 8 | | | |
| 6 | Post-Scanner Workflow | 9 | | | |
| 7 | Idempotency | 9 | | | |
| 8 | Edge Cases | 14 | | | |
| 9 | Multi-System Registration | 18 | | | |
| 10 | Extension Versions | 2 | | | |
| **Total** | | **118** | | | |

---

## Bugs Found

| # | Phase | Severity | Description | Status |
|---|-------|----------|-------------|--------|
| | | | | |

---

## Notes

- The scanner script runs locally — no Docker volume mount required
- Script is fetched fresh each time `/scan-projects` runs (no local caching)
- Dedup logic lives in the skill, not the backend — `find_projects` MCP is the source of truth
- Config files are written by the local Python script, not by Archon server
- Private GitHub repos will have README crawl failures but projects are still created
- The scanner is designed as a one-time bulk onboarding tool; new projects use `/archon-setup`
- Cross-platform support: Windows, Mac, Linux, and WSL2 all use the same Python script
