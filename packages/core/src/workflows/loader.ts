/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access, stat } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition, LoopConfig, SingleStep, WorkflowStep } from './types';
import * as archonPaths from '../utils/archon-paths';
import * as configLoader from '../config/config-loader';
import { isValidCommandName } from './executor';
import { BUNDLED_WORKFLOWS, isBinaryBuild } from '../defaults/bundled-defaults';

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

/**
 * Parse and validate a workflow YAML file
 */
function parseWorkflow(content: string, filename: string): WorkflowDefinition | null {
  try {
    const raw = parseYaml(content) as Record<string, unknown>;

    if (!raw.name || typeof raw.name !== 'string') {
      console.warn(`[WorkflowLoader] Missing 'name' in ${filename}`);
      return null;
    }
    if (!raw.description || typeof raw.description !== 'string') {
      console.warn(`[WorkflowLoader] Missing 'description' in ${filename}`);
      return null;
    }

    // Validate mutual exclusivity: steps XOR (loop + prompt)
    // This prevents ambiguous execution modes - a workflow is either
    // step-based (sequential commands) or loop-based (autonomous iteration)
    const hasSteps = Array.isArray(raw.steps) && raw.steps.length > 0;
    const hasLoop = raw.loop && typeof raw.loop === 'object';
    const hasPrompt = typeof raw.prompt === 'string' && raw.prompt.trim().length > 0;

    if (hasSteps && hasLoop) {
      console.warn(`[WorkflowLoader] Cannot have both 'steps' and 'loop' in ${filename}`);
      return null;
    }

    if (hasLoop && !hasPrompt) {
      console.warn(`[WorkflowLoader] Loop workflow requires 'prompt' in ${filename}`);
      return null;
    }

    if (!hasSteps && !hasLoop) {
      console.warn(`[WorkflowLoader] Workflow must have 'steps' or 'loop' in ${filename}`);
      return null;
    }

    // Parse loop config if present
    let loopConfig: LoopConfig | undefined;
    if (hasLoop) {
      const loop = raw.loop as Record<string, unknown>;
      if (typeof loop.until !== 'string' || !loop.until.trim()) {
        console.warn(`[WorkflowLoader] Loop requires 'until' signal in ${filename}`);
        return null;
      }
      if (typeof loop.max_iterations !== 'number' || loop.max_iterations < 1) {
        console.warn(`[WorkflowLoader] Loop requires positive 'max_iterations' in ${filename}`);
        return null;
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
        console.warn(`[WorkflowLoader] Workflow ${filename} failed validation:`, validationErrors);
        return null;
      }
    }

    // Validate provider (leave undefined if not specified - executor handles fallback to config)
    const provider =
      raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : undefined;
    const model = typeof raw.model === 'string' ? raw.model : undefined;

    // Return appropriate workflow type based on discriminated union
    if (hasLoop && loopConfig) {
      return {
        name: raw.name,
        description: raw.description,
        provider,
        model,
        loop: loopConfig,
        prompt: raw.prompt as string,
      };
    }

    // Guard for TypeScript type narrowing - if we reach here without steps,
    // it means step validation failed (see errors logged above at line 150)
    if (!steps) {
      console.error(
        `[WorkflowLoader] Workflow ${filename} failed step validation (see errors above)`
      );
      return null;
    }

    return {
      name: raw.name,
      description: raw.description,
      provider,
      model,
      steps,
    };
  } catch (error) {
    const err = error as Error;
    // Extract line number from YAML parse errors if available
    const linePattern = /line (\d+)/i;
    const lineMatch = linePattern.exec(err.message);
    const lineInfo = lineMatch ? ` (near line ${lineMatch[1]})` : '';
    console.error(`[WorkflowLoader] Failed to parse ${filename}${lineInfo}:`, {
      error: err.message,
      contentPreview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
    });
    return null;
  }
}

/**
 * Load workflows from a directory (recursively includes subdirectories)
 * Returns a Map of filename -> workflow for easy deduplication
 */
