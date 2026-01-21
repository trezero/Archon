# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

### Fixed

## [0.2.0] - 2026-01-21

Monorepo restructure introducing the CLI package for local workflow execution.

### Added

- **Monorepo structure** with `@archon/core`, `@archon/server`, and `@archon/cli` packages (#311)
- **CLI entry point** with `workflow list`, `workflow run`, and `version` commands (#313)
- **Database abstraction layer** supporting both PostgreSQL and SQLite (#314)
- **SQLite auto-detection** - uses `~/.archon/archon.db` when `DATABASE_URL` not set (#314)
- **Isolation commands** - `isolation list` and `isolation cleanup` for worktree management (#313)

### Fixed

- Surface git utility errors instead of swallowing silently (#292)

## [0.1.1] - 2026-01-19

Major workflow engine release with autonomous execution, parallel steps, and comprehensive fixes.

### Added

- **Workflow engine** for multi-step AI orchestration with YAML definitions (#108)
- **Ralph-style autonomous iteration loops** for plan-until-done execution (#168)
- **Parallel block execution** for workflows - run multiple steps concurrently (#217)
- **Workflow router** with platform context for intelligent intent detection (#170, #135)
- **Workflow status visibility** - track running workflows per conversation (#256)
- **Emoji status indicators** for workflow messages (#160)
- **Session state machine** with immutable sessions for full audit trail (#302)
- **Config-based provider selection** for workflows (Claude/Codex per workflow) (#283)
- **Auto-copy default commands/workflows** on `/clone` (#243)
- **Worktree-aware automatic port allocation** for parallel development (#178)
- **GitHub thread history** - fetch previous PR/issue comments as context (#185)
- **Claude global auth detection** - auto-detect when `CLAUDE_USE_GLOBAL_AUTH` not set (#228, #236)
- **Cloud deployment support** for `with-db` profile (#134)
- **Pre-commit hook** to prevent formatting drift (#229)
- Integration tests for orchestrator workflow routing (#181)
- Concurrent workflow detection tests (#179)
- Comprehensive AI error handling tests (#176)
- Tests for logger filesystem error handling (#133)

### Changed

- Improve error handling in workflow engine (#150)
- Improve error handling and code clarity in server entry point (#257)
- Deep orchestrator code review refactor (#265)
- Comprehensive isolation module code review (#274)
- Make `WorkflowDefinition.steps` readonly for immutability (#136)
- Update README with accurate command reference and new features (#242)

### Fixed

- Detect and block concurrent workflow execution (#196)
- Bot no longer responds to @mentions in issue/PR descriptions (#143)
- Bot self-triggering on own comments (#202)
- RouterContext not populated for non-slash commands on GitHub (#173)
- Workflow executor missing GitHub issue context (#212)
- Load workflows from conversation.cwd instead of server cwd (#149)
- Workflows should only load from `.archon/workflows/` (#200)
- `/repo <name>` fails due to owner/repo folder structure mismatch (#148)
- Add ConversationLock to GitHub webhook handler (#142)
- Skip step notification for single-step workflows (#159)
- Remove redundant workflow completion message on GitHub (#162)
- Add message length handling for GitHub adapter (#163)
- Use code formatting for workflow/command names (#161)
- Consolidate startup messages into single workflow start comment (#177)
- Show repo identifier instead of server filesystem path (#175)
- Copy `.archon` directory to worktrees by default (#210)
- Auto-sync `.archon` folder to worktrees before workflow discovery (#219)
- Copy git-ignored files to worktrees (#145)
- Stale workflow cleanup and defense-in-depth error handling (#237)
- Cleanup service handles missing worktree directories gracefully (#207)
- Worktree limit blocks workflow execution instead of falling back to main (#197)
- Worktree provider cleans up branches when worktrees are deleted (#222)
- Worktree creation fails when orphan directory exists (#208)
- PR worktrees use actual branch for same-repo PRs (#238)
- Stale workspace: sync before worktree creation (#287)
- GitHub adapter parameter bug causes clone failures (#209)
- Check for existing PR before creating new one (#195)
- Workflows ensure artifacts committed before completing (#203)
- Add logging to detect silent updateConversation failures (#235)
- Extract port utilities to prevent test conflicts with running server (#251)
- Add defaults subdirectory to command search paths (#289)
- Codex sandbox/network settings and progress logging (#290)
- Remove unnecessary String() calls in workflow db operations (#182)
- Use empty Slack token placeholders in .env.example (#249)
- Wrap platform.sendMessage calls in try-catch in executor (#132)
- Revert to Bun native YAML parser and add Windows CI (#141)

## [0.1.0] - 2025-12-08

Initial release of the Remote Agentic Coding Platform.

### Added

- **Platform Adapters**
  - Telegram adapter with streaming support and markdown formatting
  - Slack adapter with Socket Mode for real-time messaging (#73)
  - Discord adapter with thread support
  - GitHub adapter with webhook integration for issues and PRs (#43)
  - Test adapter for HTTP-based integration testing

- **AI Assistant Clients**
  - Claude Code SDK integration with session persistence
  - Codex SDK integration as alternative AI assistant

- **Core Features**
  - PostgreSQL persistence for conversations, codebases, and sessions
  - Generic command system with user-defined markdown commands
  - Variable substitution ($1, $2, $ARGUMENTS, $PLAN)
  - Worktree isolation per conversation for parallel development (#43)
  - Session resume capability across restarts

- **Workflow Commands** (exp-piv-loop)
  - `/plan` - Deep implementation planning with codebase analysis
  - `/implement` - Execute implementation plans
  - `/commit` - Quick commits with natural language targeting
  - `/create-pr` - Create PRs from current branch
  - `/merge-pr` - Merge PRs with rebase handling
  - `/review-pr` - Comprehensive PR code review
  - `/rca` - Root cause analysis for issues
  - `/fix-rca` - Implement fixes from RCA reports
  - `/prd` - Product requirements documents
  - `/worktree` - Parallel branch development
  - `/worktree-cleanup` - Clean up merged worktrees
  - `/router` - Natural language intent detection (#59)

- **Platform Features**
  - Configurable streaming modes (stream/batch) per platform
  - Platform-specific authorization (whitelist users)
  - Configurable GitHub bot mention via environment variable (#66)

- **Developer Experience**
  - ESLint 9 with flat config and Prettier integration
  - Jest test framework with mocks
  - Docker Compose for local development
  - Builtin command templates (configurable via LOAD_BUILTIN_COMMANDS)

### Fixed

- Shared worktree cleanup preventing duplicate removal errors (#72)
- Case-sensitive bot mention detection in GitHub adapter
- PR review to checkout actual PR branch instead of creating new branch (#48)
- Template commands treated as documentation (#35, #63)
- Auto-load commands in /clone like /repo does (#55)
- /status and /repos codebase active state inconsistency (#60)
- WORKSPACE_PATH configuration to avoid nested repos (#37, #54)
- Shorten displayed paths in worktree and status messages (#33, #45)
- Create worktrees retroactively for legacy conversations (#56)

### Security

- Use commit SHA for reproducible PR reviews (#52, #75)
- Add retry logic to GitHub API calls for transient network failures (#64)
