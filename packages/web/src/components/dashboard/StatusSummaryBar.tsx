import { Search } from 'lucide-react';
import type { DashboardRunResponse, CodebaseResponse, HealthResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

interface StatusSummaryBarProps {
  runs: DashboardRunResponse[];
  activeFilter: string | null;
  onFilterChange: (status: string | null) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  projectFilter: string | null;
  onProjectFilterChange: (codebaseId: string | null) => void;
  codebases: CodebaseResponse[] | undefined;
  health: HealthResponse | undefined;
}

const STATUS_CHIPS = ['running', 'completed', 'failed', 'cancelled'] as const;

function getStatusCount(runs: DashboardRunResponse[], status: string): number {
  return runs.filter(r => r.status === status).length;
}

export function StatusSummaryBar({
  runs,
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  projectFilter,
  onProjectFilterChange,
  codebases,
  health,
}: StatusSummaryBarProps): React.ReactElement {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 space-y-3">
      {/* Row 1: Status chips */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={(): void => {
            onFilterChange(null);
          }}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium transition-colors',
            activeFilter === null
              ? 'bg-primary/10 text-primary border border-primary'
              : 'bg-surface-elevated text-text-secondary border border-border hover:border-text-tertiary'
          )}
        >
          All: {String(runs.length)}
        </button>
        {STATUS_CHIPS.map(status => {
          const count = getStatusCount(runs, status);
          const isActive = activeFilter === status;
          return (
            <button
              key={status}
              onClick={(): void => {
                onFilterChange(isActive ? null : status);
              }}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary border border-primary'
                  : 'bg-surface-elevated text-text-secondary border border-border hover:border-text-tertiary',
                status === 'running' && count > 0 && !isActive && 'animate-pulse'
              )}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}: {String(count)}
            </button>
          );
        })}
      </div>

      {/* Row 2: Project dropdown, search, capacity */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={projectFilter ?? ''}
          onChange={(e): void => {
            onProjectFilterChange(e.target.value || null);
          }}
          className="rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-primary focus:border-primary focus:outline-none"
        >
          <option value="">All Projects</option>
          {codebases?.map(cb => (
            <option key={cb.id} value={cb.id}>
              {cb.name}
            </option>
          ))}
        </select>

        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e): void => {
              onSearchChange(e.target.value);
            }}
            placeholder="Search workflows..."
            className="w-full rounded-md border border-border bg-surface-elevated py-1.5 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
          />
        </div>

        {health && (
          <span className="text-xs text-text-tertiary shrink-0">
            Capacity: {String(health.concurrency.active)}/{String(health.concurrency.maxConcurrent)}{' '}
            active
          </span>
        )}
      </div>
    </div>
  );
}
