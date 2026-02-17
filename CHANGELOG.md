# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Workflow error visibility** - `/workflow list` and `/workflow reload` now show per-file load errors (#260, #263, #264)
- **Case-insensitive workflow routing** - Router falls back to case-insensitive match before reporting unknown workflow (#263)

### Changed

- **Resilient workflow loading** - One broken YAML no longer aborts loading all workflows; errors accumulated and reported (#260)

### Fixed

- **Router error feedback** - Users now see clear error messages with available workflow names instead of raw `/invoke-workflow` output (#263)

## [0.2.2] - 2026-01-22

Documentation improvements and bug fixes.

### Added

- **CLI documentation** - User guide and developer guide with architecture diagrams (#326)
- **Private repo installation guide** using `gh` CLI for authenticated cloning
- **Manual release process** documentation for when GitHub Actions unavailable

### Changed

- **Repository ownership** migrated from `raswonders` to `dynamous-community`

### Fixed

- Dockerfile monorepo workspace structure for proper package resolution

## [0.2.1] - 2026-01-21

Server migration to Hono and CLI binary distribution infrastructure.

### Added

- **CLI binary distribution** - Standalone binaries for macOS/Linux with curl install and Homebrew formula (#325)
- **Bundled defaults** - Commands and workflows embedded at compile time for binary builds (#325)
- **Runtime default loading** - Load default commands/workflows at runtime instead of copying on clone (#324)
- **Default opt-out** - Config options `loadDefaultCommands` and `loadDefaultWorkflows` (#324)
- **Version command enhancements** - Shows platform, build type (binary/source), and database type (#325)

### Changed

- **Express to Hono migration** - Replaced Express with Hono for improved performance and Bun integration (#318)
- **Default port** changed from 3000 to 3090
- **ESLint zero-warnings policy** enforced in CI (#316)
- **CLAUDE.md consolidation** - Removed duplications and streamlined documentation (#317)

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

## [0.1.6] - 2026-01-19

Provider selection and session audit trail.

### Added

- **Config-based provider selection** for workflows - choose Claude or Codex per workflow (#283)
- **Session state machine** with immutable sessions for full audit trail (#302)
- **Workflow status visibility** - track running workflows per conversation (#256)
- Codex sandbox/network settings and progress logging (#290)

### Changed

- Comprehensive isolation module code review (#274)

### Fixed

- Stale workspace: sync before worktree creation (#287)
- Add defaults subdirectory to command search paths (#289)

## [0.1.5] - 2026-01-18

Major stability release with comprehensive bug fixes and test coverage.

### Added

- **Worktree-aware automatic port allocation** for parallel development (#178)
- **GitHub thread history** - fetch previous PR/issue comments as context (#185)
- **Cloud deployment support** for `with-db` profile (#134)
- Integration tests for orchestrator workflow routing (#181)
- Concurrent workflow detection tests (#179)
- Comprehensive AI error handling tests for workflow executor (#176)

### Changed

- Deep orchestrator code review refactor (#265)
- Improve error handling and code clarity in server entry point (#257)

### Fixed

- Workflows should only load from `.archon/workflows/` (#200)
- PR worktrees use actual branch for same-repo PRs (#238)
- GitHub adapter parameter bug causes clone failures (#209)
- Auto-detect Claude auth when `CLAUDE_USE_GLOBAL_AUTH` not set (#236)
- Worktree provider cleans up branches when worktrees are deleted (#222)
- Extract port utilities to prevent test conflicts with running server (#251)
- Workflows ensure artifacts committed before completing (#203)
- Worktree creation fails when orphan directory exists (#208)
- Add logging to detect silent updateConversation failures (#235)
- Auto-sync `.archon` folder to worktrees before workflow discovery (#219)
- Consolidate startup messages into single workflow start comment (#177)
- Show repo identifier instead of server filesystem path (#175)
- Check for existing PR before creating new one (#195)
- Use empty Slack token placeholders in .env.example (#249)

## [0.1.4] - 2026-01-15

Developer experience improvements and worktree stability.

### Added

- **Auto-copy default commands/workflows** on `/clone` (#243)
- **Pre-commit hook** to prevent formatting drift (#229)
- **Claude global auth** - `CLAUDE_USE_GLOBAL_AUTH` for SDK built-in authentication (#228)

### Changed

- Update README with accurate command reference and new features (#242)

### Fixed

- Copy `.archon` directory to worktrees by default (#210)
- Stale workflow cleanup and defense-in-depth error handling (#237)
- Cleanup service handles missing worktree directories gracefully (#207)
- Worktree limit blocks workflow execution instead of falling back to main (#197)
- Bot self-triggering on own comments (#202)
- Remove unnecessary String() calls in workflow db operations (#182)

## [0.1.3] - 2026-01-13

Workflow engine improvements with autonomous execution and parallel steps.

### Added

- **Ralph-style autonomous iteration loops** for plan-until-done execution (#168)
- **Parallel block execution** for workflows - run multiple steps concurrently (#217)
- **Workflow router** with platform context for intelligent intent detection (#170)
- **Emoji status indicators** for workflow messages (#160)
- Tests for logger filesystem error handling (#133)

### Changed

- Make `WorkflowDefinition.steps` readonly for immutability (#136)

### Fixed

- Detect and block concurrent workflow execution (#196)
- RouterContext not populated for non-slash commands on GitHub (#173)
- Workflow executor missing GitHub issue context (#212)
- Skip step notification for single-step workflows (#159)
- Remove redundant workflow completion message on GitHub (#162)
- Add message length handling for GitHub adapter (#163)
- Use code formatting for workflow/command names (#161)

## [0.1.2] - 2026-01-07

Introduction of the YAML-based workflow engine.

### Added

- **Workflow engine** for multi-step AI orchestration with YAML definitions (#108)
- Improve workflow router to always invoke a workflow (#135)

### Changed

- Improve error handling in workflow engine (#150)

### Fixed

- Add ConversationLock to GitHub webhook handler (#142)
- Bot no longer responds to @mentions in issue/PR descriptions (#143)
- Copy git-ignored files to worktrees (#145)
- `/repo <name>` fails due to owner/repo folder structure mismatch (#148)
- Load workflows from conversation.cwd instead of server cwd (#149)
- Revert to Bun native YAML parser and add Windows CI (#141)
- Wrap platform.sendMessage calls in try-catch in executor (#132)
- Cloud database pooler idle disconnects gracefully (#118)

## [0.1.1] - 2025-12-17

Isolation architecture overhaul and Bun runtime migration.

### Added

- **Bun runtime migration** - replaced Node.js/npm/Jest with Bun (#85)
- **Unified isolation environment architecture** with provider abstraction (#87, #92)
- **Scheduled cleanup service** for stale worktree environments (#94)
- **Worktree limits** with user feedback (#98)
- **Force-thread response model** for Discord (#93)
- **Archon distribution config** and `~/.archon/` directory structure (#101)
- User feedback messages for GitHub worktree operations (#90)
- Required SDK options for permissions and system prompt (#91)
- Test coverage for PR worktree creation (#77)

### Changed

- Drop legacy isolation columns in favor of new architecture (#99)
- Use `isolation_env_id` with fallback to `worktree_path` (#88)

### Fixed

- Fork PR support in worktree creation (#76)
- Multi-repository path collision bug (#78)
- Status command displays `isolation_env_id` (#89)
- Worktree path collision for repos with same name (#106)

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
