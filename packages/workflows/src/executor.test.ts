/**
 * Tests for executeWorkflow() — the top-level orchestration function.
 * Covers concurrent-run guards, model/provider resolution, and resume logic
 * that the inner dag-executor.test.ts cannot reach.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock logger ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
}));

// --- Mock git ---
mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor ---
const mockExecuteDagWorkflow = mock(async () => {});
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

// --- Mock logger functions ---
mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

// --- Mock event emitter ---
const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// --- Import after mocks ---
import { executeWorkflow } from './executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// --- Helpers ---

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRun: mock(async () => null),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    createWorkflowEvent: mock(async () => {}),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    ...overrides,
  };
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: {
          claude: {},
          codex: {},
        },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    createAssistantClient: mock(() => ({
      run: mock(async () => {}),
    })),
  } as unknown as WorkflowDeps;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'Test',
    nodes: [{ id: 'node1', prompt: 'Do something' }],
    ...overrides,
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-123',
    workflow_name: 'test-workflow',
    conversation_id: 'conv-1',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

describe('executeWorkflow', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async () => {});
  });

  // -------------------------------------------------------------------------
  // Concurrent-run guard
  // -------------------------------------------------------------------------

  describe('concurrent-run guard', () => {
    it('allows workflow when no active workflow exists', async () => {
      const store = makeStore({ getActiveWorkflowRun: mock(async () => null) });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.workflowRunId).toBe('run-123');
    });

    it('blocks workflow when active workflow check fails', async () => {
      const store = makeStore({
        getActiveWorkflowRun: mock(async () => {
          throw new Error('DB connection lost');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error');
    });

    it('blocks workflow when another is actively running', async () => {
      const activeRun = makeRun({
        status: 'running',
        started_at: new Date().toISOString(), // Recent — not stale
      });
      const store = makeStore({
        getActiveWorkflowRun: mock(async () => activeRun),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('already running');
    });
  });

  // -------------------------------------------------------------------------
  // Model/provider resolution
  // -------------------------------------------------------------------------

  describe('model/provider resolution', () => {
    it('uses default provider from config when workflow has no provider or model', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should succeed — uses config.assistant (claude) as default
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('infers claude provider when workflow sets a claude model alias', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      // config.assistant defaults to 'claude', model 'sonnet' is a claude alias
      await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow({ model: 'sonnet' }),
        'test message',
        'db-conv-1'
      );
      expect(mockExecuteDagWorkflow).toHaveBeenCalledTimes(1);
    });

    it('throws when model is incompatible with explicit provider', async () => {
      const store = makeStore();
      const deps = makeDeps(store);
      await expect(
        executeWorkflow(
          deps,
          makePlatform(),
          'conv-1',
          '/tmp',
          makeWorkflow({ provider: 'codex', model: 'sonnet' }),
          'test message',
          'db-conv-1'
        )
      ).rejects.toThrow('not compatible');
    });
  });

  // -------------------------------------------------------------------------
  // Resume logic
  // -------------------------------------------------------------------------

  describe('resume logic', () => {
    it('starts fresh run when findResumableRun returns null', async () => {
      const store = makeStore({
        findResumableRun: mock(async () => null),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('starts fresh run when findResumableRun throws', async () => {
      const store = makeStore({
        findResumableRun: mock(async () => {
          throw new Error('DB error');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should fall back to creating a fresh run
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(result.workflowRunId).toBe('run-123');
    });

    it('starts fresh run when prior run has 0 completed nodes', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => new Map()),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      // Should skip resume and create a fresh run
      expect(store.createWorkflowRun).toHaveBeenCalledTimes(1);
      expect(store.resumeWorkflowRun).not.toHaveBeenCalled();
    });

    it('returns error when resumeWorkflowRun throws', async () => {
      const failedRun = makeRun({ id: 'prior-run', status: 'failed' });
      const priorNodes = new Map([['node1', 'output1']]);
      const store = makeStore({
        findResumableRun: mock(async () => failedRun),
        getCompletedDagNodeOutputs: mock(async () => priorNodes),
        resumeWorkflowRun: mock(async () => {
          throw new Error('Resume DB error');
        }),
      });
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Database error resuming');
    });
  });

  // -------------------------------------------------------------------------
  // Pre-created run (skip concurrent check)
  // -------------------------------------------------------------------------

  describe('pre-created run', () => {
    it('skips concurrent-run check when preCreatedRun is provided', async () => {
      const preRun = makeRun({ id: 'pre-run-1' });
      const store = makeStore();
      const deps = makeDeps(store);
      const result = await executeWorkflow(
        deps,
        makePlatform(),
        'conv-1',
        '/tmp',
        makeWorkflow(),
        'test message',
        'db-conv-1',
        undefined,
        undefined,
        undefined,
        undefined,
        preRun
      );
      expect(store.getActiveWorkflowRun).not.toHaveBeenCalled();
      expect(result.workflowRunId).toBe('pre-run-1');
    });
  });
});
