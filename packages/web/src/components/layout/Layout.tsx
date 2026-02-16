import { Outlet } from 'react-router';
import { Sidebar } from './Sidebar';

export function Layout(): React.ReactElement {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
