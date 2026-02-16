/**
 * API client functions for the Archon Web UI.
 * Uses relative URLs - Vite proxy handles routing in dev.
 * SSE streams bypass the proxy in dev mode (Vite proxy buffers SSE responses).
 */

/**
 * Base URL for SSE streams. In dev, bypasses Vite proxy by connecting directly
 * to the backend server. In production, uses relative URLs (same origin).
 * Uses the page hostname so it works from any network interface.
 */
export const SSE_BASE_URL = import.meta.env.DEV ? `http://${window.location.hostname}:3090` : '';

export interface ConversationResponse {
  id: string;
  platform_type: string;
  platform_conversation_id: string;
  codebase_id: string | null;
  cwd: string | null;
  ai_assistant_type: string;
  title: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CodebaseResponse {
  id: string;
  name: string;
  repository_url: string | null;
  default_cwd: string;
  ai_assistant_type: string;
  commands: Record<string, { path: string; description: string }>;
  created_at: string;
  updated_at: string;
}

export interface HealthResponse {
  status: string;
  adapter: string;
  concurrency: {
    active: number;
    queuedTotal: number;
    maxConcurrent: number;
  };
}

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    const truncated = body.length > 200 ? body.slice(0, 200) + '...' : body;
    const path = new URL(url, window.location.origin).pathname;
    const error = new Error(`API error ${String(res.status)} (${path}): ${truncated}`);
    (error as Error & { status: number }).status = res.status;
    throw error;
  }
  return res.json() as Promise<T>;
}

// Conversations
export async function listConversations(codebaseId?: string): Promise<ConversationResponse[]> {
  const params = new URLSearchParams();
  if (codebaseId) params.set('codebaseId', codebaseId);
  const qs = params.toString();
  return fetchJSON<ConversationResponse[]>(`/api/conversations${qs ? `?${qs}` : ''}`);
}

export async function createConversation(
  codebaseId?: string
): Promise<{ conversationId: string; id: string }> {
  return fetchJSON('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codebaseId }),
  });
}

export async function updateConversation(
  id: string,
  updates: { title?: string }
): Promise<{ success: boolean }> {
  return fetchJSON(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
}

export async function deleteConversation(id: string): Promise<{ success: boolean }> {
  return fetchJSON(`/api/conversations/${id}`, { method: 'DELETE' });
}

export async function sendMessage(
  conversationId: string,
  message: string
): Promise<{ accepted: boolean; status: string }> {
  return fetchJSON(`/api/conversations/${conversationId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

// Messages
export interface MessageResponse {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata: string;
  created_at: string;
}

export async function getMessages(conversationId: string, limit = 200): Promise<MessageResponse[]> {
  return fetchJSON<MessageResponse[]>(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${String(limit)}`
  );
}

// Codebases
export async function listCodebases(): Promise<CodebaseResponse[]> {
  return fetchJSON<CodebaseResponse[]>('/api/codebases');
}

export async function getCodebase(id: string): Promise<CodebaseResponse> {
  return fetchJSON<CodebaseResponse>(`/api/codebases/${id}`);
}

export async function addCodebase(
  input: { url: string } | { path: string }
): Promise<CodebaseResponse> {
  return fetchJSON<CodebaseResponse>('/api/codebases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteCodebase(id: string): Promise<{ success: boolean }> {
  return fetchJSON<{ success: boolean }>(`/api/codebases/${id}`, { method: 'DELETE' });
}

// Workflows
export interface WorkflowDefinitionResponse {
  name: string;
  description?: string;
  steps: unknown[];
}

export interface WorkflowRunResponse {
  id: string;
  workflow_name: string;
  conversation_id: string;
  codebase_id: string | null;
  current_step_index: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  user_message: string;
  metadata: Record<string, unknown>;
  started_at: string;
  completed_at: string | null;
  last_activity_at: string | null;
  worker_platform_id?: string;
  parent_platform_id?: string;
}

export interface WorkflowEventResponse {
  id: string;
  workflow_run_id: string;
  event_type: string;
  step_index: number | null;
  step_name: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export async function listWorkflows(cwd?: string): Promise<WorkflowDefinitionResponse[]> {
  const params = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const result = await fetchJSON<{ workflows: WorkflowDefinitionResponse[] }>(
    `/api/workflows${params}`
  );
  return result.workflows;
}

export async function runWorkflow(
  name: string,
  conversationId: string,
  message: string
): Promise<{ accepted: boolean; status: string }> {
  return fetchJSON(`/api/workflows/${encodeURIComponent(name)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message }),
  });
}

export async function listWorkflowRuns(options?: {
  conversationId?: string;
  status?: string;
  limit?: number;
  codebaseId?: string;
}): Promise<WorkflowRunResponse[]> {
  const params = new URLSearchParams();
  if (options?.conversationId) params.set('conversationId', options.conversationId);
  if (options?.status) params.set('status', options.status);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.codebaseId) params.set('codebaseId', options.codebaseId);
  const qs = params.toString();
  const result = await fetchJSON<{ runs: WorkflowRunResponse[] }>(
    `/api/workflows/runs${qs ? `?${qs}` : ''}`
  );
  return result.runs;
}

export async function getWorkflowRun(
  runId: string
): Promise<{ run: WorkflowRunResponse; events: WorkflowEventResponse[] }> {
  return fetchJSON(`/api/workflows/runs/${encodeURIComponent(runId)}`);
}

export async function getWorkflowRunByWorker(
  workerPlatformId: string
): Promise<{ run: WorkflowRunResponse } | null> {
  try {
    return await fetchJSON(`/api/workflows/runs/by-worker/${encodeURIComponent(workerPlatformId)}`);
  } catch (e: unknown) {
    // 404 means no run exists yet — expected during dispatch
    if ((e as Error & { status?: number }).status === 404) {
      return null;
    }
    throw e;
  }
}

export async function getConfig(): Promise<{ config: Record<string, unknown>; database: string }> {
  return fetchJSON('/api/config');
}

// System
export async function getHealth(): Promise<HealthResponse> {
  return fetchJSON<HealthResponse>('/api/health');
}
