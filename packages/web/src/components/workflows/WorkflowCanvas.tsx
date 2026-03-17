import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  Background,
  BackgroundVariant,
} from '@xyflow/react';
import type { Connection, Edge, OnConnect, NodeTypes } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { DagNode } from '@archon/workflows/types';
import { dagNodeComponent, type DagFlowNode } from './DagNodeComponent';

const NODE_WIDTH = 160;
const NODE_HEIGHT = 50;

function layoutWithDagre(
  nodes: DagFlowNode[],
  edges: Edge[]
): { nodes: DagFlowNode[]; edges: Edge[] } {
  try {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 40 });

    for (const node of nodes) {
      g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    }
    for (const edge of edges) {
      g.setEdge(edge.source, edge.target);
    }

    dagre.layout(g);

    const layoutedNodes = nodes.map(node => {
      const pos = g.node(node.id) as { x: number; y: number } | undefined;
      if (!pos) return node;
      return {
        ...node,
        position: {
          x: pos.x - NODE_WIDTH / 2,
          y: pos.y - NODE_HEIGHT / 2,
        },
      };
    });

    return { nodes: layoutedNodes, edges };
  } catch (err) {
    // Fallback: return nodes at their default stacked positions. This is safe
    // because the user can still manually drag nodes; layout is cosmetic only.
    console.error('[WorkflowCanvas] Dagre layout failed, using fallback positions:', err);
    return { nodes, edges };
  }
}

function resolveNodeDisplay(dn: DagNode): {
  label: string;
  nodeType: 'command' | 'prompt' | 'bash';
  promptText?: string;
  bashScript?: string;
  bashTimeout?: number;
} {
  if ('bash' in dn && dn.bash) {
    return {
      label: 'Shell',
      nodeType: 'bash',
      bashScript: dn.bash,
      bashTimeout: dn.timeout,
    };
  }
  if ('command' in dn && dn.command) {
    return { label: dn.command, nodeType: 'command' };
  }
  return {
    label: 'Prompt',
    nodeType: 'prompt',
    promptText: dn.prompt,
  };
}

export function dagNodesToReactFlow(dagNodes: readonly DagNode[]): {
  nodes: DagFlowNode[];
  edges: Edge[];
} {
  const nodes: DagFlowNode[] = dagNodes.map((dn, i) => ({
    id: dn.id,
    type: 'dagNode',
    position: { x: 0, y: i * 100 },
    data: {
      ...dn,
      ...resolveNodeDisplay(dn),
    },
  }));

  const edges: Edge[] = [];
  for (const dn of dagNodes) {
    for (const dep of dn.depends_on ?? []) {
      edges.push({
        id: `${dep}->${dn.id}`,
        source: dep,
        target: dn.id,
        type: 'smoothstep',
      });
    }
  }

  const { nodes: layouted, edges: layoutedEdges } = layoutWithDagre(nodes, edges);
  return { nodes: layouted, edges: layoutedEdges };
}

export function reactFlowToDagNodes(rfNodes: DagFlowNode[], rfEdges: Edge[]): DagNode[] {
  return rfNodes.map(node => {
    const deps = rfEdges.filter(e => e.target === node.id).map(e => e.source);

    const dagBase = {
      id: node.id,
      depends_on: deps.length > 0 ? deps : undefined,
      when: node.data.when || undefined,
      trigger_rule: node.data.trigger_rule || undefined,
    };

    if (node.data.nodeType === 'bash') {
      // DagNode uses `never` discriminant fields that can't be set on object literals
      return {
        ...dagBase,
        bash: node.data.bashScript ?? '',
        ...(node.data.bashTimeout ? { timeout: node.data.bashTimeout } : {}),
      } as DagNode;
    }

    // AI node fields (not applicable to bash)
    const aiBase = {
      ...dagBase,
      model: node.data.model || undefined,
      provider: node.data.provider || undefined,
      context: node.data.context || undefined,
      output_format: node.data.output_format ?? undefined,
      allowed_tools: node.data.allowed_tools ?? undefined,
      denied_tools: node.data.denied_tools ?? undefined,
      hooks: node.data.hooks ?? undefined,
      mcp: node.data.mcp ?? undefined,
      skills: node.data.skills ?? undefined,
    };

    // DagNode uses `never` discriminant fields that can't be set on object literals
    if (node.data.nodeType === 'command') {
      return { ...aiBase, command: node.data.label } as DagNode;
    }
    const promptText = node.data.promptText;
    return {
      ...aiBase,
      prompt: typeof promptText === 'string' ? promptText : '',
    } as DagNode;
  });
}

interface WorkflowCanvasProps {
  nodes: DagFlowNode[];
  edges: Edge[];
  /** Handles React Flow internal changes (drag, select, remove). */
  onNodesChange: ReturnType<typeof useNodesState<DagFlowNode>>[2];
  onEdgesChange: ReturnType<typeof useEdgesState<Edge>>[2];
  /** Programmatic state setter for adding nodes (e.g. onDrop). Both this and onNodesChange are needed because React Flow requires its own change handler. */
  setNodes: ReturnType<typeof useNodesState<DagFlowNode>>[1];
  setEdges: ReturnType<typeof useEdgesState<Edge>>[1];
  onNodeSelect: (nodeId: string | null) => void;
  onDirty: () => void;
}

export function WorkflowCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  setNodes,
  setEdges,
  onNodeSelect,
  onDirty,
}: WorkflowCanvasProps): React.ReactElement {
  const { screenToFlowPosition } = useReactFlow();

  const nodeTypes: NodeTypes = useMemo(() => ({ dagNode: dagNodeComponent }), []);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges(eds => addEdge({ ...connection, type: 'smoothstep' }, eds));
      onDirty();
    },
    [setEdges, onDirty]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();

      const type = e.dataTransfer.getData('application/reactflow-type');
      const command = e.dataTransfer.getData('application/reactflow-command');
      if (!type) return;

      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = `node-${crypto.randomUUID()}`;

      const nodeType = type as 'command' | 'prompt' | 'bash';
      const label = nodeType === 'command' ? command : nodeType === 'bash' ? 'Shell' : 'Prompt';

      const newNode: DagFlowNode = {
        id,
        type: 'dagNode',
        position,
        data: {
          id,
          label,
          nodeType,
        },
      };

      setNodes(nds => [...nds, newNode]);
      onDirty();
    },
    [screenToFlowPosition, setNodes, onDirty]
  );

  const handleNodesChange: typeof onNodesChange = useCallback(
    changes => {
      onNodesChange(changes);
      if (changes.some(c => c.type !== 'select')) {
        onDirty();
      }
    },
    [onNodesChange, onDirty]
  );

  const handleEdgesChange: typeof onEdgesChange = useCallback(
    changes => {
      onEdgesChange(changes);
      if (changes.some(c => c.type !== 'select')) {
        onDirty();
      }
    },
    [onEdgesChange, onDirty]
  );

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onNodeClick={(_e, node): void => {
          onNodeSelect(node.id);
        }}
        onPaneClick={(): void => {
          onNodeSelect(null);
        }}
        nodeTypes={nodeTypes}
        fitView
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border)" />
      </ReactFlow>
    </div>
  );
}
