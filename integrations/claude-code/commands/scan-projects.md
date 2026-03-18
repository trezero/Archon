# Scan Local Projects

Scan a local projects directory for Git repositories and bulk-onboard them into Archon. Downloads a scanner script, detects repos, creates Archon projects via MCP, and writes config files — all from the current machine.

## Prerequisites
- System must be registered with Archon (run `/archon-setup` in any project first)
- Archon stack must be running

## Procedure

Follow these steps exactly in order. Do not skip steps.

### Step 1 — Preflight Checks

1. Look for `archon-state.json` in `~/.claude/` or the current project's `.claude/` directory. Read it.
2. Extract `system_fingerprint` and `system_name`. If the file is not found, tell the user: "System not registered. Run /archon-setup in any project first." and STOP.
3. Look for `archon-config.json` in the same locations. Extract `archon_api_url` (default: `http://localhost:8181`) and `archon_mcp_url` (default: `http://localhost:8051`).
4. Detect the Python executable:
   - Try: `python3 --version`
   - If that fails, try: `python --version` and verify the output shows Python 3.x
   - If neither works: tell the user "Python 3.8+ not found. Please install Python and ensure it's on your PATH." and STOP.
   - Store the working command as PYTHON_CMD for later use.
5. Detect the temp directory:
   - Run: `<PYTHON_CMD> -c "import tempfile; print(tempfile.gettempdir())"`
   - Store the output as TEMP_DIR.

### Step 2 — Download Scanner Script

1. Run: `curl -s <archon_api_url>/api/scanner/script -o <TEMP_DIR>/archon-scanner.py`
2. If the download fails (curl error or empty file), tell the user: "Can't reach Archon at <url>. Is the Archon stack running?" and STOP.

### Step 3 — Run Scan

1. Ask the user: "What directory should I scan? (default: ~/projects)"
2. Run: `<PYTHON_CMD> <TEMP_DIR>/archon-scanner.py --scan <directory>`
3. Parse the JSON output. If the output contains an `error` key, display the error and STOP.
4. Store the full scan result for use in later steps.

### Step 4 — Deduplicate Against Existing Archon Projects

1. Call the `find_projects` MCP tool to get all existing Archon projects.
2. For each project in the scan results, compare its `github_url` (normalized, lowercase) against the `github_repo` field of existing Archon projects.
3. Mark matches by setting `already_in_archon: true` and storing the `existing_project_id`.
4. Count: how many are new, how many already exist.

### Step 5 — Present Results to User

Display a summary like:
```
Scan complete!
- Total repositories found: <N>
- New (not in Archon): <N>
- Already in Archon: <N> (<names>)
- Project groups: <N>
```

For each NEW project:
- If it has a `readme_excerpt`, generate a 1-2 sentence description from it.
- If no README, note the detected languages and infra markers.

Present the list:
```
New projects to set up:
1. <name> — <description>
2. <name> — [no README, detected: python, docker]
...

Already in Archon (will skip): <names>

Proceed with setting up these <N> projects? You can exclude any by number.
```

Wait for user confirmation. If they exclude projects, remove them from the list. If they cancel, STOP.

### Step 6 — Create Projects in Archon

For each confirmed new project:
1. If the project belongs to a group and the group parent hasn't been created yet:
   - Call `manage_project` MCP tool with `action: "create"`, `title: "<group_name>"`, `tags: ["project-group"]`, `description: "Project group containing <child names>"`.
   - Store the returned `project_id` as the group parent ID.
2. Call `manage_project` MCP tool with:
   - `action: "create"`
   - `title`: directory_name
   - `description`: the AI-generated description
   - `github_repo`: the normalized `github_url` (or null if no GitHub remote)
   - `tags`: combine `detected_languages` + `infra_markers`
   - `metadata`: `{"dependencies": <deps>, "scanned_from": "<absolute_path>", "scanner_version": "1.0"}`
   - `parent_project_id`: group parent ID if applicable
3. Store the returned `project_id` for each project.

The `manage_project` tool returns `{"success": true, "project": {...}, "project_id": "...", "message": "..."}` synchronously.

### Step 7 — Register System for Each Project

For each created project, call the `manage_extensions` MCP tool with:
- `action: "sync"`
- `project_id`: the created project's ID
- `system_fingerprint`: from Step 1

This links the current system to each project so Archon knows which systems have which projects.

### Step 8 — Download Extensions Tarball

Run: `curl -s <archon_mcp_url>/archon-setup/extensions.tar.gz -o <TEMP_DIR>/archon-extensions.tar.gz`

If the download fails, warn the user: "Extensions tarball download failed. Projects will be created without extensions." Continue to Step 9.

### Step 9 — Apply Config Files

1. Build a JSON payload with all created projects:
```json
{
  "projects": [
    {
      "absolute_path": "<path>",
      "project_id": "<id from Step 6>",
      "project_title": "<directory_name>",
      "archon_api_url": "<from Step 1>",
      "archon_mcp_url": "<from Step 1>",
      "system_fingerprint": "<from Step 1>",
      "system_name": "<from Step 1>"
    }
  ]
}
```
2. Write the payload to `<TEMP_DIR>/archon-apply-payload.json` using the Write tool.
3. Run: `<PYTHON_CMD> <TEMP_DIR>/archon-scanner.py --apply --payload-file <TEMP_DIR>/archon-apply-payload.json --extensions-tarball <TEMP_DIR>/archon-extensions.tar.gz`
4. Parse the JSON output for success/failure counts.

### Step 10 — Knowledge Base Ingestion

For each created project that has a `github_url` with `github_owner` and `github_repo_name`:
- Call `manage_rag_source` MCP tool with:
  - `action: "add"`
  - `source_type: "url"`
  - `title: "<directory_name> README"`
  - `url: "https://github.com/<owner>/<repo>#readme"`
  - `project_id: "<project_id>"`
  - `knowledge_type: "technical"`

For large scans (20+ projects), batch these calls in groups of 5 with a brief pause between batches to avoid overwhelming the backend.

### Step 11 — Display Final Summary

```
Setup complete!
- Projects created: <N>
- Projects skipped (already in Archon): <N>
- Projects failed: <N>
- README crawls queued: <N>

<If any failures, list them with error messages>

You can now open Claude Code in any of these projects and Archon context will be available.
```
