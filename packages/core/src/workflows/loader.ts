/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access, stat } from 'fs/promises';
import { join } from 'path';
import type {
  WorkflowDefinition,
  WorkflowLoadError,
  WorkflowLoadResult,
  LoopConfig,
  SingleStep,
  WorkflowStep,
} from './types';
import * as archonPaths from '../utils/archon-paths';
import * as configLoader from '../config/config-loader';
import { isValidCommandName } from './executor';
import { BUNDLED_WORKFLOWS, isBinaryBuild } from '../defaults/bundled-defaults';
import { createLogger } from '../utils/logger';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.loader');
  return cachedLog;
}

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
}

/**
 * Parse a single step (helper for parseStep)
 * @param errors - Array to collect validation errors for aggregated reporting
 */
function parseSingleStep(s: unknown, indexPath: string, errors: string[]): SingleStep | null {
  const step = s as Record<string, unknown>;
  const command = String(step.command ?? step.step);

  if (!isValidCommandName(command)) {
    errors.push(`Step ${indexPath}: invalid command name "${command}"`);
    return null;
  }

  return {
    command,
    clearContext: Boolean(step.clearContext),
  };
}

/**
 * Parse a workflow step (either single step or parallel block)
 * @param errors - Array to collect validation errors for aggregated reporting
 */
function parseStep(s: unknown, index: number, errors: string[]): WorkflowStep | null {
  const step = s as Record<string, unknown>;

  // Check for parallel block
  if (Array.isArray(step.parallel)) {
    const rawParallelSteps = step.parallel;

    // Check for nested parallel BEFORE parsing (raw input still has parallel property)
    if (
      rawParallelSteps.some((ps: unknown) => {
        const pstep = ps as Record<string, unknown>;
        return Array.isArray(pstep.parallel);
      })
    ) {
      errors.push(`Step ${String(index + 1)}: nested parallel blocks not allowed`);
      return null;
    }

    const parallelSteps = rawParallelSteps
      .map((ps: unknown, pi: number) =>
        parseSingleStep(ps, `${String(index + 1)}.${String(pi + 1)}`, errors)
      )
      .filter((ps): ps is SingleStep => ps !== null);

    if (parallelSteps.length === 0) {
      errors.push(`Step ${String(index + 1)}: empty parallel block`);
      return null;
    }

    // If any steps were invalid (filtered out), the errors were already collected
    if (parallelSteps.length !== rawParallelSteps.length) {
      return null;
    }

    return { parallel: parallelSteps };
  }

  // Regular single step
  return parseSingleStep(step, String(index + 1), errors);
}

type ParseResult =
  | { workflow: WorkflowDefinition; error: null }
  | { workflow: null; error: WorkflowLoadError };

/**
 * Parse and validate a workflow YAML file
 */
