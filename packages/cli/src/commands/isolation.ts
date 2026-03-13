/**
 * Isolation commands - list, cleanup, and complete worktrees
 */
import * as isolationDb from '@archon/core/db/isolation-environments';
import { createLogger } from '@archon/paths';
import { toRepoPath, toBranchName, hasUncommittedChanges, toWorktreePath } from '@archon/git';
import { getIsolationProvider } from '@archon/isolation';
import { cleanupMergedWorktrees, removeEnvironment } from '@archon/core/services/cleanup-service';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.isolation');
  return cachedLog;
}

/**
 * Codebase info for display (extracted from isolation environment JOIN)
 */
interface CodebaseInfo {
  id: string;
  repository_url: string | null;
  default_cwd: string;
}

/**
 * List all active isolation environments
 */
export async function isolationListCommand(): Promise<void> {
  const codebases = await getCodebases();

  if (codebases.length === 0) {
    console.log('No codebases registered.');
    console.log('Use /clone or --branch to create worktrees.');
    return;
  }

  let totalEnvs = 0;

  for (const codebase of codebases) {
    const envs = await isolationDb.listByCodebaseWithAge(codebase.id);

    if (envs.length === 0) continue;

    console.log(`\n${codebase.repository_url ?? codebase.default_cwd}:`);

    for (const env of envs) {
      const age =
        env.days_since_activity !== null
          ? `${Math.floor(env.days_since_activity)}d ago`
          : 'unknown';
      const platform = env.created_by_platform ?? 'unknown';

      console.log(`  ${env.branch_name ?? env.workflow_id}`);
      console.log(`    Path: ${env.working_path}`);
      console.log(`    Type: ${env.workflow_type} | Platform: ${platform} | Last activity: ${age}`);
    }

    totalEnvs += envs.length;
  }

  if (totalEnvs === 0) {
    console.log('No active isolation environments.');
  } else {
    console.log(`\nTotal: ${String(totalEnvs)} environment(s)`);
  }
}

/**
 * Cleanup stale isolation environments
 */
export async function isolationCleanupCommand(daysStale = 7): Promise<void> {
  console.log(`Finding environments with no activity for ${String(daysStale)}+ days...`);

  const staleEnvs = await isolationDb.findStaleEnvironments(daysStale);

  if (staleEnvs.length === 0) {
    console.log('No stale environments found.');
    return;
  }

  console.log(`Found ${String(staleEnvs.length)} stale environment(s):`);

  const provider = getIsolationProvider();
  let cleaned = 0;
  let failed = 0;

  for (const env of staleEnvs) {
    console.log(`\nCleaning: ${env.branch_name ?? env.workflow_id}`);
    console.log(`  Path: ${env.working_path}`);

    try {
      await provider.destroy(env.working_path, {
        branchName: env.branch_name ? toBranchName(env.branch_name) : undefined,
        canonicalRepoPath: toRepoPath(env.codebase_default_cwd),
      });

      await isolationDb.updateStatus(env.id, 'destroyed');
      console.log('  Status: Cleaned');
      cleaned++;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, envId: env.id, path: env.working_path }, 'worktree_destroy_failed');
      console.error(`  Status: Failed - ${err.message}`);
      failed++;
    }
  }

  console.log(`\nCleanup complete: ${String(cleaned)} cleaned, ${String(failed)} failed`);
}

/**
 * Cleanup merged isolation environments (branches merged into main)
 * Also deletes remote branches for merged environments
 */
export async function isolationCleanupMergedCommand(): Promise<void> {
  console.log('Finding environments with branches merged into main...');

  const codebases = await getCodebases();

  if (codebases.length === 0) {
    console.log('No codebases with active environments found.');
    return;
  }

  let totalCleaned = 0;
  let totalSkipped = 0;

  for (const codebase of codebases) {
    try {
      console.log(`\nChecking ${codebase.repository_url ?? codebase.default_cwd}...`);

      const result = await cleanupMergedWorktrees(codebase.id, codebase.default_cwd);

      for (const branch of result.removed) {
        console.log(`  Cleaned: ${branch}`);
      }
      for (const skip of result.skipped) {
        console.log(`  Skipped: ${skip.branchName} (${skip.reason})`);
      }

      totalCleaned += result.removed.length;
      totalSkipped += result.skipped.length;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, codebaseId: codebase.id }, 'merged_cleanup_failed');
      console.error(`  Error processing codebase: ${err.message}`);
    }
  }

  console.log(
    `\nMerged cleanup complete: ${String(totalCleaned)} cleaned, ${String(totalSkipped)} skipped`
  );
}

/**
 * Complete branch lifecycle — remove worktree, local branch, remote branch, mark DB as destroyed
 */
export async function isolationCompleteCommand(
  branchNames: string[],
  options: { force?: boolean; deleteRemote?: boolean }
): Promise<void> {
  let completed = 0;
  let failed = 0;
  let notFound = 0;

  for (const branch of branchNames) {
    let env: Awaited<ReturnType<typeof isolationDb.findActiveByBranchName>>;
    try {
      env = await isolationDb.findActiveByBranchName(branch);
    } catch (error) {
      const err = error as Error;
      getLog().error({ err, branch }, 'isolation.lookup_failed');
      console.error(`  Failed: ${branch} — DB lookup error: ${err.message}`);
      failed++;
      continue;
    }

    if (!env) {
      console.log(`  Not found: ${branch} (no active isolation environment)`);
      notFound++;
      continue;
    }

    // Explicitly check for uncommitted changes before calling removeEnvironment,
    // which silently returns (no throw, no DB update) when the path has changes
    // and force is not set. This surfaces the issue to the user as a blocked failure.
    if (!options.force) {
      const hasChanges = await hasUncommittedChanges(toWorktreePath(env.working_path));
      if (hasChanges) {
        console.error(`  Blocked: ${branch} has uncommitted changes. Use --force to override.`);
        failed++;
        continue;
      }
    }

    try {
      await removeEnvironment(env.id, {
        force: options.force,
        deleteRemoteBranch: options.deleteRemote ?? true,
      });
      console.log(`  Completed: ${branch}`);
      completed++;
    } catch (error) {
      const err = error as Error;
      getLog().warn({ err, branch, envId: env.id }, 'isolation.complete_failed');
      console.error(`  Failed: ${branch} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nComplete: ${completed} completed, ${failed} failed, ${notFound} not found`);
}

/**
 * Helper to get all codebases with active environments
 * Extracts unique codebases from isolation environment JOIN results
 */
async function getCodebases(): Promise<CodebaseInfo[]> {
  const allEnvs = await isolationDb.listAllActiveWithCodebase();
  const codebaseMap = new Map<string, CodebaseInfo>();

  for (const env of allEnvs) {
    if (!codebaseMap.has(env.codebase_id)) {
      codebaseMap.set(env.codebase_id, {
        id: env.codebase_id,
        repository_url: env.codebase_repository_url,
        default_cwd: env.codebase_default_cwd,
      });
    }
  }

  return Array.from(codebaseMap.values());
}
