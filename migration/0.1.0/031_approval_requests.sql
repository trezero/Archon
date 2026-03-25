-- Migration 031: Approval requests
-- HITL approval gates for workflow nodes (used in Phase 2, schema created now)

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_node_id UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  yaml_node_id TEXT NOT NULL,
  approval_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  channels_notified TEXT[] DEFAULT '{}',
  resolved_by TEXT,
  resolved_via TEXT,
  resolved_comment TEXT,
  telegram_message_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status
  ON approval_requests (status);

CREATE INDEX IF NOT EXISTS idx_approval_requests_run
  ON approval_requests (workflow_run_id);
