# Docs Migration Map

Maps each existing `docs/*.md` file to its target location in the Starlight content collection.

## Frontmatter Template

Every migrated doc should have this frontmatter:

```yaml
---
title: Page Title
description: One-line description for SEO and search.
category: getting-started | guides | adapters | deployment | reference | contributing
area: adapters | cli | clients | config | database | handlers | infra | isolation | orchestrator | server | services | web | workflows
audience: [user, developer, operator]  # one or more
status: current | deprecated | research
sidebar:
  order: 1  # lower = higher in sidebar within its section
---
```

- `title` and `description` are required by Starlight
- `category` determines the directory and sidebar section
- `area` maps to the `area:*` GitHub labels (omit if doc spans multiple areas)
- `audience` indicates who the doc is for
- `status` defaults to `current` if omitted
- Use `draft: true` (Starlight built-in) for work-in-progress pages

## Migration Map

### getting-started/

| Source | Target | area | audience |
|--------|--------|------|----------|
| `getting-started.md` | `getting-started/index.md` | — | user |
| `configuration.md` | `getting-started/configuration.md` | config | user, operator |
| `ai-assistants.md` | `getting-started/ai-assistants.md` | clients | user |

### guides/

| Source | Target | area | audience |
|--------|--------|------|----------|
| `authoring-workflows.md` | `guides/authoring-workflows.md` | workflows | user |
| `authoring-commands.md` | `guides/authoring-commands.md` | workflows | user |
| `loop-nodes.md` | `guides/loop-nodes.md` | workflows | user |
| `approval-nodes.md` | `guides/approval-nodes.md` | workflows | user |
| `hooks.md` | `guides/hooks.md` | workflows | user |
| `mcp-servers.md` | `guides/mcp-servers.md` | workflows | user |
| `skills.md` | `guides/skills.md` | workflows | user |
| `global-workflows.md` | `guides/global-workflows.md` | workflows | user |
| `remotion-workflow.md` | `guides/remotion-workflow.md` | workflows | user |

### adapters/

| Source | Target | area | audience |
|--------|--------|------|----------|
| `slack-setup.md` | `adapters/slack.md` | adapters | operator |
| `adapters/telegram.md` | `adapters/telegram.md` | adapters | operator |
| `adapters/github.md` | `adapters/github.md` | adapters | operator |
| `adapters/discord.md` | `adapters/discord.md` | adapters | operator |
| `adapters/web.md` | `adapters/web.md` | adapters | user |

### deployment/

| Source | Target | area | audience |
|--------|--------|------|----------|
| `deployment.md` | `deployment/local.md` | infra | operator |
| `docker.md` | `deployment/docker.md` | infra | operator |
| `cloud-deployment.md` | `deployment/cloud.md` | infra | operator |
| `windows.md` | `deployment/windows.md` | infra | operator |
| `e2e-testing.md` | `deployment/e2e-testing.md` | infra | operator |
| `e2e-testing-wsl.md` | `deployment/e2e-testing-wsl.md` | infra | operator |

### reference/

| Source | Target | area | audience |
|--------|--------|------|----------|
| `architecture.md` | `reference/architecture.md` | — | developer |
| `archon-architecture.md` | `reference/archon-directories.md` | config | developer |
| `cli-user-guide.md` | `reference/cli.md` | cli | user |
| `commands-reference.md` | `reference/commands.md` | handlers | user |
| `database.md` | `reference/database.md` | database | developer, operator |
| `troubleshooting.md` | `reference/troubleshooting.md` | — | user, operator |

### contributing/

| Source | Target | area | audience |
|--------|--------|------|----------|
| `new-developer-guide.md` | `contributing/new-developer-guide.md` | — | developer |
| `cli-developer-guide.md` | `contributing/cli-internals.md` | cli | developer |
| `releasing.md` | `contributing/releasing.md` | infra | developer |
| `dx-quirks.md` | `contributing/dx-quirks.md` | — | developer |
| `migration-guide.md` | `contributing/migration-guide.md` | — | developer |
| `sequential-dag-migration-guide.md` | `contributing/sequential-dag-migration.md` | workflows | developer |

### Not migrated (research / internal)

| Source | Reason |
|--------|--------|
| `worktree-orchestration-research.md` | Research doc — status: research, low priority |
| `worktree-orchestration.md` | Internal implementation notes |

## Migration Checklist Per Doc

When migrating a doc:

1. Copy to target path under `packages/docs-web/src/content/docs/`
2. Add frontmatter (title, description, category, area, audience)
3. Replace relative links (`./other-doc.md`) with Starlight paths (`/category/other-doc/`)
4. Replace `# Title` heading with frontmatter `title:` (Starlight renders title from frontmatter)
5. Review content for accuracy — update any stale references
6. Remove the original from `docs/` once migrated and verified
