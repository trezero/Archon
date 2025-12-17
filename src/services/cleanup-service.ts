/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands
 */
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import { getIsolationProvider } from '../isolation';
import { execFileAsync } from '../utils/git';
import { IsolationEnvironmentRow } from '../types';

// Configuration constants (configurable via env vars)
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14', 10);
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6', 10);

// Module-level variable for scheduler
let cleanupIntervalId: NodeJS.Timeout | null = null;

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

/**
 * Run full scheduled cleanup cycle
 * 1. Find and remove merged branches
 * 2. Find and remove stale environments
 */
export async function runScheduledCleanup(): Promise<CleanupReport> {
  console.log('[Cleanup] Starting scheduled cleanup');
  const report: CleanupReport = { removed: [], skipped: [], errors: [] };

  try {
    // Get all active environments with their codebase info
    const environments = await isolationEnvDb.listAllActiveWithCodebase();
    console.log(`[Cleanup] Found ${String(environments.length)} active environments`);

    for (const env of environments) {
      try {
        // Skip if already processing or destroyed
        if (env.status !== 'active') continue;

        // Check if path still exists
        const pathExists = await worktreeExists(env.working_path);
        if (!pathExists) {
          // Path doesn't exist - mark as destroyed in DB
          await isolationEnvDb.updateStatus(env.id, 'destroyed');
          report.removed.push(`${env.id} (path missing)`);
          console.log(`[Cleanup] Marked ${env.id} as destroyed (path missing)`);
          continue;
        }

        // Check if branch is merged
        const mainBranch = await getMainBranch(env.codebase_default_cwd);
        const merged = await isBranchMerged(env.codebase_default_cwd, env.branch_name, mainBranch);

        if (merged) {
          // Check for uncommitted changes before removing
          const hasChanges = await hasUncommittedChanges(env.working_path);
          if (hasChanges) {
            report.skipped.push({ id: env.id, reason: 'merged but has uncommitted changes' });
            console.log(`[Cleanup] Skipping ${env.id}: merged but has uncommitted changes`);
            continue;
          }

          // Check if any conversations still reference this env
          const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
          if (conversations.length > 0) {
            report.skipped.push({
              id: env.id,
              reason: `merged but still used by ${String(conversations.length)} conversations`,
            });
            console.log(
              `[Cleanup] Skipping ${env.id}: still used by ${String(conversations.length)} conversations`
            );
            continue;
          }

          // Safe to remove merged branch
          await removeEnvironment(env.id, { force: false });
          report.removed.push(`${env.id} (merged)`);
          continue;
        }

        // Check staleness (skip Telegram - already filtered in query but double-check)
        if (env.created_by_platform === 'telegram') {
          continue; // Never cleanup Telegram (persistent workspace)
        }

        // Check if environment is stale
        const isStale = await isEnvironmentStale(env, STALE_THRESHOLD_DAYS);
        if (isStale) {
          const hasChanges = await hasUncommittedChanges(env.working_path);
          if (hasChanges) {
            report.skipped.push({ id: env.id, reason: 'stale but has uncommitted changes' });
            console.log(`[Cleanup] Skipping ${env.id}: stale but has uncommitted changes`);
            continue;
          }

          const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
          if (conversations.length > 0) {
            report.skipped.push({
              id: env.id,
              reason: `stale but still used by ${String(conversations.length)} conversations`,
            });
            continue;
          }

          await removeEnvironment(env.id, { force: false });
          report.removed.push(`${env.id} (stale)`);
        }
      } catch (error) {
        const err = error as Error;
        report.errors.push({ id: env.id, error: err.message });
        console.error(`[Cleanup] Error processing ${env.id}:`, err.message);
        // Continue to next environment - don't crash the cleanup cycle
      }
    }
  } catch (error) {
    const err = error as Error;
    console.error('[Cleanup] Scheduled cleanup failed:', err.message);
    report.errors.push({ id: 'scheduler', error: err.message });
  }

  console.log('[Cleanup] Scheduled cleanup complete:', {
    removed: report.removed.length,
    skipped: report.skipped.length,
    errors: report.errors.length,
  });

  return report;
}

/**
 * Check if an environment is stale based on activity
 */
async function isEnvironmentStale(
  env: IsolationEnvironmentRow,
  staleDays: number
): Promise<boolean> {
  // Check last commit date in the worktree
  const lastCommit = await getLastCommitDate(env.working_path);
  if (lastCommit) {
    const daysSinceCommit = (Date.now() - lastCommit.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCommit < staleDays) {
      return false; // Recent commit activity
    }
  }

  // Check environment creation date as fallback
  const daysSinceCreation =
    (Date.now() - new Date(env.created_at).getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceCreation >= staleDays;
}

/**
 * Get the main branch name for a repository
 */
async function getMainBranch(repoPath: string): Promise<string> {
  try {
    // Try to get the default branch from remote
    const { stdout } = await execFileAsync('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    // Output is like "refs/remotes/origin/main"
    const match = /refs\/remotes\/origin\/(.+)/.exec(stdout.trim());
    return match?.[1] ?? 'main';
  } catch {
    // Fallback to 'main'
    return 'main';
  }
}

/**
 * Check if a worktree path exists
 */
async function worktreeExists(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--git-dir']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Start the cleanup scheduler
 * Runs cleanup cycle every CLEANUP_INTERVAL_HOURS
 */
export function startCleanupScheduler(): void {
  if (cleanupIntervalId) {
    console.warn('[Cleanup] Scheduler already running');
    return;
  }

  const intervalMs = CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;
  console.log(`[Cleanup] Starting scheduler (interval: ${String(CLEANUP_INTERVAL_HOURS)} hours)`);

  // Run immediately on startup, then at interval
  void runScheduledCleanup().catch(err => {
    console.error('[Cleanup] Initial cleanup failed:', (err as Error).message);
  });

  cleanupIntervalId = setInterval(() => {
    void runScheduledCleanup().catch(err => {
      console.error('[Cleanup] Scheduled cleanup failed:', (err as Error).message);
    });
  }, intervalMs);

  console.log('[Cleanup] Scheduler started');
}

/**
 * Stop the cleanup scheduler
 */
export function stopCleanupScheduler(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
    console.log('[Cleanup] Scheduler stopped');
  }
}

/**
 * Check if scheduler is running (for testing)
 */
export function isSchedulerRunning(): boolean {
  return cleanupIntervalId !== null;
}
