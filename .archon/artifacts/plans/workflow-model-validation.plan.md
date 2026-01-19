# Feature: Workflow Model Validation with Provider-Specific Model Selection

## Summary

Implement strict validation for the `model` field in workflow YAML files, ensuring model names are compatible with their provider (Claude or Codex). Add credential validation at execution time to prevent silent fallbacks. Support per-step model overrides for fine-grained control over which model handles each workflow step.

## User Story

As a workflow author
I want model names validated against providers at load and execution time
So that I get clear errors instead of silent fallbacks when there's a model/provider mismatch or missing credentials

## Problem Statement

The `model` field in workflow files is currently parsed but ignored. This causes:
1. Misleading configuration (e.g., `model: sonnet` with Codex provider)
2. No validation of model/provider compatibility
3. Silent fallback when credentials are missing for specified provider
4. No way to use different models for different steps in a workflow

## Solution Statement

Add a validation layer that:
1. Validates model names against provider at workflow load time (when provider is explicit)
2. Validates model + credentials at execution time (when provider comes from config)
3. Passes validated model to AI clients for actual use
4. Supports per-step model overrides with validation

## Metadata

| Field            | Value                                                    |
| ---------------- | -------------------------------------------------------- |
| Type             | ENHANCEMENT                                              |
| Complexity       | MEDIUM                                                   |
| Systems Affected | workflows, clients, config                               |
| Dependencies     | @anthropic-ai/claude-agent-sdk, @openai/codex-sdk        |
| Estimated Tasks  | 12                                                       |

---

## UX Design

### Before State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                              BEFORE STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────┐    ║
║   │  workflow.yaml  │ ──────► │  Loader parses  │ ──────► │   Executor  │    ║
║   │  provider: codex│         │  model: sonnet  │         │   IGNORES   │    ║
║   │  model: sonnet  │         │  (no validation)│         │    model    │    ║
║   └─────────────────┘         └─────────────────┘         └─────────────┘    ║
║                                                                    │          ║
║                                                                    ▼          ║
║                                                           ┌─────────────┐     ║
║                                                           │ Codex uses  │     ║
║                                                           │  DEFAULT    │     ║
║                                                           │   model     │     ║
║                                                           └─────────────┘     ║
║                                                                               ║
║   USER_FLOW: User sets model: sonnet, expects sonnet, gets gpt-5.2-codex     ║
║   PAIN_POINT: Silent mismatch, no error, unexpected behavior                  ║
║   DATA_FLOW: model field → parsed → stored → ignored at execution            ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### After State

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                               AFTER STATE                                      ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                               ║
║   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────┐    ║
║   │  workflow.yaml  │ ──────► │  Loader parses  │ ──────► │  Validator  │    ║
║   │  provider: codex│         │  model: sonnet  │         │   CHECKS    │    ║
║   │  model: sonnet  │         │  provider: codex│         │   model vs  │    ║
║   └─────────────────┘         └─────────────────┘         │   provider  │    ║
║                                                           └──────┬──────┘    ║
║                                                                  │           ║
║                                       ┌──────────────────────────┼───────┐   ║
║                                       │                          │       │   ║
║                                       ▼                          ▼       │   ║
║                               ┌─────────────┐            ┌─────────────┐ │   ║
║                               │   ERROR!    │            │  Executor   │ │   ║
║                               │ "sonnet not │            │  validates  │ │   ║
║                               │  valid for  │            │  credentials│ │   ║
║                               │   codex"    │            │  + passes   │ │   ║
║                               └─────────────┘            │   model to  │ │   ║
║                                                          │   client    │ │   ║
║                                                          └──────┬──────┘ │   ║
║                                                                 │        │   ║
║                                                                 ▼        │   ║
║                                                         ┌─────────────┐  │   ║
║                                                         │ AI Client   │  │   ║
║                                                         │ uses ACTUAL │◄─┘   ║
║                                                         │   model     │      ║
║                                                         └─────────────┘      ║
║                                                                               ║
║   USER_FLOW: User sets invalid combo → gets clear error at load time         ║
║   VALUE_ADD: Explicit errors, no silent fallbacks, predictable behavior      ║
║   DATA_FLOW: model → validated → passed to client → used by SDK              ║
║                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

