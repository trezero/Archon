import { NavLink } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { LayoutDashboard, MessageSquare, Workflow, Settings } from 'lucide-react';
import { listWorkflowRuns } from '@/lib/api';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/', end: true, icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/chat', end: false, icon: MessageSquare, label: 'Chat' },
  { to: '/workflows', end: false, icon: Workflow, label: 'Workflows' },
  { to: '/settings', end: false, icon: Settings, label: 'Settings' },
] as const;

export function TopNav(): React.ReactElement {
  const { data: runningRuns } = useQuery({
    queryKey: ['workflowRuns', { status: 'running' }],
    queryFn: () => listWorkflowRuns({ status: 'running', limit: 1 }),
    refetchInterval: 10_000,
  });
  const hasRunning = (runningRuns?.length ?? 0) > 0;

  return (
    <nav className="flex items-center gap-1 border-b border-border bg-surface px-4">
      {tabs.map(({ to, end, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }: { isActive: boolean }): string =>
            cn(
              'flex items-center gap-2 px-3 py-3 text-sm font-medium border-b-2 transition-colors',
              isActive
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )
          }
        >
          <Icon className="h-4 w-4" />
          {label}
          {label === 'Dashboard' && hasRunning && (
            <span className="flex h-2 w-2 rounded-full bg-primary animate-pulse" />
          )}
        </NavLink>
      ))}
    </nav>
  );
}
