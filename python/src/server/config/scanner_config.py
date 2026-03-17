"""Scanner configuration constants."""

import os


SCANNER_PROJECTS_ROOT = os.getenv("SCANNER_PROJECTS_ROOT", "/projects")
SCANNER_ENABLED = os.getenv("SCANNER_ENABLED", "false").lower() == "true"
