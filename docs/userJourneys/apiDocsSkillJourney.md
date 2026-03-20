# API Documentation Skill — User Journey Test Plan

## Prerequisites

- Archon server running (for extension seeding)
- Claude Code CLI with Archon MCP connected
- The `api-docs` skill deployed via `/archon-extension-sync` or `/archon-bootstrap`
- The `postman-integration` skill installed (for Postman handoff tests)
- A FastAPI project available for testing (Archon itself works)

---

## Journey 1: Extension Seeding Picks Up the Skill

**What it tests:** The extension seeding service finds `integrations/claude-code/extensions/api-docs/SKILL.md` and registers it.

- [ ] **1.1** Restart the Archon server:
  ```bash
  docker compose restart archon-server
  ```

- [ ] **1.2** Check server logs for seeding:
  ```bash
  docker compose logs archon-server | grep -i "seed"
  ```
  **Expected:** The `api-docs` extension appears in the seeding output (created or unchanged).

- [ ] **1.3** Verify via API:
  ```bash
  curl http://localhost:8181/api/extensions | python3 -m json.tool | grep "api-docs"
  ```
  **Expected:** `api-docs` appears in the extensions list with the correct description.

- [ ] **1.4** Run extension sync in Claude Code:
  > "/archon-extension-sync"

  **Expected:** `api-docs` skill is synced to the local machine.

---

## Journey 2: Guard — FastAPI Detection

**What it tests:** Phase 0 correctly detects or skips based on FastAPI presence.

### 2.1 Guard passes in a FastAPI project

- [ ] **2.1.1** In the Archon repo, invoke the skill:
  > "Use the api-docs skill to audit the API endpoints"

  **Expected:** The skill does NOT output the skip message. It proceeds to project discovery and eventually reports documentation gaps.

### 2.2 Guard skips in a non-FastAPI project

- [ ] **2.2.1** Navigate to a project that does not use FastAPI (e.g., a pure frontend repo or a non-Python project).

- [ ] **2.2.2** Invoke the skill:
  > "Use the api-docs skill to audit the API endpoints"

  **Expected:** Output includes: *"Skipping API documentation — no FastAPI endpoints detected in this project."*

---

## Journey 3: Project Discovery

**What it tests:** Phase 1 correctly identifies project structure in the Archon codebase.

- [ ] **3.1** Invoke the skill in the Archon repo:
  > "Use the api-docs skill to audit the projects API"

- [ ] **3.2** Verify discovery finds the correct structure. Claude should identify:
  - Route directory: `python/src/server/api_routes/`
  - Service directory: `python/src/server/services/`
  - Models: inline in route files
  - Pydantic version: v2
  - App entry point: `python/src/server/main.py`

  **How to verify:** Claude may not explicitly list these, but you can ask: *"What did you discover about the project structure?"*

- [ ] **3.3** Verify Postman integration detection:
  Ask Claude: *"Is the postman-integration skill available?"*
  **Expected:** Yes (if installed) or graceful skip message (if not).

---

## Journey 4: Retrofit Mode — Dry Run

**What it tests:** Phase 4 correctly scans existing endpoints and produces a gap report.

- [ ] **4.1** Invoke retrofit mode scoped to one feature:
  > "Use the api-docs skill to audit just the projects API endpoints"

- [ ] **4.2** Verify gap count report:
  **Expected:** Claude reports something like: *"Found X documentation gaps across Y files (Z endpoints). Want a dry-run report first, or should I fix them all?"*

- [ ] **4.3** Choose dry-run:
  > "Dry run first"

  **Expected:** A markdown table with columns: File, Endpoint, Missing. Each row shows specific gaps (e.g., "response_model", "Field descriptions", "status_code").

- [ ] **4.4** Verify the report is accurate. Spot-check 2-3 endpoints:
  - Open the route file Claude references
  - Confirm the gaps listed actually exist in the code
  - Confirm no false positives (things listed as missing that are actually present)

---

## Journey 5: Retrofit Mode — Fix All

**What it tests:** Phase 4 correctly fixes documentation gaps in place.

- [ ] **5.1** After the dry run (or in a fresh invocation), choose fix all:
  > "Fix them all"

- [ ] **5.2** Verify progress reporting:
  **Expected:** For multi-file operations, Claude reports progress like: *"Fixed 3/8 endpoints (projects_api.py complete, starting tasks_api.py...)"*

- [ ] **5.3** Verify fixes are correct. For each fixed endpoint, check:
  - [ ] Route decorator has `response_model` with a Pydantic model
  - [ ] Route decorator has explicit `status_code`
  - [ ] Route decorator has `tags`
  - [ ] Route decorator has `responses` for error codes
  - [ ] Function has a docstring or `description` parameter
  - [ ] Function has type hints on all parameters
  - [ ] Function has return type annotation
  - [ ] Pydantic model fields use `Field(description=...)`
  - [ ] Response models have `json_schema_extra` examples (Pydantic v2)

