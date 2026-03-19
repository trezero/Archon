import type { Project } from "../types";
import { SystemBadge } from "./SystemBadge";

interface TaskCounts {
  todo: number;
  doing: number;
  done: number;
}

interface ProjectGridCardProps {
  project: Project;
  taskCounts?: TaskCounts;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function ProjectGridCard({ project, taskCounts, isSelected, onSelect }: ProjectGridCardProps) {
  const registrations = project.system_registrations ?? [];
  const primaryReg = registrations[0];
  const extraCount = registrations.length - 1;

  const dirtySystems = registrations.filter((r) => r.git_dirty);
  const dirtyTitle = dirtySystems.map((r) => r.system_name).join(", ");

  const cardClass = isSelected
    ? "rounded-xl border border-purple-500/40 bg-gradient-to-br from-[rgba(30,20,60,0.9)] to-[rgba(20,15,40,0.9)] p-4 cursor-pointer shadow-[0_0_20px_rgba(139,92,246,0.15)]"
    : "rounded-xl border border-white/[0.08] bg-gradient-to-br from-[rgba(20,18,35,0.9)] to-[rgba(15,13,28,0.9)] p-4 cursor-pointer transition-all duration-200 hover:border-white/15";

  const titleClass = isSelected
    ? "text-[15px] font-semibold text-[#f0eaff] leading-tight line-clamp-2"
    : "text-[15px] font-semibold text-[#c0c0d8] leading-tight line-clamp-2";

  return (
    <div
      className={cardClass}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(project.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect(project.id);
      }}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-1.5 mb-2">
        <span className={titleClass}>{project.title}</span>
        {project.pinned && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-600/20 text-purple-400 whitespace-nowrap shrink-0">
            PINNED
          </span>
        )}
      </div>

      {/* System row */}
      {primaryReg && (
        <div className="flex items-center gap-1.5 mb-2">
          <SystemBadge name={primaryReg.system_name} os={primaryReg.os} />
          {extraCount > 0 && (
            <span className="text-xs text-gray-500">+{extraCount}</span>
          )}
          {project.has_uncommitted_changes && (
            <span
              className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.5)] ml-auto shrink-0"
              title={dirtyTitle}
              aria-label={`Uncommitted changes on: ${dirtyTitle}`}
            />
          )}
        </div>
      )}

      {/* Task pills row */}
      {taskCounts && (taskCounts.todo > 0 || taskCounts.doing > 0 || taskCounts.done > 0) && (
        <div className="flex gap-2 mb-2">
          {taskCounts.todo > 0 && (
            <span className="text-xs px-2 py-0.5 rounded bg-pink-500/12 text-pink-300">
              {taskCounts.todo} todo
            </span>
          )}
          {taskCounts.doing > 0 && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/12 text-blue-300">
              {taskCounts.doing} doing
            </span>
          )}
          {taskCounts.done > 0 && (
            <span className="text-xs px-2 py-0.5 rounded bg-green-500/12 text-green-300">
              {taskCounts.done} done
            </span>
          )}
        </div>
      )}

      {/* Activity timestamp */}
      <div className="text-xs text-gray-400">{formatRelativeTime(project.updated_at)}</div>
    </div>
  );
}
