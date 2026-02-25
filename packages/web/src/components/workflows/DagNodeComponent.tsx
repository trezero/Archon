import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps, Node } from '@xyflow/react';
import type { DagNodeBase } from '@archon/core/workflows/types';

export interface DagNodeData extends DagNodeBase {
  /** For command nodes: the command name. For prompt nodes: display label ("Prompt"). For bash: display label ("Shell"). */
  label: string;
  nodeType: 'command' | 'prompt' | 'bash';
  promptText?: string;
  bashScript?: string;
  bashTimeout?: number;
  /** Required by React Flow's Node<T> constraint — do not rely on this for typed access. */
  [key: string]: unknown;
}

export type DagFlowNode = Node<DagNodeData>;

function DagNodeRender({ data, selected }: NodeProps<DagFlowNode>): React.ReactElement {
  return (
    <div
      className={`rounded-lg border px-4 py-2 min-w-[140px] text-center transition-colors ${
        selected
          ? 'border-accent bg-accent/10 shadow-md'
          : 'border-border bg-surface-elevated hover:border-border-bright'
      }`}
    >
      <Handle type="target" position={Position.Top} className="!bg-accent !w-2 !h-2" />
      <div className="flex items-center gap-2 justify-center">
        <span className="text-[10px] text-text-tertiary">
          {data.nodeType === 'command' ? 'CMD' : data.nodeType === 'bash' ? 'BASH' : 'PROMPT'}
        </span>
        <span className="text-xs font-medium text-text-primary truncate max-w-[120px]">
          {data.label}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-accent !w-2 !h-2" />
    </div>
  );
}

// memo() for React Flow performance; exported as a named function component
export const dagNodeComponent = memo(DagNodeRender);
