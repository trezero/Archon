import type { Skill, SystemSkill } from "../types";
import { SkillStatusBadge } from "./SkillStatusBadge";

interface SystemSkillListProps {
  systemSkills: SystemSkill[];
  allSkills: Skill[];
  onInstall: (skillId: string) => void;
  onRemove: (skillId: string) => void;
}

export function SystemSkillList({ systemSkills, allSkills, onInstall, onRemove }: SystemSkillListProps) {
  const installedSkillIds = new Set(systemSkills.map((ss) => ss.skill_id));
  const availableSkills = allSkills.filter((s) => !installedSkillIds.has(s.id));

  return (
    <div className="space-y-4">
      {systemSkills.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Installed Skills</h4>
          <div className="space-y-1">
            {systemSkills.map((ss) => (
              <div key={ss.id} className="flex items-center justify-between p-2 rounded-md bg-white/5">
                <span className="text-sm text-white">
                  {ss.archon_skills?.display_name || ss.archon_skills?.name || ss.skill_id}
                </span>
                <div className="flex items-center gap-2">
                  <SkillStatusBadge status={ss.status} hasLocalChanges={ss.has_local_changes} />
                  <button
                    type="button"
                    onClick={() => onRemove(ss.skill_id)}
                    className="px-2 py-1 text-xs rounded-md bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {availableSkills.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Available</h4>
          <div className="space-y-1">
            {availableSkills.map((skill) => (
              <div key={skill.id} className="flex items-center justify-between p-2 rounded-md bg-white/5">
                <div>
                  <span className="text-sm text-white">{skill.display_name || skill.name}</span>
                  {skill.is_required && <span className="ml-2 text-xs text-cyan-400">Required</span>}
                </div>
                <button
                  type="button"
                  onClick={() => onInstall(skill.id)}
                  className="px-3 py-1 text-xs rounded-md bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 transition-colors"
                >
                  Install
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {systemSkills.length === 0 && availableSkills.length === 0 && (
        <div className="text-center py-8 text-zinc-500 text-sm">
          No skills in the registry yet. Skills are added when systems sync.
        </div>
      )}
    </div>
  );
}
