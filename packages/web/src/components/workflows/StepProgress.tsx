import { ParallelBlockView } from './ParallelBlockView';
import type { WorkflowStepState } from '@/lib/types';

interface StepProgressProps {
  steps: WorkflowStepState[];
  activeStepIndex: number;
  onStepClick: (index: number) => void;
}

function StatusIcon({ status }: { status: string }): React.ReactElement {
  switch (status) {
    case 'completed':
      return <span className="text-success text-sm">&#x2713;</span>;
    case 'running':
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      );
    case 'failed':
      return <span className="text-error text-sm">&#x2717;</span>;
    case 'skipped':
      return <span className="text-text-secondary text-sm">&#x2014;</span>;
    default:
      return <span className="text-text-secondary text-sm">&#x25CB;</span>;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function StepProgress({
  steps,
  activeStepIndex,
  onStepClick,
}: StepProgressProps): React.ReactElement {
  return (
    <div className="space-y-1 p-2">
      {steps.map(step => (
        <button
          key={step.index}
          onClick={(): void => {
            onStepClick(step.index);
          }}
          className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
            step.index === activeStepIndex
              ? 'bg-accent/10 border-l-2 border-accent'
              : 'hover:bg-surface-hover'
          }`}
        >
          {step.agents && step.agents.length > 0 ? (
            <ParallelBlockView agents={step.agents} stepName={step.name} />
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <StatusIcon status={step.status} />
              <span className="truncate flex-1">{step.name}</span>
              {step.duration !== undefined && (
                <span className="text-xs text-text-secondary shrink-0">
                  {formatDuration(step.duration)}
                </span>
              )}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
