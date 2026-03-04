---
name: archon-skill-sync
description: Sync local Claude Code skills with the Archon skill registry. Detects new skills, local modifications, and pending installs. Use when "sync skills", "check skills", "update skills", or at startup when sync is stale.
---

# Archon Skill Sync

Synchronizes local Claude Code skills with the Archon skill registry. Detects drift, handles conflict resolution, installs pending skills, and uploads new local skills.

**Invocation:** `/archon-skill-sync`
**Auto-trigger:** Runs automatically when any Archon skill detects last_skill_sync > 24h in `.claude/archon-state.json`

---

## Phase 0: Compute Machine Fingerprint

### 0a. Gather system info

```bash
hostname
```

```bash
whoami
```

```bash
uname -s
```

### 0b. Compute fingerprint

Concatenate: `<hostname>|<username>|<os>` and compute SHA256:

```bash
echo -n "$(hostname)|$(whoami)|$(uname -s)" | sha256sum | cut -d' ' -f1
```

Store as `system_fingerprint`.

---

## Phase 1: Scan Local Skills

### 1a. Find all SKILL.md files

Scan these directories for SKILL.md files:
- `.claude/skills/` (user-installed skills)
- `integrations/claude-code/skills/` (repo skills, if in Archon repo)
- Any directory listed in `.claude/archon-state.json` under `skill_directories`

```
Glob: .claude/skills/**/SKILL.md
Glob: integrations/claude-code/skills/**/SKILL.md
```

### 1b. Parse each skill

For each SKILL.md found:
1. Read the file content
2. Parse YAML frontmatter to extract `name`
3. Compute SHA256 hash of the full content:
   ```bash
   sha256sum <filepath> | cut -d' ' -f1
   ```

Build `local_skills` list: `[{name, content_hash}]`

---

## Phase 2: Sync with Archon

### 2a. Read project state

Read `.claude/archon-state.json` for `archon_project_id`.

If no project ID:
> "No Archon project linked. Run `/link-to-project` first to associate this repo with an Archon project."

Stop here.

### 2b. Call sync

```
manage_skills(
    action="sync",
    local_skills=<local_skills list>,
    system_fingerprint="<fingerprint>",
    project_id="<archon_project_id>"
)
```

### 2c. Handle first-time registration

If response has `system.is_new == true`:

Ask the user:
> "This is the first time this machine is connecting to Archon. What name should we use for this system?"
>
> Suggestion: `<hostname>`

Store the user's choice, then re-call:
```
manage_skills(
    action="sync",
    local_skills=<local_skills list>,
    system_fingerprint="<fingerprint>",
    system_name="<user-provided-name>",
    project_id="<archon_project_id>"
)
```

---

## Phase 3: Process Sync Results

### 3a. Install pending skills

For each item in `pending_install`:
1. Write the `content` to `.claude/skills/<name>/SKILL.md`
2. Report: "Installed skill: <name>"

### 3b. Remove pending skills

For each item in `pending_remove`:
1. Delete `.claude/skills/<name>/SKILL.md`
2. Report: "Removed skill: <name>"

### 3c. Resolve local changes

For each item in `local_changes`, ask the user:

> "Skill **<name>** has local modifications (local hash: `<local_hash>`, Archon hash: `<archon_hash>`). What would you like to do?"

Options:
- **Update Source** — Push local content to Archon as a new version
- **Save as Project Version** — Store as a project-specific override
- **Create New Skill** — Upload as a new skill with a different name
- **Discard Changes** — Overwrite local with Archon version

**If Update Source:**
Read the local file content, then:
```
manage_skills(action="upload", skill_content="<local content>")
```

**If Save as Project Version:**
Read the local file content. The backend stores it as a project override (future API call).

**If Create New Skill:**
Ask for a new name, then:
```
manage_skills(action="validate", skill_content="<local content>")
```
If validation passes:
```
manage_skills(action="upload", skill_content="<local content>", skill_name="<new-name>")
```

**If Discard Changes:**
Fetch the Archon version via `find_skills(skill_id="<skill_id>")` and overwrite the local file.

### 3d. Handle unknown local skills

For each item in `unknown_local`, ask the user:

> "Found local skill **<name>** not in Archon. Would you like to upload it to the registry?"

Options:
- **Upload** — Validate and upload
- **Skip** — Leave as local-only

**If Upload:**
Read the local file, then:
```
manage_skills(action="validate", skill_content="<content>")
```
If validation passes (or user accepts warnings):
```
manage_skills(action="upload", skill_content="<content>")
```
If validation has errors, show them and ask user to fix.

---

## Phase 4: Update State

### 4a. Write sync timestamp

Update `.claude/archon-state.json`:
```json
{
  "last_skill_sync": "<ISO timestamp>",
  "system_fingerprint": "<fingerprint>",
  "system_name": "<name>"
}
```

Merge with existing state — do not overwrite other fields.

### 4b. Summary

> "**Skill sync complete:**
> - In sync: <N> skills
> - Installed: <list or 'none'>
> - Removed: <list or 'none'>
> - Updated: <list or 'none'>
> - Uploaded: <list or 'none'>
> - Skipped: <list or 'none'>"

---

## Important Notes

### Sync Freshness

Other Archon skills check sync freshness in their Phase 0:
```
Read .claude/archon-state.json
If last_skill_sync is missing or older than 24h:
  → Run /archon-skill-sync before continuing
```

### Skill File Locations

- **Installed skills:** `.claude/skills/<name>/SKILL.md`
- **Repo skills:** `integrations/claude-code/skills/<name>/SKILL.md`
- Skills are identified by their frontmatter `name` field, not directory name

### Error Recovery

- If Archon is unreachable, skip sync and continue with stale state
- If a single skill install/upload fails, continue with remaining operations
- Always save the sync timestamp even if some operations failed (prevents retry loops)
