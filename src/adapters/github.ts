/**
 * GitHub platform adapter using Octokit REST API and Webhooks
 * Handles issue and PR comments with @mention detection
 */
import { Octokit } from '@octokit/rest';
import { createHmac, timingSafeEqual } from 'crypto';
import { IPlatformAdapter, IsolationHints, ConversationNotFoundError } from '../types';
import { handleMessage } from '../orchestrator/orchestrator';
import { classifyAndFormatError } from '../utils/error-formatter';
import * as db from '../db/conversations';
import * as codebaseDb from '../db/codebases';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readdir, access } from 'fs/promises';
import { join } from 'path';
import { parseAllowedUsers, isGitHubUserAuthorized } from '../utils/github-auth';
import { getLinkedIssueNumbers } from '../utils/github-graphql';
import { onConversationClosed } from '../services/cleanup-service';
import { isWorktreePath } from '../utils/git';
import { getArchonWorkspacesPath, getCommandFolderSearchPaths } from '../utils/archon-paths';
import { copyDefaultsToRepo } from '../utils/defaults-copy';
import { ConversationLockManager } from '../utils/conversation-lock';

const execAsync = promisify(exec);

const MAX_LENGTH = 65000; // GitHub comment limit (~65,536, leave buffer for safety)

interface WebhookEvent {
  action: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    labels: { name: string }[];
    state: string;
    pull_request?: { url: string }; // Present if the issue is actually a PR
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    state: string;
    changed_files?: number;
    additions?: number;
    deletions?: number;
  };
  comment?: {
    body: string;
    user: { login: string };
  };
  repository: {
    owner: { login: string };
    name: string;
    full_name: string;
    html_url: string;
    default_branch: string;
  };
  sender: { login: string };
}

export class GitHubAdapter implements IPlatformAdapter {
  private octokit: Octokit;
  private webhookSecret: string;
  private allowedUsers: string[];
  private botMention: string;
  private lockManager: ConversationLockManager;

  constructor(
    token: string,
    webhookSecret: string,
    lockManager: ConversationLockManager,
    botMention?: string
  ) {
    this.octokit = new Octokit({ auth: token });
    this.webhookSecret = webhookSecret;
    this.lockManager = lockManager;
    this.botMention = botMention ?? 'Archon';

    // Parse GitHub user whitelist (optional - empty = open access)
    this.allowedUsers = parseAllowedUsers(process.env.GITHUB_ALLOWED_USERS);
    if (this.allowedUsers.length > 0) {
      console.log(`[GitHub] User whitelist enabled (${this.allowedUsers.length} users)`);
    } else {
      console.log('[GitHub] User whitelist disabled (open access)');
    }

    console.log('[GitHub] Adapter initialized with secret:', webhookSecret.substring(0, 8) + '...');
    console.log('[GitHub] Bot mention configured as:', this.botMention);
  }

  /**
   * Check if an error is retryable (transient network issues)
   */
  private isRetryableError(error: unknown): boolean {
    const err = error as Error | undefined;
    const message = err?.message ?? '';
    const causeErr = (error as { cause?: Error }).cause;
    const cause = causeErr?.message ?? '';
    const combined = `${message} ${cause}`.toLowerCase();

    // Retry on transient network errors
    return (
      combined.includes('timeout') ||
      combined.includes('econnrefused') ||
      combined.includes('econnreset') ||
      combined.includes('etimedout') ||
      combined.includes('fetch failed')
    );
  }

  /**
   * Send a message to a GitHub issue or PR.
   * Splits long messages into paragraph-based chunks.
   * Throws on failure so caller can handle appropriately.
   */
  async sendMessage(conversationId: string, message: string): Promise<void> {
    const parsed = this.parseConversationId(conversationId);
    if (!parsed) {
      console.error('[GitHub] Invalid conversationId:', conversationId);
      return;
    }

    console.log(`[GitHub] sendMessage called, length=${String(message.length)}`);

    // Check if message needs splitting
    if (message.length <= MAX_LENGTH) {
      await this.postComment(parsed, message);
    } else {
      console.log(`[GitHub] Message too long (${String(message.length)}), splitting by paragraphs`);
      const chunks = this.splitIntoParagraphChunks(message, MAX_LENGTH - 500);

      // Fail-fast: if any chunk fails, stop and propagate error with context
      for (let i = 0; i < chunks.length; i++) {
        try {
          await this.postComment(parsed, chunks[i]);
        } catch (error) {
          const err = error as Error;
          console.error(
            `[GitHub] Failed to post chunk ${String(i + 1)}/${String(chunks.length)}:`,
            err.message
          );
          // Wrap error with context about partial delivery
          const partialError = new Error(
            `Failed to post comment chunk ${String(i + 1)}/${String(chunks.length)}. ` +
              `${String(i)} chunk(s) were posted before failure.`
          );
          partialError.cause = error;
          throw partialError;
        }
      }
    }
  }

