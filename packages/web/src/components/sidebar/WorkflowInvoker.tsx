import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X } from 'lucide-react';
import { listWorkflows, createConversation, runWorkflow } from '@/lib/api';

interface WorkflowInvokerProps {
  codebaseId: string;
}

export function WorkflowInvoker({ codebaseId }: WorkflowInvokerProps): React.ReactElement | null {
  const navigate = useNavigate();
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: workflows } = useQuery({
    queryKey: ['workflows'],
    queryFn: () => listWorkflows(),
  });

  if (!workflows || workflows.length === 0) return null;

  const handleCancel = (): void => {
    setSelectedWorkflow(null);
    setMessage('');
    setError(null);
  };

  const handleRun = async (): Promise<void> => {
    if (!selectedWorkflow || !message.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const { conversationId } = await createConversation(codebaseId);
      await runWorkflow(selectedWorkflow, conversationId, message.trim());
      setSelectedWorkflow(null);
      setMessage('');
      navigate(`/chat/${conversationId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setRunning(false);
    }
  };

  if (!selectedWorkflow) {
    return (
      <div className="mx-1">
        <select
          value=""
          onChange={(e): void => {
            setSelectedWorkflow(e.target.value);
            setError(null);
          }}
          className="w-full rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-xs text-text-secondary cursor-pointer focus:border-primary focus:outline-none"
        >
          <option value="" disabled>
            Run workflow...
          </option>
          {workflows.map(wf => (
            <option key={wf.name} value={wf.name}>
              {wf.name}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="mx-1 rounded-md border border-border bg-surface-elevated p-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-text-primary">{selectedWorkflow}</span>
        <button
          onClick={handleCancel}
          className="p-0.5 rounded hover:bg-surface transition-colors"
          title="Cancel"
        >
          <X className="h-3 w-3 text-text-tertiary" />
        </button>
      </div>
      <input
        type="text"
        value={message}
        onChange={(e): void => {
          setMessage(e.target.value);
        }}
        onKeyDown={(e): void => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void handleRun();
          }
          if (e.key === 'Escape') handleCancel();
        }}
        placeholder="Enter message..."
        disabled={running}
        className="w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none disabled:opacity-50"
        autoFocus
      />
      <div className="flex items-center justify-end gap-2 mt-1.5">
        {error && <span className="text-[10px] text-error flex-1 line-clamp-1">{error}</span>}
        <button
          onClick={(): void => {
            void handleRun();
          }}
          disabled={running || !message.trim()}
          className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          {running && <Loader2 className="h-3 w-3 animate-spin" />}
          {running ? 'Starting...' : 'Run'}
        </button>
      </div>
    </div>
  );
}
