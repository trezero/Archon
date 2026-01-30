# Documentation Impact Findings: PR #363

**Reviewer**: docs-impact-agent
**Date**: 2026-01-30T11:15:00Z
**Docs Checked**: CLAUDE.md, docs/, agents, README

---

## Summary

PR #363 changes the `IIsolationProvider.destroy()` method signature from `Promise<void>` to `Promise<DestroyResult>` and adds a new `DestroyResult` interface. Two documentation files (`docs/architecture.md` and `docs/worktree-orchestration.md`) contain code examples and diagrams that reference the old `void` return type and need updating. CLAUDE.md and README are unaffected.

**Verdict**: UPDATES_REQUIRED

---

## Impact Assessment

| Document | Impact | Required Update |
|----------|--------|-----------------|
| CLAUDE.md | NONE | None |
| docs/architecture.md | HIGH | Update `IIsolationProvider` interface listing and `WorktreeProvider.destroy()` signature |
| docs/worktree-orchestration.md | MEDIUM | Update ASCII diagram showing `destroy() → void` |
| docs/cli-developer-guide.md | LOW | Cleanup flow diagram references `provider.destroy()` but doesn't specify return type |
| README.md | NONE | None |
| .claude/agents/*.md | NONE | None |
| .archon/commands/*.md | NONE | None |

---

## Findings

### Finding 1: `docs/architecture.md` - IIsolationProvider Interface Shows Old Signature

**Severity**: HIGH
**Category**: outdated-docs
**Document**: `docs/architecture.md`
**PR Change**: `packages/core/src/isolation/types.ts` - `destroy()` return type changed from `Promise<void>` to `Promise<DestroyResult>`

**Issue**:
The architecture docs contain a full TypeScript listing of the `IIsolationProvider` interface (line 467) and the `WorktreeProvider` class (line 507), both showing the old `Promise<void>` return type for `destroy()`. The new `DestroyResult` type is not mentioned anywhere in the document.

**Current Documentation**:
```typescript
// docs/architecture.md:467-475
export interface IIsolationProvider {
  readonly providerType: string;
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;
  destroy(envId: string, options?: { force?: boolean; branchName?: string }): Promise<void>;
  get(envId: string): Promise<IsolatedEnvironment | null>;
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;
  adopt?(path: string): Promise<IsolatedEnvironment | null>;
  healthCheck(envId: string): Promise<boolean>;
}
```

```typescript
// docs/architecture.md:517-521
async destroy(envId: string, options?: { force?: boolean; branchName?: string }): Promise<void> {
  // git worktree remove <path> [--force]
  // git branch -D <branchName> (if provided, best-effort)
}
```

**Code Change**:
```typescript
// packages/core/src/isolation/types.ts - new interface
export interface DestroyResult {
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  directoryClean: boolean;
  warnings: string[];
}

// Updated signature
destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;
```

**Impact if Not Updated**:
Developers implementing a new `IIsolationProvider` (e.g., ContainerProvider) would implement `destroy()` returning `void` based on docs, causing a type error. The architecture doc is the primary reference for adding new isolation providers (see "Adding a New Isolation Provider" checklist at line 1187).

---

#### Update Suggestions

| Option | Approach | Scope | Effort |
|--------|----------|-------|--------|
| A | Update interface listing and WorktreeProvider example with new return type | Two code blocks | LOW |
| B | Option A + add `DestroyResult` to the "Request & Response Types" section | Three code blocks + description | MED |

**Recommended**: Option B

**Reasoning**:
- The "Request & Response Types" section (line 478-500) already documents `IsolationRequest` and `IsolatedEnvironment` - `DestroyResult` belongs alongside them
- The ContainerProvider example (line 622) also shows `destroy()` returning `void` and should be updated
- Matches existing documentation style of listing all major types

**Suggested Documentation Update**:

For the interface (line 467-475):
```typescript
export interface IIsolationProvider {
  readonly providerType: string;
  create(request: IsolationRequest): Promise<IsolatedEnvironment>;
  destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;
  get(envId: string): Promise<IsolatedEnvironment | null>;
  list(codebaseId: string): Promise<IsolatedEnvironment[]>;
  adopt?(path: string): Promise<IsolatedEnvironment | null>;
  healthCheck(envId: string): Promise<boolean>;
}
```

For the types section (after line 500):
```typescript
interface DestroyResult {
  worktreeRemoved: boolean;  // Primary operation succeeded
  branchDeleted: boolean;    // Branch cleanup succeeded (true if no branch requested)
  directoryClean: boolean;   // No orphan files remain
  warnings: string[];        // Non-fatal issues during cleanup
}
```

For the WorktreeProvider example (line 517-521):
```typescript
async destroy(envId: string, options?: WorktreeDestroyOptions): Promise<DestroyResult> {
  // git worktree remove <path> [--force]
  // git branch -D <branchName> (if provided, tracked via result)
  // Returns DestroyResult with warnings for partial failures
}
```

**Documentation Style Reference**:
```markdown
# SOURCE: docs/architecture.md:478-500
# How similar types are documented - simple interface with field comments
interface IsolatedEnvironment {
  id: string; // Worktree path (for worktree provider)
  provider: 'worktree' | 'container' | 'vm' | 'remote';
  workingPath: string; // Where AI should work
  ...
}
```

---

### Finding 2: `docs/worktree-orchestration.md` - ASCII Diagram Shows `→ void`

**Severity**: MEDIUM
**Category**: outdated-docs
**Document**: `docs/worktree-orchestration.md`
**PR Change**: `packages/core/src/isolation/types.ts:250` - return type changed

**Issue**:
The ASCII art diagram of the isolation provider interface at line 38 shows `destroy(envId, branchName?) → void`. This should reflect the new `DestroyResult` return type.

**Current Documentation**:
```
│  destroy(envId, branchName?)   → void                           │
```

**Code Change**:
```typescript
destroy(envId: string, options?: DestroyOptions | WorktreeDestroyOptions): Promise<DestroyResult>;
```

**Impact if Not Updated**:
Minor - the diagram is a quick-reference visual aid. Developers relying on it would have an incorrect mental model of the destroy contract, but would discover the actual type when reading the code.

---

#### Update Suggestions

| Option | Approach | Scope | Effort |
|--------|----------|-------|--------|
| A | Update the single line in the ASCII diagram | 1 line | LOW |
| B | Option A + add a note about DestroyResult fields | 2-3 lines | LOW |

**Recommended**: Option A

**Reasoning**:
- ASCII diagrams are meant to be concise quick-references
- The architecture.md doc is the right place for detailed type documentation
- Keeping it minimal matches the existing diagram style

**Suggested Documentation Update**:
```
│  destroy(envId, options?)      → DestroyResult                  │
```

**Documentation Style Reference**:
```
# SOURCE: docs/worktree-orchestration.md:37
# How other methods are documented in this diagram
│  create(request)  → IsolatedEnvironment                         │
```

---

### Finding 3: `docs/worktree-orchestration.md` - File Reference Table Missing `DestroyResult`

**Severity**: LOW
**Category**: incomplete-docs
**Document**: `docs/worktree-orchestration.md`
**PR Change**: `packages/core/src/isolation/types.ts` - new `DestroyResult` type added

**Issue**:
The file reference table at line 283 lists types exported from `types.ts` as `IIsolationProvider, IsolationRequest, IsolatedEnvironment` but doesn't include the new `DestroyResult` type.

**Current Documentation**:
```markdown
| `src/isolation/types.ts`              | `IIsolationProvider`, `IsolationRequest`, `IsolatedEnvironment` |
```

**Code Change**:
```typescript
export type { DestroyResult, IIsolationProvider, IsolatedEnvironment, IsolationRequest };
```

**Impact if Not Updated**:
Minimal - reference table used for navigation. Developers would still find the type via IDE or reading the actual types file.

---

#### Update Suggestions

| Option | Approach | Scope | Effort |
|--------|----------|-------|--------|
| A | Add `DestroyResult` to the type list | 1 cell update | LOW |

**Recommended**: Option A

**Suggested Documentation Update**:
```markdown
| `src/isolation/types.ts`              | `IIsolationProvider`, `IsolationRequest`, `IsolatedEnvironment`, `DestroyResult` |
```

---

## CLAUDE.md Sections to Update

| Section | Current | Needed Update |
|---------|---------|---------------|
| Error Handling > Git Operation Errors | Empty section (line 676) | No update needed from this PR (pre-existing gap) |
| Architecture | No isolation provider details | No update needed (architecture.md is the reference) |

CLAUDE.md does not contain isolation provider interface details - it correctly defers to `docs/architecture.md` for implementation details. No CLAUDE.md changes required.

---

## Statistics

| Severity | Count | Documents Affected |
|----------|-------|-------------------|
| CRITICAL | 0 | - |
| HIGH | 1 | `docs/architecture.md` |
| MEDIUM | 1 | `docs/worktree-orchestration.md` |
| LOW | 1 | `docs/worktree-orchestration.md` |

---

## New Documentation Needed

| Topic | Suggested Location | Priority |
|-------|-------------------|----------|
| `DestroyResult` type reference | `docs/architecture.md` (Request & Response Types section) | HIGH |

No entirely new documentation files are needed. The existing documentation structure accommodates these changes with updates to existing sections.

---

## Positive Observations

- The PR includes well-documented JSDoc comments on the new `DestroyResult` interface in `types.ts`, with clear field-level documentation
- The implementation follows the existing error handling pattern documented in CLAUDE.md: "Git Operation Errors (Graceful Handling but don't fail silently)"
- Test files are comprehensive and self-documenting, covering all new behavior paths
- The change is backwards-compatible in spirit - callers that previously ignored the void return can simply ignore the DestroyResult

---

## Metadata

- **Agent**: docs-impact-agent
- **Timestamp**: 2026-01-30T11:15:00Z
- **Artifact**: `.archon/artifacts/runs/0f2cb95e-b46e-4d09-8473-802778d5d8dc/review/docs-impact-findings.md`