  /**
   * Post a single comment to a GitHub issue or PR.
   * Includes retry logic with exponential backoff (3 attempts max).
   * Throws on failure after exhausting retries so caller can handle appropriately.
   */
  private async postComment(
    parsed: { owner: string; repo: string; number: number },
    message: string
  ): Promise<void> {
    const maxRetries = 3;
    const conversationId = `${parsed.owner}/${parsed.repo}#${String(parsed.number)}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.octokit.rest.issues.createComment({
          owner: parsed.owner,
          repo: parsed.repo,
          issue_number: parsed.number,
          body: message,
        });
        console.log(`[GitHub] Comment posted to ${conversationId}`);
        return;
      } catch (error) {
        const isRetryable = this.isRetryableError(error);
        if (attempt < maxRetries && isRetryable) {
          const delay = 1000 * attempt;
          console.log(
            `[GitHub] Retry ${String(attempt)}/${String(maxRetries)} for ${conversationId} (waiting ${String(delay)}ms)`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        // Log with full context for debugging
        console.error('[GitHub] Failed to post comment after retries:', {
          error,
          conversationId,
          attempt,
          maxRetries,
          wasRetryable: isRetryable,
          messageLength: message.length,
        });
        // Re-throw so caller can handle (e.g., notify user, stop chunk loop)
        throw error;
      }
    }
  }

  /**
   * Split message into paragraph-based chunks that fit within maxLength.
   * Preserves paragraph boundaries to maintain context and readability.
   */
  private splitIntoParagraphChunks(message: string, maxLength: number): string[] {
    const paragraphs = message.split(/\n\n+/);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const para of paragraphs) {
      const newLength = currentChunk.length + para.length + 2; // +2 for \n\n separator

      if (newLength > maxLength && currentChunk) {
        // Current chunk is full, start new chunk
        chunks.push(currentChunk);
        currentChunk = para;
      } else {
        // Add paragraph to current chunk
        currentChunk += (currentChunk ? '\n\n' : '') + para;
      }
    }

    // Add remaining chunk
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    console.log(`[GitHub] Split into ${String(chunks.length)} paragraph chunks`);
    return chunks;
  }

  /**
   * Get streaming mode (always batch for GitHub to avoid comment spam)
   */
  getStreamingMode(): 'batch' {
    return 'batch';
  }

  /**
   * Get platform type
   */
  getPlatformType(): string {
    return 'github';
  }

  /**
   * Start the adapter (no-op for webhook-based adapter)
   */
  async start(): Promise<void> {
    console.log('[GitHub] Webhook adapter ready');
  }

  /**
   * Stop the adapter (no-op for webhook-based adapter)
   */
  stop(): void {
    console.log('[GitHub] Adapter stopped');
  }

  /**
   * Ensure responses go to a thread.
   * GitHub issues/PRs are inherently threaded - all comments go to the issue.
   * Returns original conversation ID unchanged.
   */
  async ensureThread(originalConversationId: string, _messageContext?: unknown): Promise<string> {
    return originalConversationId;
  }

  /**
   * Verify webhook signature using HMAC SHA-256
   */
  private verifySignature(payload: string, signature: string): boolean {
    try {
      const hmac = createHmac('sha256', this.webhookSecret);
      const digest = 'sha256=' + hmac.update(payload).digest('hex');

      const digestBuffer = Buffer.from(digest);
      const signatureBuffer = Buffer.from(signature);

      if (digestBuffer.length !== signatureBuffer.length) {
        console.error('[GitHub] Signature length mismatch:', {
          receivedLength: signatureBuffer.length,
          computedLength: digestBuffer.length,
        });
        return false;
      }

      const isValid = timingSafeEqual(digestBuffer, signatureBuffer);

      if (!isValid) {
        console.error('[GitHub] Signature mismatch:', {
          received: signature.substring(0, 15) + '...',
          computed: digest.substring(0, 15) + '...',
          secretLength: this.webhookSecret.length,
        });
      }

      return isValid;
    } catch (error) {
      console.error('[GitHub] Signature verification error:', error);
      return false;
    }
  }

  /**
   * Parse webhook event and extract relevant data
   *
   * Handles:
   * - issues.closed / pull_request.closed → cleanup (isCloseEvent: true)
   * - issue_comment.created → bot @mention detection
   *
   * Does NOT handle:
   * - issues.opened / pull_request.opened → returns null (see #96)
   */
  private parseEvent(event: WebhookEvent): {
    owner: string;
    repo: string;
    number: number;
    comment: string;
    eventType: 'issue' | 'issue_comment' | 'pull_request';
    issue?: WebhookEvent['issue'];
    pullRequest?: WebhookEvent['pull_request'];
    isCloseEvent?: boolean;
  } | null {
    const owner = event.repository.owner.login;
    const repo = event.repository.name;

    // Detect issue closed
    if (event.issue && event.action === 'closed') {
      return {
        owner,
        repo,
        number: event.issue.number,
        comment: '',
        eventType: 'issue',
        issue: event.issue,
        isCloseEvent: true,
      };
    }

    // Detect PR merged/closed
    if (event.pull_request && event.action === 'closed') {
      return {
        owner,
        repo,
        number: event.pull_request.number,
        comment: '',
        eventType: 'pull_request',
        pullRequest: event.pull_request,
        isCloseEvent: true,
      };
    }

    // issue_comment (covers both issues and PRs)
    if (event.comment) {
      const number = event.issue?.number ?? event.pull_request?.number;
      if (!number) return null;
      return {
        owner,
        repo,
        number,
        comment: event.comment.body,
        eventType: 'issue_comment',
        issue: event.issue,
        pullRequest: event.pull_request,
      };
    }

    // Note: We intentionally do NOT handle issues.opened or pull_request.opened
    // events here. Issue/PR descriptions often contain example commands or
    // documentation about how to use the bot - these are NOT command invocations.
    // Only actual comments (issue_comment events) trigger bot responses.
    // See issue #96 for details.

    return null;
  }

  /**
   * Check if text contains @mention for the configured bot
   */
  private hasMention(text: string): boolean {
    const pattern = new RegExp(`@${this.botMention}[\\s,:;]`, 'i');
    return pattern.test(text) || text.trim().toLowerCase() === `@${this.botMention.toLowerCase()}`;
  }

  /**
   * Strip @mention from text for the configured bot
   */
  private stripMention(text: string): string {
    const pattern = new RegExp(`@${this.botMention}[\\s,:;]+`, 'gi');
    return text.replace(pattern, '').trim();
  }

  /**
   * Fetch comment history from issue or PR
   * Returns comments in chronological order (oldest first)
   */
  private async fetchCommentHistory(owner: string, repo: string, number: number): Promise<string[]> {
    try {
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: number,
        per_page: 20, // Last 20 comments for context
        sort: 'created',
        direction: 'desc',
      });

      // Reverse to get chronological order (oldest first)
      return [...comments].reverse().map(comment => {
        const author = comment.user?.login ?? 'unknown';
        const body = comment.body ?? '';
        return `${author}: ${body}`;
      });
    } catch (error) {
      console.error('[GitHub] Failed to fetch comment history:', error);
      return [];
    }
  }

  /**
   * Build conversationId from owner, repo, and number
   */
  private buildConversationId(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${String(number)}`;
  }

