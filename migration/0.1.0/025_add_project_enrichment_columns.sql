-- Migration 025: Add project enrichment columns for chat prioritization
-- Adds optional goals, relevance, and category fields to archon_projects

ALTER TABLE archon_projects
  ADD COLUMN IF NOT EXISTS project_goals jsonb DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS project_relevance text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS project_category text DEFAULT NULL;

-- Index for category-based filtering and grouping
CREATE INDEX IF NOT EXISTS idx_archon_projects_category
  ON archon_projects (project_category)
  WHERE project_category IS NOT NULL;
