-- 024_add_auto_research_tables.sql
-- Adds tables to track auto-research optimization jobs and their per-iteration
-- results, supporting the auto-research engine that iteratively improves prompts.

CREATE TABLE auto_research_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    eval_suite_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed, cancelled
    target_file TEXT NOT NULL,
    baseline_payload TEXT NOT NULL,
    baseline_score FLOAT,
    best_payload TEXT,
    best_score FLOAT,
    max_iterations INT NOT NULL,
    completed_iterations INT NOT NULL DEFAULT 0,
    model TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE auto_research_iterations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES auto_research_jobs(id) ON DELETE CASCADE,
    iteration_number INT NOT NULL,
    payload TEXT NOT NULL,
    scalar_score FLOAT NOT NULL,
    signals JSONB NOT NULL,
    is_frontier BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_auto_research_jobs_status ON auto_research_jobs(status);
CREATE INDEX idx_auto_research_iterations_job_id ON auto_research_iterations(job_id);