function parseWorkflow(content: string, filename: string): ParseResult {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw || typeof raw !== 'object') {
      return {
        workflow: null,
        error: {
          filename,
          error: 'YAML file is empty or does not contain an object',
          errorType: 'validation_error',
        },
      };
    }

    if (!raw.name || typeof raw.name !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_name');
      return {
        workflow: null,
        error: { filename, error: "Missing required field 'name'", errorType: 'validation_error' },
      };
    }
    if (!raw.description || typeof raw.description !== 'string') {
      getLog().warn({ filename }, 'workflow_missing_description');
      return {
        workflow: null,
        error: {
          filename,
          error: "Missing required field 'description'",
          errorType: 'validation_error',
        },
      };
    }

    // Validate mutual exclusivity: steps XOR (loop + prompt)
    // This prevents ambiguous execution modes - a workflow is either
    // step-based (sequential commands) or loop-based (autonomous iteration)
    const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
    const hasLoop = raw.loop && typeof raw.loop === 'object';
    const hasPrompt = typeof raw.prompt === 'string' && raw.prompt.trim().length > 0;

    if (hasSteps && hasLoop) {
      getLog().warn({ filename }, 'workflow_steps_and_loop_conflict');
      return {
        workflow: null,
        error: {
          filename,
          error: "Cannot have both 'steps' and 'loop' (mutually exclusive)",
          errorType: 'validation_error',
        },
      };
    }

    if (hasLoop && !hasPrompt) {
      getLog().warn({ filename }, 'workflow_loop_missing_prompt');
      return {
        workflow: null,
        error: {
          filename,
          error: "Loop workflows require a 'prompt' field",
          errorType: 'validation_error',
        },
      };
    }

    if (!hasSteps && !hasLoop) {
      getLog().warn({ filename }, 'workflow_missing_steps_or_loop');
      return {
        workflow: null,
        error: {
          filename,
          error: "Missing 'steps' or 'loop' configuration",
          errorType: 'validation_error',
        },
      };
    }

    // Parse loop config if present
    let loopConfig: LoopConfig | undefined;
    if (hasLoop) {
      const loop = raw.loop as Record<string, unknown>;
      if (typeof loop.until !== 'string' || !loop.until.trim()) {
        getLog().warn({ filename }, 'workflow_loop_missing_until');
        return {
          workflow: null,
          error: {
            filename,
            error: "Loop 'until' must be a non-empty string",
            errorType: 'validation_error',
          },
        };
      }
      if (typeof loop.max_iterations !== 'number' || loop.max_iterations < 1) {
        getLog().warn({ filename }, 'workflow_loop_invalid_max_iterations');
        return {
          workflow: null,
          error: {
            filename,
            error: "'max_iterations' must be a positive number",
            errorType: 'validation_error',
          },
        };
      }
      loopConfig = {
        until: loop.until,
        max_iterations: loop.max_iterations,
        fresh_context: Boolean(loop.fresh_context),
      };
    }

    // Parse steps if present (for step-based workflows)
    let steps: WorkflowStep[] | undefined;
    if (hasSteps) {
      // Collect validation errors for aggregated reporting
      const validationErrors: string[] = [];

      steps = (raw.steps as unknown[])
        .map((s: unknown, index: number) => parseStep(s, index, validationErrors))
        .filter((step): step is WorkflowStep => step !== null);

      // Reject workflow if any steps were invalid - report all errors at once
      if (steps.length !== (raw.steps as unknown[]).length) {
        getLog().warn({ filename, validationErrors }, 'workflow_step_validation_failed');
        return {
          workflow: null,
          error: {
            filename,
            error: `Step validation failed: ${validationErrors.join('; ')}`,
            errorType: 'validation_error',
          },
        };
      }
    }

    // Validate provider (leave undefined if not specified - executor handles fallback to config)
    const provider =
      raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : undefined;
    const model = typeof raw.model === 'string' ? raw.model : undefined;

    // Return appropriate workflow type based on discriminated union
    if (hasLoop && loopConfig) {
      return {
        workflow: {
          name: raw.name,
          description: raw.description,
          provider,
          model,
          loop: loopConfig,
          prompt: raw.prompt as string,
        },
        error: null,
      };
    }

    // Guard for TypeScript type narrowing - if we reach here without steps,
    // it means step validation failed (see workflow_step_validation_failed log above)
    if (!steps) {
      getLog().error({ filename }, 'workflow_step_validation_unexpected_failure');
      return {
        workflow: null,
        error: {
          filename,
          error: 'Step validation failed unexpectedly',
          errorType: 'validation_error',
        },
      };
    }

    return {
      workflow: {
        name: raw.name,
        description: raw.description,
        provider,
        model,
        steps,
      },
      error: null,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    getLog().error(
      {
        err,
        filename,
        lineInfo: lineInfo || undefined,
        contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
      },
      'workflow_parse_failed'
    );
    return {
      workflow: null,
      error: {
        filename,
        error: `YAML parse error${lineInfo}: ${err.message}`,
        errorType: 'parse_error',
      },
    };
  }
}

interface DirLoadResult {
  workflows: Map<string, WorkflowDefinition>;
  errors: WorkflowLoadError[];
}

/**
 * Load workflows from a directory (recursively includes subdirectories).
 * Failures are per-file: one broken file does not abort loading the rest.
 */
async function loadWorkflowsFromDir(dirPath: string): Promise<DirLoadResult> {
  const workflows = new Map<string, WorkflowDefinition>();
  const errors: WorkflowLoadError[] = [];

  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);

      try {
        const entryStat = await stat(entryPath);

        if (entryStat.isDirectory()) {
          // Recursively load from subdirectories
          const subResult = await loadWorkflowsFromDir(entryPath);
          for (const [filename, workflow] of subResult.workflows) {
            workflows.set(filename, workflow);
          }
          errors.push(...subResult.errors);
        } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
          const content = await readFile(entryPath, 'utf-8');
          const result = parseWorkflow(content, entry);

          if (result.workflow) {
            workflows.set(entry, result.workflow);
            getLog().debug({ workflowName: result.workflow.name, dirPath }, 'workflow_loaded');
          } else {
            errors.push(result.error);
          }
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        getLog().warn({ err, entryPath }, 'workflow_file_read_error');
        errors.push({
          filename: entry,
          error: `File read error: ${err.message} (${err.code ?? 'unknown'})`,
          errorType: 'read_error',
        });
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      getLog().debug({ dirPath }, 'workflow_directory_not_found');
    } else {
      getLog().warn({ err, dirPath }, 'workflow_directory_read_error');
      errors.push({
        filename: dirPath,
        error: `Directory read error: ${err.message} (${err.code ?? 'unknown'})`,
        errorType: 'read_error',
      });
    }
  }

  return { workflows, errors };
}

/**
 * Load bundled default workflows (for binary distribution)
 * Returns a Map of filename -> workflow for consistency with loadWorkflowsFromDir
 *
 * Note: Bundled workflows are embedded at compile time and should ALWAYS be valid.
 * Parse failures indicate a build-time corruption and are logged as errors.
 */
