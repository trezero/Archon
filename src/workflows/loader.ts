/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access, stat } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition, LoopConfig, SingleStep, WorkflowStep } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';
import { isValidCommandName } from './executor';

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

    // Validate provider (default to 'claude')
    const provider =
      raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : 'claude';
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

    // Step-based workflow
    return {
      name: raw.name,
      description: raw.description,
      provider,
      model,
      steps: steps!,
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
 */
async function loadWorkflowsFromDir(dirPath: string): Promise<WorkflowDefinition[]> {
  const workflows: WorkflowDefinition[] = [];

  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      const entryStat = await stat(entryPath);

      if (entryStat.isDirectory()) {
        // Recursively load from subdirectories
        const subWorkflows = await loadWorkflowsFromDir(entryPath);
        workflows.push(...subWorkflows);
      } else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        const content = await readFile(entryPath, 'utf-8');
        const workflow = parseWorkflow(content, entry);

        if (workflow) {
          workflows.push(workflow);
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
 * Discover and load workflows from codebase
 * Searches .archon/workflows/ recursively (includes subdirectories like defaults/).
 */
export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
  const [workflowFolder] = getWorkflowFolderSearchPaths();
  const workflowPath = join(cwd, workflowFolder);

  console.log(`[WorkflowLoader] Searching for workflows in: ${workflowPath}`);

  try {
    await access(workflowPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log(`[WorkflowLoader] No workflow folder found at: ${workflowPath}`);
    } else {
      console.warn(`[WorkflowLoader] Error accessing ${workflowPath}: ${err.message}`);
    }
    return [];
  }

  const workflows = await loadWorkflowsFromDir(workflowPath);
  console.log(
    `[WorkflowLoader] Loaded ${String(workflows.length)} workflows from ${workflowFolder}`
  );
  return workflows;
}
