/**
 * @archon/core - Shared business logic for Archon
 *
 * This package contains:
 * - Workflow engine (YAML-based multi-step workflows)
 * - AI client adapters (Claude, Codex)
 * - Database operations (PostgreSQL)
 * - Isolation providers (git worktrees, extensible for containers/VMs)
 * - Orchestration logic
 * - Utility functions
 */

// =============================================================================
// Types
// =============================================================================
export {
  ConversationNotFoundError,
  type Conversation,
  type IsolationHints,
  type IsolationEnvironmentRow,
  type Codebase,
  type Session,
  type CommandTemplate,
  type CommandResult,
  type IPlatformAdapter,
  type IWebPlatformAdapter,
  isWebAdapter,
  type MessageChunk,
  type IAssistantClient,
} from './types';

// =============================================================================
// Database
// =============================================================================
export {
  pool,
  getDatabase,
  getDialect,
  getDatabaseType,
  closeDatabase,
  resetDatabase,
} from './db/connection';
export type { IDatabase, SqlDialect } from './db/adapters/types';

// Namespaced db modules for explicit access
export * as conversationDb from './db/conversations';
export * as codebaseDb from './db/codebases';
export * as sessionDb from './db/sessions';
export * as commandTemplateDb from './db/command-templates';
export * as isolationEnvDb from './db/isolation-environments';
export * as workflowDb from './db/workflows';
export * as messageDb from './db/messages';

// Re-export SessionNotFoundError for error handling
export { SessionNotFoundError } from './db/sessions';

// =============================================================================
// AI Clients
// =============================================================================
export { ClaudeClient } from './clients/claude';
export { CodexClient } from './clients/codex';
export { getAssistantClient } from './clients/factory';

// =============================================================================
// Workflows
// =============================================================================
// Types
export {
  type SingleStep,
  type StepDefinition,
  type ParallelBlock,
  type WorkflowStep,
  isParallelBlock,
  isSingleStep,
  type LoopConfig,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
  type ArtifactType,
  type StepResult,
  type LoadCommandResult,
  type WorkflowExecutionResult,
  type DiscoverWorkflowsResult,
} from './workflows/types';

// Loader
export { discoverWorkflows } from './workflows/loader';

// Router
export {
  type RouterContext,
  buildRouterPrompt,
  type WorkflowInvocation,
  parseWorkflowInvocation,
  findWorkflow,
} from './workflows/router';

// Executor
export { isValidCommandName, executeWorkflow } from './workflows/executor';

// Logger
export {
  type WorkflowEvent,
  logWorkflowEvent,
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logWorkflowError,
  logWorkflowComplete,
  logParallelBlockStart,
  logParallelBlockComplete,
} from './workflows/logger';

// Event Emitter
export {
  type WorkflowEmitterEvent,
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
} from './workflows/event-emitter';

// Workflow Events DB
export * as workflowEventDb from './db/workflow-events';

// =============================================================================
// Isolation
// =============================================================================
export {
  type IIsolationProvider,
  type IsolatedEnvironment,
  type IsolationRequest,
  getIsolationProvider,
  resetIsolationProvider,
} from './isolation';

// =============================================================================
// Orchestrator
// =============================================================================
export { handleMessage } from './orchestrator/orchestrator';

// =============================================================================
// Handlers
// =============================================================================
export { handleCommand, parseCommand } from './handlers/command-handler';
export { cloneRepository, registerRepository, type RegisterResult } from './handlers/clone';

// =============================================================================
// Config
// =============================================================================
export { type GlobalConfig, type RepoConfig, type MergedConfig } from './config/config-types';

export {
  readConfigFile,
  loadGlobalConfig,
  loadRepoConfig,
  loadConfig,
  clearConfigCache,
  logConfig,
} from './config/config-loader';

// =============================================================================
// Services
// =============================================================================
export {
  startCleanupScheduler,
  stopCleanupScheduler,
  onConversationClosed,
} from './services/cleanup-service';

