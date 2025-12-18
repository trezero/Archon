/**
 * Workflow loader - discovers and parses workflow YAML files
 */
import { readFile, readdir, access } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition } from './types';
import { getWorkflowFolderSearchPaths } from '../utils/archon-paths';

// In-memory registry of loaded workflows
const workflowRegistry = new Map<string, WorkflowDefinition>();

/**
 * Parse YAML using Bun's native YAML parser (established pattern from config-loader.ts)
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
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      console.warn(`[WorkflowLoader] Missing or empty 'steps' in ${filename}`);
      return null;
    }

    const steps = raw.steps.map((s: unknown) => {
      const step = s as Record<string, unknown>;
      return {
        step: String(step.step),
        clearContext: Boolean(step.clearContext),
      };
    });

    return {
      name: raw.name,
      description: raw.description,
      provider: typeof raw.provider === 'string' ? raw.provider : 'claude',
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
  } catch {
    // Directory doesn't exist or isn't readable
    console.log(`[WorkflowLoader] No workflows found in ${dirPath}`);
  }

  return workflows;
}

/**
 * Discover and load workflows from codebase
 * Searches .archon/workflows/, .claude/workflows/, .agents/workflows/
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
    } catch {
      // Folder doesn't exist, try next
    }
  }

  return allWorkflows;
}

/**
 * Register workflows in memory
 */
export function registerWorkflows(workflows: WorkflowDefinition[]): void {
  for (const workflow of workflows) {
    workflowRegistry.set(workflow.name, workflow);
  }
}

/**
 * Get all registered workflows
 */
export function getRegisteredWorkflows(): WorkflowDefinition[] {
  return Array.from(workflowRegistry.values());
}

/**
 * Get a specific workflow by name
 */
export function getWorkflow(name: string): WorkflowDefinition | undefined {
  return workflowRegistry.get(name);
}

/**
 * Clear all registered workflows (for testing)
 */
export function clearWorkflows(): void {
  workflowRegistry.clear();
}
