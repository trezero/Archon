import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Workflow } from 'lucide-react';
import {
  listDashboardRuns,
  cancelWorkflowRun,
  listCodebases,
  getHealth,
  type DashboardCounts,
} from '@/lib/api';
import type { WorkflowRunStatus } from '@/lib/types';
import { StatusSummaryBar } from '@/components/dashboard/StatusSummaryBar';
import { WorkflowRunCard } from '@/components/dashboard/WorkflowRunCard';
import { WorkflowHistoryTable } from '@/components/dashboard/WorkflowHistoryTable';

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;

/** Date range presets. "all" means no date filter. */
type DateRange = 'today' | '7d' | '30d' | 'all';

function getDateBounds(range: DateRange): { after?: string; before?: string } {
  if (range === 'all') return {};
  const now = new Date();
  const start = new Date(now);
  if (range === 'today') {
    start.setHours(0, 0, 0, 0);
  } else if (range === '7d') {
    start.setDate(start.getDate() - 7);
  } else if (range === '30d') {
    start.setDate(start.getDate() - 30);
  }
  return { after: start.toISOString() };
}

export function DashboardPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Hydrate filter state from URL (supports bookmarkable views)
  const statusFilter = searchParams.get('status') ?? null;
  const searchQuery = searchParams.get('q') ?? '';
  const projectFilter = searchParams.get('project') ?? null;
  const dateRange: DateRange = (searchParams.get('range') as DateRange) ?? 'all';
  const page = Math.max(0, Number(searchParams.get('page') ?? '0'));
  const pageSizeParam = Number(searchParams.get('pageSize') ?? '0');
  const pageSize = PAGE_SIZE_OPTIONS.includes(pageSizeParam as (typeof PAGE_SIZE_OPTIONS)[number])
    ? pageSizeParam
    : DEFAULT_PAGE_SIZE;

  // Debounced search: type instantly in the input, but delay the server request
  const [searchInput, setSearchInput] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Sync searchInput when URL changes externally (e.g., back/forward)
  useEffect(() => {
    setSearchInput(searchParams.get('q') ?? '');
  }, [searchParams]);

  /** Helper to update URL params (replaces history entry to avoid back-spam). */
  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      setSearchParams(
        prev => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(updates)) {
            if (v === null || v === '' || v === '0' || v === 'all') {
              next.delete(k);
            } else {
              next.set(k, v);
            }
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const setStatusFilter = useCallback(
    (status: string | null) => {
      updateParams({ status, page: null });
    },
    [updateParams]
  );
  const setProjectFilter = useCallback(
    (project: string | null) => {
      updateParams({ project, page: null });
    },
    [updateParams]
  );
  const setDateRange = useCallback(
    (range: DateRange) => {
      updateParams({ range, page: null });
    },
    [updateParams]
  );
  const setPage = useCallback(
    (p: number) => {
      updateParams({ page: p === 0 ? null : String(p) });
    },
    [updateParams]
  );

  const setPageSize = useCallback(
    (size: number) => {
      updateParams({
        pageSize: size === DEFAULT_PAGE_SIZE ? null : String(size),
        page: null,
      });
    },
    [updateParams]
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        updateParams({ q: value || null, page: null });
      }, 300);
    },
    [updateParams]
  );

  // Compute date bounds from range preset
  const dateBounds = useMemo(() => getDateBounds(dateRange), [dateRange]);

  // Server-side fetch with all filters
  const { data: dashboardData, isLoading } = useQuery({
    queryKey: [
      'dashboardRuns',
      {
        status: statusFilter,
        codebaseId: projectFilter,
        search: searchQuery,
        dateRange,
        page,
        pageSize,
      },
    ],
    queryFn: () =>
      listDashboardRuns({
        status: (statusFilter as WorkflowRunStatus) ?? undefined,
        codebaseId: projectFilter ?? undefined,
        search: searchQuery || undefined,
        after: dateBounds.after,
        before: dateBounds.before,
        limit: pageSize,
        offset: page * pageSize,
      }),
    refetchInterval: 5_000,
  });

  const runs = dashboardData?.runs ?? [];
  const total = dashboardData?.total ?? 0;
  const counts: DashboardCounts = dashboardData?.counts ?? {
    all: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
  };

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: () => listCodebases(),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => getHealth(),
    refetchInterval: 30_000,
  });

  // Split into active and history (from server-filtered results)
  const activeRuns = useMemo(
    () => runs.filter(r => r.status === 'running' || r.status === 'pending'),
    [runs]
  );

  const historyRuns = useMemo(
    () =>
      runs.filter(
        r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
      ),
    [runs]
  );

  const handleCancel = async (runId: string): Promise<void> => {
    await cancelWorkflowRun(runId);
    void queryClient.invalidateQueries({ queryKey: ['dashboardRuns'] });
  };

  const totalPages = Math.ceil(total / pageSize);
  const hasMore = page + 1 < totalPages;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-text-primary">Mission Control</h1>
          {dashboardData && (
            <span className="text-xs text-text-tertiary">
              Last updated {new Date().toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Status Summary Bar — receives real server counts */}
        <StatusSummaryBar
          counts={counts}
          activeFilter={statusFilter}
          onFilterChange={setStatusFilter}
          searchQuery={searchInput}
          onSearchChange={handleSearchChange}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          dateRange={dateRange}
          onDateRangeChange={setDateRange}
          codebases={codebases}
          health={health}
        />

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm text-text-tertiary">Loading...</span>
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16">
            <Workflow className="h-10 w-10 text-text-tertiary" />
            <p className="text-sm text-text-tertiary">No workflow runs found</p>
          </div>
        ) : (
          <>
            {/* Active Workflows */}
            {activeRuns.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-text-secondary">Active Workflows</h2>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {activeRuns.map(run => (
                    <WorkflowRunCard key={run.id} run={run} onCancel={handleCancel} />
                  ))}
                </div>
              </section>
            )}

            {/* History */}
            {historyRuns.length > 0 && (
              <section>
                <h2 className="mb-3 text-sm font-semibold text-text-secondary">History</h2>
                <WorkflowHistoryTable runs={historyRuns} />
              </section>
            )}

            {/* Pagination */}
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-3">
                <span className="text-xs text-text-tertiary">
                  Showing {String(page * pageSize + 1)}&ndash;
                  {String(Math.min((page + 1) * pageSize, total))} of {String(total)} runs
                </span>
                <select
                  value={pageSize}
                  onChange={(e): void => {
                    setPageSize(Number(e.target.value));
                  }}
                  className="rounded-md border border-border bg-surface-elevated px-2 py-1 text-xs text-text-primary focus:border-primary focus:outline-none"
                >
                  {PAGE_SIZE_OPTIONS.map(size => (
                    <option key={size} value={size}>
                      {String(size)} per page
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={(): void => {
                    setPage(page - 1);
                  }}
                  disabled={page === 0}
                  className="rounded-md border border-border bg-surface-elevated px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-xs text-text-tertiary">
                  Page {String(page + 1)} of {String(Math.max(1, totalPages))}
                </span>
                <button
                  onClick={(): void => {
                    setPage(page + 1);
                  }}
                  disabled={!hasMore}
                  className="rounded-md border border-border bg-surface-elevated px-3 py-1 text-xs text-text-secondary transition-colors hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
