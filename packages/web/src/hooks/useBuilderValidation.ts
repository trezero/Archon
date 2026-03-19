import { useState, useEffect, useRef } from 'react';
import type { DagFlowNode } from '@/components/workflows/DagNodeComponent';
import type { Edge } from '@xyflow/react';

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  field?: string;
  suggestion?: string;
}

const SEVERITY_ORDER: Record<ValidationIssue['severity'], number> = {
  error: 0,
  warning: 1,
  info: 2,
};

function getInstantIssues(
  mode: 'dag' | 'sequential' | 'loop',
  workflowName: string,
  workflowDescription: string,
  nodes: DagFlowNode[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!workflowName.trim()) {
    issues.push({
      severity: 'error',
      message: 'Workflow name is required',
      field: 'name',
    });
  }

  if (!workflowDescription.trim()) {
    issues.push({
      severity: 'error',
      message: 'Workflow description is required',
      field: 'description',
    });
  }

  if (mode === 'dag' && nodes.length === 0) {
    issues.push({
      severity: 'error',
      message: 'At least one node is required',
    });
  }

  return issues;
}

function getDebouncedIssues(
  mode: 'dag' | 'sequential' | 'loop',
  nodes: DagFlowNode[],
  edges: Edge[]
): ValidationIssue[] {
  if (mode !== 'dag') return [];

  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map(n => n.data.id));

  // 1. Duplicate node IDs
  const idCounts = new Map<string, number>();
  for (const node of nodes) {
    const id = node.data.id;
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push({
        severity: 'error',
        message: `Duplicate node ID "${id}" (appears ${count} times)`,
        nodeId: id,
        field: 'id',
        suggestion: 'Each node must have a unique ID',
      });
    }
  }

  // 2. Broken depends_on (missing source or target)
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push({
        severity: 'error',
        message: `Edge references non-existent source node "${edge.source}"`,
        nodeId: edge.target,
        field: 'depends_on',
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        severity: 'error',
        message: `Edge references non-existent target node "${edge.target}"`,
        nodeId: edge.source,
        field: 'depends_on',
      });
    }
  }

  // 3. Self-loops
  for (const edge of edges) {
    if (edge.source === edge.target) {
      issues.push({
        severity: 'error',
        message: `Node "${edge.source}" has a self-loop dependency`,
        nodeId: edge.source,
        field: 'depends_on',
        suggestion: 'A node cannot depend on itself',
      });
    }
  }

  // 4. Cycle detection via Kahn's algorithm
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    if (nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target) {
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      adjacency.get(edge.source)?.push(edge.target);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    visited++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  if (visited < nodeIds.size) {
    issues.push({
      severity: 'error',
      message: 'Cycle detected in workflow graph',
      suggestion: 'Remove circular dependencies between nodes',
    });
  }

  // 5. Broken $nodeId.output references
  const outputRefPattern = /\$(\w+)\.output/g;
  for (const node of nodes) {
    const textsToScan: string[] = [];
    if (node.data.when) textsToScan.push(node.data.when);
    if (node.data.promptText) textsToScan.push(node.data.promptText);

    for (const text of textsToScan) {
      let match: RegExpExecArray | null;
      // Reset lastIndex for each text scan
      outputRefPattern.lastIndex = 0;
      while ((match = outputRefPattern.exec(text)) !== null) {
        const referencedId = match[1];
        if (!nodeIds.has(referencedId)) {
          issues.push({
            severity: 'warning',
            message: `Node "${node.data.id}" references "$${referencedId}.output" but node "${referencedId}" does not exist`,
            nodeId: node.data.id,
            suggestion: `Check that node ID "${referencedId}" is correct`,
          });
        }
      }
    }
  }

  return issues;
}

export function useBuilderValidation(
  mode: 'dag' | 'sequential' | 'loop',
  workflowName: string,
  workflowDescription: string,
  nodes: DagFlowNode[],
  edges: Edge[]
): ValidationIssue[] {
  const [debouncedIssues, setDebouncedIssues] = useState<ValidationIssue[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced checks
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      const issues = getDebouncedIssues(mode, nodes, edges);
      setDebouncedIssues(issues);
      timerRef.current = null;
    }, 300);

    return (): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [mode, nodes, edges]);

  // Instant checks (every render)
  const instantIssues = getInstantIssues(mode, workflowName, workflowDescription, nodes);

  // Combine and sort by severity (errors first)
  const allIssues = [...instantIssues, ...debouncedIssues];
  allIssues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return allIssues;
}
