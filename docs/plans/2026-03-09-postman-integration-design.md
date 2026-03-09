# Postman Integration Design — Collections as Code

**Date**: 2026-03-09
**Status**: Approved (v2 — replaces API-based design)
**Feature**: Automatic Postman collection and environment management via Git-native YAML files

## Overview

Automatically maintain a Postman collection and environment per project as human-readable YAML files committed directly to the repository — using Postman's "Collections as Code" workflow. Every API endpoint Claude suggests testing is captured as a `.request.yaml` file, replacing ad-hoc curl commands with a version-controlled, executable API test suite.

### How It Works End-to-End

1. Claude is working in a project and suggests testing an API call
2. Claude checks if `postman/collections/{Project Name}/` exists in the repo (or creates it)
3. Claude writes a `.request.yaml` file in the appropriate resource folder
4. Claude writes/updates the environment YAML with any needed variables
5. The user opens Postman, which auto-syncs the YAML files from their local repo
6. In documentation, Claude references the Postman collection contextually

**No API keys. No backend services. No database changes. No MCP tools.**

### What Users Get

- A self-building Postman collection that grows alongside the codebase — in Git
- Clean YAML diffs in pull requests showing exactly what API changes were made
- Per-environment config files (local dev, CI, staging) committed to the repo
- Test scripts that chain requests via collection variables
- `postman collection run` CLI support for CI/CD pipelines
- Consistent Postman references across all documentation

### Why Collections as Code

| Concern | Old API-Based Design | Collections as Code |
|---------|---------------------|---------------------|
| API keys | Required PMAK key in Settings | None needed |
| Backend code | PostmanService, API routes, MCP tools | None needed |
| Database | New column on archon_projects | None needed |
| Settings UI | Feature toggle + credential fields | None needed |
| Session hook | .env sync to Postman API | None needed |
| Collaboration | Shared workspace, API-pushed | Git — PRs, diffs, branches |
| CI/CD | Requires API access | `postman collection run` on local files |
| Offline | Requires internet | Works fully offline |

## Architecture: Purely Behavioral

The entire feature is a single behavioral extension (`SKILL.md`) distributed via the Archon extension registry. It instructs Claude on when and how to write Postman YAML files.

No backend services. No MCP tools. No database migrations. No frontend changes.

### Reference Implementation

A complete working example lives in `reference_repos/PostmanFastAPIDemo/postman/` demonstrating the full Collections as Code pattern.

## Directory Structure

Claude creates and maintains this structure at the repository root:

```
postman/
├── collections/
│   └── {Project Name}/                           # One collection per project
│       ├── .resources/
│       │   └── definition.yaml                   # Collection metadata + variables
│       ├── {Resource Domain}/                    # Folder per API domain
│       │   ├── .resources/
│       │   │   └── definition.yaml               # Folder metadata + ordering
│       │   └── {Request Name}.request.yaml       # Individual HTTP request
│       └── {Request Name}.request.yaml           # Top-level requests (if any)
├── environments/
│   ├── {Project} - Local.environment.yaml        # Local dev environment
│   ├── {Project} - CI.environment.yaml           # CI/CD environment (optional)
│   └── {Project} - {Custom}.environment.yaml     # Additional environments as needed
└── globals/
    └── workspace.globals.yaml                    # Workspace-wide constants (optional)
```

### Collection Naming

- **Primary**: Archon project name (e.g., `Archon`)
- **Fallback**: Git repo name — just the repo name, no owner prefix (`Archon` not `coleam00-Archon`)
- **Derived from**: Archon project if linked, otherwise `basename $(git rev-parse --show-toplevel)`

### Folder Naming — Framework-Agnostic

Use the core resource name or domain grouping. Derive from the controller/router file name regardless of framework:

| Source File | Folder Name |
|-------------|-------------|
| `projects_api.py` | `Projects` |
| `users.controller.ts` | `Users` |
| `AuthRouter.java` | `Auth` |
| `handlers/orders.go` | `Orders` |
| Health check endpoints | `Health` |

## YAML File Schemas

### Collection Definition

**Path**: `postman/collections/{Project}/.resources/definition.yaml`

```yaml
$kind: collection
description: >
  API collection for {Project Name}.
  Auto-generated and maintained by Claude.
variables:
  baseUrl: "{{baseUrl}}"
```

### Folder Definition

**Path**: `postman/collections/{Project}/{Folder}/.resources/definition.yaml`

```yaml
$kind: collection
order: 1000
```

Folder ordering uses increments of 1000 (1000, 2000, 3000...) to allow insertion without renumbering.

### HTTP Request

**Path**: `postman/collections/{Project}/{Folder}/{Request Name}.request.yaml`

