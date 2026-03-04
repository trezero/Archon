-- Skills Management System Tables
-- Adds tables for centralized skill registry, version history,
-- project-specific overrides, and per-system install state tracking.

-- archon_systems: Registered machines
CREATE TABLE IF NOT EXISTS archon_systems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hostname TEXT,
  os TEXT,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- archon_skills: Central skill registry
CREATE TABLE IF NOT EXISTS archon_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  is_required BOOLEAN DEFAULT false,
  is_validated BOOLEAN DEFAULT false,
  tags TEXT[] DEFAULT '{}',
  created_by_system_id UUID REFERENCES archon_systems(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- archon_skill_versions: Version history
CREATE TABLE IF NOT EXISTS archon_skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES archon_skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  change_summary TEXT,
  created_by_system_id UUID REFERENCES archon_systems(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(skill_id, version)
);

-- archon_project_skills: Project-specific overrides
CREATE TABLE IF NOT EXISTS archon_project_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES archon_projects(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES archon_skills(id) ON DELETE CASCADE,
  content_override TEXT,
  content_hash TEXT,
  override_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, skill_id)
);

-- archon_system_skills: Install state junction
CREATE TABLE IF NOT EXISTS archon_system_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_id UUID NOT NULL REFERENCES archon_systems(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES archon_skills(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES archon_projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending_install',
  installed_content_hash TEXT,
  installed_version INTEGER,
  has_local_changes BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(system_id, skill_id, project_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_archon_skills_name ON archon_skills(name);
CREATE INDEX IF NOT EXISTS idx_archon_systems_fingerprint ON archon_systems(fingerprint);
CREATE INDEX IF NOT EXISTS idx_archon_system_skills_system ON archon_system_skills(system_id);
CREATE INDEX IF NOT EXISTS idx_archon_system_skills_project ON archon_system_skills(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_system_skills_status ON archon_system_skills(status);
CREATE INDEX IF NOT EXISTS idx_archon_skill_versions_skill ON archon_skill_versions(skill_id);
CREATE INDEX IF NOT EXISTS idx_archon_project_skills_project ON archon_project_skills(project_id);
