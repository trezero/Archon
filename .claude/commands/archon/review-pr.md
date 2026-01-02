---
description: Review a pull request and post findings as a comment
argument-hint: <pr-number> (blank = current branch PR)
---

# Review PR

**Input**: $ARGUMENTS

You are autonomous. Review the PR and post findings. Be helpful, not pedantic.

---

## Step 1: Get PR

**If number provided:**
```bash
gh pr view {number} --json title,body,state,files
gh pr diff {number}
```

**If blank (current branch):**
```bash
gh pr view --json title,body,state,files
gh pr diff
```

---

## Step 2: Analyze Changes

Review each changed file for:
- **Bugs**: Logic errors, edge cases, null issues
- **Security**: Injection, auth, data exposure
- **Tests**: Are changes tested?
- **Patterns**: Follows codebase conventions?

Categorize findings:
- 🔴 Critical (must fix)
- 🟡 Important (should fix)
- 💡 Suggestions (nice to have)
- ✅ Strengths (good things)

---

## Step 3: Post Review

```bash
gh pr comment {number} --body "$(cat <<'EOF'
## 🔍 Code Review

**Verdict**: {Approve | Request changes}

### Summary
{2-3 sentences}

### Findings

{🔴 Critical - if any}
- `file:line` - {issue}

{🟡 Important - if any}
- `file:line` - {issue}

{💡 Suggestions - if any}
- `file:line` - {suggestion}

{✅ Strengths}
- {good thing}

### Security
{🔒 No concerns | ⚠️ Issues found}

---
*Reviewed by Claude*
EOF
)"
```

---

## Output

```
Reviewed: PR #{number}
Verdict: {verdict}
Critical: {n} | Important: {n} | Suggestions: {n}
Posted: ✅
```
