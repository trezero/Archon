/**
 * Workflow command - list and run workflows
 */
import {
  discoverWorkflows,
  executeWorkflow,
  getIsolationProvider,
  registerRepository,
  createLogger,
  type WorkflowLoadResult,
} from '@archon/core';
import * as conversationDb from '@archon/core/db/conversations';
import * as codebaseDb from '@archon/core/db/codebases';
import * as isolationDb from '@archon/core/db/isolation-environments';
import * as git from '@archon/git';
import { CLIAdapter } from '../adapters/cli-adapter';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.workflow');
  return cachedLog;
}

/**
 * Options for workflow run command
 *
 * Discriminated union ensures `noWorktree` can only be set when `branchName` is provided.
 */
export type WorkflowRunOptions =
  | { branchName?: undefined; noWorktree?: undefined } // No isolation
  | { branchName: string; noWorktree?: boolean }; // With branch - worktree or direct checkout

/**
 * Generate a unique conversation ID for CLI usage
 */
function generateConversationId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `cli-${String(timestamp)}-${random}`;
}

/**
 * Load workflows from cwd with standardized error handling.
 * Returns the WorkflowLoadResult with both workflows and errors.
 */
async function loadWorkflows(cwd: string): Promise<WorkflowLoadResult> {
  try {
    return await discoverWorkflows(cwd);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Error loading workflows: ${err.message}\nHint: Check permissions on .archon/workflows/ directory.`
    );
  }
}

/**
 * List available workflows in the current directory
 */
export async function workflowListCommand(cwd: string): Promise<void> {
  console.log(`Discovering workflows in: ${cwd}`);

  const { workflows, errors } = await loadWorkflows(cwd);

  if (workflows.length === 0 && errors.length === 0) {
    console.log('\nNo workflows found.');
    console.log('Workflows should be in .archon/workflows/ directory.');
    return;
  }

  if (workflows.length > 0) {
    console.log(`\nFound ${String(workflows.length)} workflow(s):\n`);

    for (const workflow of workflows) {
      console.log(`  ${workflow.name}`);
      console.log(`    ${workflow.description}`);
      if (workflow.provider) {
        console.log(`    Provider: ${workflow.provider}`);
      }
      console.log('');
    }
  }

  if (errors.length > 0) {
    console.log(`\n${String(errors.length)} workflow(s) failed to load:\n`);
    for (const e of errors) {
      console.log(`  ${e.filename}: ${e.error}`);
    }
    console.log('');
  }
}

/**
 * Run a specific workflow
 */
export async function workflowRunCommand(
  cwd: string,
  workflowName: string,
  userMessage: string,
  options: WorkflowRunOptions = {}
): Promise<void> {
  const { workflows, errors } = await loadWorkflows(cwd);

  if (workflows.length === 0 && errors.length === 0) {
    throw new Error('No workflows found in .archon/workflows/');
  }

  // Find the requested workflow (exact match first, then case-insensitive)
  let workflow = workflows.find(w => w.name === workflowName);
  if (!workflow) {
    const caseMatch = workflows.find(w => w.name.toLowerCase() === workflowName.toLowerCase());
    if (caseMatch) {
      getLog().info(
        { requested: workflowName, matched: caseMatch.name },
        'workflow_run_case_insensitive_match'
      );
      workflow = caseMatch;
    }
  }

  if (!workflow) {
    // Check if the requested workflow had a load error
    const loadError = errors.find(
      e =>
        e.filename.replace(/\.ya?ml$/, '') === workflowName ||
        e.filename === `${workflowName}.yaml` ||
        e.filename === `${workflowName}.yml`
    );
    if (loadError) {
      throw new Error(
        `Workflow '${workflowName}' failed to load: ${loadError.error}\n\nFix the YAML file and try again.`
      );
    }
    const availableWorkflows = workflows.map(w => `  - ${w.name}`).join('\n');
    throw new Error(
      `Workflow '${workflowName}' not found.\n\nAvailable workflows:\n${availableWorkflows}`
    );
  }

  console.log(`Running workflow: ${workflowName}`);
  console.log(`Working directory: ${cwd}`);
  console.log('');

  // Create CLI adapter
  const adapter = new CLIAdapter();

  // Generate conversation ID
  const conversationId = generateConversationId();

  // Get or create conversation in database
  let conversation;
  try {
    conversation = await conversationDb.getOrCreateConversation('cli', conversationId);
  } catch (error) {
    const err = error as Error;
    throw new Error(
      `Failed to access database: ${err.message}\nHint: Check that DATABASE_URL is set and the database is running.`
    );
  }

  // Try to find a codebase for this directory
  let codebase = null;
  let codebaseLookupError: Error | null = null;
  try {
    codebase = await codebaseDb.findCodebaseByDefaultCwd(cwd);
  } catch (error) {
    const err = error as Error;
    codebaseLookupError = err;
    getLog().warn({ err, cwd }, 'codebase_lookup_failed');
    if (
      err.message.includes('connect') ||
      err.message.includes('ECONNREFUSED') ||
      err.message.includes('ETIMEDOUT')
    ) {
      getLog().warn(
        { hint: 'Check DATABASE_URL and that the database is running.' },
        'db_connection_hint'
      );
    }
  }

  // Auto-register unregistered repos (creates project structure for artifacts/logs)
  if (!codebase && !codebaseLookupError) {
    const repoRoot = await git.findRepoRoot(cwd);
    if (repoRoot) {
      try {
        const result = await registerRepository(repoRoot);
        codebase = await codebaseDb.getCodebase(result.codebaseId);
        if (!result.alreadyExisted) {
          getLog().info({ name: result.name }, 'codebase_auto_registered');
        }
      } catch (error) {
        const err = error as Error;
        getLog().warn({ err }, 'codebase_auto_registration_failed');
      }
    }
  }

  // Handle isolation (worktree creation)
  let workingCwd = cwd;
  let isolationEnvId: string | undefined;

  if (options.branchName) {
    // Need a codebase for isolation
    if (!codebase) {
      if (codebaseLookupError) {
        throw new Error(
          'Cannot create worktree: Database lookup failed.\n' +
            `Error: ${codebaseLookupError.message}\n` +
            'Hint: Check your database connection before using --branch.'
        );
      }
      throw new Error(
        'Cannot create worktree: Not in a git repository.\n' +
          'Either run from a git repo or use /clone first.'
      );
    }

    if (options.noWorktree) {
      // Checkout branch in cwd, no worktree
      getLog().info({ branch: options.branchName }, 'branch_checkout');
      await git.checkout(git.toRepoPath(cwd), git.toBranchName(options.branchName));
      workingCwd = cwd;
    } else {
      // Create or reuse worktree
      const provider = getIsolationProvider();

      // Check for existing worktree
      const existingEnv = await isolationDb.findActiveByWorkflow(
        codebase.id,
        'task',
        options.branchName
      );

      if (existingEnv && (await provider.healthCheck(existingEnv.working_path))) {
        getLog().info({ path: existingEnv.working_path }, 'worktree_reused');
        workingCwd = existingEnv.working_path;
        isolationEnvId = existingEnv.id;
      } else {
        // Create new worktree
        getLog().info({ branch: options.branchName }, 'worktree_creating');

        const isolatedEnv = await provider.create({
          workflowType: 'task',
          identifier: options.branchName,
          codebaseId: codebase.id,
          canonicalRepoPath: git.toRepoPath(codebase.default_cwd),
          description: `CLI workflow: ${workflowName}`,
        });

        // Track in database
        const envRecord = await isolationDb.create({
          codebase_id: codebase.id,
          workflow_type: 'task',
          workflow_id: options.branchName,
          provider: 'worktree',
          working_path: isolatedEnv.workingPath,
          branch_name: isolatedEnv.branchName,
          created_by_platform: 'cli',
          metadata: {},
        });

        workingCwd = isolatedEnv.workingPath;
        isolationEnvId = envRecord.id;
        getLog().info({ path: workingCwd }, 'worktree_created');
      }
    }
  }

  // Update conversation with cwd and isolation info
  try {
    await conversationDb.updateConversation(conversation.id, {
      cwd: workingCwd,
      codebase_id: codebase?.id ?? null,
      isolation_env_id: isolationEnvId ?? null,
    });
  } catch (error) {
    const err = error as Error;
    throw new Error(`Failed to update conversation: ${err.message}`);
  }

  // Execute workflow with workingCwd (may be worktree path)
  const result = await executeWorkflow(
    adapter,
    conversationId,
    workingCwd,
    workflow,
    userMessage,
    conversation.id,
    codebase?.id
  );

  // Check result and exit appropriately
  if (result.success) {
    console.log('\nWorkflow completed successfully.');
  } else {
    throw new Error(`Workflow failed: ${result.error}`);
  }
}

/**
 * Show workflow status (placeholder for future implementation)
 */
export async function workflowStatusCommand(): Promise<void> {
  throw new Error(
    'Workflow status not yet implemented.\nThis will show running workflows and their progress.'
  );
}
