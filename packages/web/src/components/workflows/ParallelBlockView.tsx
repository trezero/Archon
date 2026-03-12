import { StatusIcon } from './StatusIcon';
import { formatDurationMs } from '@/lib/format';
import type { ParallelAgentState } from '@/lib/types';

interface ParallelBlockViewProps {
  agents: ParallelAgentState[];
  stepName: string;
}

function overallStatus(agents: ParallelAgentState[]): string {
  if (agents.some(a => a.status === 'failed')) return 'failed';
  if (agents.some(a => a.status === 'running')) return 'running';
  if (agents.every(a => a.status === 'completed')) return 'completed';
  return 'pending';
}

export function ParallelBlockView({
  agents,
  stepName,
}: ParallelBlockViewProps): React.ReactElement {
  const status = overallStatus(agents);
  const completed = agents.filter(a => a.status === 'completed').length;

  return (
    <div className="space-y-0.5">
      {/* Parent row */}
      <div className="flex items-center gap-2 text-sm">
        <StatusIcon status={status} />
        <span className="truncate flex-1">{stepName}</span>
        <span className="text-xs text-text-secondary shrink-0">
          ({String(completed)}/{String(agents.length)} agents)
        </span>
      </div>

      {/* Nested agent list */}
      <div className="ml-4 border-l border-border pl-3 space-y-0.5">
        {agents.map(agent => (
          <div key={agent.index} className="flex items-center gap-2 text-xs">
            <StatusIcon status={agent.status} />
            <span
              className={agent.status === 'running' ? 'text-text-primary' : 'text-text-secondary'}
            >
              {agent.name}
            </span>
            {agent.duration !== undefined && (
              <span className="ml-auto text-text-secondary">
                {formatDurationMs(agent.duration)}
              </span>
            )}
            {agent.error && (
              <span className="ml-auto text-error truncate max-w-[150px]" title={agent.error}>
                {agent.error}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
