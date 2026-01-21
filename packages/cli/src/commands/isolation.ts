/**
 * Isolation commands - list and cleanup worktrees
 */
import * as isolationDb from '@archon/core/db/isolation-environments';
import { getIsolationProvider } from '@archon/core';

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
        branchName: env.branch_name ?? undefined,
        canonicalRepoPath: env.codebase_default_cwd,
      });

      await isolationDb.updateStatus(env.id, 'destroyed');
      console.log('  Status: Cleaned');
      cleaned++;
    } catch (error) {
      const err = error as Error;
      console.error(`  Status: Failed - ${err.message}`);
      failed++;
    }
  }

  console.log(`\nCleanup complete: ${String(cleaned)} cleaned, ${String(failed)} failed`);
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
