# Archon Backup & Restore Design

**Date:** 2026-03-18
**Status:** Approved
**Approach:** Hybrid — scheduled pg_dump + rsync + pre-staged recovery environment

## Problem

Archon runs entirely on a single machine (WIN-AI-PC, WSL2 Ubuntu 22.04) with a local
self-hosted Supabase instance. If the server goes down and its data is lost, all knowledge
base content, projects, tasks, sessions, settings, and embeddings are gone. There is
currently no backup mechanism.

## Goals

- **RPO (Recovery Point Objective):** 6 hours maximum data loss
- **RTO (Recovery Time Objective):** ~10 minutes to fully operational on backup server
- **Backup server:** `172.16.1.222` (Ubuntu 22.04, Docker installed, 154 GB free, ~86 MB/s network link)

## Data Inventory

### Tier 1 — Critical (data loss = start over)

| Data | Size | Location |
|------|------|----------|
| PostgreSQL (all 12 schemas — see note below) | 1.1 GB logical, **353 MB** compressed dump | `supabase-db` Docker container |
| PostgreSQL roles (via `pg_dumpall --globals-only`) | ~5 KB | `supabase-db` Docker container |
| Archon `.env` | ~3 KB | `/home/winadmin/projects/archon/.env` |
| localSupabase `.env` | ~4 KB | `/home/winadmin/projects/localSupabase/.env` |

The database contains 23 `archon_*` tables (1 GB of which is `archon_crawled_pages` with
vector embeddings), plus ~20 non-Archon public tables (memecoin, brand_settings, etc.),
auth schema, and Supabase system schemas.

**All 12 schemas captured by `pg_dump -Fc -d postgres`:** `public`, `auth`, `storage`,
`realtime`, `_realtime`, `extensions`, `graphql`, `graphql_public`, `pgbouncer`,
`supabase_functions`, `vault`, `net`. Verified via test dump on 2026-03-18 (353 MB).

**Roles:** `pg_dump -Fc` does not include role definitions. A separate
`pg_dumpall --globals-only` captures all roles (`supabase_admin`, `supabase_auth_admin`,
`supabase_storage_admin`, `authenticator`, `pgbouncer`, etc.) and must be restored before
the main dump.

### Tier 2 — Important (loss = inconvenience, manual re-setup)

| Data | Size | Location |
|------|------|----------|
| `archon-state.json` | <1 KB | `/home/winadmin/projects/archon/.claude/` |
| `archon-config.json` | <1 KB | `/home/winadmin/projects/archon/.claude/` |
| `archon-memory-buffer.jsonl` | ~240 KB | `/home/winadmin/projects/archon/.claude/` |
| `settings.local.json` | <1 KB | `/home/winadmin/projects/archon/.claude/` |
| `skills/` directory | ~212 KB | `/home/winadmin/projects/archon/.claude/skills/` |
| `commands/` directory | ~132 KB | `/home/winadmin/projects/archon/.claude/commands/` |
| `agents/` directory | ~16 KB | `/home/winadmin/projects/archon/.claude/agents/` |
| `plugins/` directory (excl. `.venv`) | ~264 KB | `/home/winadmin/projects/archon/.claude/plugins/` |
| `postmanSkill/.env` | <1 KB | `/home/winadmin/projects/archon/postmanSkill/.env` |
| Global `settings.json` | ~1 KB | `/home/winadmin/.claude/settings.json` |
| Auto-memory `.md` files | ~50 KB | `/home/winadmin/.claude/projects/-home-winadmin-projects-archon/memory/` |

### Tier 3 — Pre-staged on backup server (enables fast recovery)

| Data | Purpose |
|------|---------|
| Archon repo (`git pull` each cycle) | Code, migrations, docker-compose |
| localSupabase repo (`git pull` each cycle) | Supabase docker-compose and config |

### Not Backed Up (verified empty or unnecessary)

- Archon Docker volumes (`archon-server-data`, `archon-mcp-data`, `archon-ui-data`) — confirmed 4 KB each, empty
- Supabase Storage — confirmed 0 buckets, 0 objects
- Global `.claude/` session logs (73 MB of JSONL) — ephemeral, not worth the space
- Supabase `db-config` volume — default PostgreSQL config, recreated on startup
- `.claude/plugins/*/.venv/` — Python virtual environments, regenerated from `requirements.txt`
- `.claude/worktrees/` — git worktree metadata, ephemeral

