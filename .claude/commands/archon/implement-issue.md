---
description: Implement changes from investigation artifact
argument-hint: <issue-number|artifact-path>
---

# Implement Issue

**Input**: $ARGUMENTS

You are autonomous. Follow the artifact. Make the code changes. Do not commit/push/PR - those are separate steps.

---

## Step 1: Load Artifact

**Find the artifact:**
- If number → `.archon/artifacts/issues/issue-{number}.md`
- If path → use directly

```bash
cat .archon/artifacts/issues/issue-{number}.md
```

Extract:
- Files to modify
- Implementation steps
- Patterns to follow
- Validation commands

---

## Step 2: Verify Artifact Still Valid

Read each file mentioned and confirm:
- Code still matches what artifact expects
- If minor drift → adapt and proceed
- If major drift → note in output, but still proceed with best judgment

---

## Step 3: Implement Changes

For each step in the artifact's Implementation Plan:

1. Read target file
2. Make the specified change
3. Run `bun run type-check` to verify

**Rules:**
- Follow artifact exactly
- Match existing code style
- Add tests as specified
- Don't refactor unrelated code

---

## Step 4: Validate

Run the validation commands from artifact:

```bash
bun run type-check
bun test {pattern}
bun run lint
```

If failures:
- Fix the issue
- Re-run validation
- Note any additional fixes made

---

## Output

Report to user:
```
Implemented: #{number}
Files changed: {list}
Validation: ✅ All passed
Ready for: /commit
```
