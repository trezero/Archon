# Documentation Impact Findings: PR #357

**Reviewer**: docs-impact-agent
**Date**: 2026-01-30T11:00:00Z
**Docs Checked**: CLAUDE.md, docs/, agents, README.md

---

## Summary

PR #357 replaces a full unique constraint on `isolation_environments` with a partial unique index and adds an ON CONFLICT upsert clause. The primary documentation impact is that the README's migration instructions for existing installations need to include the new migration file `011_partial_unique_constraint.sql`. CLAUDE.md and other docs require no changes since they don't document constraint-level schema details.

**Verdict**: UPDATES_REQUIRED

---

## Impact Assessment

| Document | Impact | Required Update |
|----------|--------|-----------------|
| CLAUDE.md | NONE | None - only mentions `isolation_environments` table by name, no constraint details |
| README.md | MEDIUM | Migration instructions need new migration `011_partial_unique_constraint.sql` |
| docs/architecture.md | NONE | None - does not reference isolation_environments constraints |
| docs/configuration.md | NONE | None - no schema details |
| docs/migration-guide.md | NONE | None - covers runtime defaults migration, not schema changes |
| docs/worktree-orchestration.md | NONE | None - references isolation concepts but not DB constraints |
| .claude/agents/*.md | NONE | None - agent definitions not affected |
| .archon/commands/*.md | NONE | None - command definitions not affected |

---

## Findings

### Finding 1: README Missing Migration 011 in Upgrade Instructions

**Severity**: MEDIUM
**Category**: incomplete-docs
**Document**: `README.md`
**PR Change**: `migrations/011_partial_unique_constraint.sql` - New migration file added

**Issue**:
The README lists individual migration files for users upgrading existing installations (both bare-metal PostgreSQL and Docker PostgreSQL). The new migration `011_partial_unique_constraint.sql` is not listed, so existing users won't know to apply it.

**Current Documentation**:
```markdown
# README.md lines 265-274 (bare-metal PostgreSQL)
**For updates to existing installations**, run only the migrations you haven't applied yet:

psql $DATABASE_URL < migrations/002_command_templates.sql
psql $DATABASE_URL < migrations/003_add_worktree.sql
psql $DATABASE_URL < migrations/004_worktree_sharing.sql
psql $DATABASE_URL < migrations/006_isolation_environments.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
```

```markdown
# README.md lines 295-301 (Docker PostgreSQL)
\i /migrations/002_command_templates.sql
\i /migrations/003_add_worktree.sql
\i /migrations/004_worktree_sharing.sql
\i /migrations/006_isolation_environments.sql
\i /migrations/007_drop_legacy_columns.sql
```

```markdown
# README.md lines 306-311 (Docker host machine)
psql ... < migrations/002_command_templates.sql
psql ... < migrations/003_add_worktree.sql
psql ... < migrations/004_worktree_sharing.sql
psql ... < migrations/006_isolation_environments.sql
psql ... < migrations/007_drop_legacy_columns.sql
```

**Code Change**:
```sql
-- migrations/011_partial_unique_constraint.sql
ALTER TABLE remote_agent_isolation_environments
  DROP CONSTRAINT IF EXISTS unique_workflow;

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_workflow
  ON remote_agent_isolation_environments (codebase_id, workflow_type, workflow_id)
  WHERE status = 'active';
```

**Impact if Not Updated**:
Existing PostgreSQL users who upgrade won't apply the new migration, leaving the old full unique constraint in place. This means they'll continue to hit issue #239 (workflows blocked from re-triggering after environment cleanup). SQLite users are unaffected since their schema is recreated from the adapter code.

---

#### Update Suggestions

| Option | Approach | Scope | Effort |
|--------|----------|-------|--------|
| A | Add migration 011 to all three existing migration lists in README | All three PostgreSQL setup sections | LOW |
| B | Same as A, plus add a note explaining what migration 011 does | Same scope + inline comment | LOW |

**Recommended**: Option A

**Reasoning**:
- Matches the existing pattern (just listing migration files)
- Other migrations in the list don't have explanatory notes
- The migration file itself has comments explaining the change
- Consistent with established documentation style

**Suggested Documentation Update**:

For bare-metal PostgreSQL (around line 274):
```markdown
psql $DATABASE_URL < migrations/002_command_templates.sql
psql $DATABASE_URL < migrations/003_add_worktree.sql
psql $DATABASE_URL < migrations/004_worktree_sharing.sql
psql $DATABASE_URL < migrations/006_isolation_environments.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
psql $DATABASE_URL < migrations/011_partial_unique_constraint.sql
```

For Docker `\i` commands (around line 301):
```markdown
\i /migrations/002_command_templates.sql
\i /migrations/003_add_worktree.sql
\i /migrations/004_worktree_sharing.sql
\i /migrations/006_isolation_environments.sql
\i /migrations/007_drop_legacy_columns.sql
\i /migrations/011_partial_unique_constraint.sql
```

For Docker host machine (around line 311):
```markdown
psql postgresql://postgres:postgres@localhost:5432/remote_coding_agent < migrations/011_partial_unique_constraint.sql
```

**Documentation Style Reference**:
```markdown
# SOURCE: README.md lines 265-274
# Existing pattern: plain list of migration files, no explanatory text per migration
psql $DATABASE_URL < migrations/006_isolation_environments.sql
psql $DATABASE_URL < migrations/007_drop_legacy_columns.sql
```

---

## CLAUDE.md Sections to Update

| Section | Current | Needed Update |
|---------|---------|---------------|
| Database Schema | Lists `isolation_environments` by name only | None needed - no constraint-level detail documented |

---

## Statistics

| Severity | Count | Documents Affected |
|----------|-------|-------------------|
| CRITICAL | 0 | - |
| HIGH | 0 | - |
| MEDIUM | 1 | README.md |
| LOW | 0 | - |

---

## New Documentation Needed

| Topic | Suggested Location | Priority |
|-------|-------------------|----------|
| None | - | - |

No new documentation sections are needed. The change is a database-level fix that doesn't introduce new user-facing features or concepts.

---

## Positive Observations

- The new migration file (`011_partial_unique_constraint.sql`) has clear header comments explaining the purpose, version, and linked issue
- The combined migration (`000_combined.sql`) was updated in sync, ensuring fresh installs get the correct schema
- The SQLite adapter was also updated, maintaining parity between database backends
- Inline SQL comments in both the migration and adapter code explain the partial index rationale

---

## Metadata

- **Agent**: docs-impact-agent
- **Timestamp**: 2026-01-30T11:00:00Z
- **Artifact**: `.archon/artifacts/runs/14ad0f4c-daa1-4fa2-babb-92822620ac7b/review/docs-impact-findings.md`
