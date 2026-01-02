---
description: Investigate a GitHub issue - analyze, plan, post to GitHub
argument-hint: <issue-number|url|"description">
---

# Investigate Issue

**Input**: $ARGUMENTS

You are autonomous. Make best judgments. Do not stop to ask - complete the investigation.

---

## Step 1: Git Setup

```bash
git status --short
git branch --show-current
```

**Act based on state:**
- In worktree → use it
- On main + clean → `git checkout -b fix/issue-{number}`
- On main + dirty → `git stash && git checkout -b fix/issue-{number}`
- On feature branch → use it

---

## Step 2: Parse Input

**Determine type:**
- Number (`123`, `#123`) → GitHub issue
- URL → extract number
- Other → free-form description

**If GitHub issue:**
```bash
gh issue view {number} --json title,body,labels,state,url
```

**Classify:** BUG | ENHANCEMENT | REFACTOR | CHORE

---

## Step 3: Explore Codebase

Use Task tool with subagent_type="Explore":

```
Find code related to: {issue description}

Return:
- Affected files with line numbers
- Integration points
- Similar patterns to mirror
- Test patterns
```

---

## Step 4: Analyze

**For bugs:** Apply 5 Whys to find root cause
**For enhancements:** Identify changes needed

Document:
- Files to modify (with line numbers)
- Implementation steps
- Patterns to follow
- Validation commands

---

## Step 5: Create Artifact

```bash
mkdir -p .archon/artifacts/issues
```

Write to `.archon/artifacts/issues/issue-{number}.md`:

```markdown
# Issue #{number}: {title}

**Type**: {type} | **Complexity**: {LOW|MED|HIGH}

## Problem
{2-3 sentence description}

## Root Cause / Rationale
{5 Whys for bugs, change rationale for enhancements}

## Implementation

### Files to Change
| File | Action | Change |
|------|--------|--------|
| `src/x.ts:45` | UPDATE | {description} |

### Steps
1. {first change with code snippet}
2. {second change}
3. Add tests

### Patterns to Follow
```typescript
// From src/similar.ts:20
{actual code from codebase}
```

## Validation
```bash
bun run type-check && bun test && bun run lint
```
```

---

## Step 6: Post to GitHub

**Only if GitHub issue:**

```bash
gh issue comment {number} --body "$(cat <<'EOF'
## 🔍 Investigation

**Type**: `{TYPE}` | **Complexity**: `{COMPLEXITY}`

### Problem
{problem statement}

### Root Cause
{brief analysis}

### Plan
| File | Change |
|------|--------|
| `src/x.ts` | {description} |

---
*Investigated by Claude*
EOF
)"
```

---

## Output

Report to user:
```
Investigated: #{number} - {title}
Branch: {branch}
Artifact: .archon/artifacts/issues/issue-{number}.md
GitHub: Posted ✓
```