```yaml
$kind: http-request
name: Create Project
url: "{{baseUrl}}/api/projects"
method: POST
description: Creates a new Archon project

headers:
  Content-Type: application/json

body:
  type: text
  content: |
    {
      "name": "My Project",
      "description": "A new project"
    }

scripts:
  - type: afterResponse
    code: |-
      pm.test('Status is 201', function () {
          pm.response.to.have.status(201);
      });

      pm.test('Project has an ID', function () {
          var json = pm.response.json();
          pm.expect(json.id).to.be.a('string');
          pm.collectionVariables.set('projectId', json.id);
      });
    language: text/javascript

order: 1000
```

### Environment

**Path**: `postman/environments/{Project} - Local.environment.yaml`

```yaml
name: "{Project Name} - Local"
values:
  - key: baseUrl
    value: http://localhost:8181
    enabled: true
  - key: supabaseUrl
    value: http://localhost:8000
    enabled: true
  - key: supabaseKey
    value: ""
    enabled: true
color: null
```

### Globals (Optional)

**Path**: `postman/globals/workspace.globals.yaml`

```yaml
name: Globals
values:
  - key: contentType
    value: application/json
    enabled: true
```

## Behavioral Extension (SKILL.md)

**Location**: `integrations/claude-code/extensions/postman-integration/SKILL.md`

Auto-seeded into the extension registry on server start, distributed to all systems via `/archon-setup`.

### Rule 1: Collection Initialization

When starting work on a project and `postman/collections/` does not exist, create the full scaffold:

1. Create `postman/collections/{Project Name}/.resources/definition.yaml`
2. Create `postman/environments/{Project Name} - Local.environment.yaml` with variables derived from the project's `.env` file
3. Commit the scaffold

If the collection directory already exists, use it as-is.

### Rule 2: Always Add, Never Just Curl

When suggesting an API call for testing:

- **Do**: Write a `.request.yaml` file in the appropriate folder
- **Do**: Include `afterResponse` test scripts that verify status and capture IDs
- **Do**: Tell the user: *"This request has been added to the Postman collection at `postman/collections/{Project}/{Folder}/{Name}.request.yaml`"*
- **Do**: Provide the curl equivalent inline as well (for quick terminal testing)
- **Don't**: Provide only a curl command without also writing the YAML file

### Rule 3: Request File Content

Every `.request.yaml` must include:

- `$kind: http-request` (required by Postman)
- `url` with `{{baseUrl}}` variable prefix (never hardcode host/port)
- `method` (GET, POST, PUT, PATCH, DELETE)
- `headers` when the request has a body (`Content-Type: application/json`)
- `body` for POST/PUT/PATCH with `type: text` and JSON `content`
- `scripts` with at least one `afterResponse` test (see Rule 4)
- `order` for execution sequencing (increments of 1000)
- `description` summarizing what the request does

Use `{{variableName}}` syntax for all dynamic values — never hardcode IDs, URLs, or tokens.

### Rule 4: Test Script Patterns

Every request gets an `afterResponse` script that:

1. **Verifies status code**: `pm.response.to.have.status(200)`
2. **Validates response shape**: `pm.expect(json.field).to.be.a('string')`
3. **Captures IDs from mutations**: `pm.collectionVariables.set('resourceId', json.id)`

Example for a create operation:
```javascript
pm.test('Status is 201', function () {
    pm.response.to.have.status(201);
});

pm.test('Response has ID', function () {
    var json = pm.response.json();
    pm.expect(json.id).to.be.a('string');
    pm.collectionVariables.set('projectId', json.id);
});
```

Example for a list operation:
```javascript
pm.test('Status is 200', function () {
    pm.response.to.have.status(200);
});

pm.test('Returns array', function () {
    var json = pm.response.json();
    pm.expect(json).to.be.an('array');
    pm.expect(json.length).to.be.above(0);
});
```

Captured variables use camelCase: `projectId`, `taskId`, `sourceId`.

### Rule 5: Environment Management

When writing requests that reference variables not yet in the environment file:

1. Read the existing `postman/environments/{Project} - Local.environment.yaml`
2. Add the missing variable with a sensible default or empty string
3. Write the updated file

Derive environment values from the project's `.env` file when possible:
- `SUPABASE_URL` → `supabaseUrl`
- `SUPABASE_SERVICE_KEY` → `supabaseKey`
- Server port from config → `baseUrl` as `http://localhost:{port}`

**Sensitive values**: Write empty strings for secrets in the committed YAML. Add a comment noting the user should populate them locally. Users should add `postman/environments/*` to `.gitignore` if they prefer not to commit environment files, or use Postman's built-in secret variable handling.

### Rule 6: Folder Organization & Ordering

- Create one folder per API resource domain
- Add `.resources/definition.yaml` to each folder with an `order` value
- Order folders logically: `Health` (1000) → domain folders alphabetically (2000, 3000...)
- Order requests within folders by typical workflow: list (1000) → create (2000) → get by ID (3000) → update (4000) → delete (5000) → error cases (6000+)

