-- Drop scanner tables (scanner rearchitected to client-side script)
-- These tables are no longer used — scanning and results are handled client-side.

DROP TABLE IF EXISTS archon_scan_projects CASCADE;
DROP TABLE IF EXISTS archon_scan_results CASCADE;
DROP TABLE IF EXISTS archon_scanner_templates CASCADE;
