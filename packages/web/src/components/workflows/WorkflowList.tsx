import { useEffect, useRef, useState, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { listWorkflows, createConversation, runWorkflow, deleteConversation } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useProject } from '@/contexts/ProjectContext';
import { WorkflowCard } from '@/components/workflows/WorkflowCard';
import { getWorkflowCategory, CATEGORIES, type WorkflowCategory } from '@/lib/workflow-metadata';

export function WorkflowList(): React.ReactElement {
  const navigate = useNavigate();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [runMessage, setRunMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<WorkflowCategory>('All');
  const { codebases, selectedProjectId } = useProject();
  const [localProjectId, setLocalProjectId] = useState<string | null>(selectedProjectId);
  const runPanelRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalProjectId(selectedProjectId);
  }, [selectedProjectId]);

  // Scroll run panel into view and focus message input when a workflow is selected
  useEffect(() => {
    if (selectedWorkflow) {
      // Small delay to let the panel render before scrolling
      requestAnimationFrame(() => {
        runPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        messageInputRef.current?.focus();
      });
    }
  }, [selectedWorkflow]);

  // Reset selection when filters change so stale run panel state doesn't persist
  useEffect(() => {
    setSelectedWorkflow(null);
    setRunMessage('');
    setRunError(null);
  }, [searchQuery, activeCategory]);

  const handleRun = async (workflowName: string): Promise<void> => {
    if (!runMessage.trim() || running) return;
    setRunning(true);
    setRunError(null);
    let conversationId: string | undefined;
    let workflowStarted = false;
    try {
      ({ conversationId } = await createConversation(localProjectId ?? undefined));
      await runWorkflow(workflowName, conversationId, runMessage.trim());
      workflowStarted = true;
      setRunMessage('');
      setSelectedWorkflow(null);
      navigate(`/chat/${conversationId}`);
    } catch (error) {
      console.error('[Workflows] Failed to run workflow', { error });
      setRunError(
        error instanceof Error
          ? `Failed to start workflow: ${error.message}`
          : 'Failed to start workflow. Check server connectivity.'
      );
      if (conversationId !== undefined && !workflowStarted) {
        void deleteConversation(conversationId).catch((cleanupErr: unknown) => {
          console.warn('[Workflows] Failed to clean up orphan conversation', {
            conversationId,
            error: cleanupErr,
          });
        });
      }
    } finally {
      setRunning(false);
    }
  };

  const selectedCwd = localProjectId
    ? codebases?.find(cb => cb.id === localProjectId)?.default_cwd
    : undefined;

  const {
    data: workflows,
    isLoading: loadingWorkflows,
    isError: workflowsError,
  } = useQuery({
    queryKey: ['workflows', selectedCwd ?? null],
    queryFn: () => listWorkflows(selectedCwd),
  });

  // Filter workflows by search query and category
  const filteredWorkflows = useMemo(() => {
    if (!workflows) return [];
    return workflows.filter(wf => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = wf.name.toLowerCase().includes(query);
        const matchesDesc = wf.description?.toLowerCase().includes(query) ?? false;
        if (!matchesName && !matchesDesc) return false;
      }
      // Category filter
      if (activeCategory !== 'All') {
        const cat = getWorkflowCategory(wf.name, wf.description ?? '');
        if (cat !== activeCategory) return false;
      }
      return true;
    });
  }, [workflows, searchQuery, activeCategory]);

  if (loadingWorkflows) {
    return (
      <div className="flex items-center justify-center h-32 text-text-secondary text-sm">
        Loading workflows...
      </div>
    );
  }

  if (workflowsError) {
    return (
      <div className="text-sm text-error">Failed to load workflows. Check server connectivity.</div>
    );
  }

  const hasWorkflows = workflows != null && workflows.length > 0;

  return (
    <div className="space-y-4">
      {/* Search + Category Filters — only show when workflows exist */}
      {hasWorkflows && (
        <div className="space-y-3">
          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e): void => {
                setSearchQuery(e.target.value);
              }}
              placeholder="Search workflows..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Category filter tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={(): void => {
                  setActiveCategory(cat);
                }}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  activeCategory === cat
                    ? 'bg-primary text-white'
                    : 'bg-surface-elevated text-text-secondary hover:text-text-primary'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Workflow grid */}
      {!hasWorkflows ? (
        <div className="text-sm text-text-secondary">
          No workflows found. Add workflow definitions to{' '}
          <code className="text-xs bg-surface-inset px-1 py-0.5 rounded">.archon/workflows/</code>
        </div>
      ) : filteredWorkflows.length === 0 ? (
        <div className="text-sm text-text-secondary py-8 text-center">
          No workflows match your search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredWorkflows.map(wf => (
              <WorkflowCard
                key={wf.name}
                workflow={wf}
                isSelected={selectedWorkflow === wf.name}
                onToggle={(name): void => {
                  setSelectedWorkflow(selectedWorkflow === name ? null : name);
                  setRunMessage('');
                  setRunError(null);
                }}
                onRun={(name): void => {
                  setSelectedWorkflow(name);
                  setRunMessage('');
                  setRunError(null);
                }}
              />
            ))}
          </div>

          {/* Run panel — rendered outside the grid so it's fully visible */}
          {selectedWorkflow && (
            <div
              ref={runPanelRef}
              className="p-4 rounded-lg border border-accent/50 bg-surface-inset"
            >
              <h3 className="text-sm font-medium text-text-primary mb-3">
                Run <span className="font-mono text-accent-bright">{selectedWorkflow}</span>
              </h3>
              <div className="flex items-center gap-2 mb-2">
                <label className="text-xs text-text-secondary shrink-0">Project</label>
                <select
                  value={localProjectId ?? ''}
                  onChange={(e): void => {
                    setLocalProjectId(e.target.value || null);
                  }}
                  className="flex-1 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">No project (orchestrator decides)</option>
                  {codebases?.map(cb => (
                    <option key={cb.id} value={cb.id}>
                      {cb.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  ref={messageInputRef}
                  type="text"
                  value={runMessage}
                  onChange={(e): void => {
                    setRunMessage(e.target.value);
                  }}
                  placeholder="Enter a message for this workflow..."
                  className="flex-1 px-3 py-2 rounded-md border border-border bg-surface text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                  onKeyDown={(e): void => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleRun(selectedWorkflow);
                    }
                  }}
                  disabled={running}
                />
                <Button
                  size="sm"
                  onClick={(): void => {
                    void handleRun(selectedWorkflow);
                  }}
                  disabled={running || !runMessage.trim()}
                >
                  {running ? 'Starting...' : 'Run'}
                </Button>
              </div>
              {runError && <p className="text-xs text-error mt-2">{runError}</p>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
