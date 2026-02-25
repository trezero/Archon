import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  listWorkflows,
  validateWorkflow,
  saveWorkflow,
  createConversation,
  runWorkflow,
} from '@/lib/api';
import { useProject } from '@/contexts/ProjectContext';
import type { WorkflowDefinition } from '@archon/core/workflows/types';

export type BuilderMode = 'dag' | 'sequential' | 'loop';

interface WorkflowToolbarProps {
  mode: BuilderMode;
  onModeChange: (mode: BuilderMode) => void;
  workflowName: string;
  onNameChange: (name: string) => void;
  workflowDescription: string;
  onDescriptionChange: (desc: string) => void;
  provider: 'claude' | 'codex' | undefined;
  onProviderChange: (p: 'claude' | 'codex' | undefined) => void;
  model: string | undefined;
  onModelChange: (m: string | undefined) => void;
  hasUnsavedChanges: boolean;
  buildDefinition: () => WorkflowDefinition;
  onLoadWorkflow: (name: string) => void;
  validationErrors: string[];
  onValidationErrors: (errors: string[]) => void;
  onSaveSuccess: () => void;
}

export function WorkflowToolbar({
  mode,
  onModeChange,
  workflowName,
  onNameChange,
  workflowDescription,
  onDescriptionChange,
  provider,
  onProviderChange,
  model,
  onModelChange,
  hasUnsavedChanges,
  buildDefinition,
  onLoadWorkflow,
  validationErrors,
  onValidationErrors,
  onSaveSuccess,
}: WorkflowToolbarProps): React.ReactElement {
  const navigate = useNavigate();
  const { codebases, selectedProjectId } = useProject();
  const cwd = selectedProjectId
    ? codebases?.find(cb => cb.id === selectedProjectId)?.default_cwd
    : undefined;

  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [pendingMode, setPendingMode] = useState<BuilderMode | null>(null);

  const {
    data: workflows,
    isError: workflowsError,
    error: workflowsLoadError,
  } = useQuery({
    queryKey: ['workflows', cwd],
    queryFn: () => listWorkflows(cwd),
  });

  const userWorkflows = workflows ?? [];

  const handleValidate = async (): Promise<void> => {
    setValidating(true);
    setSaveError(null);
    try {
      const def = buildDefinition();
      const result = await validateWorkflow(def);
      if (result.valid) {
        onValidationErrors([]);
      } else {
        onValidationErrors(result.errors ?? ['Unknown validation error']);
      }
    } catch (err) {
      console.error('[WorkflowToolbar] Validation request failed:', err);
      onValidationErrors([
        `Validation request failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      ]);
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!workflowName.trim()) {
      setSaveError('Workflow name is required');
      return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const def = buildDefinition();
      // Client-side validation for immediate UX feedback (backend also validates on save)
      const validation = await validateWorkflow(def);
      if (!validation.valid) {
        onValidationErrors(validation.errors ?? ['Workflow is invalid']);
        setSaving(false);
        return;
      }
      onValidationErrors([]);
      await saveWorkflow(workflowName.trim(), def, cwd);
      setSaveSuccess(true);
      onSaveSuccess();
      setTimeout(() => {
        setSaveSuccess(false);
      }, 2000);
    } catch (err) {
      console.error('[WorkflowToolbar] Save failed:', err);
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleRun = async (): Promise<void> => {
    if (!workflowName.trim()) {
      setRunError('Workflow name is required');
      return;
    }
    if (hasUnsavedChanges) {
      setRunError('Please save the workflow before running');
      return;
    }
    setRunning(true);
    setRunError(null);
    setSaveError(null);
    onValidationErrors([]);
    try {
      const result = await createConversation(selectedProjectId ?? undefined);
      const conversationId = result.conversationId;
      await runWorkflow(workflowName.trim(), conversationId, '');
      navigate(`/chat/${conversationId}`);
    } catch (err) {
      console.error('[WorkflowToolbar] Run failed:', err);
      setRunError(err instanceof Error ? err.message : 'Failed to run');
    } finally {
      setRunning(false);
    }
  };

  const handleModeSwitch = (newMode: BuilderMode): void => {
    if (newMode === mode) return;
    if (hasUnsavedChanges) {
      setPendingMode(newMode);
    } else {
      onModeChange(newMode);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border flex-wrap">
        {/* Mode tabs */}
        <Tabs value={mode} className="gap-0">
          <TabsList>
            <TabsTrigger
              value="dag"
              onClick={(): void => {
                handleModeSwitch('dag');
              }}
            >
              DAG
            </TabsTrigger>
            <TabsTrigger
              value="sequential"
              onClick={(): void => {
                handleModeSwitch('sequential');
              }}
            >
              Sequential
            </TabsTrigger>
            <TabsTrigger
              value="loop"
              onClick={(): void => {
                handleModeSwitch('loop');
              }}
            >
              Loop
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Name */}
        <input
          type="text"
          value={workflowName}
          onChange={(e): void => {
            onNameChange(e.target.value);
          }}
          placeholder="workflow-name"
          className="w-40 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {hasUnsavedChanges && (
          <span className="text-accent text-sm" title="Unsaved changes">
            *
          </span>
        )}

        {/* Description */}
        <input
          type="text"
          value={workflowDescription}
          onChange={(e): void => {
            onDescriptionChange(e.target.value);
          }}
          placeholder="Description..."
          className="flex-1 min-w-[120px] rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />

        {/* Provider */}
        <select
          value={provider ?? ''}
          onChange={(e): void => {
            onProviderChange((e.target.value || undefined) as 'claude' | 'codex' | undefined);
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">Provider (default)</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>

        {/* Model */}
        <input
          type="text"
          value={model ?? ''}
          onChange={(e): void => {
            onModelChange(e.target.value || undefined);
          }}
          placeholder="Model"
          className="w-24 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />

        {/* Load existing */}
        <select
          value=""
          onChange={(e): void => {
            if (e.target.value) onLoadWorkflow(e.target.value);
          }}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">{workflowsError ? 'Failed to load' : 'Load...'}</option>
          {userWorkflows.map(wf => (
            <option key={wf.name} value={wf.name}>
              {wf.name}
            </option>
          ))}
        </select>

        {/* Actions */}
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={(): void => {
              void handleValidate();
            }}
            disabled={validating}
            className="rounded-md border border-border px-3 py-1 text-xs text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {validating ? 'Validating...' : 'Validate'}
          </button>
          <button
            type="button"
            onClick={(): void => {
              void handleSave();
            }}
            disabled={saving || !workflowName.trim()}
            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            onClick={(): void => {
              void handleRun();
            }}
            disabled={running || !workflowName.trim() || hasUnsavedChanges}
            className="rounded-md border border-accent bg-accent/10 px-3 py-1 text-xs text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
            title={hasUnsavedChanges ? 'Save the workflow before running' : undefined}
          >
            {running ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>

      {/* Feedback row */}
      {(validationErrors.length > 0 || saveError || runError || saveSuccess || workflowsError) && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-border bg-surface-inset">
          {validationErrors.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {validationErrors.map((err, i) => (
                <p key={i} className="text-xs text-error">
                  {err}
                </p>
              ))}
            </div>
          )}
          {saveError && <p className="text-xs text-error">{saveError}</p>}
          {runError && <p className="text-xs text-error">Run failed: {runError}</p>}
          {workflowsError && (
            <p className="text-xs text-error">
              Failed to load workflows:{' '}
              {workflowsLoadError instanceof Error ? workflowsLoadError.message : 'Unknown error'}
            </p>
          )}
          {saveSuccess && <p className="text-xs text-success">Saved successfully</p>}
        </div>
      )}

      {/* Mode switch confirmation */}
      <AlertDialog
        open={pendingMode !== null}
        onOpenChange={(open): void => {
          if (!open) setPendingMode(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Switching modes will discard them. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(): void => {
                if (pendingMode) {
                  onModeChange(pendingMode);
                  setPendingMode(null);
                }
              }}
            >
              Discard & Switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
