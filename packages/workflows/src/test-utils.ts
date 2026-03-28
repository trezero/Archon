/**
 * Test factories for workflow types.
 * Use these instead of inline fixture objects — schema changes update one file.
 *
 * makeTestWorkflow: uses workflowDefinitionSchema.parse() for runtime validation of base fields.
 * Note: `nodes` uses z.any() by design (per-node parsing happens in loader.ts), so
 * centralizing the `as WorkflowDefinition` cast here prevents per-call-site workarounds.
 */
import { workflowDefinitionSchema } from './schemas/workflow';
import type { WorkflowDefinition } from './schemas/workflow';

const DEFAULT_NODE = { id: 'default', command: 'test-command' };

type TestWorkflowOverrides = {
  name: string;
  nodes?: unknown[];
} & Partial<Omit<WorkflowDefinition, 'name' | 'nodes'>>;

export function makeTestWorkflow(overrides: TestWorkflowOverrides): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    description: `${overrides.name} test workflow`,
    nodes: [DEFAULT_NODE],
    ...overrides,
  }) as WorkflowDefinition;
}

export function makeTestWorkflowList(names: string[]): WorkflowDefinition[] {
  return names.map(name => makeTestWorkflow({ name }));
}
