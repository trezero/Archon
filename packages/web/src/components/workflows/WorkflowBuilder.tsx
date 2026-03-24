import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ReactFlowProvider, useNodesState, useEdgesState, useViewport } from '@xyflow/react';
import type { Edge } from '@xyflow/react';
import type {
  WorkflowDefinition,
  WorkflowStep,
  LoopConfig,
  SingleStep,
  ParallelBlock,
} from '@archon/workflows/types';
import { isDagWorkflow, isParallelBlock } from '@archon/workflows/types';
import { useProject } from '@/contexts/ProjectContext';
import {
  getWorkflow,
  listCommands,
  validateWorkflow,
  saveWorkflow,
  createConversation,
  runWorkflow,
} from '@/lib/api';
import type { CommandEntry } from '@/lib/api';
import { dagNodesToReactFlow } from '@/lib/dag-layout';
import { useBuilderKeyboard } from '@/hooks/useBuilderKeyboard';
import { useBuilderUndo } from '@/hooks/useBuilderUndo';
import { useBuilderValidation } from '@/hooks/useBuilderValidation';
import type { ValidationIssue } from '@/hooks/useBuilderValidation';
import { BuilderToolbar } from './BuilderToolbar';
import type { BuilderMode, ViewMode } from './BuilderToolbar';
import { NodeLibrary } from './NodeLibrary';
import { WorkflowCanvas, reactFlowToDagNodes } from './WorkflowCanvas';
import { NodeInspector } from './NodeInspector';
import { SequentialEditor } from './SequentialEditor';
import { LoopEditor } from './LoopEditor';
import { ValidationPanel } from './ValidationPanel';
import { StatusBar } from './StatusBar';
import { YamlCodeView } from './YamlCodeView';
import type { DagNodeData, DagFlowNode } from './DagNodeComponent';

const DEFAULT_LOOP_CONFIG: LoopConfig = {
  until: 'COMPLETE',
  max_iterations: 10,
  fresh_context: false,
};

