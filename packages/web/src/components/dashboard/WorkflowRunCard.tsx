import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  Globe,
  Terminal,
  Hash,
  Send,
  GitBranch,
  ExternalLink,
  MessageSquare,
  FileText,
  XCircle,
} from 'lucide-react';
import type { DashboardRunResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format';

interface WorkflowRunCardProps {
  run: DashboardRunResponse;
  onCancel: (runId: string) => void;
}

const PLATFORM_ICONS: Record<string, React.ReactElement> = {
  web: <Globe className="h-3.5 w-3.5" />,
  cli: <Terminal className="h-3.5 w-3.5" />,
  slack: <Hash className="h-3.5 w-3.5" />,
  telegram: <Send className="h-3.5 w-3.5" />,
  github: <GitBranch className="h-3.5 w-3.5" />,
};

export function WorkflowRunCard({ run, onCancel }: WorkflowRunCardProps): React.ReactElement {
  const navigate = useNavigate();
  const [elapsed, setElapsed] = useState(() => formatDuration(run.started_at, run.completed_at));

  useEffect(() => {
    if (run.status !== 'running') return;
    const interval = setInterval(() => {
      setElapsed(formatDuration(run.started_at, null));
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [run.status, run.started_at]);

  const chatId = run.parent_platform_id ?? run.worker_platform_id;
  const truncatedMessage = run.user_message
    ? run.user_message.length > 80
      ? run.user_message.slice(0, 80) + '...'
      : run.user_message
    : null;

  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      {/* Header: status dot + name + badge + elapsed */}
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-2.5 w-2.5 shrink-0 rounded-full',
            run.status === 'running' && 'bg-primary animate-pulse',
            run.status === 'pending' && 'bg-text-tertiary'
          )}
        />
        <span className="font-medium text-sm text-text-primary truncate flex-1">
          {run.workflow_name}
        </span>
        <span
          className={cn(
            'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
            run.status === 'running' && 'bg-primary/10 text-primary',
            run.status === 'pending' && 'bg-surface-elevated text-text-secondary'
          )}
        >
          {run.status}
        </span>
        <span className="text-xs text-text-tertiary shrink-0">{elapsed}</span>
      </div>

      {/* Metadata row */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-secondary">
        <span className="flex items-center gap-1">
          {PLATFORM_ICONS[run.platform_type ?? ''] ?? <Globe className="h-3.5 w-3.5" />}
          {run.platform_type ?? 'unknown'}
        </span>
        <span>{run.codebase_name ?? 'Unknown project'}</span>
        {run.current_step_index > 0 && <span>Step {String(run.current_step_index)}</span>}
      </div>

      {/* User message */}
      {truncatedMessage && (
        <p className="text-xs text-text-tertiary italic truncate">{truncatedMessage}</p>
      )}

      {/* Working path */}
      {run.working_path && (
        <p className="text-[11px] text-text-tertiary truncate">
          Worktree: {run.working_path.split('/').pop()}
        </p>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={(): void => {
            navigate(`/workflows/runs/${run.id}`);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
        >
          <FileText className="h-3.5 w-3.5" />
          View Logs
        </button>
        {chatId && (
          <button
            onClick={(): void => {
              navigate(`/chat/${chatId}`);
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Open Chat
          </button>
        )}
        {run.working_path && (
          <a
            href={`vscode://file/${run.working_path.replace(/\\/g, '/')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-surface-elevated hover:text-text-primary transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in IDE
          </a>
        )}
        <button
          onClick={(): void => {
            if (window.confirm(`Cancel workflow "${run.workflow_name}"?`)) {
              onCancel(run.id);
            }
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-error/80 hover:bg-error/10 hover:text-error transition-colors ml-auto"
        >
          <XCircle className="h-3.5 w-3.5" />
          Cancel
        </button>
      </div>
    </div>
  );
}