### Rule 7: Documentation References (Contextual)

Match reference style to document type:

- **Test plans / user journeys** — per-step references:
  > Step 3: Create a new project via `POST /api/projects`
  > *(Postman: `{Project}` → `Projects` → `Create Project`)*

- **Architecture docs / general docs** — single summary section:
  > ## API Testing
  > All endpoints are available as a Postman collection in `postman/collections/{Project}/`.
  > Run locally: `postman collection run postman/collections/{Project}/`

- **Code comments** — no Postman references

### Rule 8: Prevent Duplicates

Before writing a new `.request.yaml`:

1. Check if a file with the same name already exists in the target folder
2. If it exists, **update** the existing file rather than creating a duplicate
3. If the request name differs but the URL + method combination matches, update the existing file and rename if needed

### Rule 9: Collection Variables for Request Chaining

Define collection-level variables in `postman/collections/{Project}/.resources/definition.yaml` for any values that flow between requests:

```yaml
variables:
  baseUrl: "{{baseUrl}}"
  projectId: ""
  taskId: ""
  sourceId: ""
```

These are populated by `afterResponse` test scripts and consumed by subsequent requests via `{{projectId}}`, `{{taskId}}`, etc.

### Rule 10: Graceful Behavior

- The extension's rules only apply when the user is working on a project with API endpoints
- If the user explicitly asks for "just a curl command," provide only the curl command
- Don't create Postman files for one-off debugging requests or internal health checks unless asked
- If `postman/` doesn't exist and the user hasn't mentioned Postman, ask before creating the scaffold

## CI/CD Integration

The Collections as Code format supports CLI-based test execution:

```bash
# Run full collection
postman collection run postman/collections/{Project}/ \
  --environment postman/environments/{Project}\ -\ Local.environment.yaml

# GitHub Actions
- name: Run API Tests
  uses: postmanlabs/postman-cli-action@v1
  with:
    command: >
      collection run postman/collections/{Project}/
      --environment postman/environments/{Project}\ -\ CI.environment.yaml
```

This enables automated API testing in CI without any Postman account or API key.

## File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `integrations/claude-code/extensions/postman-integration/SKILL.md` | Behavioral extension with all 10 rules |

### Files NOT Needed (Removed from Previous Design)

| Previously Planned | Why Removed |
|--------------------|-------------|
| `python/src/server/services/postman/*` | No backend services — YAML files written directly |
| `python/src/server/api_routes/postman_api.py` | No API routes needed |
| `python/src/mcp_server/features/postman/*` | No MCP tools needed |
| `migration/0.1.0/020_add_postman_collection_uid.sql` | No database changes |
| `tests/server/services/postman/*` | No backend code to test |
| `tests/server/api_routes/test_postman_api.py` | No API routes to test |
| `tests/mcp_server/features/postman/*` | No MCP tools to test |

### Modified Files

None. The extension is auto-seeded from `integrations/claude-code/extensions/` on server start — no registration code changes needed.

## Testing Strategy

Since there is no backend code, testing focuses on the behavioral extension itself:

### Extension Validation

- Verify the SKILL.md passes Archon's extension validation (frontmatter, size, content checks)
- Verify it seeds correctly into the extension registry on server start
- Verify it distributes via `/archon-setup`

### Manual Integration Testing

1. Start a session in a project with no `postman/` directory
2. Ask Claude to test an API endpoint → verify it creates the full scaffold
3. Ask Claude to test another endpoint → verify it adds to the existing collection
4. Ask Claude to test a duplicate endpoint → verify it updates, not duplicates
5. Verify all generated YAML files are valid by opening them in Postman
6. Run `postman collection run` on the generated collection → verify tests pass
7. Ask Claude for a test plan → verify it includes Postman references per-step
8. Ask Claude for architecture docs → verify single summary section

### YAML Validation

Generated files must:
- Parse as valid YAML
- Include required `$kind` field
- Use `{{variable}}` syntax (not hardcoded values)
- Have `afterResponse` test scripts on every request
- Follow the ordering convention (increments of 1000)

## Design Decisions Summary

1. **Collections as Code** — YAML files in the repo, no Postman API needed
2. **Purely behavioral** — one SKILL.md extension, no backend/frontend/database changes
3. **Git-native** — collections are version-controlled, diffable, branch-able
4. **Collection per project** — named after Archon project, fallback to repo name (no owner prefix)
5. **Folders mirror resource domains** — framework-agnostic derivation from controller/router names
6. **Test scripts on every request** — verify status, validate shape, capture IDs
7. **Environment files per deployment target** — Local, CI, custom
8. **Sensitive values left empty** — user populates locally, optionally gitignored
9. **CLI-runnable** — `postman collection run` works in CI without accounts
10. **Graceful behavior** — don't force Postman on users who don't want it