function WorkflowBuilderInner(): React.ReactElement {
  const [searchParams] = useSearchParams();
  const editName = searchParams.get('edit');
  const navigate = useNavigate();

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

  const [yamlViewMode, setYamlViewMode] = useState<ViewMode>('hidden');
  const [validationPanelOpen, setValidationPanelOpen] = useState(false);
  const [showLibrary, setShowLibrary] = useState(true);

  // DAG state
  const [nodes, setNodes, onNodesChange] = useNodesState<DagFlowNode>([]);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-arguments -- TSC infers never[] without explicit Edge
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Sequential state
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  // Loop state
  const [loopPrompt, setLoopPrompt] = useState('');
  const [loopConfig, setLoopConfig] = useState<LoopConfig>(DEFAULT_LOOP_CONFIG);

  // Commands for palette/inspector
  const {
    data: commands,
    isError: commandsError,
    isLoading: commandsLoading,
  } = useQuery({
    queryKey: ['commands', cwd],
    queryFn: () => listCommands(cwd),
  });
  const commandList: CommandEntry[] = commands ?? [];

  const { pushSnapshot, undo, redo } = useBuilderUndo();
  const { zoom } = useViewport();

  const validationIssues = useBuilderValidation(
    mode,
    workflowName,
    workflowDescription,
    nodes,
    edges
  );
  const errorCount = useMemo(
    () => validationIssues.filter(i => i.severity === 'error').length,
    [validationIssues]
  );
  const warningCount = useMemo(
    () => validationIssues.filter(i => i.severity === 'warning').length,
    [validationIssues]
  );

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
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[workflow-builder] workflow.load_failed', {
          workflowName: name,
          cwd,
          error,
        });
        setValidationErrors([`Failed to load workflow: ${error.message}`]);
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

  const handleToggleValidationPanel = useCallback((): void => {
    setValidationPanelOpen(v => !v);
  }, []);

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
    pushSnapshot({ nodes, edges });
    setNodes(nds => nds.filter(n => n.id !== selectedNodeId));
    setEdges(eds => eds.filter(e => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    markDirty();
  }, [selectedNodeId, setNodes, setEdges, markDirty, pushSnapshot, nodes, edges]);

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

  // Toolbar action handlers
  const handleValidate = useCallback(async (): Promise<void> => {
    try {
      const def = buildDefinition();
      const result = await validateWorkflow(def);
      if (result.valid) {
        setValidationErrors([]);
      } else {
        setValidationErrors(result.errors ?? ['Unknown validation error']);
      }
      setValidationPanelOpen(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.validate_failed', { workflowName, error });
      setValidationErrors([`Validation request failed: ${error.message}`]);
    }
  }, [buildDefinition]);

  const handleSave = useCallback(async (): Promise<void> => {
    if (!workflowName.trim()) {
      setValidationErrors(['Workflow name is required']);
      return;
    }
    try {
      const def = buildDefinition();
      const validation = await validateWorkflow(def);
      if (!validation.valid) {
        setValidationErrors(validation.errors ?? ['Workflow is invalid']);
        return;
      }
      setValidationErrors([]);
      await saveWorkflow(workflowName.trim(), def, cwd);
      setHasUnsavedChanges(false);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.save_failed', { workflowName, cwd, error });
      setValidationErrors([`Save failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [buildDefinition, workflowName, cwd]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!workflowName.trim() || hasUnsavedChanges) return;
    try {
      const result = await createConversation(selectedProjectId ?? undefined);
      const conversationId = result.conversationId;
      await runWorkflow(workflowName.trim(), conversationId, '');
      navigate(`/chat/${conversationId}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Unknown error');
      console.error('[workflow-builder] workflow.run_failed', { workflowName, error });
      setValidationErrors([`Run failed: ${error.message}`]);
      setValidationPanelOpen(true);
    }
  }, [workflowName, hasUnsavedChanges, selectedProjectId, navigate]);

  // Undo/redo handlers
  const handleUndo = useCallback((): void => {
    const state = undo();
    if (state) {
      setNodes(state.nodes);
      setEdges(state.edges);
    }
  }, [undo, setNodes, setEdges]);

  const handleRedo = useCallback((): void => {
    const state = redo();
    if (state) {
      setNodes(state.nodes);
      setEdges(state.edges);
    }
  }, [redo, setNodes, setEdges]);

  // Convert validation issues to string array for toolbar display
  const toolbarValidationErrors = useMemo(
    (): string[] => [
      ...validationErrors,
      ...validationIssues.filter(i => i.severity === 'error').map(i => i.message),
    ],
    [validationErrors, validationIssues]
  );

  // Convert validation issues for the panel (merge server-side errors with client-side)
  const allValidationIssues = useMemo((): ValidationIssue[] => {
    const serverIssues: ValidationIssue[] = validationErrors.map(msg => ({
      severity: 'error' as const,
      message: msg,
    }));
    return [...serverIssues, ...validationIssues];
  }, [validationErrors, validationIssues]);

  // Keyboard shortcuts — stabilize actions object to avoid re-registering handler on every render
  const keyboardActions = useMemo(
    () => ({
      onSave: (): void => void handleSave(),
      onUndo: handleUndo,
      onRedo: handleRedo,
      onToggleLibrary: (): void => {
        setShowLibrary(v => !v);
      },
      onToggleYaml: (): void => {
        setYamlViewMode(v => {
          const modes: ViewMode[] = ['hidden', 'split', 'full'];
          const idx = modes.indexOf(v);
          return modes[(idx + 1) % modes.length];
        });
      },
      onToggleValidation: handleToggleValidationPanel,
      onAddPrompt: (): void => {
        if (mode !== 'dag') return;
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: 200, y: 200 },
          data: { id, label: 'Prompt', nodeType: 'prompt' },
        };
        pushSnapshot({ nodes, edges });
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
      onAddBash: (): void => {
        if (mode !== 'dag') return;
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: 200, y: 200 },
          data: { id, label: 'Shell', nodeType: 'bash' },
        };
        pushSnapshot({ nodes, edges });
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
      onDeleteSelected: (): void => {
        if (selectedNodeId && mode === 'dag') {
          handleNodeDelete();
        }
      },
      onDuplicateSelected: (): void => {
        if (!selectedNodeId || mode !== 'dag') return;
        const sourceNode = nodes.find(n => n.id === selectedNodeId);
        if (!sourceNode) return;
        const id = `node-${crypto.randomUUID()}`;
        const newNode: DagFlowNode = {
          id,
          type: 'dagNode',
          position: { x: sourceNode.position.x + 30, y: sourceNode.position.y + 30 },
          data: { ...sourceNode.data, id },
        };
        pushSnapshot({ nodes, edges });
        setNodes(nds => [...nds, newNode]);
        markDirty();
      },
    }),
    [
      handleSave,
      handleUndo,
      handleRedo,
      handleToggleValidationPanel,
      handleNodeDelete,
      mode,
      nodes,
      edges,
      selectedNodeId,
      pushSnapshot,
      setNodes,
      markDirty,
    ]
  );
  useBuilderKeyboard(keyboardActions, true);

  const selectedNode = selectedNodeId ? nodes.find(n => n.id === selectedNodeId) : null;

  const selectedStep = selectedStepIndex !== null ? steps[selectedStepIndex] : null;

  return (
    <div className="flex flex-col h-full">
      <BuilderToolbar
        workflowName={workflowName}
        workflowDescription={workflowDescription}
        mode={mode}
        provider={provider}
        model={model}
        hasUnsavedChanges={hasUnsavedChanges}
        validationErrors={toolbarValidationErrors}
        viewMode={yamlViewMode}
        onNameChange={(n): void => {
          setWorkflowName(n);
          markDirty();
        }}
        onDescriptionChange={(d): void => {
          setWorkflowDescription(d);
          markDirty();
        }}
        onModeChange={setMode}
        onProviderChange={(p): void => {
          setProvider(p);
          markDirty();
        }}
        onModelChange={(m): void => {
          setModel(m);
          markDirty();
        }}
        onViewModeChange={setYamlViewMode}
        onValidate={(): void => {
          void handleValidate();
        }}
        onSave={(): void => {
          void handleSave();
        }}
        onRun={(): void => {
          void handleRun();
        }}
        onLoadWorkflow={(name): void => {
          void loadWorkflow(name);
        }}
      />

      {commandsError && (
        <div className="px-4 py-1.5 text-xs text-error bg-surface-inset border-b border-border">
          Failed to load commands. Command palette and dropdowns may be empty.
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Node Library (DAG mode only) */}
        {mode === 'dag' && showLibrary && (
          <div className="w-52 shrink-0 h-full overflow-hidden">
            <NodeLibrary commands={commandList} isLoading={commandsLoading} />
          </div>
        )}

        {/* Center area */}
        <div className="flex-1 relative overflow-hidden flex">
          {yamlViewMode === 'full' ? (
            <YamlCodeView definition={buildDefinition()} mode="full" />
          ) : (
            <>
              <div className="flex-1 relative overflow-hidden">
                {mode === 'dag' && (
                  <WorkflowCanvas
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    setNodes={setNodes}
                    setEdges={setEdges}
                    onNodeSelect={setSelectedNodeId}
                    onDirty={markDirty}
                    onPushSnapshot={(): void => {
                      pushSnapshot({ nodes, edges });
                    }}
                    commands={commandList}
                  />
                )}

                {mode === 'sequential' && (
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
                )}

                {mode === 'loop' && (
                  <LoopEditor
                    prompt={loopPrompt}
                    loop={loopConfig}
                    onPromptChange={setLoopPrompt}
                    onLoopChange={setLoopConfig}
                    onDirty={markDirty}
                  />
                )}
              </div>

              {yamlViewMode === 'split' && (
                <div className="w-80 border-l border-border shrink-0">
                  <YamlCodeView definition={buildDefinition()} mode="split" />
                </div>
              )}
            </>
          )}
        </div>

        {/* Right panel: Node Inspector (DAG mode only) */}
        {selectedNodeId && selectedNode && mode === 'dag' && yamlViewMode !== 'full' && (
          <div className="w-72 shrink-0">
            <NodeInspector
              node={selectedNode.data}
              commands={commandList}
              onUpdate={handleNodeUpdate}
              onDelete={handleNodeDelete}
              onClose={(): void => {
                setSelectedNodeId(null);
              }}
            />
          </div>
        )}
      </div>

      {/* Inspector for sequential/parallel modes (bottom panel) */}
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

      {/* Validation Panel */}
      <ValidationPanel
        issues={allValidationIssues}
        isOpen={validationPanelOpen}
        onToggle={handleToggleValidationPanel}
        onFocusNode={setSelectedNodeId}
      />

      {/* Status Bar */}
      <StatusBar
        mode={mode}
        nodeCount={nodes.length}
        edgeCount={edges.length}
        errorCount={errorCount}
        warningCount={warningCount}
        hasUnsavedChanges={hasUnsavedChanges}
        zoomLevel={Math.round(zoom * 100)}
        onValidationClick={handleToggleValidationPanel}
      />
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
