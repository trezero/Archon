"""
Skills management tools for Archon MCP Server.

Provides tools for discovering, syncing, and managing skills:
- find_skills: List, search, and get skill details
- manage_skills: Sync, upload, validate, install, and remove skills
"""

from .skill_tools import register_skill_tools

__all__ = ["register_skill_tools"]
