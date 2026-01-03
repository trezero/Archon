/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';

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
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      console.warn(`[WorkflowLoader] Missing or empty 'steps' in ${filename}`);
      return null;
    }

    // Parse command field (support both 'command' and 'step' for backward compat)
    const steps = raw.steps.map((s: unknown) => {
      const step = s as Record<string, unknown>;
      return {
        command: String(step.command ?? step.step),
        clearContext: Boolean(step.clearContext),
      };
    });

    // Validate provider (default to 'claude')
    const provider =
      raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : 'claude';

    return {
      name: raw.name,
      description: raw.description,
      provider,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      steps,
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[WorkflowLoader] Failed to parse ${filename}:`, err.message);
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
