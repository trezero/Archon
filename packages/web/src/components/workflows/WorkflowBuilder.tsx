import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider, useNodesState, useEdgesState } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import type {
  WorkflowDefinition,
  WorkflowStep,
  LoopConfig,
  SingleStep,
  ParallelBlock,
} from '@archon/workflows';
import { isDagWorkflow, isParallelBlock } from '@archon/workflows';
import { useProject } from '@/contexts/ProjectContext';
import { getWorkflow, listCommands, type CommandEntry } from '@/lib/api';
import { WorkflowToolbar, type BuilderMode } from './WorkflowToolbar';
import { NodePalette } from './NodePalette';
import { WorkflowCanvas, dagNodesToReactFlow, reactFlowToDagNodes } from './WorkflowCanvas';
import { NodeInspector } from './NodeInspector';
import { SequentialEditor } from './SequentialEditor';
import { LoopEditor } from './LoopEditor';
import type { DagNodeData, DagFlowNode } from './DagNodeComponent';

const DEFAULT_LOOP_CONFIG: LoopConfig = {
  until: 'COMPLETE',
  max_iterations: 10,
  fresh_context: false,
};

function WorkflowBuilderInner(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const editName = searchParams.get('edit');

  const { codebases, selectedProjectId } = useProject();
  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  // Core state
  const [mode, setMode] = useState<BuilderMode>('dag');
  const [workflowName, setWorkflowName] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [provider, setProvider] = useState<'claude' | 'codex' | undefined>(undefined);
  const [model, setModel] = useState<string | undefined>(undefined);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // DAG state
  const [nodes, setNodes, onNodesChange] = useNodesState<DagFlowNode>([]);
  const initialEdges: Edge[] = [];
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Sequential state
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  // Loop state
  const [loopPrompt, setLoopPrompt] = useState('');
  const [loopConfig, setLoopConfig] = useState<LoopConfig>(DEFAULT_LOOP_CONFIG);

  // Commands for palette/inspector
  const { data: commands, isError: commandsError } = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => listCommands(cwd),
  });
  const commandList: CommandEntry[] = commands ?? [];

  const markDirty = useCallback((): void => {
    setHasUnsavedChanges(true);
  }, []);

  const buildDefinition = useCallback((): WorkflowDefinition => {
    const name = workflowName.trim() || 'untitled';
    const description = workflowDescription;

    switch (mode) {
      case 'dag': {
        const dagNodes = reactFlowToDagNodes(nodes, edges);
        return { name, description, provider, model, nodes: dagNodes };
      }
      case 'loop':
        return { name, description, provider, model, prompt: loopPrompt, loop: loopConfig };
      case 'sequential':
        return { name, description, provider, model, steps };
      default: {
        const exhaustiveCheck: never = mode;
        throw new Error(`Unknown builder mode: ${String(exhaustiveCheck)}`);
      }
    }
  }, [
    mode,
    workflowName,
    workflowDescription,
    provider,
    model,
    nodes,
    edges,
    steps,
    loopPrompt,
    loopConfig,
  ]);

  const loadWorkflow = useCallback(
    async (name: string): Promise<void> => {
      try {
        const { workflow } = await getWorkflow(name, cwd);
        setWorkflowName(workflow.name);
        setWorkflowDescription(workflow.description);
        setProvider(workflow.provider);
        setModel(workflow.model);
        setValidationErrors([]);

        if (isDagWorkflow(workflow)) {
          setMode('dag');
          const { nodes: rfNodes, edges: rfEdges } = dagNodesToReactFlow(workflow.nodes);
          setNodes(rfNodes);
          setEdges(rfEdges);
        } else if ('loop' in workflow && workflow.loop) {
          setMode('loop');
          setLoopPrompt(workflow.prompt ?? '');
          setLoopConfig(workflow.loop);
        } else if ('steps' in workflow && workflow.steps) {
          setMode('sequential');
          setSteps([...workflow.steps] as WorkflowStep[]);
        } else {
          setValidationErrors([
            'Workflow has an unrecognized structure and cannot be loaded in the builder.',
          ]);
          return;
        }

        setHasUnsavedChanges(false);
      } catch (err) {
        console.error('[WorkflowBuilder] Failed to load workflow:', err);
        setValidationErrors([
          `Failed to load workflow: ${err instanceof Error ? err.message : String(err)}`,
        ]);
      }
    },
    [cwd, setNodes, setEdges]
  );

  // Auto-load if ?edit= is present
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (editName && !autoLoaded.current) {
      autoLoaded.current = true;
      void loadWorkflow(editName);
    }
  }, [editName, loadWorkflow]);

  const handleNodeUpdate = useCallback(
    (updates: Partial<DagNodeData>): void => {
      setNodes(nds =>
        nds.map(n => (n.id === selectedNodeId ? { ...n, data: { ...n.data, ...updates } } : n))
      );
      markDirty();
    },
    [selectedNodeId, setNodes, markDirty]
  );

  const handleNodeDelete = useCallback((): void => {
    if (!selectedNodeId) return;
    setNodes(nds => nds.filter(n => n.id !== selectedNodeId));
    setEdges(eds => eds.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    markDirty();
  }, [selectedNodeId, setNodes, setEdges, markDirty]);

  const handleStepUpdate = useCallback(
    (updates: Partial<SingleStep>): void => {
      if (selectedStepIndex === null) return;
      setSteps(prev => prev.map((s, i) => (i === selectedStepIndex ? { ...s, ...updates } : s)));
      markDirty();
    },
    [selectedStepIndex, markDirty]
  );

  const handleStepDelete = useCallback((): void => {
    if (selectedStepIndex === null) return;
    setSteps(prev => prev.filter((_, i) => i !== selectedStepIndex));
    setSelectedStepIndex(null);
    markDirty();
  }, [selectedStepIndex, markDirty]);

  const ungroupBlock = useCallback(
    (index: number): void => {
      const step = steps[index];
      if (!isParallelBlock(step)) return;
      const newSteps = [...steps];
      newSteps.splice(index, 1, ...(step.parallel as SingleStep[]));
      setSteps(newSteps);
      if (selectedStepIndex === index) setSelectedStepIndex(null);
      markDirty();
    },
    [steps, selectedStepIndex, markDirty]
  );

  const handleBlockUpdate = useCallback(
    (block: ParallelBlock): void => {
      if (selectedStepIndex === null) return;
      setSteps(prev => prev.map((s, i) => (i === selectedStepIndex ? block : s)));
      markDirty();
    },
    [selectedStepIndex, markDirty]
  );

  const handleUngroup = useCallback((): void => {
    if (selectedStepIndex === null) return;
    ungroupBlock(selectedStepIndex);
  }, [selectedStepIndex, ungroupBlock]);

  const selectedNode = selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null;

  const selectedStep = selectedStepIndex !== null ? steps[selectedStepIndex] : null;

  return (
    <div className="flex flex-col h-full">
      <WorkflowToolbar
        mode={mode}
        onModeChange={setMode}
        workflowName={workflowName}
        onNameChange={(n): void => {
          setWorkflowName(n);
          markDirty();
        }}
        workflowDescription={workflowDescription}
        onDescriptionChange={(d): void => {
          setWorkflowDescription(d);
          markDirty();
        }}
        provider={provider}
        onProviderChange={(p): void => {
          setProvider(p);
          markDirty();
        }}
        model={model}
        onModelChange={(m): void => {
          setModel(m);
          markDirty();
        }}
        hasUnsavedChanges={hasUnsavedChanges}
        buildDefinition={buildDefinition}
        onLoadWorkflow={(name): void => {
          void loadWorkflow(name);
        }}
        validationErrors={validationErrors}
        onValidationErrors={setValidationErrors}
        onSaveSuccess={(): void => {
          setHasUnsavedChanges(false);
        }}
      />

      {commandsError && (
        <div className="px-4 py-1.5 text-xs text-error bg-surface-inset border-b border-border">
          Failed to load commands. Command palette and dropdowns may be empty.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* DAG mode: palette + canvas */}
        {mode === 'dag' && (
          <>
            <div className="w-52 border-r border-border overflow-auto shrink-0">
              <NodePalette />
            </div>
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1">
                <WorkflowCanvas
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  setNodes={setNodes}
                  setEdges={setEdges}
                  onNodeSelect={setSelectedNodeId}
                  onDirty={markDirty}
                />
              </div>
            </div>
          </>
        )}

        {/* Sequential mode */}
        {mode === 'sequential' && (
          <div className="flex-1 overflow-hidden">
            <SequentialEditor
              steps={steps}
              commands={commandList}
              selectedStepIndex={selectedStepIndex}
              onStepsChange={(s): void => {
                setSteps(s);
                markDirty();
              }}
              onSelectStep={setSelectedStepIndex}
              onUngroup={ungroupBlock}
              onDirty={markDirty}
            />
          </div>
        )}

        {/* Loop mode */}
        {mode === 'loop' && (
          <div className="flex-1 overflow-hidden">
            <LoopEditor
              prompt={loopPrompt}
              loop={loopConfig}
              onPromptChange={setLoopPrompt}
              onLoopChange={setLoopConfig}
              onDirty={markDirty}
            />
          </div>
        )}
      </div>

      {/* Inspector panel */}
      {mode === 'dag' && selectedNode && (
        <NodeInspector
          key={selectedNode.id}
          mode="dag"
          node={selectedNode.data}
          commands={commandList}
          onUpdate={handleNodeUpdate}
          onDelete={handleNodeDelete}
        />
      )}
      {mode === 'sequential' &&
        selectedStep &&
        selectedStepIndex !== null &&
        ('command' in selectedStep ? (
          <NodeInspector
            mode="sequential"
            step={selectedStep}
            stepIndex={selectedStepIndex}
            commands={commandList}
            onUpdate={handleStepUpdate}
            onDelete={handleStepDelete}
          />
        ) : isParallelBlock(selectedStep) ? (
          <NodeInspector
            mode="parallel"
            block={selectedStep}
            blockIndex={selectedStepIndex}
            commands={commandList}
            onUpdate={handleBlockUpdate}
            onUngroup={handleUngroup}
            onDelete={handleStepDelete}
          />
        ) : null)}
    </div>
  );
}

export function WorkflowBuilder(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner />
    </ReactFlowProvider>
  );
}
