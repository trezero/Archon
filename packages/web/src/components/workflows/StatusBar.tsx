import { cn } from '@/lib/utils';

interface StatusBarProps {
  mode: 'dag' | 'sequential' | 'loop';
  nodeCount: number;
  edgeCount: number;
  errorCount: number;
  warningCount: number;
  hasUnsavedChanges: boolean;
  zoomLevel: number;
  onValidationClick: () => void;
}

const MODE_LABELS: Record<StatusBarProps['mode'], string> = {
  dag: 'DAG',
  sequential: 'Steps',
  loop: 'Loop',
};

export function StatusBar({
  mode,
  nodeCount,
  edgeCount,
  errorCount,
  warningCount,
  hasUnsavedChanges,
  zoomLevel,
  onValidationClick,
}: StatusBarProps): React.ReactElement {
  const isValid = errorCount === 0 && warningCount === 0;

  return (
    <div className="flex h-7 items-center justify-between border-t border-border bg-surface px-3 text-xs text-text-tertiary">
      {/* Left side */}
      <div className="flex items-center gap-3">
        {/* Validation badge */}
        <button
          type="button"
          onClick={onValidationClick}
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-surface-hover',
            isValid && 'text-success'
          )}
        >
          {isValid ? (
            <>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>Valid</span>
            </>
          ) : (
            <>
              {errorCount > 0 && <span className="text-error">{errorCount} errors</span>}
              {errorCount > 0 && warningCount > 0 && <span>,</span>}
              {warningCount > 0 && <span className="text-warning">{warningCount} warnings</span>}
            </>
          )}
        </button>

        {/* Mode label */}
        <span>{MODE_LABELS[mode]}</span>

        {/* Node/edge count — DAG mode only */}
        {mode === 'dag' && (
          <span>
            {nodeCount} nodes &middot; {edgeCount} edges
          </span>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {/* Unsaved indicator */}
        {hasUnsavedChanges && (
          <span className="flex items-center gap-1 text-warning">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-warning" />
            Unsaved
          </span>
        )}

        {/* Zoom level */}
        <span>{Math.round(zoomLevel)}%</span>
      </div>
    </div>
  );
}
