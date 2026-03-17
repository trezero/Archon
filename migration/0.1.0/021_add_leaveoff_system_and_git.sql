-- 021_add_leaveoff_system_and_git.sql
-- Add system_name and git_clean columns to archon_leaveoff_points.
-- system_name: human-readable name of the machine that generated the LeaveOff point.
-- git_clean: whether all changes were committed at the time of generation.

ALTER TABLE archon_leaveoff_points ADD COLUMN IF NOT EXISTS system_name TEXT;
ALTER TABLE archon_leaveoff_points ADD COLUMN IF NOT EXISTS git_clean BOOLEAN;
