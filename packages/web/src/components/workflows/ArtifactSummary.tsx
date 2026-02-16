import type { WorkflowArtifact } from '@/lib/types';

interface ArtifactSummaryProps {
  artifacts: WorkflowArtifact[];
}

function ArtifactIcon({ type }: { type: string }): React.ReactElement {
  switch (type) {
    case 'pr':
      return <span className="text-accent">PR</span>;
    case 'commit':
      return <span className="text-success">C</span>;
    case 'branch':
      return <span className="text-text-secondary">B</span>;
    case 'file':
    case 'file_created':
    case 'file_modified':
      return <span className="text-text-secondary">F</span>;
    default:
      return <span className="text-text-secondary">*</span>;
  }
}

export function ArtifactSummary({ artifacts }: ArtifactSummaryProps): React.ReactElement {
  if (artifacts.length === 0) {
    return <></>;
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wider mb-2">
        Artifacts
      </h4>
      <div className="space-y-1.5">
        {artifacts.map((artifact, idx) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <ArtifactIcon type={artifact.type} />
            {artifact.url ? (
              <a
                href={artifact.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:text-accent-bright transition-colors truncate"
              >
                {artifact.label}
              </a>
            ) : (
              <span className="text-text-primary truncate">{artifact.label}</span>
            )}
            {artifact.path && (
              <span
                className="text-xs text-text-secondary ml-auto shrink-0 truncate max-w-[200px]"
                title={artifact.path}
              >
                {artifact.path}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
