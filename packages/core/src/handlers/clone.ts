/**
 * Standalone repository clone/register logic.
 * Extracted from command-handler.ts for reuse by REST endpoints.
 */
import { access } from 'fs/promises';
import { join, basename } from 'path';
import * as codebaseDb from '../db/codebases';
import { sanitizeError } from '../utils/credential-sanitizer';
import { execFileAsync } from '../utils/git';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '../utils/archon-paths';
import { findMarkdownFilesRecursive } from '../utils/commands';

export interface RegisterResult {
  codebaseId: string;
  name: string;
  repositoryUrl: string | null;
  defaultCwd: string;
  commandCount: number;
  alreadyExisted: boolean;
}

/**
 * Shared logic: register a repo at a given path in the DB and load commands.
 */
async function registerRepoAtPath(
  targetPath: string,
  name: string,
  repositoryUrl: string | null
): Promise<RegisterResult> {
  // Auto-detect assistant type based on folder structure
  let suggestedAssistant = 'claude';
  const codexFolder = join(targetPath, '.codex');
  const claudeFolder = join(targetPath, '.claude');

  try {
    await access(codexFolder);
    suggestedAssistant = 'codex';
    console.log('[Clone] Detected .codex folder - using Codex assistant');
  } catch {
    try {
      await access(claudeFolder);
      suggestedAssistant = 'claude';
      console.log('[Clone] Detected .claude folder - using Claude assistant');
    } catch {
      console.log('[Clone] No assistant folder detected - defaulting to Claude');
    }
  }

  const codebase = await codebaseDb.createCodebase({
    name,
    repository_url: repositoryUrl ?? undefined,
    default_cwd: targetPath,
    ai_assistant_type: suggestedAssistant,
  });

  // Auto-load commands if found
  let commandsLoaded = 0;
  for (const folder of getCommandFolderSearchPaths()) {
    const commandPath = join(targetPath, folder);
    try {
      await access(commandPath);
    } catch {
      continue; // Folder doesn't exist, try next
    }
    // Command loading errors should NOT be swallowed
    const markdownFiles = await findMarkdownFilesRecursive(commandPath);
    if (markdownFiles.length > 0) {
      const commands = await codebaseDb.getCodebaseCommands(codebase.id);
      markdownFiles.forEach(({ commandName, relativePath }) => {
        commands[commandName] = {
          path: join(folder, relativePath),
          description: `From ${folder}`,
        };
      });
      await codebaseDb.updateCodebaseCommands(codebase.id, commands);
      commandsLoaded = markdownFiles.length;
      break;
    }
  }

  return {
    codebaseId: codebase.id,
    name: codebase.name,
    repositoryUrl: repositoryUrl,
    defaultCwd: targetPath,
    commandCount: commandsLoaded,
    alreadyExisted: false,
  };
}

/**
 * Normalize a repo URL: strip trailing slashes and convert SSH to HTTPS.
 */
function normalizeRepoUrl(rawUrl: string): {
  workingUrl: string;
  ownerName: string;
  repoName: string;
  targetPath: string;
} {
  const normalizedUrl = rawUrl.replace(/\/+$/, '');

  let workingUrl = normalizedUrl;
  if (normalizedUrl.startsWith('git@github.com:')) {
    workingUrl = normalizedUrl.replace('git@github.com:', 'https://github.com/');
  }

  const urlParts = workingUrl.replace(/\.git$/, '').split('/');
  const repoName = urlParts.pop() ?? 'unknown';
  const ownerName = urlParts.pop() ?? 'unknown';

  const workspacePath = getArchonWorkspacesPath();
  const targetPath = join(workspacePath, ownerName, repoName);

  return { workingUrl, ownerName, repoName, targetPath };
}

/**
 * Clone a repository from a URL and register it in the database.
 */
