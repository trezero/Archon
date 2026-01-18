/**
 * Cleanup service for isolation environments
 * Handles removal triggered by events, schedule, or commands
 */
import * as isolationEnvDb from '../db/isolation-environments';
import * as conversationDb from '../db/conversations';
import * as sessionDb from '../db/sessions';
import * as codebaseDb from '../db/codebases';
import { getIsolationProvider } from '../isolation';
import { execFileAsync, hasUncommittedChanges } from '../utils/git';
import { IsolationEnvironmentRow, ConversationNotFoundError } from '../types';

// Configuration constants (configurable via env vars)
const STALE_THRESHOLD_DAYS = parseInt(process.env.STALE_THRESHOLD_DAYS ?? '14', 10);
const CLEANUP_INTERVAL_HOURS = parseInt(process.env.CLEANUP_INTERVAL_HOURS ?? '6', 10);
const MAX_WORKTREES_PER_CODEBASE = parseInt(process.env.MAX_WORKTREES_PER_CODEBASE ?? '25', 10);

// Export configuration for use by other modules
export { MAX_WORKTREES_PER_CODEBASE, STALE_THRESHOLD_DAYS };

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

  // Clear this conversation's reference (best-effort - conversation may be deleted)
  await conversationDb.updateConversation(conversation.id, { isolation_env_id: null }).catch(err => {
    if (!(err instanceof ConversationNotFoundError)) throw err;
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

  // Get canonical repo path from codebase for branch cleanup
  let canonicalRepoPath: string | undefined;
  if (env.codebase_id) {
    const codebase = await codebaseDb.getCodebase(env.codebase_id);
    canonicalRepoPath = codebase?.default_cwd;
  }

  // Check if directory exists before attempting removal
  const pathExists = await worktreeExists(env.working_path);

  const provider = getIsolationProvider();

  try {
    // If path exists, check for uncommitted changes (unless force)
    if (pathExists && !options?.force) {
      const hasChanges = await hasUncommittedChanges(env.working_path);
      if (hasChanges) {
        console.warn(`[Cleanup] Environment ${envId} has uncommitted changes, skipping`);
        return;
      }
    }

    // Remove the worktree (and branch if provided)
    // Call destroy even if path doesn't exist - branch cleanup may still be needed
    await provider.destroy(env.working_path, {
      force: options?.force,
      branchName: env.branch_name,
      canonicalRepoPath,
    });

    // Mark as destroyed in database
    await isolationEnvDb.updateStatus(envId, 'destroyed');

    console.log(`[Cleanup] Removed environment ${envId} at ${env.working_path}`);
  } catch (error) {
    const err = error as Error & { code?: string; stderr?: string };
    const errorText = `${err.message} ${err.stderr ?? ''}`;

    // Handle "directory not found" errors gracefully
    // Be specific: check that the error is about the worktree path, not unrelated paths
    const isPathNotFoundError =
      err.code === 'ENOENT' ||
      (errorText.includes(env.working_path) &&
        (errorText.includes('No such file or directory') ||
          errorText.includes('does not exist') ||
          errorText.includes('is not a working tree')));

    if (isPathNotFoundError) {
      await isolationEnvDb.updateStatus(envId, 'destroyed');
      console.log(`[Cleanup] Directory removed externally for ${envId}, marked as destroyed`);
      return;
    }

    console.error(`[Cleanup] Failed to remove environment ${envId}:`, err.message);
    throw err;
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
 * Clean up to make room when limit reached (Phase 3D)
 * Attempts to remove merged branches first
 * Returns detailed results for user feedback
 */
export async function cleanupToMakeRoom(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupOperationResult> {
  // Reuse the merged cleanup logic
  return cleanupMergedWorktrees(codebaseId, mainRepoPath);
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
          // Path doesn't exist - call removeEnvironment to clean up branch and mark as destroyed
          await removeEnvironment(env.id, { force: false });
          report.removed.push(`${env.id} (path missing)`);
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
 * Check if a worktree path exists and is functional
 * Returns false for: path not found, not a git repo, or git directory missing
 * Only throws on truly unexpected errors (e.g., EACCES permission denied)
 */
async function worktreeExists(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--git-dir']);
    return stdout.trim().length > 0;
  } catch (error) {
    const err = error as Error & { code?: string };
    const errorText = err.message.toLowerCase();

    // Return false for expected "not found" scenarios:
    // - ENOENT: path doesn't exist
    // - "No such file or directory": path or .git missing
    // - "not a git repo/repository": path exists but .git is missing/corrupted
    if (
      err.code === 'ENOENT' ||
      errorText.includes('no such file or directory') ||
      errorText.includes('not a git repo')
    ) {
      return false;
    }

    // Log and re-throw unexpected errors (EACCES, timeout, etc.)
    console.error('[Cleanup] Unexpected error checking worktree existence:', {
      path,
      error: err.message,
      code: err.code,
    });
    throw err;
  }
}

// =============================================================================
// Phase 3D: Worktree Limits and User Feedback
// =============================================================================

/**
 * Detailed worktree status breakdown for a codebase
 */
export interface WorktreeStatusBreakdown {
  total: number;
  merged: number;
  stale: number;
  active: number;
  limit: number;
  mergedEnvs: { id: string; branchName: string }[];
  staleEnvs: { id: string; branchName: string; daysInactive: number }[];
  activeEnvs: { id: string; branchName: string }[];
}

/**
 * Result from cleanup operations with detailed information
 */
export interface CleanupOperationResult {
  removed: string[];
  skipped: { branchName: string; reason: string }[];
}

/**
 * Get detailed worktree status breakdown for a codebase
 * Includes git operations to detect merged branches
 */
export async function getWorktreeStatusBreakdown(
  codebaseId: string,
  mainRepoPath: string
): Promise<WorktreeStatusBreakdown> {
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

  const breakdown: WorktreeStatusBreakdown = {
    total: environments.length,
    merged: 0,
    stale: 0,
    active: 0,
    limit: MAX_WORKTREES_PER_CODEBASE,
    mergedEnvs: [],
    staleEnvs: [],
    activeEnvs: [],
  };

  const mainBranch = await getMainBranch(mainRepoPath);

  for (const env of environments) {
    // Skip Telegram (never shown as stale)
    const isTelegram = env.created_by_platform === 'telegram';

    // Check if merged
    const merged = await isBranchMerged(mainRepoPath, env.branch_name, mainBranch);
    if (merged) {
      breakdown.merged++;
      breakdown.mergedEnvs.push({ id: env.id, branchName: env.branch_name });
      continue;
    }

    // Check if stale (non-Telegram only)
    const isStale = !isTelegram && env.days_since_activity >= STALE_THRESHOLD_DAYS;
    if (isStale) {
      breakdown.stale++;
      breakdown.staleEnvs.push({
        id: env.id,
        branchName: env.branch_name,
        daysInactive: env.days_since_activity,
      });
      continue;
    }

    // Active
    breakdown.active++;
    breakdown.activeEnvs.push({ id: env.id, branchName: env.branch_name });
  }

  return breakdown;
}

/**
 * Clean up stale worktrees for a codebase
 * Respects uncommitted changes and conversation references
 */
export async function cleanupStaleWorktrees(
  codebaseId: string,
  _mainRepoPath: string
): Promise<CleanupOperationResult> {
  const result: CleanupOperationResult = { removed: [], skipped: [] };
  const environments = await isolationEnvDb.listByCodebaseWithAge(codebaseId);

  for (const env of environments) {
    // Skip Telegram
    if (env.created_by_platform === 'telegram') continue;

    // Check if stale
    if (env.days_since_activity < STALE_THRESHOLD_DAYS) continue;

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges(env.working_path);
    if (hasChanges) {
      result.skipped.push({ branchName: env.branch_name, reason: 'has uncommitted changes' });
      continue;
    }

    // Check for conversation references
    const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
    if (conversations.length > 0) {
      result.skipped.push({
        branchName: env.branch_name,
        reason: `still used by ${String(conversations.length)} conversation(s)`,
      });
      continue;
    }

    // Safe to remove
    try {
      await removeEnvironment(env.id);
      result.removed.push(env.branch_name);
    } catch (error) {
      const err = error as Error;
      result.skipped.push({ branchName: env.branch_name, reason: err.message });
    }
  }

  return result;
}

/**
 * Clean up merged worktrees for a codebase
 * Respects uncommitted changes and conversation references
 */
export async function cleanupMergedWorktrees(
  codebaseId: string,
  mainRepoPath: string
): Promise<CleanupOperationResult> {
  const result: CleanupOperationResult = { removed: [], skipped: [] };
  const environments = await isolationEnvDb.listByCodebase(codebaseId);
  const mainBranch = await getMainBranch(mainRepoPath);

  for (const env of environments) {
    // Check if merged
    const merged = await isBranchMerged(mainRepoPath, env.branch_name, mainBranch);
    if (!merged) continue;

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges(env.working_path);
    if (hasChanges) {
      result.skipped.push({ branchName: env.branch_name, reason: 'has uncommitted changes' });
      continue;
    }

    // Check for conversation references
    const conversations = await isolationEnvDb.getConversationsUsingEnv(env.id);
    if (conversations.length > 0) {
      result.skipped.push({
        branchName: env.branch_name,
        reason: `still used by ${String(conversations.length)} conversation(s)`,
      });
      continue;
    }

    // Safe to remove
    try {
      await removeEnvironment(env.id);
      result.removed.push(env.branch_name);
    } catch (error) {
      const err = error as Error;
      result.skipped.push({ branchName: env.branch_name, reason: err.message });
    }
  }

  return result;
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
