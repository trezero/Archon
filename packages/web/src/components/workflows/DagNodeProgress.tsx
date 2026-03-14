import { StatusIcon } from './StatusIcon';
import { formatDurationMs } from '@/lib/format';
import type { DagNodeState } from '@/lib/types';

interface DagNodeProgressProps {
  nodes: DagNodeState[];
  activeNodeId: string | null;
  onNodeClick: (nodeId: string) => void;
}

export function DagNodeProgress({
  nodes,
  activeNodeId,
  onNodeClick,
}: DagNodeProgressProps): React.ReactElement {
  if (nodes.length === 0) {
    return (
      <div className="p-3 text-xs text-text-secondary italic">No DAG node events recorded.</div>
    );
  }

  return (
    <div className="space-y-1 p-2">
      {nodes.map(node => (
        <button
          key={node.nodeId}
          onClick={(): void => {
            onNodeClick(node.nodeId);
          }}
          className={`w-full text-left px-2 py-1.5 rounded transition-colors ${
            node.nodeId === activeNodeId
              ? 'bg-accent/10 border-l-2 border-accent'
              : 'hover:bg-surface-hover'
          }`}
        >
          <div className="flex items-center gap-2 text-sm">
            <StatusIcon status={node.status} />
            <span className="truncate flex-1">{node.name}</span>
            {node.duration !== undefined && (
              <span className="text-xs text-text-secondary shrink-0">
                {formatDurationMs(node.duration)}
              </span>
            )}
          </div>
          {node.error && (
            <div className="text-xs text-red-400 mt-0.5 ml-6 truncate" title={node.error}>
              {node.error.slice(0, 80)}
            </div>
          )}
          {node.reason && (
            <div className="text-xs text-text-tertiary mt-0.5 ml-6">
              Skipped: {node.reason.replace(/_/g, ' ')}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
