import { callAPIWithETag } from "../../shared/api/apiClient";
import type {
  CreateDefinitionRequest,
  CreateRunRequest,
  ExecutionBackend,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunDetail,
} from "../types";

export const workflowService = {
  async listDefinitions(projectId?: string): Promise<WorkflowDefinition[]> {
    const params = projectId ? `?project_id=${projectId}` : "";
    return callAPIWithETag<WorkflowDefinition[]>(`/api/workflows/definitions${params}`);
  },

  async getDefinition(id: string): Promise<WorkflowDefinition> {
    return callAPIWithETag<WorkflowDefinition>(`/api/workflows/definitions/${id}`);
  },

  async createDefinition(data: CreateDefinitionRequest): Promise<WorkflowDefinition> {
    return callAPIWithETag<WorkflowDefinition>("/api/workflows/definitions", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async deleteDefinition(id: string): Promise<void> {
    await callAPIWithETag(`/api/workflows/definitions/${id}`, { method: "DELETE" });
  },

  async listRuns(status?: string, projectId?: string): Promise<WorkflowRun[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (projectId) params.set("project_id", projectId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return callAPIWithETag<WorkflowRun[]>(`/api/workflows${qs}`);
  },

  async getRun(runId: string): Promise<WorkflowRunDetail> {
    return callAPIWithETag<WorkflowRunDetail>(`/api/workflows/${runId}`);
  },

  async createRun(data: CreateRunRequest): Promise<{ run_id: string; status: string }> {
    return callAPIWithETag<{ run_id: string; status: string }>("/api/workflows", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async cancelRun(runId: string): Promise<void> {
    await callAPIWithETag(`/api/workflows/${runId}/cancel`, { method: "POST" });
  },

  async listBackends(): Promise<ExecutionBackend[]> {
    return callAPIWithETag<ExecutionBackend[]>("/api/workflows/backends");
  },
};
