# Research Cookbook

Deep codebase exploration and question answering. Produces a research document with evidence-backed findings.

**Input**: `$ARGUMENTS` — a question or topic to investigate.

---

## Phase 1: PARSE — Understand the Question

Extract the core research question from `$ARGUMENTS`.

Classify the research type:
- **Architecture**: "how does X work", "trace the flow of X"
- **Location**: "where is X defined", "find all uses of X"
- **Comparison**: "how does X differ from Y"
- **External**: "what are best practices for X" (requires web research)

---

## Phase 2: EXPLORE — Deploy Parallel Agents

Launch up to 3 agents in parallel using the Agent tool. Write a detailed, specific prompt for each agent based on the research question — include relevant keywords, file names, module names, or concepts you expect to find.

### Agent 1: Codebase Explorer (`Explore`)
**Always launch.** Ask it to find all relevant code locations — files, functions, types, tests. Request file:line references.

### Agent 2: Codebase Analyst (`codebase-analyst`)
**Launch for architecture/flow questions.** Ask it to trace data flow, map dependencies, identify entry points, and document how components interact.

### Agent 3: Web Researcher (`web-researcher`)
**Launch only if the question involves external libraries, APIs, or best practices.** Ask it to find official docs, known issues, version-specific guidance.

---

## Phase 3: SYNTHESIZE — Merge Findings

After all agents return:

1. **Deduplicate** — Remove overlapping findings
2. **Resolve conflicts** — If agents disagree, investigate the discrepancy
3. **Build narrative** — Organize findings into a coherent story
4. **Verify key claims** — Read the most critical files yourself to confirm agent findings

---

## Phase 4: WRITE — Create Artifact

Save to `.claude/archon/research/{date}-{slug}.md` where:
- `{date}` = today in `YYYY-MM-DD` format
- `{slug}` = kebab-case summary of the topic (max 50 chars)

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# Research: {topic}

**Date**: {YYYY-MM-DD}
**Branch**: {current branch}
**Status**: complete

## Question

{The original research question}

## Summary

{2-3 sentence answer}

## Detailed Findings

### {Finding Area 1}

**Location**: `{file}:{lines}`

{Analysis with code references}

### {Finding Area 2}

...

## Architecture Diagram

{ASCII diagram if applicable — skip if not relevant}

## Key Files

| File | Lines | Role |
|------|-------|------|
| {path} | {range} | {what it does} |

## Recommendations

{Actionable next steps — what to do with these findings}

## Next Steps

- To write requirements: `/archon-dev prd {topic}`
- To create a plan: `/archon-dev plan {topic}`
```

---

## Phase 5: REPORT — Present to User

Summarize the key findings in 3-5 bullet points. Link to the artifact file. Suggest the next cookbook if appropriate.