function loadBundledWorkflows(): Map<string, WorkflowDefinition> {
  const workflows = new Map<string, WorkflowDefinition>();

  for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
    const filename = `${name}.yaml`;
    const result = parseWorkflow(content, filename);
    if (result.workflow) {
      workflows.set(filename, result.workflow);
      getLog().debug({ workflowName: result.workflow.name }, 'bundled_workflow_loaded');
    } else {
      // Bundled workflows should ALWAYS be valid - this indicates a build-time error
      getLog().error(
        { filename, contentPreview: content.slice(0, 200) + '...' },
        'bundled_workflow_parse_failed'
      );
    }
  }

  return workflows;
}

/**
 * Discover and load workflows from codebase
 * Loads from both app's bundled defaults and repo's workflow folder.
 * Repo workflows override app defaults by exact filename match.
 *
 * When running as a compiled binary, defaults are loaded from the bundled
 * content embedded at compile time. When running with Bun, defaults are
 * loaded from the filesystem.
 */
export async function discoverWorkflows(cwd: string): Promise<WorkflowLoadResult> {
  // Map of filename -> workflow for deduplication
  const workflowsByFile = new Map<string, WorkflowDefinition>();
  const allErrors: WorkflowLoadError[] = [];

  // Load config to check opt-out settings
  let config;
  try {
    config = await configLoader.loadConfig(cwd);
  } catch (error) {
    const err = error as Error;
    getLog().warn(
      {
        err,
        cwd,
        note: 'Default workflows will be loaded. Check your .archon/config.yaml if this is unexpected.',
      },
      'config_load_failed_using_defaults'
    );
    config = { defaults: { loadDefaultWorkflows: true } };
  }

  // 1. Load from app's bundled defaults (unless opted out)
  const loadDefaultWorkflows = config.defaults?.loadDefaultWorkflows ?? true;
  if (loadDefaultWorkflows) {
    if (isBinaryBuild()) {
      // Binary: load from embedded bundled content
      getLog().debug('loading_bundled_default_workflows');
      const bundledWorkflows = loadBundledWorkflows();
      for (const [filename, workflow] of bundledWorkflows) {
        workflowsByFile.set(filename, workflow);
      }
      getLog().info({ count: bundledWorkflows.size }, 'bundled_default_workflows_loaded');
    } else {
      // Bun: load from filesystem (development mode)
      const appDefaultsPath = archonPaths.getDefaultWorkflowsPath();
      getLog().debug({ appDefaultsPath }, 'loading_app_default_workflows');
      try {
        await access(appDefaultsPath);
        const appResult = await loadWorkflowsFromDir(appDefaultsPath);
        for (const [filename, workflow] of appResult.workflows) {
          workflowsByFile.set(filename, workflow);
        }
        // Don't surface bundled/app default errors to users - they're internal
        if (appResult.errors.length > 0) {
          getLog().warn(
            { errorCount: appResult.errors.length, errors: appResult.errors },
            'app_default_workflow_errors'
          );
        }
        getLog().info({ count: appResult.workflows.size }, 'app_default_workflows_loaded');
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          getLog().warn({ err, appDefaultsPath }, 'app_defaults_access_error');
        } else {
          getLog().debug({ appDefaultsPath }, 'app_defaults_directory_not_found');
        }
      }
    }
  }

  // 2. Load from repo's workflow folder (overrides app defaults by exact filename)
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(cwd, workflowFolder);

  getLog().debug({ workflowPath }, 'searching_repo_workflows');

  try {
    await access(workflowPath);
    const repoResult = await loadWorkflowsFromDir(workflowPath);

    // Repo workflows override app defaults by exact filename match
    for (const [filename, workflow] of repoResult.workflows) {
      if (workflowsByFile.has(filename)) {
        getLog().debug({ filename }, 'repo_workflow_overrides_default');
      }
      workflowsByFile.set(filename, workflow);
    }

    // Surface repo workflow errors to users (these are actionable)
    allErrors.push(...repoResult.errors);

    // Warn about deprecated non-prefixed defaults in repo's defaults folder
    const repoDefaultsPath = join(cwd, workflowFolder, 'defaults');
    try {
      await access(repoDefaultsPath);
      const defaultEntries = await readdir(repoDefaultsPath);
      const oldDefaults = defaultEntries.filter(
        f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('archon-')
      );
      if (oldDefaults.length > 0) {
        getLog().warn(
          { count: oldDefaults.length, repoDefaultsPath, hint: `rm -rf "${repoDefaultsPath}"` },
          'deprecated_workflow_defaults_found'
        );
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        getLog().warn({ err, repoDefaultsPath }, 'deprecated_defaults_check_failed');
      }
      // ENOENT (not found) is expected - no defaults folder exists
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw new Error(
        `Cannot access workflow folder at ${workflowPath}: ${err.message} (${err.code ?? 'unknown'})`
      );
    }
    getLog().debug({ workflowPath }, 'workflow_folder_not_found');
  }

  const workflows = Array.from(workflowsByFile.values());
  getLog().info(
    { count: workflows.length, errorCount: allErrors.length },
    'workflows_discovery_complete'
  );
  return { workflows, errors: allErrors };
}
