# PR Cookbook

Create well-structured pull requests. The PR itself is the artifact — no file written.

**Input**: `$ARGUMENTS` — optional PR title hint, base branch, or omit for auto-detection.

---

## Phase 1: ANALYZE — Understand the Branch

Run in parallel:
1. `git log --oneline main..HEAD` — all commits on this branch (adjust base branch if needed)
2. `git diff main...HEAD --stat` — files changed summary
3. `git branch --show-current` — current branch name
4. `git status` — any uncommitted changes (warn if dirty)

If there are uncommitted changes, commit them first (follow the commit cookbook pattern — stage specific files, conventional message, no `git add -A`).

**Detect the base branch**: Check `main`, then `master`, then the default remote branch.

**CHECKPOINT**: All commits and changes understood.

---

## Phase 2: CONTEXT — Gather Related Artifacts

Check `.claude/archon/` for artifacts related to this work:

1. **Plans**: Look in `plans/completed/` for the plan that drove this work
2. **Reports**: Look in `reports/` for implementation reports
3. **PRDs**: Look in `prds/` for the original requirements
4. **Issues**: Look in `issues/` for investigation artifacts
5. **Debug**: Look in `debug/` for root cause analyses

Use file names and dates to match artifacts to the current branch/work.

---

## Phase 3: DRAFT — Write PR Title and Body

**Title**: Under 70 characters. Conventional format: `{type}({scope}): {description}`

**Body**: Use this template:

```markdown
## Summary
- {bullet 1 — most important change}
- {bullet 2}
- {bullet 3 if needed}

## Context
{Link to plan/PRD/issue if they exist. Otherwise, brief motivation.}

## Test Plan
- [ ] {validation step 1}
- [ ] {validation step 2}
- [ ] {validation step 3}
```

**Rules from CLAUDE.md:**
- No "Generated with Claude Code" in description
- No AI attribution anywhere
- Write as if a human wrote it

If `$ARGUMENTS` provides a title hint, use it.

---

## Phase 4: PUSH — Push Branch to Remote

Check if the branch tracks a remote:
- If not pushed yet: `git push -u origin {branch}`
- If already pushed: `git push`

---

## Phase 5: CREATE — Open the PR

Create the PR using `gh pr create`:

```bash
gh pr create --title "{title}" --body "$(cat <<'EOF'
{body content}
EOF
)"
```

If there's a related GitHub issue, add `--body` reference like "Fixes #123" or "Relates to #123".

---

## Phase 6: VERIFY — Confirm PR Created

1. Get the PR URL from `gh pr create` output
2. Verify with `gh pr view --json url,title,state`
3. Present the PR URL to the user

---

## Done

Report:
- PR URL
- Title
- Files changed count
- Related artifacts (if any)

Suggest: `/archon-dev review {pr-number}` to self-review before requesting human review.
