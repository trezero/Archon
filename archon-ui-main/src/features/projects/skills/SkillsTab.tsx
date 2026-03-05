import { useState } from "react";
import { SystemCard } from "./components/SystemCard";
import { SystemSkillList } from "./components/SystemSkillList";
import { useInstallSkill, useProjectSkills, useRemoveSkill } from "./hooks/useSkillQueries";

interface SkillsTabProps {
  projectId: string;
}

export function SkillsTab({ projectId }: SkillsTabProps) {
  const { data, isLoading, error } = useProjectSkills(projectId);
  const installSkill = useInstallSkill();
  const removeSkill = useRemoveSkill();
  const [selectedSystemId, setSelectedSystemId] = useState<string | null>(null);

  if (isLoading) {
    return <div className="flex items-center justify-center py-12 text-zinc-400">Loading skills...</div>;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12 text-red-400">Failed to load skills: {error.message}</div>
    );
  }

  const systems = data?.systems ?? [];
  const allSkills = data?.all_skills ?? [];
  const selectedSystem = systems.find((s) => s.id === selectedSystemId) ?? systems[0];

  const handleInstall = (skillId: string) => {
    if (!selectedSystem) return;
    installSkill.mutate({
      projectId,
      skillId,
      systemIds: [selectedSystem.id],
    });
  };

  const handleRemove = (skillId: string) => {
    if (!selectedSystem) return;
    removeSkill.mutate({
      projectId,
      skillId,
      systemIds: [selectedSystem.id],
    });
  };

  if (systems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-zinc-400 space-y-2">
        <p className="text-sm">No systems registered to this project yet.</p>
        <p className="text-xs text-zinc-500">
          Systems are registered when they connect via the Archon MCP server and run a skill sync.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-4 h-full">
      {/* Systems list */}
      <div className="w-64 flex-shrink-0 space-y-2">
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Systems</h3>
        {systems.map((system) => (
          <SystemCard
            key={system.id}
            system={system}
            isSelected={system.id === (selectedSystem?.id ?? null)}
            onClick={() => setSelectedSystemId(system.id)}
          />
        ))}
      </div>

      {/* Detail panel */}
      <div className="flex-1 min-w-0">
        {selectedSystem && (
          <div className="space-y-4">
            <div className="border-b border-white/10 pb-3">
              <h3 className="text-lg font-medium text-white">{selectedSystem.name}</h3>
              <div className="flex gap-4 mt-1 text-xs text-zinc-400">
                {selectedSystem.hostname && <span>Host: {selectedSystem.hostname}</span>}
                {selectedSystem.os && <span>OS: {selectedSystem.os}</span>}
                <span>Last seen: {new Date(selectedSystem.last_seen_at).toLocaleString()}</span>
              </div>
            </div>

            <SystemSkillList
              systemSkills={selectedSystem.skills}
              allSkills={allSkills}
              onInstall={handleInstall}
              onRemove={handleRemove}
            />
          </div>
        )}
      </div>
    </div>
  );
}
