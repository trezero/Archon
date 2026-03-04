import { ParallelBlockView } from './ParallelBlockView';
import { WorkflowStatusIcon as StatusIcon } from './WorkflowStatusIcon';
import { formatDuration } from '@/lib/utils';
import type { WorkflowStepState } from '@/lib/types';

interface StepProgressProps {
  steps: WorkflowStepState[];
  activeStepIndex: number;
  onStepClick: (index: number) => void;
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
