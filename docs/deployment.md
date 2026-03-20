# Deployment Guide

This guide covers how to run the Archon server locally, with Docker, and in production. For VPS deployment with automatic HTTPS, see the [Cloud Deployment Guide](cloud-deployment.md).

**Quick links:** [Local Development](#local-development) | [Docker with Remote DB](#docker-with-remote-postgresql) | [Docker with Local PostgreSQL](#docker-with-local-postgresql) | [Production](#production-deployment)

---

## Local Development

Local development with SQLite is the recommended default. No database setup is needed.

### Prerequisites

- [Bun](https://bun.sh) 1.0+
- At least one AI assistant configured (Claude Code or Codex)
- A GitHub token for repository cloning (`GH_TOKEN` / `GITHUB_TOKEN`)

### Setup

```bash
# 1. Clone and install
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
bun install

# 2. Configure environment
cp .env.example .env
nano .env  # Add your AI assistant tokens (Claude or Codex)

# 3. Start server + Web UI (SQLite auto-detected, no database setup needed)
bun run dev

# 4. Open Web UI
# http://localhost:5173
```

In development mode, two servers run simultaneously:

| Service    | URL                    | Purpose                          |
|------------|------------------------|----------------------------------|
| Web UI     | http://localhost:5173  | React frontend (Vite dev server) |
| API Server | http://localhost:3090  | Backend API + SSE streaming      |

### Optional: Use PostgreSQL Instead of SQLite

If you prefer PostgreSQL for local development:

```bash
docker compose --profile with-db up -d postgres
# Set DATABASE_URL=postgresql://postgres:postgres@localhost:5432/remote_coding_agent in .env
```

> **Note:** The database schema is created automatically on first container startup via the mounted migration file. No manual `psql` step is needed for fresh installs.

### Production Build (Local)

```bash
bun run build    # Build the frontend
bun run start    # Server serves both API and Web UI on port 3090
```

### Verify It Works

```bash
curl http://localhost:3090/health
# Expected: {"status":"ok"}
```

---

## Docker with Remote PostgreSQL

Use this option when your database is hosted externally (Supabase, Neon, AWS RDS, etc.). This starts only the app container.

### Prerequisites

- Docker & Docker Compose
- A remote PostgreSQL database with `DATABASE_URL` set in `.env`
- AI assistant tokens configured in `.env`

### Setup

```bash
# 1. Get the deployment files
mkdir remote-agent && cd remote-agent
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/deploy/.env.example -o .env

# 2. Configure (edit .env with your tokens and DATABASE_URL)
nano .env

# 3. Start app container
docker compose --profile external-db up -d --build

# 4. View logs
docker compose logs -f app

# 5. Verify
curl http://localhost:3090/health
```

### Database Migration (First Time)

For fresh installations, run the combined migration:

```bash
psql $DATABASE_URL < migrations/000_combined.sql
```

### Stop

```bash
docker compose --profile external-db down
```

---

## Docker with Local PostgreSQL

Use this option to run both the app and PostgreSQL in Docker containers. The database schema is created automatically on first startup.

### Setup

```bash
# 1. Configure .env
# Set: DATABASE_URL=postgresql://postgres:postgres@postgres:5432/remote_coding_agent

# 2. Start both containers
docker compose --profile with-db up -d --build

# 3. Wait for startup (watch logs)
docker compose logs -f app-with-db

# 4. Verify
curl http://localhost:3090/health
```

> **Note:** Database tables are created automatically via the init script on first startup. No manual migration step is needed.

### Updating an Existing Installation

When new migrations are added, apply them manually:

```bash
# Connect to the running postgres container
docker compose exec postgres psql -U postgres -d remote_coding_agent

# Run migrations you haven't applied yet
\i /migrations/002_command_templates.sql
\i /migrations/003_add_worktree.sql
\i /migrations/004_worktree_sharing.sql
\i /migrations/006_isolation_environments.sql
\i /migrations/007_drop_legacy_columns.sql
\i /migrations/011_partial_unique_constraint.sql
\q
```

### Stop

```bash
docker compose --profile with-db down
```

---

## Production Deployment

For deploying to a VPS (DigitalOcean, Linode, AWS EC2, etc.) with automatic HTTPS via Caddy, see the [Cloud Deployment Guide](cloud-deployment.md).

---

## Database Options Summary

| Option | Setup | Best For |
|--------|-------|----------|
| **SQLite** (default) | Zero config, just omit `DATABASE_URL` | Single-user, CLI usage, local development |
| **Remote PostgreSQL** | Set `DATABASE_URL` to hosted DB | Cloud deployments, shared access |
| **Local PostgreSQL** | Docker `--profile with-db` | Self-hosted, Docker-based setups |

SQLite stores data at `~/.archon/archon.db` (or `/.archon/archon.db` in Docker). It is auto-initialized on first run.

---

## Port Configuration

| Context | Default Port | Notes |
|---------|-------------|-------|
| Main repo | 3090 | Default server port |
| Worktrees | 3190-4089 | Auto-allocated, hash-based on path |
| Override | Any | Set `PORT=4000 bun dev` |

The server port defaults to **3090**. Override with the `PORT` environment variable.

---

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs app          # --profile external-db
docker compose logs app-with-db  # --profile with-db

# Verify environment
docker compose --profile external-db config

# Rebuild without cache
docker compose --profile external-db build --no-cache
docker compose --profile external-db up -d
```

### Port Conflicts

```bash
# Check if port 3090 is in use
lsof -i :3090        # macOS/Linux
netstat -ano | findstr :3090  # Windows
```

### Health Checks

```bash
curl http://localhost:3090/health       # Basic health
curl http://localhost:3090/health/db    # Database connectivity
curl http://localhost:3090/health/concurrency  # Concurrency status
```
