export interface Skill {
  id: string;
  name: string;
  display_name: string;
  description: string;
  content?: string;
  content_hash: string;
  current_version: number;
  is_required: boolean;
  is_validated: boolean;
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface System {
  id: string;
  fingerprint: string;
  name: string;
  hostname: string | null;
  os: string | null;
  last_seen_at: string;
  created_at: string;
}

export interface SystemSkill {
  id: string;
  system_id: string;
  skill_id: string;
  project_id: string;
  status: "pending_install" | "installed" | "pending_remove" | "removed";
  installed_content_hash: string | null;
  installed_version: number | null;
  has_local_changes: boolean;
  updated_at: string;
  archon_skills?: Skill;
}

export interface SystemWithSkills extends System {
  skills: SystemSkill[];
}

export interface ProjectSkillsResponse {
  all_skills: Skill[];
  systems: SystemWithSkills[];
}

export interface ProjectSystemsResponse {
  systems: System[];
  count: number;
}

export interface SkillsListResponse {
  skills: Skill[];
  count: number;
}
