import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Workflow } from 'lucide-react';
import {
  listDashboardRuns,
  cancelWorkflowRun,
  listCodebases,
  getHealth,
  type DashboardRunResponse,
} from '@/lib/api';
import { StatusSummaryBar } from '@/components/dashboard/StatusSummaryBar';
import { WorkflowRunCard } from '@/components/dashboard/WorkflowRunCard';
import { WorkflowHistoryTable } from '@/components/dashboard/WorkflowHistoryTable';

export function DashboardPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  // Fetch all runs (project-scoped only); status + search filtering done client-side
  const { data: allRuns, isLoading } = useQuery({
    queryKey: ['dashboardRuns', { codebaseId: projectFilter }],
    queryFn: () =>
      listDashboardRuns({
        codebaseId: projectFilter ?? undefined,
        limit: 50,
      }),
    refetchInterval: 5_000,
  });

  const { data: codebases } = useQuery({
    queryKey: ['codebases'],
    queryFn: () => listCodebases(),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => getHealth(),
    refetchInterval: 30_000,
  });

  // Client-side status filter
  const statusFilteredRuns = useMemo(() => {
    if (!allRuns) return [];
    if (!statusFilter) return allRuns;
    return allRuns.filter(r => r.status === statusFilter);
  }, [allRuns, statusFilter]);

  // Client-side search filter (applied after status filter)
  const filteredRuns = useMemo(() => {
    if (!searchQuery) return statusFilteredRuns;
    const query = searchQuery.toLowerCase();
    return statusFilteredRuns.filter(
      (run: DashboardRunResponse) =>
        run.workflow_name.toLowerCase().includes(query) ||
        run.user_message?.toLowerCase().includes(query)
    );
  }, [statusFilteredRuns, searchQuery]);

  // Split into active and history
  const activeRuns = useMemo(
    () => filteredRuns.filter(r => r.status === 'running' || r.status === 'pending'),
    [filteredRuns]
  );

  const historyRuns = useMemo(
    () =>
      filteredRuns.filter(
        r => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled'
      ),
    [filteredRuns]
  );

  const handleCancel = async (runId: string): Promise<void> => {
    await cancelWorkflowRun(runId);
    void queryClient.invalidateQueries({ queryKey: ['dashboardRuns'] });
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-text-primary">Mission Control</h1>
          {allRuns && (
            <span className="text-xs text-text-tertiary">
              Last updated {new Date().toLocaleTimeString()}
            </span>
          )}
        </div>

        {/* Status Summary Bar — always receives unfiltered runs for accurate counts */}
        <StatusSummaryBar
          runs={allRuns ?? []}
          activeFilter={statusFilter}
          onFilterChange={setStatusFilter}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          codebases={codebases}
          health={health}
        />

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <span className="text-sm text-text-tertiary">Loading...</span>
          </div>
        ) : filteredRuns.length === 0 ? (
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
          </>
        )}
      </div>
    </div>
  );
}
