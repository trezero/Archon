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
