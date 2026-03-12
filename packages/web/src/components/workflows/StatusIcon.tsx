export function StatusIcon({ status }: { status: string }): React.ReactElement {
  switch (status) {
    case 'completed':
      return <span className="text-success text-sm">&#x2713;</span>;
    case 'running':
      return (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      );
    case 'failed':
      return <span className="text-error text-sm">&#x2717;</span>;
    default:
      return <span className="text-text-secondary text-sm">&#x25CB;</span>;
  }
}
