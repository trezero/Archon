/**
 * @archon/core - Shared business logic for Archon
 *
 * This package contains:
 * - AI client adapters (Claude, Codex)
 * - Database operations (SQLite/PostgreSQL)
 * - Isolation providers (git worktrees, extensible for containers/VMs)
 * - Orchestration logic
 * - Workflow store adapter (bridges core DB to @archon/workflows IWorkflowStore)
 * - Utility functions
 */

// =============================================================================
// Types
// =============================================================================
export {
  ConversationNotFoundError,
  type Conversation,
  type HandleMessageContext,
  type Codebase,
  type Session,
  type CommandResult,
  type IPlatformAdapter,
  type IWebPlatformAdapter,
  isWebAdapter,
  type MessageMetadata,
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

// Store adapter (bridges core DB to @archon/workflows IWorkflowStore)
export { createWorkflowStore } from './workflows/store-adapter';

// Workflow Events DB
export * as workflowEventDb from './db/workflow-events';

// =============================================================================
// Isolation (re-exported from @archon/isolation for backward compatibility)
// =============================================================================
export {
  type IIsolationProvider,
  type IsolatedEnvironment,
  type IsolationRequest,
  type IsolationHints,
  type IsolationBlockReason,
  type IsolationEnvironmentRow,
  type IsolationWorkflowType,
  type WorktreeStatusBreakdown,
  type IsolationResolution,
  type IIsolationStore,
  type IsolationResolverDeps,
  getIsolationProvider,
  configureIsolation,
  resetIsolationProvider,
  IsolationBlockedError,
  IsolationResolver,
} from '@archon/isolation';

// =============================================================================
// Orchestrator
// =============================================================================
export { handleMessage } from './orchestrator/orchestrator-agent';
export { buildOrchestratorPrompt, buildProjectScopedPrompt } from './orchestrator/prompt-builder';

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
export { toError } from './utils/error';

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

// Git utilities (re-exported from @archon/git for backward compatibility)
export {
  // Exec wrappers
  execFileAsync,
  mkdirAsync,
  // Worktree operations
  getWorktreeBase,
  isProjectScopedWorktreeBase,
  worktreeExists,
  listWorktrees,
  findWorktreeByBranch,
  isWorktreePath,
  createWorktreeForIssue,
  removeWorktree,
  getCanonicalRepoPath,
  // Branch operations
  commitAllChanges,
  hasUncommittedChanges,
  getDefaultBranch,
  checkout,
  // Repository operations
  syncWorkspace,
  findRepoRoot,
  getRemoteUrl,
  // Branded type conversions
  toRepoPath,
  toBranchName,
  toWorktreePath,
} from '@archon/git';
export type { RepoPath, BranchName, WorktreePath, WorktreeInfo } from '@archon/git';

// GitHub GraphQL
export { getLinkedIssueNumbers } from './utils/github-graphql';

// Path validation
export { isPathWithinWorkspace, validateAndResolvePath } from './utils/path-validation';

// Port allocation
export { getPort } from './utils/port-allocation';

// Worktree copy (re-exported from @archon/isolation for backward compatibility)
export {
  parseCopyFileEntry,
  isPathWithinRoot,
  copyWorktreeFile,
  copyWorktreeFiles,
} from '@archon/isolation';

// Worktree sync
export { syncArchonToWorktree } from './utils/worktree-sync';

// Logger
export { createLogger, setLogLevel, getLogLevel } from './utils/logger';
export type { Logger } from './utils/logger';

// Defaults copy
export { copyDefaultsToRepo } from './utils/defaults-copy';
