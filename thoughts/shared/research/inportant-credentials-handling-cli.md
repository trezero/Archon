Core Env Vars That CLI Users Need
From @archon/core:
┌──────────────────────────────────────────┬────────────────────────┬─────────────────────────────────────────────────────────┐
│ Variable │ Purpose │ Distribution Solution │
├──────────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ DATABASE_URL │ Database connection │ SQLite default (~/.archon/archon.db), PostgreSQL opt-in │
├──────────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ CLAUDE_USE_GLOBAL_AUTH │ Use claude /login auth │ Default to true - leverage existing Claude Code login │
├──────────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ CLAUDE_API_KEY / CLAUDE_CODE_OAUTH_TOKEN │ Direct API credentials │ ~/.archon/.env if not using global auth │
├──────────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ GH_TOKEN │ Git operations, PRs │ ~/.archon/.env (could also integrate with gh auth) │
├──────────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ DEFAULT_AI_ASSISTANT │ claude/codex │ ~/.archon/config.yaml or env │
├──────────────────────────────────────────┼────────────────────────┼─────────────────────────────────────────────────────────┤
│ ARCHON_HOME │ Override base path │ Rarely needed, env var │
└──────────────────────────────────────────┴────────────────────────┴─────────────────────────────────────────────────────────┘
Proposed Solution for Distributed CLI

~/.archon/.env for secrets:

# Only needed if NOT using claude /login

CLAUDE_API_KEY=sk-ant-...

# For git operations

GH*TOKEN=ghp*...

# Optional: Use PostgreSQL instead of SQLite

# DATABASE_URL=postgresql://...

~/.archon/config.yaml for non-secret config:

# Default AI assistant

assistant: claude

# Or for codex users (would need tokens in .env)

# assistant: codex

Smart defaults in CLI:
// In @archon/core or CLI
const getClaudeAuth = () => {
// If explicit credentials provided, use them
if (process.env.CLAUDE_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
return { useGlobalAuth: false };
}
// Default: try global auth from claude /login
return { useGlobalAuth: true };
};

Future: archon setup command (Phase 5):
$ archon setup
? AI Provider: Claude (recommended) / Codex
? Use existing Claude login? Yes (detected from claude /login)
? GitHub token for PR operations: ghp\_...
✓ Created ~/.archon/.env
✓ Created ~/.archon/config.yaml
For Phase 2 (Now)
Quick fix for development:
{
"cli": "bun --env-file=.env --cwd packages/cli src/cli.ts"
}
The ~/.archon/.env fallback already handles the rest - it's not just for DATABASE_URL, it's for all credentials.
Summary
┌────────────────────┬────────────────────────────────────────┐
│ Context │ How env vars are loaded │
├────────────────────┼────────────────────────────────────────┤
│ Dev (bun run cli) │ --env-file=.env from repo root │
├────────────────────┼────────────────────────────────────────┤
│ Distributed binary │ ~/.archon/.env (already supported) │
├────────────────────┼────────────────────────────────────────┤
│ Claude auth │ Default to global auth (claude /login) │
├────────────────────┼────────────────────────────────────────┤
│ Database │ SQLite default, PostgreSQL opt-in │
└────────────────────┴────────────────────────────────────────┘

we also need to think about htis part and how to manage it if its not included

1 MINUTE AGO
Good point. The CLI needs credentials to work, and the current setup assumes a development environment with .env in the repo root. Let me think through this.

Current state:

CLI loads .env from cwd or ~/.archon/.env
But when running bun run cli, cwd is packages/cli, not repo root
So credentials from repo root .env aren't found

For distributed binary (Phase 5):

Users won't have a repo root .env
They need ~/.archon/.env for secrets
Claude global auth (claude /login) should be the default - zero config for Claude Code users

What needs to happen:

Phase 2 quick fix - Update root package.json:

{
"cli": "bun --env-file=.env --cwd packages/cli src/cli.ts"
}

Phase 3 (with SQLite) - Smart credential loading:

Default CLAUDE_USE_GLOBAL_AUTH=true if no explicit tokens
SQLite removes DATABASE_URL requirement
~/.archon/.env for optional overrides

Phase 5 - archon setup wizard for first-time users

Let me make the quick fix for Phase 2 now and add a note to the research doc about credential management for Phase 3/5.
