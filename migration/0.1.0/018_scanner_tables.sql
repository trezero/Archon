-- 018_scanner_tables.sql
-- Tables for the local project scanner feature

-- Scan session results (one row per scan invocation)
CREATE TABLE IF NOT EXISTS archon_scan_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    directory_path TEXT NOT NULL,
    system_id UUID REFERENCES archon_systems(id),
    total_found INTEGER NOT NULL DEFAULT 0,
    new_projects INTEGER NOT NULL DEFAULT 0,
    already_in_archon INTEGER NOT NULL DEFAULT 0,
    project_groups INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, applied, partial, expired
    template JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    applied_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

-- Individual detected projects within a scan
CREATE TABLE IF NOT EXISTS archon_scan_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID NOT NULL REFERENCES archon_scan_results(id) ON DELETE CASCADE,
    directory_name TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    host_path TEXT NOT NULL,
    git_remote_url TEXT,
    github_owner TEXT,
    github_repo_name TEXT,
    github_url TEXT,
    default_branch TEXT,
    has_readme BOOLEAN NOT NULL DEFAULT FALSE,
    readme_content TEXT,
    readme_excerpt TEXT,
    detected_languages TEXT[] DEFAULT '{}',
    project_indicators TEXT[] DEFAULT '{}',
    dependencies JSONB DEFAULT '{}',
    infra_markers TEXT[] DEFAULT '{}',
    is_project_group BOOLEAN NOT NULL DEFAULT FALSE,
    group_name TEXT,
    already_in_archon BOOLEAN NOT NULL DEFAULT FALSE,
    existing_project_id UUID,
    selected BOOLEAN NOT NULL DEFAULT TRUE,
    apply_status TEXT NOT NULL DEFAULT 'pending',  -- pending, created, skipped, failed, duplicate_skipped
    archon_project_id UUID,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_projects_scan_id ON archon_scan_projects(scan_id);
CREATE INDEX IF NOT EXISTS idx_scan_projects_github_url ON archon_scan_projects(github_url);

-- Saved scan templates for reuse
CREATE TABLE IF NOT EXISTS archon_scanner_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    template JSONB NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    system_id UUID REFERENCES archon_systems(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Only one default template per system
CREATE UNIQUE INDEX IF NOT EXISTS idx_scanner_templates_default
    ON archon_scanner_templates(system_id)
    WHERE is_default = TRUE;
