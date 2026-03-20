import { useQuery } from '@tanstack/react-query';
import { Header } from '@/components/layout/Header';
import { getConfig, getHealth } from '@/lib/api';

export function SettingsPage(): React.ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  const {
    data: health,
    isLoading: healthLoading,
    error: healthError,
  } = useQuery({
    queryKey: ['health'],
    queryFn: getHealth,
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <Header title="Settings" />
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4 max-w-2xl">
          <section>
            <h3 className="text-sm font-semibold text-text-primary mb-2">System Health</h3>
            {healthLoading && <div className="text-sm text-text-secondary">Checking health...</div>}
            {healthError && (
              <div className="text-sm text-error">
                Failed to check health:{' '}
                {healthError instanceof Error ? healthError.message : 'Unknown error'}. Check that
                the server is running.
              </div>
            )}
            {health && (
              <div className="rounded-lg border border-border bg-surface p-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-text-secondary">Status: </span>
                    <span className="text-text-primary font-medium">{health.status}</span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Adapter: </span>
                    <span className="text-text-primary font-medium">{health.adapter}</span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Active: </span>
                    <span className="text-text-primary font-medium">{health.runningWorkflows}</span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Queued: </span>
                    <span className="text-text-primary font-medium">
                      {health.concurrency.queuedTotal}
                    </span>
                  </div>
                  <div>
                    <span className="text-text-secondary">Max Concurrent: </span>
                    <span className="text-text-primary font-medium">
                      {health.concurrency.maxConcurrent}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {isLoading && <div className="text-sm text-text-secondary">Loading configuration...</div>}
          {error && (
            <div className="text-sm text-error">
              Failed to load configuration:{' '}
              {error instanceof Error ? error.message : 'Unknown error'}. Try refreshing the page.
            </div>
          )}
          {data && (
            <>
              <section>
                <h3 className="text-sm font-semibold text-text-primary mb-2">Database</h3>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <span className="text-sm text-text-secondary">Type: </span>
                  <span className="text-sm text-text-primary font-medium">{data.database}</span>
                </div>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-text-primary mb-2">Configuration</h3>
                <pre className="rounded-lg border border-border bg-surface-inset p-3 text-xs text-text-secondary overflow-auto max-h-96 font-mono">
                  {JSON.stringify(data.config, null, 2)}
                </pre>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