- [ ] **5.4** Verify existing documentation was preserved:
  - Check that pre-existing docstrings were NOT overwritten
  - Check that pre-existing Field descriptions were NOT changed

- [ ] **5.5** Verify the code still works:
  ```bash
  cd python && uv run ruff check src/server/api_routes/
  ```
  **Expected:** No new linting errors introduced.

- [ ] **5.6** Verify summary message:
  **Expected:** *"Documented X endpoints across Y files. Postman collection entries generated for all endpoints."* (or Postman skip message if not available)

---

## Journey 6: Intercept Mode — New Endpoint Creation

**What it tests:** Phase 3 ensures new endpoints come out fully documented when building features.

- [ ] **6.1** Ask Claude to create a new endpoint (in a test branch):
  > "Add a GET /api/projects/{project_id}/stats endpoint that returns task counts by status"

- [ ] **6.2** Verify the endpoint was created with full documentation:
  - [ ] `response_model` on the decorator
  - [ ] Explicit `status_code=200`
  - [ ] `tags=["projects"]`
  - [ ] `responses` for error codes (e.g., 404)
  - [ ] Docstring on the function
  - [ ] Pydantic response model with `Field(description=...)` on every field
  - [ ] Response model has `json_schema_extra` example
  - [ ] Return type annotation

- [ ] **6.3** Verify full slice scaffolding (if applicable):
  - [ ] Service method stub was created (or existing service was used)
  - [ ] Router was wired into `main.py` (if new router)

- [ ] **6.4** Verify Postman handoff:
  **Expected:** Claude invokes the postman-integration skill to create a collection entry for the new endpoint (or outputs the skip message if not available).

---

## Journey 7: Postman Integration Handoff

**What it tests:** Phase 5 correctly hands off to the postman-integration skill.

- [ ] **7.1** Ensure postman-integration is installed and configured.

- [ ] **7.2** After retrofit or intercept mode completes, verify Claude:
  - [ ] Called `find_postman()` to detect sync mode
  - [ ] Created collection entries for the documented endpoints
  - [ ] Followed the correct mode (API mode or Git mode)

- [ ] **7.3** If Postman is not configured:
  **Expected:** *"Postman integration not available — skipping collection generation. Install the postman-integration skill to enable this."*

---

## Journey 8: Edge Cases

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 8.1 | Retrofit preserves existing docs | Run retrofit on an endpoint that already has a docstring and some Field descriptions | Existing docs untouched, only gaps filled |
| 8.2 | No service layer project | Run intercept mode on a FastAPI project without a `services/` directory | Route and models created, no service scaffolding attempted |
| 8.3 | Pydantic v1 project | Run on a project using Pydantic v1 | Skill uses `class Config` / `schema_extra` syntax, not v2 |
| 8.4 | Models in separate files | Run on a project where models are in `schemas.py` | New models created in `schemas.py`, not inline |
| 8.5 | Complex return types | Endpoint returns `list[dict]` | Skill creates typed response model with `response_model=list[ItemResponse]` |
| 8.6 | Multiple FastAPI apps | Project has two `FastAPI()` instances | Skill asks which app to target |
| 8.7 | Retrofit whole repo | "Document all API endpoints in this repo" | All route files scanned, all gaps fixed |

---

## Journey 9: Skill Trigger Accuracy

**What it tests:** The skill activates when it should and stays quiet when it shouldn't.

- [ ] **9.1** Natural trigger — ask to build a feature involving endpoints:
  > "Add user profile CRUD endpoints with GET, POST, PUT, DELETE"

  **Expected:** The skill activates in intercept mode. Endpoints come out fully documented without being asked.

- [ ] **9.2** Explicit trigger:
  > "/api-docs"

  **Expected:** The skill activates and asks whether to intercept or retrofit.

- [ ] **9.3** Non-trigger — ask for frontend work:
  > "Add a new React component for displaying project stats"

  **Expected:** The skill does NOT activate. No API documentation messages.

- [ ] **9.4** Non-trigger — ask for non-FastAPI backend work:
  > "Fix the database migration script"

  **Expected:** The skill does NOT activate.

---

## Results Tracking

| Journey | Status | Notes |
|---------|--------|-------|
| 1. Extension Seeding | | |
| 2. Guard Detection | | |
| 3. Project Discovery | | |
| 4. Retrofit Dry Run | | |
| 5. Retrofit Fix All | | |
| 6. Intercept Mode | | |
| 7. Postman Handoff | | |
| 8. Edge Cases | | |
| 9. Trigger Accuracy | | |
