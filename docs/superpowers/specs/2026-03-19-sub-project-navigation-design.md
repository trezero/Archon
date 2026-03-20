# Sub-Project Navigation Design

## Problem

Parent projects (projects with children linked via `parent_project_id`) have no special treatment in the UI. Users cannot discover or navigate to child projects from a parent's detail page. Additionally, parent-child relationships established by the scanner on one system cannot be managed or corrected from the Archon UI.

## Design Decisions

- **Approach A** selected: horizontal scrolling card strip on the parent detail page, with a management modal
- Parent-child is an **Archon-level concept** (database), not tied to filesystem layout — a project can be a child on one system's directory structure but standalone on another
- `parent_project_id` is a **single field** — one parent per project, enforced by the DB's single-level hierarchy trigger
- Child cards use the **existing DataCard primitive** at a compact size for styling consistency
- No new database schema — all required fields already exist

## Section 1: Projects List — Parent Indicators

### Parent projects in grid/table

When a project has children (is a parent), the card shows:

- A **folder-tree icon** next to the project name
- A **count pill** (e.g., "3 sub-projects") styled consistently with existing StatPill — compact, muted color

No other changes to the card. Clicking navigates to the project detail page as normal.

### Child projects in grid/table

When viewing the flat (ungrouped) list, child projects show a **breadcrumb-style parent link** under the project name:

- Format: `"↳ RecipeRaiders_Complete"` in muted text
- Clicking the parent name navigates to the parent's detail page
- Only visible in flat view — when grouped by parent, the hierarchy is already apparent

### Components affected

- `ProjectGridCard` — add icon + count pill for parents, breadcrumb for children
- `ProjectTableRow` — same indicators adapted for table layout

## Section 2: Parent Detail Page — Sub-Projects Strip

### Layout

A **horizontal scrolling strip** of compact child cards, positioned between the project header and the tab bar. Only renders when the project has children.

### Strip structure

- A muted `"Sub-Projects"` label (left-aligned, above or inline with the strip)
- Horizontal flex container with `gap: 8px` and `overflow-x: auto`
- A `"Manage"` button (ghost/outline style) on the right side of the strip header
- Separated from the tabs below by a subtle border

### Child card contents (minimal)

- Project name
- System badges (e.g., macOS, WSL)
- Git dirty indicator (amber dot) if applicable
- Click anywhere on the card → navigates to that child's detail page

### Card styling

Compact variant of DataCard — same border, background, and color system as existing cards. Smaller padding and font size. Fixed minimum width to prevent cards from collapsing on narrow content.

### Breadcrumb on child detail pages

When viewing a child project's detail page, a breadcrumb appears above the project name:

- Format: `"RecipeRaiders_Complete › RecipeRaiders"`
- Clicking the parent segment navigates to the parent's detail page
- Does not appear for root-level projects

## Section 3: Parent-Child Management

### Entry point A: "Manage" button on the sub-projects strip

Opens a **ManageSubProjectsModal** with:

- **Current children** listed with a remove (unlink) button next to each
- **Search field** at the top to find and add existing Archon projects as children
  - Filters out projects that already have a parent (single-parent constraint)
  - Filters out the parent itself
  - Selecting a project from results sets its `parent_project_id` to this parent
- Unlinking clears the child's `parent_project_id` — does not delete the project

### Entry point B: "Parent Project" dropdown on project edit form

Added to the existing project edit modal/form:

- Dropdown listing all projects that qualify as parents (no parent of their own)
- A "None" option to clear the parent and make the project standalone
- This allows moving a child between parents or removing it from a parent entirely

### Entry point C: Scan-time conflict resolution

When `/scan-projects` discovers a project nested under a different parent directory than its current `parent_project_id` in Archon:

- The scan-projects skill detects the conflict
- Presents it to the user during the scan: "RecipeRaiders is currently under RecipeRaiders_Complete but was found under RecipeRaiders_Ecosystem on this system. Keep current parent / Change parent / Remove parent?"
- Keeps conflict resolution at scan time rather than requiring dedicated conflict UI

The "Set Parent" dropdown in the Archon UI serves as the manual cleanup tool for anything that slips through.

## Section 4: Backend & Data

### Schema

No changes. `parent_project_id` (UUID, self-referencing FK), `metadata` (JSONB), and `tags` (text array) already exist. Single-level hierarchy enforced by `enforce_single_level_hierarchy` trigger.

### New API endpoint

**`GET /api/projects/{id}/children`**

Returns a lightweight list of child projects for a given parent. Response includes:

- `id`, `title`, `description`
- `system_registrations` (system name, OS, git dirty status)
- `tags`

This avoids loading full project data for each child on the parent detail page.

### Existing endpoints (no changes needed)

- `PUT /api/projects/{id}` — already accepts `parent_project_id` for setting/clearing parent
- `GET /api/projects` — already returns `parent_project_id` for list indicators
- `GET /api/projects/{id}` — already returns full project data including `parent_project_id`

### Frontend data flow

**New query hook:** `useProjectChildren(projectId)`
- Fetches children via the new endpoint
- Query key: `projectKeys.children(id)` added to the existing factory
- Uses `STALE_TIMES.normal` (30s)

**New service method:** `projectService.getProjectChildren(id)` added to existing service file.

**Optimistic updates:** When linking/unlinking a child via the manage modal:
- Optimistically update the children list query
- Invalidate the affected child's detail query (its `parent_project_id` changed)

### New components

| Component | Location | Purpose |
|-----------|----------|---------|
| `SubProjectsStrip` | `features/projects/components/` | Horizontal strip + manage button on parent detail page |
| `SubProjectCard` | `features/projects/components/` | Compact DataCard variant for the strip |
| `ManageSubProjectsModal` | `features/projects/components/` | Modal for adding/removing children |

### Modified components

| Component | Change |
|-----------|--------|
| `ProjectGridCard` | Add folder-tree icon + count pill for parents; breadcrumb link for children |
| `ProjectTableRow` | Same indicators adapted for table layout |
| Project detail page | Add `SubProjectsStrip` above tabs; add breadcrumb for child projects |
| Project edit form/modal | Add "Parent Project" dropdown field |

## Out of Scope

- Multi-parent relationships (DB enforces single parent)
- Deep nesting beyond one level (DB trigger prevents it)
- Drag-and-drop reordering of children
- Aggregated task/activity counts across children on the parent card
- Opening projects in external tools (Claude Code, terminals) from the UI
