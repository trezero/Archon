# Global Workflows

Workflows placed in `~/.archon/.archon/workflows/` are loaded globally — they appear in
every project's `workflow list` and can be invoked from any repository.

## Path

`~/.archon/.archon/workflows/` (or `$ARCHON_HOME/.archon/workflows/`)

## Load Priority

1. Bundled defaults (lowest priority)
2. Global workflows — `~/.archon/.archon/workflows/` (override bundled by filename)
3. Repo-specific workflows — `.archon/workflows/` (override global by filename)

## Use Cases

- Personal workflow templates applied to every project
- Organization-wide standards distributed via dotfiles
- Experimental workflows shared across repos during development

## CLI Support

Both `bun run cli workflow list` and `bun run cli workflow run` search the global path.
