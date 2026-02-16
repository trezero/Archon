import { cn } from '@/lib/utils';

interface LockIndicatorProps {
  locked: boolean;
  queuePosition?: number;
}

export function LockIndicator({ locked, queuePosition }: LockIndicatorProps): React.ReactElement {
  return (
    <div
      className={cn(
        'overflow-hidden transition-all duration-200',
        locked ? 'h-8 opacity-100' : 'h-0 opacity-0'
      )}
    >
      <div className="flex h-8 items-center gap-2 border-l-2 border-l-primary bg-surface px-4">
        <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
        <span className="text-sm text-text-secondary">
          Agent is working...
          {queuePosition !== undefined && queuePosition > 0 && (
            <span className="ml-1 text-text-tertiary">
              Position {String(queuePosition)} in queue
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
