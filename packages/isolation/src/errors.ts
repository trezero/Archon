import type { IsolationBlockReason, WorktreeStatusBreakdown } from './types';

/**
 * Error thrown when isolation is required but cannot be provided.
 * This error signals that ALL message handling should stop - not just workflows.
 * The user has already been notified of the specific reason (worktree limit reached,
 * isolation creation failure, etc.) before this error is thrown.
 */
export class IsolationBlockedError extends Error {
  readonly reason: IsolationBlockReason;

  constructor(message: string, reason: IsolationBlockReason) {
    super(message);
    this.name = 'IsolationBlockedError';
    this.reason = reason;
  }
}

/**
 * Classify isolation creation errors into user-friendly messages.
 */
export function classifyIsolationError(err: Error): string {
  const stderr = (err as Error & { stderr?: string }).stderr ?? '';
  const errorLower = `${err.message} ${stderr}`.toLowerCase();

  const errorPatterns: { pattern: string; message: string }[] = [
    {
      pattern: 'permission denied',
      message:
        '**Error:** Permission denied while creating workspace. Check file system permissions.',
    },
    {
      pattern: 'eacces',
      message:
        '**Error:** Permission denied while creating workspace. Check file system permissions.',
    },
    {
      pattern: 'timeout',
      message:
        '**Error:** Timed out creating workspace. Git repository may be slow or unavailable.',
    },
    {
      pattern: 'no space left',
      message: '**Error:** No disk space available for new workspace.',
    },
    {
      pattern: 'enospc',
      message: '**Error:** No disk space available for new workspace.',
    },
    {
      pattern: 'not a git repository',
      message: '**Error:** Target path is not a valid git repository.',
    },
    {
      pattern: 'cannot extract owner/repo',
      message:
        '**Error:** Repository path is too short to extract owner and repo name. ' +
        'Re-register the codebase with a full path (e.g. `/home/user/owner/repo`).',
    },
    {
      pattern: 'branch not found',
      message:
        '**Error:** Branch not found. The requested branch may have been deleted or not yet pushed.',
    },
  ];

  for (const { pattern, message } of errorPatterns) {
    if (errorLower.includes(pattern)) {
      return message;
    }
  }

  return `**Error:** Could not create isolated workspace (${err.message}).`;
}

/**
 * Returns true if the error is a known infrastructure failure that should
 * produce a user-facing "blocked" message rather than a crash.
 *
 * Unknown errors (programming bugs, unexpected failures) should propagate
 * so they are visible as crashes rather than silent workspace failures.
 */
export function isKnownIsolationError(err: Error): boolean {
  const stderr = (err as Error & { stderr?: string }).stderr ?? '';
  const errorLower = `${err.message} ${stderr}`.toLowerCase();

  const knownPatterns = [
    'permission denied',
    'eacces',
    'timeout',
    'no space left',
    'enospc',
    'not a git repository',
    'branch not found',
  ];

  return knownPatterns.some(pattern => errorLower.includes(pattern));
}

/**
 * Format the worktree limit reached message with actionable options.
 */
export function formatWorktreeLimitMessage(
  codebaseName: string,
  breakdown: WorktreeStatusBreakdown,
  staleThresholdDays: number
): string {
  let msg = `Worktree limit reached (${String(breakdown.total)}/${String(breakdown.limit)}) for **${codebaseName}**.\n\n`;

  msg += '**Status:**\n';
  msg += `• ${String(breakdown.merged)} merged (can auto-remove)\n`;
  msg += `• ${String(breakdown.stale)} stale (no activity in ${String(staleThresholdDays)}+ days)\n`;
  msg += `• ${String(breakdown.active)} active\n\n`;

  msg += '**Options:**\n';
  if (breakdown.stale > 0) {
    msg += '• `/worktree cleanup stale` - Remove stale worktrees\n';
  }
  msg += '• `/worktree list` - See all worktrees\n';
  msg += '• `/worktree remove` - Remove current worktree';

  return msg;
}
