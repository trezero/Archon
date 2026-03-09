-- 020_add_postman_collection_uid.sql
-- Add postman_collection_uid to archon_projects for API-mode collection tracking.

ALTER TABLE archon_projects
  ADD COLUMN IF NOT EXISTS postman_collection_uid VARCHAR(255);

COMMENT ON COLUMN archon_projects.postman_collection_uid IS 'Postman collection UID for API-mode sync. Set by manage_postman init_collection action.';
