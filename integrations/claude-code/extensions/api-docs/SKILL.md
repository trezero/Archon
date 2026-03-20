---
name: api-docs
description: Use when creating, modifying, or reviewing FastAPI API endpoints. Ensures endpoints have complete OpenAPI documentation including response models, field descriptions, status codes, and examples. Also generates Postman collection entries. Triggers on: "create endpoint", "add API route", "document API", "audit endpoints", "retrofit API docs", or when working in FastAPI route files.
---

# API Documentation Enforcement

Ensures every FastAPI endpoint has complete OpenAPI documentation and generates Postman collection entries. Works in any FastAPI project by discovering project structure at runtime.

## Phase 0: Guard — Detect FastAPI

Before doing anything, confirm this project uses FastAPI.

1. Use Grep to search for `APIRouter` or `FastAPI` in `*.py` files from the project root
   - Exclude: `venv/`, `.venv/`, `node_modules/`, `__pycache__/`, `.git/`, `site-packages/`
   - A single match is sufficient
2. **If found:** Proceed to Phase 1 (Project Discovery)
3. **If not found:** Output: *"Skipping API documentation — no FastAPI endpoints detected in this project."* and stop. Do not proceed further.

## Phase 1: Project Discovery

Run once per activation. Discover the project layout silently — no output to the user unless something unexpected is found (e.g., multiple FastAPI apps).

### Step 1: Find Python package root
Use Glob to find `pyproject.toml`, `setup.py`, or `requirements.txt`. The directory containing the first match is the Python package root.

### Step 2: Find all route files
Use Grep to find all `.py` files containing `APIRouter()`. These are the route files. Note the directory they live in — this is the route directory (e.g., `api_routes/`, `routes/`, `routers/`).

### Step 3: Infer service directory
Read several route files and look for import statements that reference service modules (e.g., `from ...services.project_service import ...`). The directory these imports resolve to is the service directory. If no service imports are found, note that the project does not use a service layer.

### Step 4: Determine model location
Check if route files define Pydantic models inline (classes inheriting `BaseModel` in the same file as route handlers) or import them from separate files (`schemas.py`, `models.py`). Follow whichever convention the project uses.

### Step 5: Detect Pydantic version
Check `pyproject.toml` or `requirements.txt` for the pydantic version:
- `pydantic>=2` or `pydantic==2.*` → **Pydantic v2** — use `model_config = ConfigDict(...)`, `json_schema_extra`
- `pydantic>=1` or `pydantic==1.*` → **Pydantic v1** — use `class Config`, `schema_extra`
- Cannot determine → default to **Pydantic v2**

### Step 6: Find app entry point
Use Grep to find the file containing `include_router(` — this is the app entry point (e.g., `main.py`). Needed for wiring new routers.

### Step 7: Check Postman integration
Check if the postman-integration skill is available (look for it in the current skill set or check for `postman-integration` in available skills). If available, Postman collection generation will be performed after endpoint work. If not, skip Postman steps silently.

### Multiple FastAPI apps
If Grep finds `FastAPI()` instantiated in more than one file, ask the user which app to target before proceeding.

### Discovery output
After discovery, you should know:
- Route directory path and list of route files
- Service directory path (or "none")
- Model convention (inline or separate files)
- Pydantic version (v1 or v2)
- App entry point path
- Postman integration availability (yes/no)

Proceed to Phase 2 (Mode Detection).

## Phase 2: Mode Detection

Determine which mode to run based on context:

- **Intercept mode** — You are mid-task building a feature and need to create or modify endpoints. The skill was triggered by the frontmatter matching your current work context (creating route handlers, working in files with `APIRouter()`). Go to Phase 3.
- **Retrofit mode** — The user explicitly asked to document, audit, or review existing endpoints (e.g., "document all API endpoints", "audit the projects API", "generate API docs for this repo"). Go to Phase 4.
- **Ambiguous** — Ask the user: *"Should I apply documentation standards to the endpoints you're building (intercept), or audit and fix existing endpoints (retrofit)?"*

## Documentation Standards

Both modes enforce these standards. An endpoint is "fully documented" when ALL of the following are present.

### Route Decorator Requirements

Every route decorator (`@router.get`, `@router.post`, etc.) MUST have:

