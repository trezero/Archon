import { ProjectGridCard } from "./ProjectGridCard";
import type { Project } from "../types";

interface TaskCountMap {
  [projectId: string]: { todo: number; doing: number; done: number } | undefined;
}

interface ProjectGridProps {
  projects: Project[];
  taskCounts: TaskCountMap;
  selectedProjectId?: string;
  onSelectProject: (id: string) => void;
  groupByParent: boolean;
}

export function ProjectGrid({
  projects,
  taskCounts,
  selectedProjectId,
  onSelectProject,
  groupByParent,
}: ProjectGridProps) {
  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500 text-sm">
        No projects found
      </div>
    );
  }

  if (!groupByParent) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 px-4 pb-4">
        {projects.map((project) => (
          <ProjectGridCard
            key={project.id}
            project={project}
            taskCounts={taskCounts[project.id]}
            isSelected={project.id === selectedProjectId}
            onSelect={onSelectProject}
          />
        ))}
      </div>
    );
  }

  // Build parent -> children map
  const childrenByParent = new Map<string, Project[]>();
  for (const project of projects) {
    if (project.parent_project_id) {
      const existing = childrenByParent.get(project.parent_project_id) ?? [];
      existing.push(project);
      childrenByParent.set(project.parent_project_id, existing);
    }
  }

  // IDs of projects that have children
  const parentIds = new Set(childrenByParent.keys());

  // IDs present in the projects list
  const projectIdSet = new Set(projects.map((p) => p.id));

  // Classify projects
  const parents: Project[] = [];
  const standalones: Project[] = [];
  const orphans: Project[] = [];

  for (const project of projects) {
    if (project.parent_project_id) {
      // Has a parent — will appear under that parent's section
      // If the parent is not in the list it goes to orphans (handled below)
      if (!projectIdSet.has(project.parent_project_id)) {
        orphans.push(project);
      }
      // otherwise rendered under its parent — skip here
    } else if (parentIds.has(project.id)) {
      // No parent and has children → it's a parent section header
      parents.push(project);
    } else {
      // No parent, no children → standalone
      standalones.push(project);
    }
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 px-4 pb-4">
      {/* Parent sections with their children */}
      {parents.map((parent) => {
        const children = childrenByParent.get(parent.id) ?? [];
        return (
          <div key={parent.id} className="col-span-full">
            {/* Section header */}
            <div className="col-span-full text-sm font-semibold text-gray-400 pt-3 pb-1 border-b border-white/5">
              {parent.title}
            </div>
            {/* Parent card + children in a nested grid */}
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pt-3">
              <ProjectGridCard
                key={parent.id}
                project={parent}
                taskCounts={taskCounts[parent.id]}
                isSelected={parent.id === selectedProjectId}
                onSelect={onSelectProject}
              />
              {children.map((child) => (
                <ProjectGridCard
                  key={child.id}
                  project={child}
                  taskCounts={taskCounts[child.id]}
                  isSelected={child.id === selectedProjectId}
                  onSelect={onSelectProject}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Standalone projects rendered directly in the grid */}
      {standalones.map((project) => (
        <ProjectGridCard
          key={project.id}
          project={project}
          taskCounts={taskCounts[project.id]}
          isSelected={project.id === selectedProjectId}
          onSelect={onSelectProject}
        />
      ))}

      {/* Orphaned children (parent not in project list) */}
      {orphans.length > 0 && (
        <div className="col-span-full">
          <div className="col-span-full text-sm font-semibold text-gray-400 pt-3 pb-1 border-b border-white/5">
            Ungrouped
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 pt-3">
            {orphans.map((project) => (
              <ProjectGridCard
                key={project.id}
                project={project}
                taskCounts={taskCounts[project.id]}
                isSelected={project.id === selectedProjectId}
                onSelect={onSelectProject}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
