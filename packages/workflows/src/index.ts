/**
 * @archon/workflows - Workflow engine for Archon
 *
 * This package contains:
 * - Workflow type definitions (step, loop, DAG)
 * - Workflow loader (YAML parsing + validation)
 * - Workflow router (prompt building + invocation parsing)
 * - Workflow executor (sequential, parallel, loop, DAG)
 * - Event emitter (observability)
 * - JSONL file logger
 * - Bundled default commands and workflows
 * - Variable substitution and tool formatting utilities
 *
 * Depends only on @archon/git and @archon/paths.
 * Database, AI clients, and config are injected via WorkflowDeps.
 */

// =============================================================================
// Types
// =============================================================================
export * from './types';

export type { IWorkflowStore, WorkflowEventType } from './store';

export type {
  WorkflowDeps,
  AssistantClientFactory,
  IWorkflowPlatform,
  IWorkflowAssistantClient,
  WorkflowMessageChunk,
  WorkflowTokenUsage,
  WorkflowMessageMetadata,
  WorkflowAssistantOptions,
  WorkflowConfig,
} from './deps';

// =============================================================================
// Loader
// =============================================================================
export { discoverWorkflows, discoverWorkflowsWithConfig, parseWorkflow } from './loader';
export type { ParseResult } from './loader';

// =============================================================================
// Router
// =============================================================================
export {
  type RouterContext,
  buildRouterPrompt,
  type WorkflowInvocation,
  parseWorkflowInvocation,
  findWorkflow,
} from './router';

// =============================================================================
// Executor
// =============================================================================
export { executeWorkflow } from './executor';

// =============================================================================
// DAG Executor (public utilities used by tests and consumers)
// =============================================================================
export { substituteNodeOutputRefs, checkTriggerRule, buildTopologicalLayers } from './dag-executor';

// =============================================================================
// Command Validation
// =============================================================================
export { isValidCommandName } from './command-validation';

// =============================================================================
// Model Validation
// =============================================================================
export { isClaudeModel, isModelCompatible } from './model-validation';

// =============================================================================
// Logger
// =============================================================================
export {
  type WorkflowEvent,
  logWorkflowEvent,
  logWorkflowStart,
  logStepStart,
  logStepComplete,
  logAssistant,
  logTool,
  logValidation,
  logWorkflowError,
  logWorkflowComplete,
  logParallelBlockStart,
  logParallelBlockComplete,
} from './logger';

// =============================================================================
// Event Emitter
// =============================================================================
export {
  type WorkflowEmitterEvent,
  getWorkflowEventEmitter,
  resetWorkflowEventEmitter,
} from './event-emitter';

// =============================================================================
// Utilities
// =============================================================================
export { substituteVariables } from './utils/variable-substitution';
export { formatToolCall, formatThinking } from './utils/tool-formatter';

// =============================================================================
// Bundled Defaults
// =============================================================================
export { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS, isBinaryBuild } from './defaults/bundled-defaults';