async function loadWorkflowsFromDir(dirPath: string): Promise<Map<string, WorkflowDefinition>> {
  const workflows = new Map<string, WorkflowDefinition>();

  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      const entryStat = await stat(entryPath);

      if (entryStat.isDirectory()) {
        // Recursively load from subdirectories
        const subWorkflows = await loadWorkflowsFromDir(entryPath);
        for (const [filename, workflow] of subWorkflows) {
          workflows.set(filename, workflow);
        }
      } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        const content = await readFile(entryPath, 'utf-8');
        const workflow = parseWorkflow(content, entry);

        if (workflow) {
          workflows.set(entry, workflow);
          console.log(`[WorkflowLoader] Loaded workflow: ${workflow.name}`);
        }
      }
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log(`[WorkflowLoader] Directory not found: ${dirPath}`);
    } else {
      console.warn(`[WorkflowLoader] Error reading ${dirPath}: ${err.message}`);
    }
  }

  return workflows;
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
    const workflow = parseWorkflow(content, filename);
    if (workflow) {
      workflows.set(filename, workflow);
      console.log(`[WorkflowLoader] Loaded bundled workflow: ${workflow.name}`);
    } else {
      // Bundled workflows should ALWAYS be valid - this indicates a build-time error
      console.error(`[WorkflowLoader] CRITICAL: Bundled workflow failed to parse: ${filename}`);
      console.error('[WorkflowLoader] This indicates build-time corruption or invalid YAML.');
      console.error(`[WorkflowLoader] Content preview: ${content.slice(0, 200)}...`);
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
export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
  // Map of filename -> workflow for deduplication
  const workflowsByFile = new Map<string, WorkflowDefinition>();

  // Load config to check opt-out settings
  let config;
  try {
    config = await configLoader.loadConfig(cwd);
  } catch (error) {
    const err = error as Error;
    console.warn('[WorkflowLoader] Failed to load config, using defaults:', {
      cwd,
      error: err.message,
      errorType: err.name,
      note: 'Default workflows will be loaded. Check your .archon/config.yaml if this is unexpected.',
    });
    config = { defaults: { loadDefaultWorkflows: true } };
  }

  // 1. Load from app's bundled defaults (unless opted out)
  const loadDefaultWorkflows = config.defaults?.loadDefaultWorkflows ?? true;
  if (loadDefaultWorkflows) {
    if (isBinaryBuild()) {
      // Binary: load from embedded bundled content
      console.log('[WorkflowLoader] Loading bundled default workflows (binary mode)');
      const bundledWorkflows = loadBundledWorkflows();
      for (const [filename, workflow] of bundledWorkflows) {
        workflowsByFile.set(filename, workflow);
      }
      console.log(
        `[WorkflowLoader] Loaded ${String(bundledWorkflows.size)} bundled default workflows`
      );
    } else {
      // Bun: load from filesystem (development mode)
      const appDefaultsPath = archonPaths.getDefaultWorkflowsPath();
      console.log(`[WorkflowLoader] Loading app defaults from: ${appDefaultsPath}`);
      try {
        await access(appDefaultsPath);
        const appWorkflows = await loadWorkflowsFromDir(appDefaultsPath);
        for (const [filename, workflow] of appWorkflows) {
          workflowsByFile.set(filename, workflow);
        }
        console.log(`[WorkflowLoader] Loaded ${String(appWorkflows.size)} app default workflows`);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.warn(`[WorkflowLoader] Could not access app defaults: ${err.message}`);
        } else {
          console.log(`[WorkflowLoader] No app defaults directory found at: ${appDefaultsPath}`);
        }
      }
    }
  }

  // 2. Load from repo's workflow folder (overrides app defaults by exact filename)
  const [workflowFolder] = archonPaths.getWorkflowFolderSearchPaths();
  const workflowPath = join(cwd, workflowFolder);

  console.log(`[WorkflowLoader] Searching for workflows in: ${workflowPath}`);

  try {
    await access(workflowPath);
    const repoWorkflows = await loadWorkflowsFromDir(workflowPath);

    // Repo workflows override app defaults by exact filename match
    for (const [filename, workflow] of repoWorkflows) {
      if (workflowsByFile.has(filename)) {
        console.log(`[WorkflowLoader] Repo workflow '${filename}' overrides app default`);
      }
      workflowsByFile.set(filename, workflow);
    }

    // Warn about deprecated non-prefixed defaults in repo's defaults folder
    const repoDefaultsPath = join(cwd, workflowFolder, 'defaults');
    try {
      await access(repoDefaultsPath);
      const defaultEntries = await readdir(repoDefaultsPath);
      const oldDefaults = defaultEntries.filter(
        f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('archon-')
      );
      if (oldDefaults.length > 0) {
        console.warn(
          `[WorkflowLoader] DEPRECATED: Found ${String(oldDefaults.length)} old-style workflow defaults in ${repoDefaultsPath}`
        );
        console.warn(
          '[WorkflowLoader] These are from an older version. Delete the folder to use updated app defaults:'
        );
        console.warn(`[WorkflowLoader]   rm -rf "${repoDefaultsPath}"`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn('[WorkflowLoader] Could not check for deprecated defaults folder:', {
          path: repoDefaultsPath,
          error: err.message,
          code: err.code,
        });
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
    console.log(`[WorkflowLoader] No workflow folder found at: ${workflowPath}`);
  }

  const workflows = Array.from(workflowsByFile.values());
  console.log(`[WorkflowLoader] Total workflows loaded: ${String(workflows.length)}`);
  return workflows;
}
