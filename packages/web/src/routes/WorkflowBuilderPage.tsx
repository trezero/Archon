import { Hammer } from 'lucide-react';

export function WorkflowBuilderPage(): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-elevated">
          <Hammer className="h-8 w-8 text-text-tertiary" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h2 className="text-lg font-semibold text-text-primary">Workflow Builder</h2>
          <span className="rounded-full bg-accent-muted px-3 py-1 text-xs font-medium text-primary">
            Coming Soon
          </span>
          <p className="max-w-sm text-center text-sm text-text-tertiary">
            Design and compose multi-step AI workflows visually.
          </p>
        </div>
      </div>
    </div>
  );
}
