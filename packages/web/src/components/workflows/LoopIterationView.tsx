import type { WorkflowState } from '@/lib/types';

interface LoopIterationViewProps {
  workflow: WorkflowState;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function LoopIterationView({ workflow }: LoopIterationViewProps): React.ReactElement {
  const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
  const current = workflow.currentIteration ?? 0;
  const max = workflow.maxIterations;

  return (
    <div className="space-y-2">
      {/* Iteration counter */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-primary font-medium">
          Iteration {String(current)}
          {max ? ` of ${String(max)}` : ''}
        </span>
        <span className="text-xs text-text-secondary">{formatDuration(elapsed)}</span>
      </div>

      {/* Progress bar */}
      {max && max > 0 && (
        <div className="h-1.5 rounded-full bg-surface-inset overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              workflow.status === 'failed' ? 'bg-error' : 'bg-accent'
            }`}
            style={{ width: `${String(Math.min(100, (current / max) * 100))}%` }}
          />
        </div>
      )}

      {/* Status */}
      <div className="text-xs text-text-secondary">
        {workflow.status === 'running' && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 animate-spin rounded-full border border-accent border-t-transparent" />
            Running iteration...
          </span>
        )}
        {workflow.status === 'completed' && (
          <span className="text-success">Loop completed after {String(current)} iterations</span>
        )}
        {workflow.status === 'failed' && (
          <div className="space-y-1">
            <span className="text-error">
              {max && current >= max
                ? `Reached max iterations (${String(max)}). Consider increasing the limit.`
                : 'Loop failed'}
            </span>
            {workflow.error && (
              <div className="text-error bg-error/10 rounded p-1.5">{workflow.error}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
