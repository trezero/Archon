-- Migration 034: Discovered patterns
-- Stores workflow automation suggestions from pattern mining

CREATE TABLE IF NOT EXISTS discovered_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL,
  description TEXT,
  pattern_type TEXT NOT NULL,
  sequence_pattern JSONB,
  cluster_embedding vector,
  source_event_ids UUID[] DEFAULT '{}',
  repos_involved TEXT[] DEFAULT '{}',
  frequency_score FLOAT NOT NULL DEFAULT 0,
  cross_repo_score FLOAT NOT NULL DEFAULT 0,
  automation_potential FLOAT NOT NULL DEFAULT 0,
  final_score FLOAT NOT NULL DEFAULT 0,
  suggested_yaml TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  accepted_workflow_id UUID REFERENCES workflow_definitions(id) ON DELETE SET NULL,
  feedback_delta JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discovered_patterns_status_score
  ON discovered_patterns (status, final_score DESC);