### Interaction Changes

| Location | Before | After | User Impact |
|----------|--------|-------|-------------|
| Workflow load | Model parsed, not validated | Model validated against provider | Errors caught early |
| Workflow execution | Model ignored | Model passed to AI client | Specified model actually used |
| Missing credentials | Silent fallback or startup warning | Runtime error with clear message | No confusion about which provider runs |
| Per-step models | Not supported | Supported with validation | Fine-grained control |

---

## Mandatory Reading

**CRITICAL: Implementation agent MUST read these files before starting any task:**

| Priority | File | Lines | Why Read This |
|----------|------|-------|---------------|
| P0 | `src/workflows/loader.ts` | 155-158 | Current provider/model parsing - MODIFY this |
| P0 | `src/workflows/executor.ts` | 467-470, 722-725 | Where client is created - ADD model param |
| P0 | `src/workflows/types.ts` | 63-91 | Workflow type definitions - ADD step model |
| P1 | `src/clients/factory.ts` | 18-27 | Factory pattern - ADD model param |
| P1 | `src/clients/claude.ts` | 117-160 | ClaudeClient sendQuery - ADD model option |
| P1 | `src/clients/codex.ts` | 36-72 | CodexClient sendQuery - ADD model option |
| P1 | `src/index.ts` | 58-78 | Credential checking pattern - REUSE logic |
| P2 | `src/workflows/loader.test.ts` | 118-152 | Provider validation tests - MIRROR pattern |
| P2 | `src/clients/factory.test.ts` | 1-48 | Factory tests - ADD model tests |
| P2 | `src/workflows/executor.test.ts` | 684-723 | Provider selection tests - EXTEND |

**External Documentation:**