| Parameter | Rule | Example |
|-----------|------|---------|
| `response_model` | Pydantic model defining the response shape | `response_model=ProjectResponse` |
| `status_code` | Explicit HTTP status code | `status_code=201` for POST, `200` for GET, `204` for DELETE |
| `tags` | At least one tag for Swagger UI grouping | `tags=["projects"]` |
| `description` | One-line summary (alternative to docstring) | `description="Create a new project"` |
| `responses` | Error responses the endpoint can return | `responses={404: {"description": "Not found"}}` |

The endpoint function MUST have:
- A **docstring** OR the decorator must have a `description` parameter — one-line summary of what the endpoint does
- **Type hints** on all parameters
- **Return type annotation** matching the `response_model`

### Pydantic Model Requirements

Every request and response model MUST have:

**All fields** use `Field()` with a `description`:
```python
# Required field
title: str = Field(..., description="The project title")

# Optional field
description: str | None = Field(None, description="Optional project summary")
```

**Response models** include an example:

Pydantic v2:
```python
class ProjectResponse(BaseModel):
    id: str = Field(..., description="Unique project identifier")
    title: str = Field(..., description="The project title")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "proj_abc123",
                "title": "My Project"
            }
        }
    )
```

Pydantic v1:
```python
class ProjectResponse(BaseModel):
    id: str = Field(..., description="Unique project identifier")
    title: str = Field(..., description="The project title")

    class Config:
        schema_extra = {
            "example": {
                "id": "proj_abc123",
                "title": "My Project"
            }
        }
```

Use whichever version was detected during Project Discovery (Phase 1, Step 5).

### What This Skill Does NOT Enforce

- Docstring format or length beyond "exists and is non-empty"
- Specific tag naming conventions (use what the project already uses, or the feature name)
- Authentication/authorization patterns
- Service layer implementation details
- Test coverage

## Phase 3: Intercept Mode

Intercept mode is invisible. The developer asks for a feature, and the endpoints come out fully documented. This is a quality standard, not a workflow step.

### Workflow

#### Step 1: Apply documentation standards inline

As you write the endpoint, bake in all documentation standards from the start. Do not write a bare endpoint and fix it later — write it correctly the first time:

```python
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, ConfigDict

router = APIRouter(prefix="/projects", tags=["projects"])

class CreateProjectRequest(BaseModel):
    title: str = Field(..., description="The project title")
    description: str | None = Field(None, description="Optional project summary")

class ProjectResponse(BaseModel):
    id: str = Field(..., description="Unique project identifier")
    title: str = Field(..., description="The project title")
    description: str | None = Field(None, description="Optional project summary")
    created_at: str = Field(..., description="ISO 8601 creation timestamp")

    model_config = ConfigDict(
        json_schema_extra={
            "example": {
                "id": "proj_abc123",
                "title": "My Project",
                "description": "A sample project",
                "created_at": "2026-01-15T10:30:00Z"
            }
        }
    )

@router.post(
    "/",
    response_model=ProjectResponse,
    status_code=status.HTTP_201_CREATED,
    tags=["projects"],
    responses={
        422: {"description": "Validation error in request body"},
    },
)
async def create_project(request: CreateProjectRequest) -> ProjectResponse:
    """Create a new project."""
    return await project_service.create(request)
```

Adapt this pattern to the project's conventions discovered in Phase 1 (Pydantic version, model location, import style).

#### Step 2: Full slice scaffolding (when applicable)

If creating a new endpoint and the supporting service method does not exist:

1. **Create service method stub** — In the service file discovered during Phase 1, add a stub method:
   ```python
   async def create(self, request: CreateProjectRequest) -> dict:
       """Create a new project."""
       raise NotImplementedError("TODO: implement")
   ```
2. **Create service file if needed** — If no service file exists for this feature, create one following the closest existing service file's pattern (imports, class structure, constructor).
3. **Wire router if needed** — If this is a brand new feature router, add `app.include_router(...)` to the app entry point found in Phase 1.

**Skip scaffolding entirely if:**
- The project does not have a service layer (no service files found in Phase 1)
- The endpoint is being added to an existing feature that already has services wired up

#### Step 3: Postman handoff

After the endpoint is written and committed, follow the Postman Integration instructions in Phase 5.

#### Step 4: Continue

Resume the developer's original task. Do not produce a report or prompt for review — the endpoint is already documented.