// =============================================================================
// State
// =============================================================================
export {
  type TransitionTrigger,
  shouldCreateNewSession,
  shouldDeactivateSession,
  detectPlanToExecuteTransition,
  getTriggerForCommand,
} from './state/session-transitions';

// =============================================================================
// Utils
// =============================================================================

// Conversation lock
export { ConversationLockManager, type LockAcquisitionResult } from './utils/conversation-lock';

// Error formatting
export { classifyAndFormatError } from './utils/error-formatter';

// Tool formatting
export { formatToolCall, formatThinking } from './utils/tool-formatter';

// Variable substitution
export { substituteVariables } from './utils/variable-substitution';

// Credential sanitization
export { sanitizeCredentials, sanitizeError } from './utils/credential-sanitizer';

// Archon paths
export {
  expandTilde,
  isDocker,
  getArchonHome,
  getArchonWorkspacesPath,
  getArchonWorktreesPath,
  getArchonConfigPath,
  getCommandFolderSearchPaths,
  getWorkflowFolderSearchPaths,
  getAppArchonBasePath,
  getDefaultCommandsPath,
  getDefaultWorkflowsPath,
  logArchonPaths,
  validateAppDefaultsPaths,
  // Project-centric path functions
  parseOwnerRepo,
  getProjectRoot,
  getProjectSourcePath,
  getProjectWorktreesPath,
  getProjectArtifactsPath,
  getProjectLogsPath,
  getRunArtifactsPath,
  getRunLogPath,
  resolveProjectRootFromCwd,
  ensureProjectStructure,
  createProjectSourceSymlink,
} from './utils/archon-paths';

// Git utilities
export {
  execFileAsync,
  mkdirAsync,
  getWorktreeBase,
  isProjectScopedWorktreeBase,
  worktreeExists,
  listWorktrees,
  findWorktreeByBranch,
  isWorktreePath,
  createWorktreeForIssue,
  removeWorktree,
  getCanonicalRepoPath,
  commitAllChanges,
  hasUncommittedChanges,
  syncWorkspace,
  getDefaultBranch,
  findRepoRoot,
  getRemoteUrl,
  checkout,
} from './utils/git';

// GitHub GraphQL
export { getLinkedIssueNumbers } from './utils/github-graphql';

// Path validation
export { isPathWithinWorkspace, validateAndResolvePath } from './utils/path-validation';

// Port allocation
export { getPort } from './utils/port-allocation';

// Worktree copy
export {
  parseCopyFileEntry,
  isPathWithinRoot,
  copyWorktreeFile,
  copyWorktreeFiles,
} from './utils/worktree-copy';

// Worktree sync
export { syncArchonToWorktree } from './utils/worktree-sync';

// Defaults copy
export { copyDefaultsToRepo } from './utils/defaults-copy';

// =============================================================================
// Platform Auth Utilities
// =============================================================================
// Each platform has parseAllowedUserIds with different return types:
// - Telegram: number[] (user IDs are numeric)
// - Slack/Discord: string[] (user IDs are strings)
// All are aliased with platform prefix for clarity.

// Telegram auth
export {
  parseAllowedUserIds as parseTelegramAllowedUserIds,
  isUserAuthorized as isTelegramUserAuthorized,
} from './utils/telegram-auth';

// Slack auth
export {
  parseAllowedUserIds as parseSlackAllowedUserIds,
  isSlackUserAuthorized,
} from './utils/slack-auth';

// Discord auth
export {
  parseAllowedUserIds as parseDiscordAllowedUserIds,
  isDiscordUserAuthorized,
} from './utils/discord-auth';

// GitHub auth
export {
  parseAllowedUsers as parseGitHubAllowedUsers,
  isGitHubUserAuthorized,
} from './utils/github-auth';

// =============================================================================
// Telegram Markdown Utilities
// =============================================================================
export {
  convertToTelegramMarkdown,
  escapeMarkdownV2,
  isAlreadyEscaped,
  stripMarkdown,
} from './utils/telegram-markdown';
