import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { LoopIterationView } from '@/components/workflows/LoopIterationView';
import type { WorkflowState } from '@/lib/types';

interface WorkflowProgressCardProps {
  workflow: WorkflowState;
  onCancel?: () => void;
  compact?: boolean;
  onViewFullScreen?: () => void;
}

function StatusIcon({ status }: { status: string }): React.ReactElement {
  switch (status) {
    case 'completed':
      return <span className="text-success">&#x2713;</span>;
    case 'running':
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      );
    case 'failed':
      return <span className="text-error">&#x2717;</span>;
    default:
      return <span className="text-text-secondary">&#x25CB;</span>;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function WorkflowProgressCard({
  workflow,
  onCancel,
  compact,
  onViewFullScreen,
}: WorkflowProgressCardProps): React.ReactElement {
  const navigate = useNavigate();

  // Force re-render every second while running so elapsed time counts up
  const [, setTick] = useState(0);
  useEffect(() => {
    if (workflow.status !== 'running') return;
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 1000);
    return (): void => {
      clearInterval(interval);
    };
  }, [workflow.status]);

  const completedSteps = workflow.steps.filter(s => s.status === 'completed').length;
  const totalSteps = workflow.steps.length;
  const elapsed = Math.max(0, (workflow.completedAt ?? Date.now()) - workflow.startedAt);

  const handleViewFullScreen = (): void => {
    if (onViewFullScreen) {
      onViewFullScreen();
    } else {
      navigate(`/workflows/runs/${workflow.runId}`);
    }
  };

  // Compact mode: single-line summary card
  if (compact) {
    return (
      <div className="rounded-lg border border-border bg-surface p-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={workflow.status} />
          <span className="flex-1 truncate text-xs font-medium text-text-primary">
            {workflow.workflowName}
          </span>
          <span className="text-[10px] text-text-secondary">
            {workflow.isLoop
              ? `Iter ${String(workflow.currentIteration ?? 0)}`
              : totalSteps > 0
                ? `${String(completedSteps)}/${String(totalSteps)}`
                : ''}
          </span>
          <span className="text-[10px] text-text-tertiary">{formatDuration(elapsed)}</span>
          {workflow.stale && workflow.status === 'running' && (
            <span
              className="text-[10px] text-yellow-400"
              title="Connection lost — status may be outdated"
            >
              !
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={handleViewFullScreen}
            className="text-[10px] text-accent hover:text-accent-bright transition-colors"
          >
            Open Full View
          </button>
          {workflow.status === 'running' && onCancel && (
            <button
              onClick={onCancel}
              className="text-[10px] text-text-secondary hover:text-error transition-colors ml-auto"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  // Full mode: detailed card
  return (
    <div className="my-2 rounded-lg border border-border bg-surface p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <StatusIcon status={workflow.status} />
          <span className="font-semibold text-sm text-text-primary">
            {workflow.status === 'running'
              ? 'Running'
              : workflow.status === 'completed'
                ? 'Completed'
                : 'Failed'}{' '}
            {workflow.workflowName}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          {workflow.isLoop ? (
            <span>
              Iteration {String(workflow.currentIteration ?? 0)}
              {workflow.maxIterations ? `/${String(workflow.maxIterations)}` : ''}
            </span>
          ) : totalSteps > 0 ? (
            <span>
              {String(completedSteps)}/{String(totalSteps)} steps
            </span>
          ) : null}
          <span>{formatDuration(elapsed)}</span>
        </div>
      </div>

      {/* Step list */}
      {!workflow.isLoop && workflow.steps.length > 0 && (
        <div className="space-y-1 mb-2">
          {workflow.steps.map(step => (
            <div key={step.index} className="flex items-center gap-2 text-xs">
              <StatusIcon status={step.status} />
              <span
                className={step.status === 'running' ? 'text-text-primary' : 'text-text-secondary'}
              >
                {step.name}
              </span>
              {step.duration !== undefined && (
                <span className="ml-auto text-text-secondary">{formatDuration(step.duration)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Loop iteration display */}
      {workflow.isLoop && (
        <div className="mb-2">
          <LoopIterationView workflow={workflow} />
        </div>
      )}

      {/* Stale indicator — polling lost contact with server */}
      {workflow.stale && workflow.status === 'running' && (
        <div className="mb-2 text-xs text-yellow-400 bg-yellow-400/10 rounded p-2">
          Connection lost — status may be outdated. Retrying...
        </div>
      )}

      {/* Error */}
      {workflow.error && (
        <div className="mb-2 text-xs text-error bg-error/10 rounded p-2">{workflow.error}</div>
      )}

      {/* Footer buttons */}
      <div className="flex items-center gap-2 pt-1 border-t border-border">
        <button
          onClick={handleViewFullScreen}
          className="text-xs text-accent hover:text-accent-bright transition-colors"
        >
          View Full Screen
        </button>
        {workflow.status === 'running' && onCancel && (
          <button
            onClick={onCancel}
            className="text-xs text-text-secondary hover:text-error transition-colors ml-auto"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
