import { callAPIWithETag } from "@/features/shared/api/apiClient";
import type { ProjectSkillsResponse, ProjectSystemsResponse, SkillsListResponse } from "../types";

export const skillService = {
  async getProjectSkills(projectId: string): Promise<ProjectSkillsResponse> {
    return callAPIWithETag<ProjectSkillsResponse>(`/api/projects/${projectId}/skills`);
  },

  async getProjectSystems(projectId: string): Promise<ProjectSystemsResponse> {
    return callAPIWithETag<ProjectSystemsResponse>(`/api/projects/${projectId}/systems`);
  },

  async getAllSkills(): Promise<SkillsListResponse> {
    return callAPIWithETag<SkillsListResponse>("/api/skills");
  },

  async installSkill(projectId: string, skillId: string, systemIds: string[]): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/skills/${skillId}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_ids: systemIds }),
    });
    if (!response.ok) throw new Error(`Failed to install skill: ${response.statusText}`);
  },

  async removeSkill(projectId: string, skillId: string, systemIds: string[]): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/skills/${skillId}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_ids: systemIds }),
    });
    if (!response.ok) throw new Error(`Failed to remove skill: ${response.statusText}`);
  },

  async unlinkSystem(projectId: string, systemId: string): Promise<void> {
    const response = await fetch(`/api/projects/${projectId}/systems/${systemId}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`Failed to unlink system: ${response.statusText}`);
  },
};
