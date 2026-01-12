/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition, LoopConfig } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';
import { isValidCommandName } from './executor';

/**
 * Parse YAML using Bun's native YAML parser
 */
function parseYaml(content: string): unknown {
  return Bun.YAML.parse(content);
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
    let steps: { command: string; clearContext: boolean }[] | undefined;
    if (hasSteps) {
      // Parse command field (support both 'command' and 'step' for backward compat)
      steps = (raw.steps as unknown[])
        .map((s: unknown, index: number) => {
          const step = s as Record<string, unknown>;
          const command = String(step.command ?? step.step);

          // Validate command name at parse time (Issue #129)
          if (!isValidCommandName(command)) {
            console.warn(
              `[WorkflowLoader] Invalid command name in ${filename} step ${String(index + 1)}: ${command}`
            );
            return null;
          }

          return {
            command,
            clearContext: Boolean(step.clearContext),
          };
        })
        .filter((step): step is NonNullable<typeof step> => step !== null);

      // Reject workflow if any steps were invalid
      if (steps.length !== (raw.steps as unknown[]).length) {
        console.warn(`[WorkflowLoader] Workflow ${filename} has invalid command names, skipping`);
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
 * Load workflows from a directory
 */
async function loadWorkflowsFromDir(dirPath: string): Promise<WorkflowDefinition[]> {
  const workflows: WorkflowDefinition[] = [];

  try {
    const files = await readdir(dirPath);
    const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of yamlFiles) {
      const filePath = join(dirPath, file);
      const content = await readFile(filePath, 'utf-8');
      const workflow = parseWorkflow(content, file);

      if (workflow) {
        workflows.push(workflow);
        console.log(`[WorkflowLoader] Loaded workflow: ${workflow.name}`);
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
 * Searches .archon/workflows/, .claude/workflows/, .agents/workflows/
 * Stops at the first folder that contains workflows (priority order).
 */
export async function discoverWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
  const allWorkflows: WorkflowDefinition[] = [];
  const searchPaths = getWorkflowFolderSearchPaths();

  for (const folder of searchPaths) {
    const fullPath = join(cwd, folder);
    try {
      await access(fullPath);
      const workflows = await loadWorkflowsFromDir(fullPath);
      allWorkflows.push(...workflows);

      if (workflows.length > 0) {
        console.log(`[WorkflowLoader] Found ${String(workflows.length)} workflows in ${folder}`);
        break; // Stop at first folder with workflows
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn(`[WorkflowLoader] Error accessing ${fullPath}: ${err.message}`);
      }
      // ENOENT is expected - folder doesn't exist, try next
    }
  }

  return allWorkflows;
}