## Architecture

### Backup Flow (runs on source machine)

```
archon-backup.sh (cron every 6 hours, or manual)
    │
    ├─ 1a. pg_dumpall --globals-only via docker exec supabase-db
    │      → ~/archon-backups/TIMESTAMP/roles.sql (~5 KB)
    │
    ├─ 1b. pg_dump -Fc -d postgres via docker exec supabase-db
    │      all 12 schemas, compressed (~353 MB)
    │      → ~/archon-backups/TIMESTAMP/archon.dump
    │
    ├─ 2. Collect Tier 1 + Tier 2 files
    │     → ~/archon-backups/TIMESTAMP/env/
    │     → ~/archon-backups/TIMESTAMP/claude-state/
    │
    ├─ 3. Verify backup integrity
    │     - pg_restore --list (valid archive)
    │     - file completeness check
    │     - size sanity vs previous backup
    │
    ├─ 4. rsync -az to 172.16.1.222:~/archon-backups/
    │     update "latest" symlink on remote
    │
    ├─ 5. Remote: git pull Archon + localSupabase repos
    │
    ├─ 6. Rotate: keep last 28 backups, prune older
    │     (tagged backups exempt from rotation)
    │
    └─ 7. Log result to backup.log
```

### Restore Flow (runs on backup server)

```
archon-restore.sh [backup_name]  (defaults to "latest")
    │
    ├─ 1. Validate backup exists, dump + roles.sql present, env files present
    │
    ├─ 2. Place .env files (MUST happen before Supabase starts — see edge cases)
    │     archon.env → $ARCHON_DIR/.env
    │     localsupabase.env → /home/winadmin/projects/localSupabase/.env
    │     postmanskill.env → $ARCHON_DIR/postmanSkill/.env
    │
    ├─ 3. Restore Claude state
    │     Project-level → $ARCHON_DIR/.claude/
    │     Plugins (excl .venv) → $ARCHON_DIR/.claude/plugins/
    │     Global settings → /home/winadmin/.claude/settings.json
    │     Memory → /home/winadmin/.claude/projects/.../memory/
    │
    ├─ 4. Start Supabase
    │     cd localSupabase && docker compose up -d
    │     Wait for supabase-db healthy
    │
    ├─ 5. Restore roles (must precede data restore)
    │     docker exec -i supabase-db psql -U postgres < roles.sql
    │     (Supabase init scripts create most roles; this catches any extras)
    │
    ├─ 6. Restore database
    │     docker exec -i supabase-db pg_restore \
    │       -U postgres -d postgres --clean --if-exists
    │
    ├─ 7. Start Archon
    │     cd $ARCHON_DIR && docker compose up -d
    │
    ├─ 8. Health check
    │     curl localhost:8181/health
    │     curl localhost:8051/health
    │
    └─ 9. Print summary (timestamp, DB size, services status)

$ARCHON_DIR defaults to /home/winadmin/projects/Archon on the backup server.
Configurable via ARCHON_DIR env var to handle path differences between machines.
```

## Directory Layout

### Source machine (local staging before rsync)

```
~/archon-backups/
├── backup.log
└── YYYY-MM-DD_HHMMSS/
    ├── archon.dump           (~353 MB compressed)
    ├── roles.sql             (~5 KB)
    ├── env/
    │   ├── archon.env
    │   ├── localsupabase.env
    │   └── postmanskill.env
    └── claude-state/
        ├── archon-state.json
        ├── archon-config.json
        ├── archon-memory-buffer.jsonl
        ├── settings.local.json
        ├── global-settings.json
        ├── skills/
        ├── commands/
        ├── agents/
        ├── plugins/          (excl. .venv/)
        └── memory/
```

### Backup server

```
~/archon-backups/
├── backup.log
├── latest -> YYYY-MM-DD_HHMMSS/   (symlink)
├── YYYY-MM-DD_HHMMSS/
│   └── (same structure as above)
├── YYYY-MM-DD_HHMMSS_pre-migration/  (tagged, exempt from rotation)
│   └── ...

~/projects/
├── Archon/           (git pull each backup cycle)
└── localSupabase/    (git pull each backup cycle)
```

