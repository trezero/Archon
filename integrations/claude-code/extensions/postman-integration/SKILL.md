---
name: postman-integration
description: Use when suggesting API calls for testing, writing test plans, creating documentation that references API endpoints, or when the user mentions Postman. Generates and maintains Postman Collections as Code — human-readable YAML files committed directly to the repository.
---

# Postman Integration — Collections as Code

Maintain a Postman collection and environment as version-controlled YAML files in the repository. Every API endpoint suggested for testing becomes a `.request.yaml` file — replacing ad-hoc curl commands with an executable, diffable API test suite.

**Reference implementation:** `reference_repos/PostmanFastAPIDemo/postman/`

---

## Directory Structure

```
postman/
├── collections/
│   └── {Project Name}/
│       ├── .resources/
│       │   └── definition.yaml           # Collection metadata + variables
│       ├── {Resource Domain}/
│       │   ├── .resources/
│       │   │   └── definition.yaml       # Folder ordering
│       │   └── {Request Name}.request.yaml
│       └── {Request Name}.request.yaml   # Top-level requests (if any)
├── environments/
│   ├── {Project} - Local.environment.yaml
│   └── {Project} - CI.environment.yaml   # Optional
└── globals/
    └── workspace.globals.yaml            # Optional
```

**Project name**: Use the Archon project name if linked (from `.claude/archon-state.json`), otherwise `basename $(git rev-parse --show-toplevel)`. Never include the owner prefix.

---

## Rule 1: Collection Initialization

When `postman/collections/` does not exist and you are about to suggest testing an API call:

