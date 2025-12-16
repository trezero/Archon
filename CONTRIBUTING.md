# Contributing

Thank you for your interest in contributing to the Remote Agentic Coding Platform.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `bun install`
4. Copy `.env.example` to `.env` and configure
5. Start development: `bun run dev`

## Development Workflow

### Code Quality

Before submitting a PR, ensure:

```bash
bun run type-check  # TypeScript types
bun run lint        # ESLint
bun run format      # Prettier
bun test            # Bun tests
```

### Commit Messages

- Use present tense ("Add feature" not "Added feature")
- Keep the first line under 72 characters
- Reference issues when applicable

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all checks pass
4. Submit a PR with a clear description

## Code Style

- TypeScript strict mode is enforced
- All functions require explicit return types
- No `any` types without justification
- Follow existing patterns in the codebase

## Architecture

See [CLAUDE.md](./CLAUDE.md) for detailed architecture documentation.

## Questions?

Open an issue for questions or discussion.