## Backup Schedule & Retention

- **Frequency:** Every 6 hours via cron (`0 0,6,12,18 * * *`)
- **Retention:** Last 28 backups (7 days)
- **Tagged backups:** Created with `--tag "reason"`, exempt from rotation, manually deleted
- **Estimated storage:** ~353 MB/backup × 28 = ~10 GB (well within 154 GB available)

## On-Demand Backup

```bash
# Standard manual backup
./scripts/backup/archon-backup.sh

# Tagged backup (exempt from rotation)
./scripts/backup/archon-backup.sh --tag "pre-migration"
```

## Verification

### Built into backup script (every run)

1. `pg_restore --list` on the dump — confirms valid archive format
2. File completeness — both `.env` files and `archon-state.json` present and non-empty
3. Size sanity — warns if dump is <80% of previous backup size or zero bytes

### Restore readiness check (manual, run on backup server)

`scripts/backup/archon-verify-restore.sh`:
1. Confirms `latest` symlink points to a valid backup
2. Confirms both repos are up to date
3. Confirms Docker is running
4. Dry-runs `pg_restore --list` on latest dump
5. Reports: "Restore-ready: YES/NO"

## Edge Cases

### host.docker.internal differences

The Archon `.env` references `host.docker.internal` for `SUPABASE_URL`. Docker Desktop
(WSL2) and native Docker (Ubuntu) may resolve this differently. The restore script checks
this and warns if adjustment is needed.

### Unflushed memory buffer

`archon-memory-buffer.jsonl` may contain session observations not yet flushed to the
database. The backup captures the file state at backup time; any observations added after
the backup but before a crash would be lost (acceptable given the 6-hour RPO).

### Non-Archon tables

The full `pg_dump` captures all schemas including non-Archon tables (memecoin,
brand_settings, etc.). This is intentional — it's a full instance backup, not selective.

### Path casing: `archon` vs `Archon`

The source machine uses lowercase `/home/winadmin/projects/archon/`. The backup server's
existing clone uses uppercase `/home/winadmin/projects/Archon/` (matching the GitHub repo
name). The restore script uses `$ARCHON_DIR` to abstract this. Claude Code's auto-memory
directory encodes the project path, so memory files backed up from the source machine will
only be found if the project path matches. The restore script places them at the
source-machine-encoded path regardless of the actual project directory.

### localSupabase .env ordering is critical

The localSupabase `.env` contains `VAULT_ENC_KEY` used by pgsodium for column-level
encryption. If Supabase initializes with a different key, vault-encrypted data becomes
unrecoverable. The restore script MUST place the `.env` file before running
`docker compose up -d` for Supabase. The restore flow (step 2 before step 4) enforces this.

### PostgreSQL data directory mount differences

On WSL2/Docker Desktop, the PostgreSQL data directory (`volumes/db/data/`) is redirected
through Docker Desktop's internal bind mount mechanism. On native Ubuntu (the backup
server), it is a direct bind mount. This means after `docker compose up -d` on the backup
server, the `volumes/db/data/` directory will be populated directly on disk. The
`pg_restore` overwrites the database contents regardless of mount type.

### Backup staleness detection

If the cron job fails silently, the RPO could be exceeded without anyone knowing. The
backup script checks the age of the most recent remote backup after each run. If the
newest backup is >12 hours old (2× the RPO), it logs a `STALE_BACKUP_WARNING`. A future
enhancement could send this alert via webhook or email.

## Files to Create

| File | Purpose |
|------|---------|
| `scripts/backup/archon-backup.sh` | Backup script (cron + manual) |
| `scripts/backup/archon-restore.sh` | One-command restore on backup server |
| `scripts/backup/archon-verify-restore.sh` | Restore readiness verification |

## Recovery Timeline

| Step | Duration |
|------|----------|
| SSH to backup server | ~1 min |
| Run `archon-restore.sh` | ~1 min (file copies) |
| Supabase startup + healthy | ~2 min |
| Database restore | ~2-3 min |
| Archon containers start | ~1 min |
| Health checks pass | ~1 min |
| **Total** | **~8-10 min** |
