# Skills Distribution System — Manual Test Plan

## Prerequisites

- Archon server running (`docker compose up -d` or local)
- Archon MCP connected in Claude Code
- At least one project created in the UI
- Server URL: `http://localhost:8181`

---

## Journey 1: Server Startup Auto-Seeds Skills

**What it tests:** `SkillSeedingService` runs on startup and populates `archon_skills` from bundled SKILL.md files.

1. Restart the server:
   ```bash
   docker compose restart archon-server
   # or locally: kill and re-run uv run python -m src.server.main
   ```
2. Check server logs for the seeding line:
   ```bash
   docker compose logs archon-server | grep "Skills seeded"
   ```
   **Expected:** `✅ Skills seeded: N created, 0 updated, 0 unchanged` (or similar counts)

3. Verify skills appear in the API:
   ```bash
   curl http://localhost:8181/api/skills | python3 -m json.tool
   ```
   **Expected:** JSON with a `skills` array containing at least `archon-bootstrap`, `archon-memory`, `archon-skill-sync`

4. Restart again (idempotency check):
   ```bash
   docker compose restart archon-server
   docker compose logs archon-server | grep "Skills seeded"
   ```
   **Expected:** `0 created, 0 updated, N unchanged` — no duplicates created

---

## Journey 2: GET /api/skills?include_content=true

**What it tests:** The `include_content` query parameter returns full SKILL.md content.

1. Without param (content omitted):
   ```bash
   curl "http://localhost:8181/api/skills" | python3 -m json.tool
   ```
   **Expected:** Skills listed, no `content` field on each skill (or `content: null`)

2. With param (content included):
   ```bash
   curl "http://localhost:8181/api/skills?include_content=true" | python3 -m json.tool
   ```
   **Expected:** Each skill has a non-empty `content` field with the full SKILL.md markdown text

---

## Journey 3: MCP Bootstrap Action

**What it tests:** `manage_skills(action="bootstrap")` fetches skills + registers system.

**Setup:** Open Claude Code in any project with the Archon MCP connected.

1. Ask Claude:
   > "Call manage_skills with action=bootstrap, system_fingerprint=test-machine-001, system_name=My Test Machine"

   **Expected response contains:**
   - `success: true`
   - `skills`: array of skills with `name`, `display_name`, `content` fields
   - `install_path`: suggested path (e.g. `~/.claude/skills/`)
   - `message` describing what to do

2. With project registration — also pass a valid `project_id` from your Archon project:
   > "Call manage_skills with action=bootstrap, system_fingerprint=test-machine-001, system_name=My Test Machine, project_id=<your-project-id>"

   **Expected:** Same as above, plus the system appears in the Skills tab of that project

3. Verify system was registered:
   ```bash
   curl "http://localhost:8181/api/projects/<your-project-id>/systems" | python3 -m json.tool
   ```
   **Expected:** System `My Test Machine` with fingerprint `test-machine-001` appears in the list

---

## Journey 4: archon-bootstrap SKILL (full machine bootstrap)

**What it tests:** The `archon-bootstrap` SKILL.md end-to-end flow.

**Setup:** Claude Code with Archon MCP connected.

1. Trigger the skill:
   > "Bootstrap archon skills on this machine"

   Or: `/archon-bootstrap` if installed

2. Walk through the 7 phases — Claude should:
   - Phase 0: Check MCP health (`GET /health`)
   - Phase 1: Generate a fingerprint using `sha256sum` (Linux) or `shasum -a 256` (macOS)
   - Phase 2: Confirm system name with you
   - Phase 3: Read `~/.claude/archon-state.json` (may not exist yet — that's fine)
   - Phase 4: Call `manage_skills(action="bootstrap", ...)`
   - Phase 5: Write each skill's content to `~/.claude/skills/<name>.md`
   - Phase 6: Write/merge `~/.claude/archon-state.json` (system_id, system_name, fingerprint)
   - Phase 7: Report summary

3. Verify files were written:
   ```bash
   ls ~/.claude/skills/
   cat ~/.claude/archon-state.json
   ```
   **Expected:** SKILL.md files for each skill, and `archon-state.json` with your system info

---

## Journey 5: Skills Tab — Remove a Skill

**What it tests:** The Remove button in `SystemSkillList` calls the remove endpoint.

**Setup:** In the Archon UI, navigate to a project → Skills tab. A system must be registered with at least one installed skill.

1. Select a system from the left panel
2. In the skill list, find an **installed** skill (shown with a status badge)
3. Click the **Remove** button next to it
4. **Expected:** The skill disappears from the installed list (or its status changes to "not installed")
5. Refresh the page — verify the skill remains removed (server-side, not just optimistic)

---

## Journey 6: Skills Tab — Unlink a System

**What it tests:** The Unlink button in `SystemCard` calls `DELETE /api/projects/{id}/systems/{id}` and clears selection.

**Setup:** Skills tab with at least one registered system visible.

1. Note the system name in the left panel
2. Click **"Unlink from project"** below the system name
3. **Expected:**
   - System disappears from the left panel
   - Detail panel clears (no stale content shown)
4. Verify via API:
   ```bash
   curl "http://localhost:8181/api/projects/<project-id>/systems" | python3 -m json.tool
   ```
   **Expected:** The unlinked system no longer appears

---

## Journey 7: Edge Cases

| Scenario | Steps | Expected |
|---|---|---|
| Unlink non-existent system | `curl -X DELETE http://localhost:8181/api/projects/bad-id/systems/bad-id` | HTTP 404 |
| Bootstrap with no project_id | Call `manage_skills(action="bootstrap", system_fingerprint=x, system_name=y)` | Returns skills, no sync call, no 500 error |
| Skills content idempotency | Restart server twice, check seeding logs | `0 created` on 2nd restart (hash-based skip) |
| Biome/TS clean | `cd archon-ui-main && npx tsc --noEmit && npm run biome` | No errors |
