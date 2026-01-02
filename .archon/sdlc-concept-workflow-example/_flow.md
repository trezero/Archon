# SDLC Command Suite

Composable commands covering the software development lifecycle. Designed for chaining via YAML configuration.

## Flow Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           SDLC COMMAND PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   INPUT                                                                     │
│     │                                                                       │
│     ▼                                                                       │
│   ┌─────────────────┐                                                       │
│   │  validate-spec  │ ──► .agents/sdlc/{feature}/spec-validated.md          │
│   └────────┬────────┘                                                       │
│            │                                                                │
│            ▼                                                                │
│   ┌─────────────────┐                                                       │
│   │   create-plan   │ ──► .agents/sdlc/{feature}/plan.md                    │
│   └────────┬────────┘                                                       │
│            │                                                                │
│            ▼                                                                │
│   ┌─────────────────┐                                                       │
│   │   review-plan   │ ──► .agents/sdlc/{feature}/plan-reviewed.md           │
│   └────────┬────────┘                                                       │
│            │                                                                │
│            ▼                                                                │
│   ┌─────────────────┐                                                       │
│   │    implement    │ ──► Source files + .agents/sdlc/{feature}/impl.md     │
│   └────────┬────────┘                                                       │
│            │                                                                │
│            ├────────────────────┬─────────────────────┐                     │
│            ▼                    ▼                     ▼                     │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│   │   unit-tests    │  │integration-tests│  │    document     │            │
│   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘            │
│            │                    │                     │                     │
│            └────────────────────┼─────────────────────┘                     │
│                                 │                                           │
│                                 ▼                                           │
│                        ┌─────────────────┐                                  │
│                        │  review-tests   │                                  │
│                        └────────┬────────┘                                  │
│                                 │                                           │
│                                 ▼                                           │
│                        ┌─────────────────┐                                  │
│                        │  final-review   │ ──► .agents/sdlc/{feature}/done.md│
│                        └─────────────────┘                                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Command Inventory

| Order | Command | Input | Output | Dual-Agent |
|-------|---------|-------|--------|------------|
| 1 | `sdlc:validate-spec` | Spec/requirements file | Validated spec + issues | Analyzer + Critic |
| 2 | `sdlc:create-plan` | Validated spec | Implementation plan | Planner + Reviewer |
| 3 | `sdlc:review-plan` | Implementation plan | Approved plan | Senior + Architect |
| 4 | `sdlc:implement` | Approved plan | Source code | Implementer + Validator |
| 5 | `sdlc:unit-tests` | Source code | Unit tests | Tester + Critic |
| 6 | `sdlc:integration-tests` | Source code | Integration tests | Tester + Critic |
| 7 | `sdlc:review-tests` | All tests | Reviewed tests | Senior + QA |
| 8 | `sdlc:document` | Source code | Documentation | Writer + Reviewer |
| 9 | `sdlc:final-review` | Everything | Final report | Senior + Auditor |

## Output Directory Structure

```
.agents/sdlc/{feature-name}/
├── spec-validated.md      # Output from validate-spec
├── plan.md                # Output from create-plan
├── plan-reviewed.md       # Output from review-plan
├── impl.md                # Output from implement (log of changes)
├── unit-tests.md          # Output from unit-tests (test plan + results)
├── integration-tests.md   # Output from integration-tests
├── tests-reviewed.md      # Output from review-tests
├── docs.md                # Output from document
└── done.md                # Output from final-review
```

## YAML Chaining Configuration

Example YAML for chaining commands:

