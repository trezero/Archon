-- Migration 030: Workflow nodes
-- Mirrors node execution state reported by the remote-agent

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  output TEXT,
  error TEXT,
  session_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workflow_nodes_run_state
  ON workflow_nodes (workflow_run_id, state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_nodes_run_node
  ON workflow_nodes (workflow_run_id, node_id);
