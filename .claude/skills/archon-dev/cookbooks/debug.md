# Debug Cookbook

Systematic root cause analysis using evidence chains. No guessing — every claim requires proof.

**Input**: `$ARGUMENTS` — error description, GitHub issue number (`#123`), or symptom.

---

## Phase 1: CAPTURE — Understand the Symptoms

1. **If GitHub issue**: Fetch with `gh issue view {number}` — extract error messages, reproduction steps, environment details
2. **If error description**: Parse the symptom, stack trace, or behavior described
3. **If vague**: Ask the user for specifics before continuing

Document:
- **What's happening** (the symptom)
- **What's expected** (the desired behavior)
- **When it started** (if known)
- **Reproduction steps** (if available)

**CHECKPOINT**: Symptom clearly documented.

---

## Phase 2: REPRODUCE — Verify the Problem

Attempt to reproduce:

1. **Check tests**: Are there failing tests that demonstrate the issue?
2. **Read the code**: Trace the code path described in the symptom
3. **Run commands**: If safe, run the reproduction steps
4. **Check logs**: Look for relevant error output

If you can reproduce it, document exactly how. If you can't, note what you tried.

---

## Phase 3: INVESTIGATE — Build the Evidence Chain

Use the WHY/BECAUSE method. Start from the symptom and dig deeper:

```
WHY: {the symptom — what's going wrong}
BECAUSE: {the immediate cause}
EVIDENCE: `{file}:{line}` — {code snippet or test output proving this}

WHY: {the immediate cause — go deeper}
BECAUSE: {the underlying cause}
EVIDENCE: `{file}:{line}` — {proof}

WHY: {the underlying cause — one more level}
BECAUSE: {the root cause}
EVIDENCE: `{file}:{line}` — {proof}

ROOT CAUSE: {the fundamental issue that, if fixed, prevents the symptom}
```

**Rules:**
- **Minimum 3 WHY levels** (unless root cause is obvious at level 2)
- **Every BECAUSE needs EVIDENCE** — a file:line reference, command output, or test result
- **No speculative language** — "likely" or "probably" is invalid without evidence
- **If you can't find evidence**: Say "unverified hypothesis" and investigate further

Launch an **Explore agent** if needed to find relevant code paths.

---

## Phase 4: OPTIONS — Identify Fix Approaches

For each fix option, document:
- **What to change**: Specific files and code
- **Complexity**: LOW / MEDIUM / HIGH
- **Risk**: What could go wrong
- **Trade-offs**: What you gain vs what you lose

Provide at least 2 options when possible. Recommend one with clear reasoning.

---

## Phase 5: WRITE — Save Artifact

**If from a GitHub issue**: Save to `.claude/archon/issues/issue-{number}.md`
**Otherwise**: Save to `.claude/archon/debug/{date}-{slug}.md`

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Root Cause Analysis

**Issue**: {description or #number}
**Date**: {YYYY-MM-DD}
**Branch**: {current branch}
**Severity**: Critical / High / Medium / Low
**Confidence**: High / Medium / Low — {reasoning}

---

## Symptom

{What's happening — observable behavior}

## Reproduction

{Steps to reproduce, or "Could not reproduce — {what was tried}"}

## Evidence Chain

WHY: {symptom}
BECAUSE: {cause}
EVIDENCE: `{file}:{line}` — {snippet}

WHY: {cause}
BECAUSE: {deeper cause}
EVIDENCE: `{file}:{line}` — {snippet}

ROOT CAUSE: {fundamental issue}

## Affected Files

| File | Lines | Role in the Bug |
|------|-------|-----------------|
| `{path}` | {range} | {how this file contributes to the issue} |

## Fix Options

### Option 1: {title} (Recommended)

**Changes**: {specific files and modifications}
**Complexity**: LOW / MEDIUM / HIGH
**Risk**: {what could go wrong}

### Option 2: {title}

**Changes**: {specific files and modifications}
**Complexity**: LOW / MEDIUM / HIGH
**Risk**: {what could go wrong}

## Recommendation

{Which option and why}
```

---

## Phase 6: REPORT — Present and Suggest Next Step

Summarize:
- Root cause in one sentence
- Severity and confidence
- Recommended fix approach

Link to the artifact.

**Next steps**:
- For complex fixes: `/archon-dev plan` (create a plan from the RCA)
- For simple fixes: `/archon-dev implement` (implement directly)
- For GitHub issues: Consider posting the RCA as a comment with `gh issue comment`
