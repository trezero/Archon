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
