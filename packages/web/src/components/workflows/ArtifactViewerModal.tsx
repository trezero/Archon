import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface ArtifactViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  filename: string;
}

export function ArtifactViewerModal({
  open,
  onOpenChange,
  runId,
  filename,
}: ArtifactViewerModalProps): React.ReactElement {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !filename) return;

    setLoading(true);
    setContent(null);
    setError(null);

    fetch(`/api/artifacts/${encodeURIComponent(runId)}/${filename}`)
      .then(async res => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Failed to load artifact' }));
          throw new Error((body as { error?: string }).error ?? 'Failed to load artifact');
        }
        return res.text();
      })
      .then(text => {
        setContent(text);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load artifact');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, runId, filename]);

  const basename = filename.split('/').pop() ?? filename;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{basename}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto min-h-0">
          {loading && <p className="text-sm text-text-secondary animate-pulse">Loading…</p>}
          {error && <p className="text-sm text-error">{error}</p>}
          {content !== null && (
            <pre className="text-sm text-text-primary whitespace-pre-wrap font-mono leading-relaxed">
              {content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
