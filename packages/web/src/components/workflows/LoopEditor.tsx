import type { LoopConfig } from '@archon/workflows/types';

interface LoopEditorProps {
  prompt: string;
  loop: LoopConfig;
  onPromptChange: (prompt: string) => void;
  onLoopChange: (loop: LoopConfig) => void;
  onDirty: () => void;
}

export function LoopEditor({
  prompt,
  loop,
  onPromptChange,
  onLoopChange,
  onDirty,
}: LoopEditorProps): React.ReactElement {
  return (
    <div className="flex flex-col h-full overflow-auto p-4 max-w-2xl mx-auto">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-4">
        Loop Configuration
      </h3>

      {/* Prompt */}
      <div className="flex flex-col gap-1 mb-4">
        <label className="text-xs text-text-secondary font-medium">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e): void => {
            onPromptChange(e.target.value);
            onDirty();
          }}
          rows={8}
          placeholder="Enter the AI prompt for each loop iteration..."
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono"
        />
      </div>

      {/* Until Signal */}
      <div className="flex flex-col gap-1 mb-4">
        <label className="text-xs text-text-secondary font-medium">Until Signal</label>
        <input
          type="text"
          value={loop.until}
          onChange={(e): void => {
            onLoopChange({ ...loop, until: e.target.value });
            onDirty();
          }}
          placeholder='e.g. "COMPLETE"'
          className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <p className="text-[10px] text-text-tertiary">
          The loop stops when AI output contains this signal
        </p>
      </div>

      {/* Max Iterations */}
      <div className="flex flex-col gap-1 mb-4">
        <label className="text-xs text-text-secondary font-medium">Max Iterations</label>
        <input
          type="number"
          value={loop.max_iterations}
          min={1}
          onChange={(e): void => {
            const val = Math.max(1, Number(e.target.value) || 1);
            onLoopChange({ ...loop, max_iterations: val });
            onDirty();
          }}
          className="w-32 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Fresh Context */}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
          <input
            type="checkbox"
            checked={loop.fresh_context ?? false}
            onChange={(e): void => {
              onLoopChange({ ...loop, fresh_context: e.target.checked || undefined });
              onDirty();
            }}
            className="rounded"
          />
          Fresh context per iteration
        </label>
        <p className="text-[10px] text-text-tertiary ml-6">
          Start a new session each iteration instead of continuing the conversation
        </p>
      </div>
    </div>
  );
}
