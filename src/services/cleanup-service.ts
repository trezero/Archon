/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands
 */
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { getIsolationProvider } from '../isolation';
import { execFileAsync } from '../utils/git';

export interface CleanupReport {
  removed: string[];
  skipped: { id: string; reason: string }[];
  errors: { id: string; error: string }[];
}

/**
 * Called when a platform conversation is closed (e.g., GitHub issue/PR closed)
 * Cleans up the associated isolation environment if no other conversations use it
 */
export async function onConversationClosed(
  platformType: string,
  platformConversationId: string
): Promise<void> {
  console.log(`[Cleanup] Conversation closed: ${platformType}/${platformConversationId}`);

  // Find the conversation
  const conversation = await conversationDb.getConversationByPlatformId(
    platformType,
    platformConversationId
  );

  if (!conversation?.isolation_env_id) {
    console.log('[Cleanup] No isolation environment to clean up');
    return;
  }

  const envId = conversation.isolation_env_id;

  // Deactivate any active sessions first
  const session = await sessionDb.getActiveSession(conversation.id);
  if (session) {
    await sessionDb.deactivateSession(session.id);
    console.log(`[Cleanup] Deactivated session ${session.id}`);
  }

  // Get the environment
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    console.log(`[Cleanup] Environment ${envId} not found in database`);
    return;
  }

  // Clear this conversation's reference (regardless of whether we remove the worktree)
  await conversationDb.updateConversation(conversation.id, {
    isolation_env_id: null,
    worktree_path: null,
    isolation_provider: null,
    // Keep cwd pointing to main repo (will be set by caller or orchestrator)
  });

  // Check if other conversations still use this environment
  const otherConversations = await isolationEnvDb.getConversationsUsingEnv(envId);
  if (otherConversations.length > 0) {
    console.log(
      `[Cleanup] Environment still used by ${String(otherConversations.length)} conversation(s), keeping`
    );
    return;
  }

  // No other users - attempt removal
  await removeEnvironment(envId, { force: false });
}

/**
 * Remove a specific environment
 */
export async function removeEnvironment(
  envId: string,
  options?: { force?: boolean }
): Promise<void> {
  const env = await isolationEnvDb.getById(envId);
  if (!env) {
    console.log(`[Cleanup] Environment ${envId} not found`);
    return;
  }

  if (env.status === 'destroyed') {
    console.log(`[Cleanup] Environment ${envId} already destroyed`);
    return;
  }

  const provider = getIsolationProvider();

  try {
    // Check for uncommitted changes (unless force)
    if (!options?.force) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (hasChanges) {
        console.warn(`[Cleanup] Environment ${envId} has uncommitted changes, skipping`);
        return;
      }
    }

    // Remove the worktree
    await provider.destroy(env.working_path, { force: options?.force });

    // Mark as destroyed in database
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    console.log(`[Cleanup] Removed environment ${envId} at ${env.working_path}`);
  } catch (error) {
    const err = error as Error;
    console.error(`[Cleanup] Failed to remove environment ${envId}:`, err.message);
    throw err;
  }
}

/**
 * Check if a worktree has uncommitted changes
 */
export async function hasUncommittedChanges(workingPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch {
    // If git fails, assume it's safe to remove (path might not exist)
    return false;
  }
}

/**
 * Check if a branch has been merged into main
 */
export async function isBranchMerged(
  repoPath: string,
  branchName: string,
  mainBranch = 'main'
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'branch',
      '--merged',
      mainBranch,
    ]);
    const mergedBranches = stdout.split('\n').map(b => b.trim().replace(/^\* /, ''));
    return mergedBranches.includes(branchName);
  } catch {
    return false;
  }
}

/**
 * Get the last commit date for a worktree
 */
export async function getLastCommitDate(workingPath: string): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', workingPath, 'log', '-1', '--format=%ci']);
    return new Date(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Clean up to make room when limit reached (Phase 3D will call this)
 * Attempts to remove merged branches first
 */
export async function cleanupToMakeRoom(codebaseId: string, mainRepoPath: string): Promise<number> {
  const envs = await isolationEnvDb.listByCodebase(codebaseId);
  let removed = 0;

  for (const env of envs) {
    // Try merged branches first
    const merged = await isBranchMerged(mainRepoPath, env.branch_name);
    if (merged) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (!hasChanges) {
        try {
          await removeEnvironment(env.id);
          removed++;
        } catch {
          // Continue to next
        }
      }
    }
  }

  return removed;
}
