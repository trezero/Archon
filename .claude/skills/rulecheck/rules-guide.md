# Rules Guide — Where to Find Project Rules

Reference for the rulecheck agent on locating and interpreting project rules.

## Rule Sources

### 1. `CLAUDE.md` (Root)

The primary source of engineering principles. Key sections:

- **Core Principles** — KISS, YAGNI, type safety
- **Engineering Principles** — SRP, ISP, Fail Fast, DRY + Rule of Three
- **Import Patterns** — `import type` for type-only, specific named imports, no generic `import *` for `@archon/core`
- **Error Handling** — always log errors, use `classifyIsolationError()` for git errors, never swallow
- **Logging** — event naming `{domain}.{action}_{state}`, never log secrets
- **ESLint Guidelines** — zero-tolerance policy, inline disables almost never acceptable

### 2. `eslint.config.mjs`

Enforced lint rules (CI blocks on any warning). Key rules to watch:

| Rule | Impact |
|------|--------|
| `@typescript-eslint/explicit-function-return-type` | Functions must declare return types |
| `@typescript-eslint/no-explicit-any` | No `any` without justification comment |
| `@typescript-eslint/consistent-type-imports` | Use `import type` for type-only imports |
| `no-console` | Use structured Pino logger, not console.log |
| `@typescript-eslint/no-unused-vars` | No unused variables (prefix with `_` if intentional) |

### 3. `tsconfig.json`

Strict TypeScript configuration:
- `strict: true` — enables all strict checks
- `noUncheckedIndexedAccess` — array/object access may be undefined
- `noImplicitReturns` — all code paths must return

### 4. `.prettierrc`

Formatting rules (checked by `bun run format:check`):
- Single quotes, trailing commas, print width, etc.
- Formatting violations are auto-fixable — lower priority than logic issues

### 5. Scoped Rules (`packages/*/CLAUDE.md`)

Check for package-specific CLAUDE.md files. None currently exist, but they could
be added for package-specific conventions.

## Violation Categories by Impact

### Tier 1 — Critical (fix first)

- **Missing return types** on exported functions
- **`any` usage** without an ESLint disable comment with justification
- **Swallowed errors** (empty catch blocks, catch-and-ignore)
- **`import *` from `@archon/core`** (should use specific named imports)

### Tier 2 — High (fix next)

- **Missing `import type`** for type-only imports
- **`console.log`/`console.error`** in production code (should use Pino logger)
- **Missing error classification** for git operations (should use `classifyIsolationError`)
- **Generic error messages** ("Something went wrong") without context

### Tier 3 — Medium (fix if time permits)

- **Nested ternaries** — should be if/else or switch
- **Over-abstraction** — abstractions that obscure rather than clarify
- **Dead code** — unused exports, unreachable branches
- **Inconsistent naming** — doesn't follow project conventions

### Tier 4 — Low (note for backlog)

- **Formatting issues** — auto-fixable by prettier
- **Comment quality** — obvious comments, outdated descriptions
- **Import ordering** — cosmetic but auto-fixable