| Source | Section | Why Needed |
|--------|---------|------------|
| [Claude Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript) | Options.model | Model parameter syntax |
| [Codex SDK](https://developers.openai.com/codex/sdk/) | startThread | Model parameter in thread options |
| [Codex Models](https://developers.openai.com/codex/models/) | Model list | Valid Codex model names |

---

## Patterns to Mirror

**PROVIDER_VALIDATION (current pattern to extend):**
```typescript
// SOURCE: src/workflows/loader.ts:155-158
// EXTEND THIS PATTERN for model validation:
// Validate provider (default to 'claude')
const provider =
  raw.provider === 'claude' || raw.provider === 'codex' ? raw.provider : 'claude';
const model = typeof raw.model === 'string' ? raw.model : undefined;
```

**ERROR_COLLECTION_PATTERN:**
```typescript
// SOURCE: src/workflows/loader.ts:142-152
// COPY THIS PATTERN for collecting model validation errors:
// Collect validation errors for aggregated reporting
const validationErrors: string[] = [];

steps = (raw.steps as unknown[])
  .map((s: unknown, index: number) => parseStep(s, index, validationErrors))
  .filter((step): step is WorkflowStep => step !== null);

// Reject workflow if any steps were invalid - report all errors at once
if (steps.length !== (raw.steps as unknown[]).length) {
  console.warn(`[WorkflowLoader] Workflow ${filename} failed validation:`, validationErrors);
  return null;
}
```

**CREDENTIAL_CHECKING:**
```typescript
// SOURCE: src/index.ts:58-72
// REUSE THIS PATTERN for runtime credential validation:
const hasClaudeCredentials = Boolean(
  process.env.CLAUDE_API_KEY ||
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  process.env.CLAUDE_USE_GLOBAL_AUTH
);
const hasCodexCredentials = process.env.CODEX_ID_TOKEN && process.env.CODEX_ACCESS_TOKEN;
```

**FACTORY_ERROR_PATTERN:**
```typescript
// SOURCE: src/clients/factory.ts:24-25
// EXTEND THIS PATTERN for model validation errors:
default:
  throw new Error(`Unknown assistant type: ${type}. Supported types: 'claude', 'codex'`);
```

**CLIENT_OPTIONS_PATTERN:**
```typescript
// SOURCE: src/clients/claude.ts:122-128
// EXTEND THIS PATTERN to add model:
const options: Options = {
  cwd,
  env: buildSubprocessEnv(),
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  systemPrompt: { type: 'preset', preset: 'claude_code' },
  settingSources: ['project'],
  // ADD: model: modelParam,
};
```

**STEP_TYPE_PATTERN:**
```typescript
// SOURCE: src/workflows/types.ts:30-34
// EXTEND THIS PATTERN for per-step model:
export interface SingleStep {
  command: string;
  clearContext?: boolean;
  // ADD: model?: string;
}
```

**TEST_PATTERN:**
```typescript
// SOURCE: src/workflows/loader.test.ts:118-132
// MIRROR THIS PATTERN for model validation tests:
it('should default provider to claude when not specified', async () => {
  fs.readdirSync.mockReturnValue(['default-provider.yaml']);

  const yamlNoProvider = `name: default-provider
description: No provider specified
steps:
  - command: test
`;
  fs.readFileSync.mockReturnValue(yamlNoProvider);

  const workflows = await discoverWorkflows(testDir);

  expect(workflows).toHaveLength(1);
  expect(workflows[0].provider).toBe('claude');
});
```

---

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/workflows/model-validation.ts` | CREATE | Centralize model/provider validation logic |
| `src/workflows/types.ts` | UPDATE | Add model to SingleStep, add ModelValidationError |
| `src/workflows/loader.ts` | UPDATE | Add model validation at load time |
| `src/workflows/executor.ts` | UPDATE | Add credential validation, pass model to client |
| `src/clients/factory.ts` | UPDATE | Accept model parameter, pass to clients |
| `src/types/index.ts` | UPDATE | Add model to IAssistantClient.sendQuery signature |
| `src/clients/claude.ts` | UPDATE | Accept and use model parameter |
| `src/clients/codex.ts` | UPDATE | Accept and use model parameter |
| `src/workflows/model-validation.test.ts` | CREATE | Unit tests for validation functions |
| `src/workflows/loader.test.ts` | UPDATE | Add model validation tests |
| `src/workflows/executor.test.ts` | UPDATE | Add credential/model validation tests |
| `.archon/workflows/defaults/*.yaml` | UPDATE | Remove model field (use provider defaults) |

---

## NOT Building (Scope Limits)

Explicit exclusions to prevent scope creep:

- **Default model config** - Not adding `defaultModel` to config files (use SDK defaults)
- **Model aliases for Codex** - Not creating short aliases like Claude has (sonnet/opus/haiku)
- **Model cost tracking** - Not adding cost estimation based on model selection
- **Model availability checking** - Not querying APIs to verify model availability
- **Per-parallel-step models** - Only single steps get model override, not parallel blocks

---

## Step-by-Step Tasks

Execute in order. Each task is atomic and independently verifiable.

### Task 1: CREATE `src/workflows/model-validation.ts`

- **ACTION**: CREATE new file with validation utilities
- **IMPLEMENT**:
  ```typescript
  // Valid model names per provider
  export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'] as const;
  export const CODEX_MODELS = [
    'gpt-5.2-codex',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-5.1-codex-max',
    'gpt-5-codex',
    'gpt-5-codex-mini',
    'o3-mini',
    'o1',
    'o1-mini',
  ] as const;

  export type ClaudeModel = typeof CLAUDE_MODELS[number];
  export type CodexModel = typeof CODEX_MODELS[number];
  export type Provider = 'claude' | 'codex';

  export function isValidModelForProvider(model: string, provider: Provider): boolean;
  export function validateModelForProvider(model: string, provider: Provider): void; // throws
  export function getValidModelsForProvider(provider: Provider): readonly string[];
  export function hasClaudeCredentials(): boolean;
  export function hasCodexCredentials(): boolean;
  export function validateCredentialsForProvider(provider: Provider): void; // throws
  ```
- **MIRROR**: Error throwing pattern from `src/clients/factory.ts:24-25`
- **IMPORTS**: None (pure utility module)
- **GOTCHA**: Use `as const` for type narrowing on model arrays
- **VALIDATE**: `bun run type-check`

### Task 2: CREATE `src/workflows/model-validation.test.ts`

- **ACTION**: CREATE unit tests for validation module
- **IMPLEMENT**:
  - Test `isValidModelForProvider` for all valid combinations
  - Test `isValidModelForProvider` returns false for invalid combinations
  - Test `validateModelForProvider` throws with descriptive message
  - Test `getValidModelsForProvider` returns correct arrays
  - Test credential checking functions (mock process.env)
- **MIRROR**: `src/clients/factory.test.ts:22-38` for throw assertions
- **PATTERN**: Use describe/it from bun:test
- **VALIDATE**: `bun test src/workflows/model-validation.test.ts`

### Task 3: UPDATE `src/workflows/types.ts` - Add model to SingleStep

- **ACTION**: UPDATE SingleStep interface to support per-step model
- **IMPLEMENT**:
  ```typescript
  export interface SingleStep {
    command: string;
    clearContext?: boolean;
    model?: string; // Optional model override for this step
  }
  ```
- **MIRROR**: Existing optional field pattern (`clearContext?: boolean`)
- **VALIDATE**: `bun run type-check`

### Task 4: UPDATE `src/workflows/loader.ts` - Add model validation

- **ACTION**: UPDATE parseWorkflow and parseSingleStep for model validation
- **IMPLEMENT**:
  - In `parseSingleStep`: Parse model field from step YAML
  - In `parseWorkflow`: Validate model against provider if BOTH are specified
  - If provider is omitted, defer validation (will happen at execution time)
  - Add validation errors to the existing errors array pattern
- **MIRROR**: `src/workflows/loader.ts:155-158` for validation pattern
- **IMPORTS**: `import { isValidModelForProvider, getValidModelsForProvider } from './model-validation'`
- **GOTCHA**: Only validate when provider is explicit in workflow; config-derived provider validated at runtime
- **VALIDATE**: `bun run type-check && bun test src/workflows/loader.test.ts`

### Task 5: UPDATE `src/workflows/loader.test.ts` - Add model validation tests

- **ACTION**: ADD tests for model validation at load time
- **IMPLEMENT**:
  - Test: Valid Claude model with Claude provider passes
  - Test: Valid Codex model with Codex provider passes
  - Test: Invalid model for provider fails with error message
  - Test: Model without explicit provider is NOT validated at load time
  - Test: Step-level model is parsed correctly
- **MIRROR**: `src/workflows/loader.test.ts:118-152`
- **VALIDATE**: `bun test src/workflows/loader.test.ts`

### Task 6: UPDATE `src/types/index.ts` - Add model to IAssistantClient

- **ACTION**: UPDATE IAssistantClient.sendQuery signature
- **IMPLEMENT**:
  ```typescript
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    model?: string // Add optional model parameter
  ): AsyncGenerator<MessageChunk>;
  ```
- **GOTCHA**: Keep model optional to maintain backward compatibility
- **VALIDATE**: `bun run type-check`

### Task 7: UPDATE `src/clients/claude.ts` - Accept model parameter

- **ACTION**: UPDATE ClaudeClient to accept and use model
- **IMPLEMENT**:
  ```typescript
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    model?: string
  ): AsyncGenerator<MessageChunk> {
    const options: Options = {
      cwd,
      // ... existing options
      model: model, // Pass to SDK (undefined uses default)
    };
  ```
- **MIRROR**: `src/clients/claude.ts:122-128`
- **GOTCHA**: Claude SDK accepts aliases ('sonnet', 'opus', 'haiku') directly
- **VALIDATE**: `bun run type-check`

### Task 8: UPDATE `src/clients/codex.ts` - Accept model parameter

- **ACTION**: UPDATE CodexClient to accept and use model
- **IMPLEMENT**:
  ```typescript
  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    model?: string
  ): AsyncGenerator<MessageChunk> {
    // In startThread:
    thread = codex.startThread({
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      model: model, // Add model parameter
    });
    // In resumeThread:
    thread = codex.resumeThread(resumeSessionId, {
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      model: model, // Add model parameter
    });
  ```
- **MIRROR**: `src/clients/codex.ts:60-72`
- **GOTCHA**: Codex SDK requires full model name (e.g., 'gpt-5.2-codex')
- **VALIDATE**: `bun run type-check`

### Task 9: UPDATE `src/clients/factory.ts` - Pass model to clients

- **ACTION**: UPDATE factory to optionally validate and pass model
- **IMPLEMENT**:
  ```typescript
  export function getAssistantClient(
    type: string,
    model?: string
  ): IAssistantClient {
    // Optionally validate model here, or leave to clients
    switch (type) {
      case 'claude':
        return new ClaudeClient();
      case 'codex':
        return new CodexClient();
      default:
        throw new Error(`Unknown assistant type: ${type}. Supported types: 'claude', 'codex'`);
    }
  }
  ```
- **NOTE**: Model passed at sendQuery time, not construction time
- **VALIDATE**: `bun run type-check && bun test src/clients/factory.test.ts`

### Task 10: UPDATE `src/workflows/executor.ts` - Add runtime validation

- **ACTION**: UPDATE executeStepInternal and executeLoopWorkflow
- **IMPLEMENT**:
  - Before creating AI client, resolve effective provider
  - Validate credentials for resolved provider
  - Validate model against resolved provider
  - Pass model to `aiClient.sendQuery()`
  - Resolve step-level model override (step.model ?? workflow.model)
- **LOCATIONS**: Lines 467-470, 722-725
- **IMPORTS**: `import { validateModelForProvider, validateCredentialsForProvider } from './model-validation'`
- **MIRROR**: Error handling pattern from `src/workflows/executor.ts:535-580`
- **GOTCHA**: Step model overrides workflow model; both validated against resolved provider
- **VALIDATE**: `bun run type-check`

### Task 11: UPDATE `src/workflows/executor.test.ts` - Add runtime validation tests

- **ACTION**: ADD tests for credential and model validation at runtime
- **IMPLEMENT**:
  - Test: Missing Claude credentials throws clear error
  - Test: Missing Codex credentials throws clear error
  - Test: Invalid model for provider throws at runtime
  - Test: Step-level model override is passed to client
  - Test: Workflow model is passed to client when no step override
- **MIRROR**: `src/workflows/executor.test.ts:684-723`
- **VALIDATE**: `bun test src/workflows/executor.test.ts`

### Task 12: UPDATE `.archon/workflows/defaults/*.yaml` - Remove model fields

- **ACTION**: REMOVE `model: sonnet` from all default workflow files
- **FILES**:
  - `.archon/workflows/defaults/assist.yaml`
  - `.archon/workflows/defaults/comprehensive-pr-review.yaml`
  - `.archon/workflows/defaults/feature-development.yaml`
  - `.archon/workflows/defaults/fix-github-issue.yaml`
  - `.archon/workflows/defaults/resolve-conflicts.yaml`
- **RATIONALE**: With validation, these would fail if provider is Codex; removing lets SDK use defaults
- **VALIDATE**: `bun test src/workflows/loader.test.ts` (ensure workflows still load)

---

## Testing Strategy

### Unit Tests to Write

| Test File | Test Cases | Validates |
|-----------|------------|-----------|
| `src/workflows/model-validation.test.ts` | Valid/invalid models, credential checking | Validation utilities |
| `src/workflows/loader.test.ts` | Model parsing, load-time validation | Loader changes |
| `src/workflows/executor.test.ts` | Runtime validation, model passing | Executor changes |
| `src/clients/claude.test.ts` | Model parameter accepted | Client changes |
| `src/clients/codex.test.ts` | Model parameter accepted | Client changes |

### Edge Cases Checklist

- [ ] Model specified without provider (defer validation to runtime)
- [ ] Provider specified without model (use SDK default)
- [ ] Invalid model for Claude provider
- [ ] Invalid model for Codex provider
- [ ] Claude credentials missing when Claude provider specified
- [ ] Codex credentials missing when Codex provider specified
- [ ] Step-level model different from workflow model
- [ ] Step-level model without workflow-level model
- [ ] Case sensitivity of model names
- [ ] Empty string model (should use default)

---

## Validation Commands

### Level 1: STATIC_ANALYSIS

```bash
bun run type-check && bun run lint
```

**EXPECT**: Exit 0, no errors or warnings

### Level 2: UNIT_TESTS

```bash
bun test src/workflows/model-validation.test.ts
bun test src/workflows/loader.test.ts
bun test src/workflows/executor.test.ts
bun test src/clients/
```

**EXPECT**: All tests pass

### Level 3: FULL_SUITE

```bash
bun test && bun run build
```

**EXPECT**: All tests pass, build succeeds

### Level 4: MANUAL_VALIDATION

1. Create test workflow with `provider: claude` and `model: sonnet` → should load successfully
2. Create test workflow with `provider: codex` and `model: sonnet` → should fail at load time
3. Create test workflow with `model: sonnet` (no provider) → should load, validate at runtime
4. Run workflow with valid model but missing credentials → should fail with clear message
5. Run workflow with per-step model override → verify correct model used

---

## Acceptance Criteria

- [ ] All specified functionality implemented per user story
- [ ] Level 1-3 validation commands pass with exit 0
- [ ] Unit tests cover >= 80% of new code
- [ ] Code mirrors existing patterns exactly (naming, structure, logging)
- [ ] No regressions in existing tests
- [ ] Clear error messages for all validation failures
- [ ] Per-step model override works correctly

---

## Completion Checklist

- [ ] All 12 tasks completed in dependency order
- [ ] Each task validated immediately after completion
- [ ] Level 1: `bun run type-check && bun run lint` passes
- [ ] Level 2: Unit tests pass for all changed files
- [ ] Level 3: `bun test && bun run build` succeeds
- [ ] Level 4: Manual validation confirms expected behavior
- [ ] All acceptance criteria met

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SDK model parameter not working as documented | LOW | HIGH | Test with actual SDK calls early; fall back to env vars if needed |
| Codex SDK doesn't support model in startThread | MEDIUM | MEDIUM | Check SDK types; may need to pass model differently |
| Breaking existing workflows | LOW | HIGH | Only fail on explicit invalid combos; undefined model uses default |
| Credential check false positives | LOW | MEDIUM | Reuse exact credential check logic from index.ts |

---

## Notes

### SDK Model Parameter Details

**Claude Agent SDK** (from docs):
- Accepts model in Options: `model?: string`
- Supports aliases: 'sonnet', 'opus', 'haiku', 'inherit'
- Also accepts full model IDs like 'claude-sonnet-4-5-20250929'

**Codex SDK** (from docs):
- Accepts model in startThread options: `model?: string`
- Requires full model names: 'gpt-5.2-codex', 'gpt-5.1-codex-mini', etc.
- Default is 'gpt-5.2-codex' as of January 2026

### Validation Timing

- **Load time**: When provider is explicit in workflow YAML
- **Execution time**: When provider comes from config (need to resolve first)
- **Never validate**: When neither model nor provider specified (use all defaults)

### Error Message Format

Follow existing pattern from factory.ts:
```
Model 'sonnet' is not valid for provider 'codex'. Valid models: gpt-5.2-codex, gpt-5.1-codex-mini, gpt-5.1-codex-max, gpt-5.1-codex, gpt-5-codex, gpt-5-codex-mini, o3-mini, o1, o1-mini
```

```
Workflow specifies provider 'claude' but no Claude credentials found. Run 'claude /login' or set ANTHROPIC_API_KEY.
```