export async function cloneRepository(repoUrl: string): Promise<RegisterResult> {
  const { workingUrl, ownerName, repoName, targetPath } = normalizeRepoUrl(repoUrl);

  // Check if target directory already exists
  let directoryExists = false;
  try {
    await access(targetPath);
    directoryExists = true;
  } catch {
    // Directory doesn't exist, proceed with clone
  }

  if (directoryExists) {
    // Directory exists - try to find existing codebase by repo URL
    const urlNoGit = workingUrl.replace(/\.git$/, '');
    const urlWithGit = urlNoGit + '.git';

    const existingCodebase =
      (await codebaseDb.findCodebaseByRepoUrl(urlNoGit)) ??
      (await codebaseDb.findCodebaseByRepoUrl(urlWithGit));

    if (existingCodebase) {
      return {
        codebaseId: existingCodebase.id,
        name: existingCodebase.name,
        repositoryUrl: existingCodebase.repository_url,
        defaultCwd: existingCodebase.default_cwd,
        commandCount: 0,
        alreadyExisted: true,
      };
    }

    // Directory exists but no codebase found
    throw new Error(
      `Directory already exists: ${targetPath}\n\nNo matching codebase found in database. Remove the directory and re-clone.`
    );
  }

  console.log(`[Clone] Cloning ${workingUrl} to ${targetPath}`);

  // Build clone command with authentication if GitHub token is available
  let cloneUrl = workingUrl;
  const ghToken = process.env.GH_TOKEN;

  if (ghToken && workingUrl.includes('github.com')) {
    if (workingUrl.startsWith('https://github.com')) {
      cloneUrl = workingUrl.replace('https://github.com', `https://${ghToken}@github.com`);
    } else if (workingUrl.startsWith('http://github.com')) {
      cloneUrl = workingUrl.replace('http://github.com', `https://${ghToken}@github.com`);
    } else if (!workingUrl.startsWith('http')) {
      cloneUrl = `https://${ghToken}@${workingUrl}`;
    }
    console.log('[Clone] Using authenticated GitHub clone');
  }

  try {
    await execFileAsync('git', ['clone', cloneUrl, targetPath]);
  } catch (error) {
    const safeErr = sanitizeError(error as Error);
    throw new Error(`Failed to clone repository: ${safeErr.message}`);
  }

  // Add to git safe.directory
  await execFileAsync('git', ['config', '--global', '--add', 'safe.directory', targetPath]);
  console.log(`[Clone] Added ${targetPath} to git safe.directory`);

  return registerRepoAtPath(targetPath, `${ownerName}/${repoName}`, workingUrl);
}

/**
 * Register an existing local repository in the database (no git clone).
 */
export async function registerRepository(localPath: string): Promise<RegisterResult> {
  // Validate path exists and is a git repo
  try {
    await execFileAsync('git', ['-C', localPath, 'rev-parse', '--git-dir']);
  } catch (error) {
    throw new Error(`Path is not a git repository: ${localPath} (${(error as Error).message})`);
  }

  // Check if already registered by path
  const existing = await codebaseDb.findCodebaseByDefaultCwd(localPath);
  if (existing) {
    return {
      codebaseId: existing.id,
      name: existing.name,
      repositoryUrl: existing.repository_url,
      defaultCwd: existing.default_cwd,
      commandCount: 0,
      alreadyExisted: true,
    };
  }

  // Get remote URL (optional — local-only repos may not have one)
  let remoteUrl: string | null = null;
  try {
    const { stdout } = await execFileAsync('git', ['-C', localPath, 'remote', 'get-url', 'origin']);
    remoteUrl = stdout.trim() || null;
  } catch (error) {
    const msg = (error as Error).message ?? '';
    if (!msg.includes('No such remote')) {
      console.warn('[Clone] Unexpected error fetching remote URL', {
        path: localPath,
        error: msg,
      });
    }
  }

  // Extract repo name from directory name
  const repoName = basename(localPath);

  // Try to build owner/repo name from remote URL
  let name = repoName;
  if (remoteUrl) {
    const cleaned = remoteUrl.replace(/\.git$/, '').replace(/\/+$/, '');
    let workingRemote = cleaned;
    if (cleaned.startsWith('git@github.com:')) {
      workingRemote = cleaned.replace('git@github.com:', 'https://github.com/');
    }
    const parts = workingRemote.split('/');
    const r = parts.pop();
    const o = parts.pop();
    if (o && r) {
      name = `${o}/${r}`;
    }
  }

  return registerRepoAtPath(localPath, name, remoteUrl);
}