```yaml
name: full-sdlc
description: Complete SDLC pipeline for a feature

input:
  spec_file: path/to/spec.md
  feature_name: user-authentication

pipeline:
  - command: sdlc:validate-spec
    input: ${spec_file}
    output: .agents/sdlc/${feature_name}/spec-validated.md

  - command: sdlc:create-plan
    input: .agents/sdlc/${feature_name}/spec-validated.md
    output: .agents/sdlc/${feature_name}/plan.md

  - command: sdlc:review-plan
    input: .agents/sdlc/${feature_name}/plan.md
    output: .agents/sdlc/${feature_name}/plan-reviewed.md
    gate: requires_approval  # Human checkpoint

  - command: sdlc:implement
    input: .agents/sdlc/${feature_name}/plan-reviewed.md
    output: .agents/sdlc/${feature_name}/impl.md

  - command: sdlc:unit-tests
    input: .agents/sdlc/${feature_name}/impl.md
    output: .agents/sdlc/${feature_name}/unit-tests.md
    parallel: true

  - command: sdlc:integration-tests
    input: .agents/sdlc/${feature_name}/impl.md
    output: .agents/sdlc/${feature_name}/integration-tests.md
    parallel: true

  - command: sdlc:document
    input: .agents/sdlc/${feature_name}/impl.md
    output: .agents/sdlc/${feature_name}/docs.md
    parallel: true

  - command: sdlc:review-tests
    input:
      - .agents/sdlc/${feature_name}/unit-tests.md
      - .agents/sdlc/${feature_name}/integration-tests.md
    output: .agents/sdlc/${feature_name}/tests-reviewed.md
    wait_for: [sdlc:unit-tests, sdlc:integration-tests]

  - command: sdlc:final-review
    input: .agents/sdlc/${feature_name}/
    output: .agents/sdlc/${feature_name}/done.md
    wait_for: all
```

## Dual-Agent Pattern

Each command uses two agents:

```
┌─────────────────────────────────────────────────────────┐
│                    DUAL-AGENT PATTERN                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   ┌─────────────┐         ┌─────────────┐              │
│   │   AGENT 1   │         │   AGENT 2   │              │
│   │  (Executor) │         │ (Validator) │              │
│   └──────┬──────┘         └──────┬──────┘              │
│          │                       │                      │
│          ▼                       │                      │
│   ┌─────────────┐                │                      │
│   │  Do Work    │                │                      │
│   └──────┬──────┘                │                      │
│          │                       │                      │
│          ▼                       ▼                      │
│   ┌─────────────────────────────────────┐              │
│   │          Validation Check            │              │
│   │  - Does output meet requirements?    │              │
│   │  - Any issues or gaps?               │              │
│   │  - Quality standards met?            │              │
│   └──────────────────┬──────────────────┘              │
│                      │                                  │
│           ┌──────────┴──────────┐                      │
│           ▼                     ▼                      │
│   ┌─────────────┐       ┌─────────────┐               │
│   │    PASS     │       │    FAIL     │               │
│   │  Continue   │       │   Iterate   │               │
│   └─────────────┘       └─────────────┘               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## I/O Contracts

### Standard Input Format
Each command expects input as a file path:
```
/sdlc:command-name path/to/input.md
```

### Standard Output Format
Each command produces:
1. **Primary artifact** - The main output file
2. **Status section** - PASS/FAIL with details
3. **Next command hint** - What to run next

```markdown
## Status

**Result**: PASS | FAIL | NEEDS_REVIEW
**Issues**: [count]
**Confidence**: [1-10]

## Next Step

Run: `/sdlc:next-command .agents/sdlc/{feature}/this-output.md`
```

## Usage

### Full Pipeline
```bash
# Start with a spec file
/sdlc:validate-spec docs/specs/user-auth.md

# Follow the chain...
/sdlc:create-plan .agents/sdlc/user-auth/spec-validated.md
/sdlc:review-plan .agents/sdlc/user-auth/plan.md
# ... etc
```

### Single Command
```bash
# Run just one step
/sdlc:implement .agents/sdlc/user-auth/plan-reviewed.md
```

### Parallel Execution
After implementation, these can run in parallel:
- `sdlc:unit-tests`
- `sdlc:integration-tests`
- `sdlc:document`
