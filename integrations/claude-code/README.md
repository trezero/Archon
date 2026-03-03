# Archon Memory — Claude Code Integration

A Claude Code skill that bridges Claude Code's native memory with Archon's RAG knowledge base. Provides semantic search across unlimited documentation, cross-project knowledge sharing, and multi-agent collaboration.

## What It Does

- **Ingest** project documentation into Archon's vector store
- **Search** semantically across ingested docs (no more reading 40+ files per session)
- **Sync** when docs change (detect staleness, re-ingest)
- **Share** knowledge across projects (framework docs, tool patterns)
- **Coordinate** tasks across AI agents via Archon's project management

## Prerequisites

1. **Archon server** running and accessible (default: `http://localhost:8051/mcp`)
2. **Archon MCP connection** configured in Claude Code
3. **Claude Code** installed

### Configure Archon MCP Connection

Add to your project's `.mcp.json` or `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "archon": {
      "type": "streamable-http",
      "url": "http://localhost:8051/mcp"
    }
  }
}
```

Replace `localhost` with the Archon server's hostname/IP if it runs on a different machine.

## Installation

### 1. Install the skill

Copy the skill into Claude Code's global skills directory:

```bash
# From the Archon repo
cp -r integrations/claude-code/skills/archon-memory ~/.claude/skills/

# Or clone directly
mkdir -p ~/.claude/skills
cp -r /path/to/Archon/integrations/claude-code/skills/archon-memory ~/.claude/skills/
```

The skill is auto-discovered by Claude Code — no registration needed.

### 2. Add ambient behavior to CLAUDE.md

Append the ambient behavior snippet to your global Claude Code instructions:

```bash
cat integrations/claude-code/claude-md-snippet.md >> ~/.claude/CLAUDE.md
```

This tells Claude to:
- Show Archon KB status at the start of every session
- Prefer Archon search over raw file reads during work
- Remind you to sync when docs change

### 3. Verify

Start a new Claude Code session and type `/archon-memory`. You should see the status overview.

## Usage

| Command | Purpose |
|---------|---------|
| `/archon-memory` | Status overview + freshness check |
| `/archon-memory ingest` | Ingest project docs (first time) |
| `/archon-memory ingest docs/` | Ingest from specific directory |
| `/archon-memory sync` | Re-ingest changed docs |
| `/archon-memory search <query>` | Search project knowledge |
| `/archon-memory search-all <query>` | Search all projects |
| `/archon-memory shared add <url>` | Add shared cross-project knowledge |
| `/archon-memory shared list` | List shared knowledge sources |
| `/archon-memory tasks` | List project tasks |
| `/archon-memory forget` | Remove project from Archon |

### Quick Start

```
# 1. Ingest your project's documentation
/archon-memory ingest

# 2. Search it
/archon-memory search "authentication flow"

# 3. After making doc changes, sync
/archon-memory sync
```

### What Gets Ingested

By default, `/archon-memory ingest` discovers and ingests:
- All `.md` files in `docs/` (or user-specified directory)
- `CLAUDE.md` (project root + parent directory)
- `README.md`

### Session Start Status

With ambient behavior configured, every session shows a one-liner:

```
Archon KB: RecipeRaiders — 44 docs, synced 2h ago, up to date
```

Or if docs have changed:
```
Archon KB: RecipeRaiders — 44 docs, synced 2h ago, 3 files changed. Run /archon-memory sync
```

## State Files

| File | Location | Purpose |
|------|----------|---------|
| `archon-state.json` | `.claude/` (per-project, gitignored) | Project ID, source ID, file hashes |
| `archon-global.json` | `~/.claude/` (global) | Shared knowledge project ID, sources |

## Architecture

```
Claude Code Session
    │
    ├── MEMORY.md (quick-ref index + Archon IDs)
    ├── CLAUDE.md (project rules + ambient behavior)
    │
    └── Archon MCP Server
        ├── Project RAG (full docs, code examples)
        ├── Shared KB (cross-project: Firebase, Next.js, etc.)
        └── Tasks (multi-agent coordination)
```

All Archon data is shared across agents. When Claude Code ingests docs, Cursor, Windsurf, and other Claude instances can search them immediately.

## Troubleshooting

**"Archon server is not reachable"**
- Check that Archon is running: `curl http://localhost:8051/mcp`
- Verify MCP config in `.mcp.json`
- Run `/mcp` in Claude Code to reconnect

**"No Archon state found"**
- Run `/archon-memory ingest` to set up this project

**Source ID mismatch**
- Run `/archon-memory forget` then `/archon-memory ingest` to start fresh

**Ingestion seems stuck**
- Progress data expires ~30 seconds after completion
- Check `rag_get_available_sources()` to verify the source was created
