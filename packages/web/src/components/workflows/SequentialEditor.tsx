import { useState, useCallback, useRef } from 'react';
import type { WorkflowStep, SingleStep, ParallelBlock } from '@archon/workflows';
import { isParallelBlock, isSingleStep } from '@archon/workflows';
import type { CommandEntry } from '@/lib/api';

interface SequentialEditorProps {
  steps: readonly WorkflowStep[];
  commands: CommandEntry[];
  selectedStepIndex: number | null;
  onStepsChange: (steps: WorkflowStep[]) => void;
  onSelectStep: (index: number | null) => void;
  onUngroup: (index: number) => void;
  onDirty: () => void;
}

export function SequentialEditor({
  steps,
  commands,
  selectedStepIndex,
  onStepsChange,
  onSelectStep,
  onUngroup,
  onDirty,
}: SequentialEditorProps): React.ReactElement {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [parallelSelectMode, setParallelSelectMode] = useState(false);
  const [selectedForParallel, setSelectedForParallel] = useState<Set<number>>(new Set());
  const dragCounter = useRef(0);

  const addStep = useCallback(
    (command: string): void => {
      const newStep: SingleStep = { command };
      onStepsChange([...steps, newStep]);
      onDirty();
    },
    [steps, onStepsChange, onDirty]
  );

  const removeStep = useCallback(
    (index: number): void => {
      const newSteps = steps.filter((_, i) => i !== index);
      onStepsChange(newSteps);
      if (selectedStepIndex === index) onSelectStep(null);
      onDirty();
    },
    [steps, onStepsChange, selectedStepIndex, onSelectStep, onDirty]
  );

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragEnter = useCallback((index: number) => {
    dragCounter.current++;
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current === 0) setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback(
    (targetIndex: number): void => {
      if (dragIndex === null || dragIndex === targetIndex) return;
      const newSteps = [...steps];
      const [removed] = newSteps.splice(dragIndex, 1);
      newSteps.splice(targetIndex, 0, removed);
      onStepsChange(newSteps);
      onDirty();
      setDragIndex(null);
      setDragOverIndex(null);
      dragCounter.current = 0;
    },
    [dragIndex, steps, onStepsChange, onDirty]
  );

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
    dragCounter.current = 0;
  }, []);

  const createParallelBlock = useCallback((): void => {
    if (selectedForParallel.size < 2) return;

    const indices = Array.from(selectedForParallel).sort((a, b) => a - b);
    const parallelSteps: SingleStep[] = [];
    for (const idx of indices) {
      const step = steps[idx];
      if (isSingleStep(step)) {
        parallelSteps.push(step);
      }
    }
    if (parallelSteps.length < 2) return;

    const block: ParallelBlock = { parallel: parallelSteps };
    const newSteps = steps.filter((_, i) => !selectedForParallel.has(i));
    const insertAt = Math.min(...indices);
    newSteps.splice(insertAt, 0, block);
    onStepsChange(newSteps);
    onDirty();
    setParallelSelectMode(false);
    setSelectedForParallel(new Set());
  }, [selectedForParallel, steps, onStepsChange, onDirty]);

  const toggleParallelSelect = useCallback((index: number): void => {
    setSelectedForParallel(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const getStepLabel = (step: WorkflowStep): string => {
    if (isSingleStep(step)) return step.command;
    if (isParallelBlock(step)) {
      return `Parallel: ${step.parallel.map(s => s.command).join(', ')}`;
    }
    return 'Unknown';
  };

  return (
    <div className="flex flex-col h-full overflow-auto p-4">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
          Steps ({String(steps.length)})
        </h3>
        <div className="ml-auto flex gap-2">
          {parallelSelectMode ? (
            <>
              <button
                type="button"
                onClick={createParallelBlock}
                disabled={selectedForParallel.size < 2}
                className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                Group ({String(selectedForParallel.size)})
              </button>
              <button
                type="button"
                onClick={(): void => {
                  setParallelSelectMode(false);
                  setSelectedForParallel(new Set());
                }}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={(): void => {
                setParallelSelectMode(true);
              }}
              disabled={steps.filter(s => isSingleStep(s)).length < 2}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              Create Parallel Block
            </button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        {steps.map((step, index) => (
          <div
            key={index}
            draggable={!parallelSelectMode}
            onDragStart={(): void => {
              handleDragStart(index);
            }}
            onDragEnter={(): void => {
              handleDragEnter(index);
            }}
            onDragLeave={handleDragLeave}
            onDragOver={(e): void => {
              e.preventDefault();
            }}
            onDrop={(): void => {
              handleDrop(index);
            }}
            onDragEnd={handleDragEnd}
            onClick={(): void => {
              if (parallelSelectMode && isSingleStep(step)) {
                toggleParallelSelect(index);
              } else {
                onSelectStep(index);
              }
            }}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
              dragOverIndex === index
                ? 'border-accent bg-accent/10'
                : selectedStepIndex === index
                  ? 'border-accent bg-accent/5'
                  : parallelSelectMode && selectedForParallel.has(index)
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-surface hover:bg-surface-hover'
            } ${dragIndex === index ? 'opacity-40' : ''}`}
          >
            {parallelSelectMode && isSingleStep(step) && (
              <input
                type="checkbox"
                checked={selectedForParallel.has(index)}
                readOnly
                className="rounded"
              />
            )}
            <span className="text-[10px] text-text-tertiary font-mono w-5 shrink-0">
              {String(index + 1)}
            </span>
            {isParallelBlock(step) ? (
              <div className="flex flex-col gap-0.5 flex-1">
                <span className="text-[10px] text-accent font-medium uppercase">Parallel</span>
                <div className="flex flex-wrap gap-1">
                  {step.parallel.map((s, i) => (
                    <span
                      key={i}
                      className="rounded bg-surface-elevated px-1.5 py-0.5 text-xs text-text-primary"
                    >
                      {s.command}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <span className="text-xs text-text-primary flex-1 truncate">
                {getStepLabel(step)}
              </span>
            )}
            {isSingleStep(step) && step.clearContext && (
              <span className="rounded bg-accent-muted px-1 py-0.5 text-[9px] text-primary shrink-0">
                fresh
              </span>
            )}
            {isParallelBlock(step) && (
              <button
                type="button"
                onClick={(e): void => {
                  e.stopPropagation();
                  onUngroup(index);
                }}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-secondary hover:bg-surface-hover transition-colors shrink-0"
                title="Ungroup parallel block"
              >
                Ungroup
              </button>
            )}
            <button
              type="button"
              onClick={(e): void => {
                e.stopPropagation();
                removeStep(index);
              }}
              className="text-text-tertiary hover:text-error transition-colors shrink-0"
              title="Remove step"
            >
              x
            </button>
          </div>
        ))}
      </div>

      {/* Add Step */}
      <div className="mt-3">
        <select
          value=""
          onChange={(e): void => {
            if (e.target.value) {
              addStep(e.target.value);
              e.target.value = '';
            }
          }}
          className="w-full rounded-md border border-dashed border-border bg-surface px-2 py-1.5 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">+ Add Step...</option>
          {commands.map(cmd => (
            <option key={cmd.name} value={cmd.name}>
              {cmd.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