1. Ask the user before creating the scaffold (unless they've already mentioned Postman)
2. Create `postman/collections/{Project}/.resources/definition.yaml`:

```yaml
$kind: collection
description: >
  API collection for {Project Name}.
variables:
  baseUrl: "{{baseUrl}}"
```

3. Create `postman/environments/{Project} - Local.environment.yaml` with variables derived from the project's `.env`:

```yaml
name: "{Project Name} - Local"
values:
  - key: baseUrl
    value: http://localhost:{port}
    enabled: true
color: null
```

4. Commit the scaffold.

If `postman/collections/{Project}/` already exists, use it as-is.

---

## Rule 2: Always Add, Never Just Curl

When suggesting an API call for testing:

- **Write** a `.request.yaml` file in the appropriate resource folder
- **Include** an `afterResponse` test script (see Rule 4)
- **Tell the user** where the file was written: *"Added to Postman collection: `postman/collections/{Project}/{Folder}/{Name}.request.yaml`"*
- **Also provide** the curl equivalent inline for quick terminal testing

Never provide only a curl command without also writing the YAML file.

---

## Rule 3: Request File Content

Every `.request.yaml` must include:

```yaml
$kind: http-request
name: {Descriptive Name}
url: "{{baseUrl}}/api/{path}"
method: GET
description: {What this request does}

headers:
  Content-Type: application/json

body:                          # For POST, PUT, PATCH only
  type: text
  content: |
    {
      "field": "value"
    }

scripts:
  - type: afterResponse
    code: |-
      pm.test('Status is 200', function () {
          pm.response.to.have.status(200);
      });
    language: text/javascript

order: 1000
```

**Requirements:**
- `$kind: http-request` — required by Postman
- `url` with `{{baseUrl}}` prefix — never hardcode host/port
- `{{variableName}}` for all dynamic values — never hardcode IDs or tokens
- `headers` when the request has a body
- `order` for execution sequencing (increments of 1000)

---

## Rule 4: Test Script Patterns

Every request gets an `afterResponse` script. Match the pattern to the operation type:

**Create (POST returning new resource):**
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

**Read (GET returning single resource):**
```javascript
pm.test('Status is 200', function () {
    pm.response.to.have.status(200);
});

pm.test('Returns expected resource', function () {
    var json = pm.response.json();
    pm.expect(json.id).to.eql(pm.collectionVariables.get('projectId'));
});
```

**List (GET returning array):**
```javascript
pm.test('Status is 200', function () {
    pm.response.to.have.status(200);
});

pm.test('Returns array', function () {
    var json = pm.response.json();
    pm.expect(json).to.be.an('array');
});
```

**Update (PUT/PATCH):**
```javascript
pm.test('Status is 200', function () {
    pm.response.to.have.status(200);
});

pm.test('Returns updated resource', function () {
    var json = pm.response.json();
    pm.expect(json.name).to.eql('Updated Name');
});
```

**Delete:**
```javascript
pm.test('Status is 200 or 204', function () {
    pm.expect(pm.response.code).to.be.oneOf([200, 204]);
});
```

**Error case (expected 404/400):**
```javascript
pm.test('Status is 404', function () {
    pm.response.to.have.status(404);
});
```

Captured variable names use camelCase: `projectId`, `taskId`, `sourceId`.

---

## Rule 5: Environment Management

When a request references variables not yet in the environment file:

1. Read `postman/environments/{Project} - Local.environment.yaml`
2. Add the missing variable with a sensible default or empty string
3. Write the updated file

**Deriving values from `.env`:**

| `.env` Key | Environment Variable | Example Value |
|------------|---------------------|---------------|
| Server port from config | `baseUrl` | `http://localhost:8181` |
| `SUPABASE_URL` | `supabaseUrl` | `http://localhost:8000` |
| `SUPABASE_SERVICE_KEY` | `supabaseKey` | (empty — user fills in) |

**Sensitive values:** Write empty strings for secrets. Do not commit real credentials. Users populate them locally or add `postman/environments/*` to `.gitignore`.

---

## Rule 6: Folder Organization & Ordering

**Folder naming** — derive from controller/router file, framework-agnostic:

| Source File | Folder Name |
|-------------|-------------|
| `projects_api.py` | `Projects` |
| `users.controller.ts` | `Users` |
| `AuthRouter.java` | `Auth` |
| `handlers/orders.go` | `Orders` |
| Health check endpoints | `Health` |

**Folder ordering** — each folder gets `.resources/definition.yaml`:

```yaml
$kind: collection
order: 2000
```

Order logically: `Health` (1000) → domain folders alphabetically (2000, 3000...).

**Request ordering** within folders — by typical workflow:

| Operation | Order |
|-----------|-------|
| List / Get All | 1000 |
| Search / Filter | 2000 |
| Create | 3000 |
| Get by ID | 4000 |
| Update | 5000 |
| Delete | 6000 |
| Error cases (404, 400) | 7000+ |

---

## Rule 7: Documentation References

Match reference style to document type:

**Test plans / user journeys** — per-step:

> Step 3: Create a new project via `POST /api/projects`
> *(Postman: `{Project}` → `Projects` → `Create Project`)*

**Architecture docs / general docs** — single summary section:

> ## API Testing
> All endpoints are available as a Postman collection in `postman/collections/{Project}/`.
> Run locally: `postman collection run postman/collections/{Project}/`

**Code comments** — no Postman references.

---

## Rule 8: Prevent Duplicates

Before writing a new `.request.yaml`:

1. Check if a file with the same name already exists in the target folder
2. If it exists, **update** the existing file
3. If the request name differs but the URL + method combination matches an existing file, update the existing file and rename if appropriate

---

## Rule 9: Collection Variables for Request Chaining

Define collection-level variables in `postman/collections/{Project}/.resources/definition.yaml`:

```yaml
variables:
  baseUrl: "{{baseUrl}}"
  projectId: ""
  taskId: ""
  sourceId: ""
```

Add new variables here whenever an `afterResponse` script uses `pm.collectionVariables.set()`. These variables are populated by test scripts at runtime and consumed by subsequent requests via `{{projectId}}`, `{{taskId}}`, etc.

---

## Rule 10: Graceful Behavior

- Only apply these rules when working on a project with API endpoints
- If the user explicitly asks for "just a curl command," provide only the curl
- Don't create Postman files for one-off debugging requests unless asked
- If `postman/` doesn't exist and the user hasn't mentioned Postman, ask before scaffolding
- If `postman/` exists, always maintain it when suggesting API tests

---

## Quick Reference: YAML Schema

| File Type | Path | Required Fields |
|-----------|------|-----------------|
| Collection definition | `{Collection}/.resources/definition.yaml` | `$kind` |
| Folder definition | `{Folder}/.resources/definition.yaml` | `$kind`, `order` |
| HTTP request | `{Folder}/{Name}.request.yaml` | `$kind`, `url`, `method`, `order` |
| Environment | `environments/{Name}.environment.yaml` | `name`, `values` |
| Globals | `globals/workspace.globals.yaml` | `name`, `values` |

## CLI Execution

```bash
# Run full collection
postman collection run postman/collections/{Project}/ \
  --environment postman/environments/{Project}\ -\ Local.environment.yaml

# CI/CD (GitHub Actions)
- uses: postmanlabs/postman-cli-action@v1
  with:
    command: collection run postman/collections/{Project}/
```