  /**
   * Parse conversationId into owner, repo, and number
   */
  private parseConversationId(
    conversationId: string
  ): { owner: string; repo: string; number: number } | null {
    const regex = /^([^/]+)\/([^#]+)#(\d+)$/;
    const match = regex.exec(conversationId);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  /**
   * Ensure repository is cloned and ready
   * For new codebases: clone (directory won't exist)
   * For existing codebases: sync if shouldSync=true, skip if shouldSync=false
   * @param shouldSync - Whether to sync if directory exists (pass true to ensure latest code)
   */
  private async ensureRepoReady(
    owner: string,
    repo: string,
    defaultBranch: string,
    repoPath: string,
    shouldSync: boolean
  ): Promise<void> {
    // Check if directory exists
    let directoryExists = false;
    try {
      await access(repoPath);
      directoryExists = true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        // Real error - permission denied, I/O failure, etc.
        console.error('[GitHub] Failed to access repository path:', {
          repoPath,
          errorCode: err.code,
          errorMessage: err.message,
        });
        throw new Error(
          `Cannot access repository at ${repoPath}: ${err.code ?? err.message}. ` +
            'Check permissions and disk health.'
        );
      }
      // ENOENT means directory doesn't exist - we'll clone below
    }

    if (directoryExists) {
      if (shouldSync) {
        console.log('[GitHub] Syncing repository');
        try {
          await execAsync(
            `cd ${repoPath} && git fetch origin && git reset --hard origin/${defaultBranch}`
          );
        } catch (syncError) {
          const err = syncError as Error;
          console.error('[GitHub] Repository sync failed:', {
            repoPath,
            defaultBranch,
            error: err.message,
          });
          throw new Error(
            `Failed to sync repository to ${defaultBranch}. ` +
              `Try /reset or check if the branch exists. Details: ${err.message}`
          );
        }
      }
      return;
    }

    // Directory doesn't exist - clone the repository
    console.log(`[GitHub] Cloning repository to ${repoPath}`);
    const ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    let cloneCommand = `git clone ${repoUrl} ${repoPath}`;

    if (ghToken) {
      const authenticatedUrl = `https://${ghToken}@github.com/${owner}/${repo}.git`;
      cloneCommand = `git clone ${authenticatedUrl} ${repoPath}`;
    }

    try {
      await execAsync(cloneCommand);
      await execAsync(`git config --global --add safe.directory '${repoPath}'`);
    } catch (cloneError) {
      const err = cloneError as Error;
      console.error('[GitHub] Repository clone failed:', {
        owner,
        repo,
        repoPath,
        error: err.message,
      });

      // Throw user-friendly error
      if (err.message.includes('not found') || err.message.includes('404')) {
        throw new Error(
          `Repository ${owner}/${repo} not found or is private. Check repository access.`
        );
      } else if (err.message.includes('Authentication failed')) {
        throw new Error(
          `Authentication failed for ${owner}/${repo}. Check GITHUB_TOKEN permissions.`
        );
      }
      throw new Error(`Failed to clone ${owner}/${repo}: ${err.message}`);
    }
  }

  /**
   * Auto-detect and load commands from .archon/commands/ (or configured folder)
   */
  private async autoDetectAndLoadCommands(repoPath: string, codebaseId: string): Promise<void> {
    const commandFolders = getCommandFolderSearchPaths();

    for (const folder of commandFolders) {
      try {
        const fullPath = join(repoPath, folder);
        await access(fullPath);

        const files = (await readdir(fullPath)).filter(f => f.endsWith('.md'));
        if (files.length === 0) continue;

        const commands = await codebaseDb.getCodebaseCommands(codebaseId);
        files.forEach(file => {
          commands[file.replace('.md', '')] = {
            path: join(folder, file),
            description: `From ${folder}`,
          };
        });

        await codebaseDb.updateCodebaseCommands(codebaseId, commands);
        console.log(`[GitHub] Loaded ${String(files.length)} commands from ${folder}`);
        return;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        // Folder not existing is expected - silently continue to next folder
        if (err.code === 'ENOENT') {
          continue;
        }
        // Log unexpected errors (database failures, permission issues) but don't fail setup
        console.error('[GitHub] Error loading commands from folder:', {
          folder,
          errorCode: err.code,
          errorMessage: err.message,
        });
        continue;
      }
    }
  }

  /**
   * Get or create codebase for repository
   * Returns: codebase record, path to use, and whether it's new
   * Always uses canonical path (not worktree paths) for codebase registration
   */
  private async getOrCreateCodebaseForRepo(
    owner: string,
    repo: string
  ): Promise<{
    codebase: { id: string; name: string; default_cwd: string };
    repoPath: string;
    isNew: boolean;
  }> {
    // Try both with and without .git suffix to match existing clones
    const repoUrlNoGit = `https://github.com/${owner}/${repo}`;
    const repoUrlWithGit = `${repoUrlNoGit}.git`;

    let existing = await codebaseDb.findCodebaseByRepoUrl(repoUrlNoGit);
    existing ??= await codebaseDb.findCodebaseByRepoUrl(repoUrlWithGit);

    // Canonical path includes owner to prevent collisions between repos with same name
    // e.g., alice/utils and bob/utils get separate directories
    const canonicalPath = join(getArchonWorkspacesPath(), owner, repo);

    if (existing) {
      // Check if existing codebase points to a worktree path - fix it if so
      // Either it's an actual worktree, or it looks like one (contains /worktrees/ in path)
      const looksLikeWorktreePath = existing.default_cwd.includes('/worktrees/');
      if (looksLikeWorktreePath || (await isWorktreePath(existing.default_cwd))) {
        console.log(`[GitHub] Fixing stale worktree path for codebase: ${existing.name}`);
        await codebaseDb.updateCodebase(existing.id, { default_cwd: canonicalPath });
        existing.default_cwd = canonicalPath;
      }

      console.log(`[GitHub] Using existing codebase: ${existing.name} at ${existing.default_cwd}`);
      return { codebase: existing, repoPath: existing.default_cwd, isNew: false };
    }

    // Include owner in name to distinguish repos with same name from different owners
    // resolve() converts relative paths to absolute (cross-platform)
    const codebase = await codebaseDb.createCodebase({
      name: `${owner}/${repo}`,
      repository_url: repoUrlNoGit, // Store without .git for consistency
      default_cwd: canonicalPath,
    });

    console.log(`[GitHub] Created new codebase: ${codebase.name} at ${canonicalPath}`);
    return { codebase, repoPath: canonicalPath, isNew: true };
  }

  /**
   * Clean up worktree when an issue/PR is closed
   * Delegates to cleanup service for unified handling
   */
  private async cleanupWorktree(owner: string, repo: string, number: number): Promise<void> {
    const conversationId = this.buildConversationId(owner, repo, number);
    console.log(`[GitHub] Cleaning up isolation for ${conversationId}`);

    try {
      await onConversationClosed('github', conversationId);
      console.log(`[GitHub] Cleanup complete for ${conversationId}`);
    } catch (error) {
      const err = error as Error;
      // Log full context for debugging - cleanup failures shouldn't break user flow
      console.error(`[GitHub] Cleanup failed for ${conversationId}:`, {
        error: err.message,
        stack: err.stack,
        conversationId,
      });
    }
  }

  /**
   * Build context-rich message for issue
   */
  private buildIssueContext(issue: WebhookEvent['issue'], userComment: string): string {
    if (!issue) return userComment;
    const labels = issue.labels.map(l => l.name).join(', ');

    return `[GitHub Issue Context]
Issue #${String(issue.number)}: "${issue.title}"
Author: ${issue.user.login}
Labels: ${labels}
Status: ${issue.state}

Description:
${issue.body ?? ''}

---

${userComment}`;
  }

  /**
   * Build context-rich message for pull request
   */
  private buildPRContext(pr: WebhookEvent['pull_request'], userComment: string): string {
    if (!pr) return userComment;
    const stats = pr.changed_files
      ? `Changed files: ${String(pr.changed_files)} (+${String(pr.additions ?? 0)}, -${String(pr.deletions ?? 0)})`
      : '';

    return `[GitHub Pull Request Context]
PR #${String(pr.number)}: "${pr.title}"
Author: ${pr.user.login}
Status: ${pr.state}
${stats}

Description:
${pr.body ?? ''}

Use 'gh pr diff ${String(pr.number)}' to see detailed changes.

---

${userComment}`;
  }

  /**
   * Handle incoming webhook event
   */
  async handleWebhook(payload: string, signature: string): Promise<void> {
    // 1. Verify signature
    if (!this.verifySignature(payload, signature)) {
      console.error('[GitHub] Invalid webhook signature');
      return;
    }

    // 2. Parse event
    const event = JSON.parse(payload) as WebhookEvent;

    // 2b. Authorization check - verify sender is in whitelist
    const senderUsername = event.sender?.login;
    if (!isGitHubUserAuthorized(senderUsername, this.allowedUsers)) {
      // Log unauthorized attempt (mask username for privacy)
      const maskedUser = senderUsername ? `${senderUsername.slice(0, 3)}***` : 'unknown';
      console.log(`[GitHub] Unauthorized webhook from user ${maskedUser}`);
      return; // Silent rejection - no error response
    }

    const parsed = this.parseEvent(event);
    if (!parsed) return;

    const { owner, repo, number, comment, eventType, issue, pullRequest, isCloseEvent } = parsed;

    // 3. Handle close/merge events (cleanup worktree)
    if (isCloseEvent) {
      console.log(`[GitHub] Handling close event for ${owner}/${repo}#${String(number)}`);
      await this.cleanupWorktree(owner, repo, number);
      return; // Don't process as a message
    }

    // 4. Ignore bot's own comments to prevent self-triggering
    const commentAuthor = event.comment?.user?.login;
    if (commentAuthor && commentAuthor.toLowerCase() === this.botMention.toLowerCase()) {
      console.log(`[GitHub] Ignoring own comment from @${commentAuthor}`);
      return;
    }

    // 5. Check @mention
    if (!this.hasMention(comment)) return;

    console.log(`[GitHub] Processing ${eventType}: ${owner}/${repo}#${String(number)}`);

    // 4. Build conversationId
    const conversationId = this.buildConversationId(owner, repo, number);

    // 5. Check if new conversation
    const existingConv = await db.getOrCreateConversation('github', conversationId);
    const isNewConversation = !existingConv.codebase_id;

    // 6. Get/create codebase (checks for existing first!)
    const {
      codebase,
      repoPath,
      isNew: isNewCodebase,
    } = await this.getOrCreateCodebaseForRepo(owner, repo);

    // 6b. Link conversation to codebase (fixes #97)
    if (isNewConversation) {
      try {
        await db.updateConversation(existingConv.id, {
          codebase_id: codebase.id,
          cwd: repoPath,
        });
      } catch (updateError) {
        if (updateError instanceof ConversationNotFoundError) {
          console.error('[GitHub] Failed to link conversation to codebase - conversation not found', {
            conversationId: existingConv.id,
            codebaseId: codebase.id,
          });
          // Re-throw as this is a critical setup step
          throw new Error('Failed to set up GitHub conversation - please try again');
        }
        throw updateError;
      }
    }

    // 7. Get default branch
    const { data: repoData } = await this.octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    // 8. Ensure repo ready (clone if needed, sync if new conversation)
    await this.ensureRepoReady(owner, repo, defaultBranch, repoPath, isNewCodebase);

    // 9. Copy defaults and auto-load commands if new codebase
    if (isNewCodebase) {
      // Copy default commands/workflows if target doesn't have them (non-fatal)
      try {
        const copyResult = await copyDefaultsToRepo(repoPath);
        if (copyResult.commandsCopied > 0 || copyResult.workflowsCopied > 0) {
          console.log('[GitHub] Copied defaults', copyResult);
        }
        if (copyResult.commandsFailed > 0 || copyResult.workflowsFailed > 0) {
          console.warn('[GitHub] Some defaults failed to copy', {
            commandsFailed: copyResult.commandsFailed,
            workflowsFailed: copyResult.workflowsFailed,
          });
        }
      } catch (copyError) {
        const err = copyError as Error;
        console.error('[GitHub] Failed to copy defaults (continuing with setup):', {
          repoPath,
          error: err.message,
        });
      }

      await this.autoDetectAndLoadCommands(repoPath, codebase.id);
    }

    // 10. Gather isolation hints for orchestrator
    // The orchestrator now handles all isolation decisions
    const isPR = eventType === 'pull_request' || !!pullRequest || !!issue?.pull_request;

    // Build isolation hints for orchestrator
    const isolationHints: IsolationHints = {
      workflowType: isPR ? 'pr' : 'issue',
      workflowId: String(number),
    };

    // For PRs: get linked issues and branch info
    if (isPR) {
      // Get linked issues for worktree sharing
      const linkedIssues = await getLinkedIssueNumbers(owner, repo, number);
      if (linkedIssues.length > 0) {
        isolationHints.linkedIssues = linkedIssues;
        console.log(`[GitHub] PR #${String(number)} linked to issues: ${linkedIssues.join(', ')}`);
      }

      // Fetch PR head branch, SHA, and fork status for isolation
      try {
        const { data: prData } = await this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: number,
        });
        isolationHints.prBranch = prData.head.ref;
        isolationHints.prSha = prData.head.sha;

        // Detect if PR is from a fork (different repo than base)
        // For fork PRs: head.repo is different from base.repo
        // For same-repo PRs: head.repo.full_name === base.repo.full_name
        // Note: head.repo can be null if the fork was deleted after PR creation
        // In that case, we treat it as a fork (can't push to deleted repo anyway)
        const headRepoFullName = prData.head.repo?.full_name;
        const baseRepoFullName = prData.base.repo.full_name;
        isolationHints.isForkPR = headRepoFullName !== baseRepoFullName;

        const forkInfo = isolationHints.isForkPR ? ' (fork)' : '';
        console.log(
          `[GitHub] PR #${String(number)} head: ${prData.head.ref}@${prData.head.sha.substring(0, 7)}${forkInfo}`
        );
      } catch (error) {
        const err = error as Error;
        // Log at appropriate level based on error type
        const isNonTransient =
          err.message.includes('rate limit') ||
          err.message.includes('403') ||
          err.message.includes('401') ||
          err.message.includes('Bad credentials');

        const logFn = isNonTransient ? console.error : console.warn;
        logFn('[GitHub] Failed to fetch PR head info:', {
          owner,
          repo,
          prNumber: number,
          error: err.message,
        });

        // Mark degraded mode - worktree isolation will use fallback naming
        isolationHints.prFetchFailed = true;
      }
    }

    // 11. Build message with context
    const strippedComment = this.stripMention(comment);
    let finalMessage = strippedComment;
    let contextToAppend: string | undefined;

    // IMPORTANT: Slash commands must be processed deterministically (not by AI)
    const isSlashCommand = strippedComment.trim().startsWith('/');

    if (isSlashCommand) {
      // For slash commands, use only the first line
      finalMessage = strippedComment.split('\n')[0].trim();
      console.log(`[GitHub] Processing slash command: ${finalMessage}`);

      // Add issue/PR reference context
      if (eventType === 'issue' && issue) {
        contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
      } else if (eventType === 'pull_request' && pullRequest) {
        contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
      } else if (eventType === 'issue_comment') {
        if (pullRequest) {
          contextToAppend = `GitHub Pull Request #${String(pullRequest.number)}: "${pullRequest.title}"\nUse 'gh pr view ${String(pullRequest.number)}' for full details if needed.`;
        } else if (issue) {
          contextToAppend = `GitHub Issue #${String(issue.number)}: "${issue.title}"\nUse 'gh issue view ${String(issue.number)}' for full details if needed.`;
        }
      }
    } else {
      // For non-command messages, add rich context
      if (eventType === 'issue' && issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
      } else if (eventType === 'issue_comment' && issue) {
        finalMessage = this.buildIssueContext(issue, strippedComment);
      } else if (eventType === 'pull_request' && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
      } else if (eventType === 'issue_comment' && pullRequest) {
        finalMessage = this.buildPRContext(pullRequest, strippedComment);
      }
    }

    // 12. Fetch comment history for thread context
    const commentHistory = await this.fetchCommentHistory(owner, repo, number);
    const threadContext = commentHistory.length > 0 ? commentHistory.join('\n') : undefined;
    console.log(
      `[GitHub] Thread context: ${threadContext ? `${String(commentHistory.length)} comments` : 'none'}`
    );

    // 13. Route to orchestrator with isolation hints (with lock for concurrency control)
    await this.lockManager.acquireLock(conversationId, async () => {
      try {
        await handleMessage(
          this,
          conversationId,
          finalMessage,
          contextToAppend,
          threadContext, // Pass comment history as thread context
          undefined, // parentConversationId
          isolationHints
        );
      } catch (error) {
        const err = error as Error;
        console.error('[GitHub] Message handling error:', error);
        try {
          const userMessage = classifyAndFormatError(err);
          await this.sendMessage(conversationId, userMessage);
        } catch (sendError) {
          console.error('[GitHub] Failed to send error message to user:', sendError);
        }
      }
    });
  }
}
