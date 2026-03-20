---
name: release
description: |
  Create a release from dev branch. Generates changelog entries from commits,
  bumps version, and creates a PR to main.

  TRIGGERS - Use this skill when user says:
  - "/release" - create a patch release (default)
  - "/release minor" - create a minor release
  - "/release major" - create a major release
  - "make a release", "cut a release", "ship it", "release to main"
---

# Release Skill

Creates a release by comparing dev to main, generating changelog entries from commits, bumping the version, and creating a PR.

## Process

### Step 1: Validate State

```bash
# Must be on dev branch with clean working tree
git checkout dev
git pull origin dev
git status --porcelain  # must be empty
git fetch origin main
```

If not on dev or working tree is dirty, abort with a clear message.

### Step 2: Detect Stack and Current Version

Detect the project's package manager and version file:

1. **Check for `pyproject.toml`** — Python project, version in `version = "x.y.z"`
2. **Check for `package.json`** — Node/Bun project, version in `"version": "x.y.z"`
3. **Check for `Cargo.toml`** — Rust project, version in `version = "x.y.z"`
4. **Check for `go.mod`** — Go project (version from git tags only, no file to bump)

If none found, abort: "Could not detect project stack — no version file found."

Read the current version from the detected file.

### Step 3: Determine Version Bump

**Bump rules based on argument:**
- No argument or `patch` (default): `0.1.0 -> 0.1.1`
- `minor`: `0.1.3 -> 0.2.0`
- `major`: `0.3.5 -> 1.0.0`

### Step 4: Collect Commits

```bash
# Get all commits on dev that aren't on main
git log main..dev --oneline --no-merges
```

If no new commits, abort: "Nothing to release — dev is up to date with main."

### Step 5: Draft Changelog Entries

Read the commit messages and the actual diffs (`git diff main..dev`) to understand what changed.

**Categorize into Keep a Changelog sections:**
- **Added** — new features, new files, new capabilities
- **Changed** — modifications to existing behavior
- **Fixed** — bug fixes
- **Removed** — deleted features or code

**Writing rules:**
- Write entries as a human would — clear, concise, user-facing language
- Do NOT just copy commit messages verbatim — rewrite them into proper changelog entries
- Group related commits into single entries where it makes sense
- Include PR numbers in parentheses when available: `(#12)`
- Each entry should start with a noun or gerund describing WHAT changed
- Skip internal-only changes (CI tweaks, typo fixes) unless they affect behavior
- One blank line between sections

### Step 6: Update Files

1. **Version file** — update version to new value:
   - `package.json`: update `"version": "x.y.z"`
   - `pyproject.toml`: update `version = "x.y.z"`
   - `Cargo.toml`: update `version = "x.y.z"`

2. **Lockfile refresh** (stack-dependent):
   - `package.json` + `bun.lock`: run `bun install`
   - `package.json` + `package-lock.json`: run `npm install --package-lock-only`
   - `pyproject.toml` + `uv.lock`: run `uv lock --quiet`
   - `Cargo.toml`: run `cargo update --workspace`

3. **`CHANGELOG.md`** — prepend new version section:

```markdown
## [x.y.z] - YYYY-MM-DD

One-line summary of the release.

### Added

- Entry one (#PR)
- Entry two (#PR)

### Changed

- Entry one (#PR)

### Fixed

- Entry one (#PR)
```

Move any content under `[Unreleased]` into the new version section. Leave `[Unreleased]` header with nothing under it.

### Step 7: Present for Review

Show the user:
1. The detected stack and version file
2. The version bump (old -> new)
3. The full changelog section that will be added
4. The list of commits being included

Ask: "Does this look good? I'll commit and create the PR."

### Step 8: Commit and PR

Only after user approval:

```bash
# Stage version file, lockfile, and changelog
git add <version-file> <lockfile> CHANGELOG.md
git commit -m "Release x.y.z"

# Push dev
git push origin dev

# Create PR: dev -> main
gh pr create --base main --head dev \
  --title "Release x.y.z" \
  --body "$(cat <<'EOF'
## Release x.y.z

{changelog section content}

---

Merging this PR releases x.y.z to main.
EOF
)"
```

Return the PR URL to the user.

### Step 9: Tag, Release, and Sync After Merge

After the PR is merged (either by the user or via `gh pr merge`):

```bash
# Fetch the merge commit on main
git fetch origin main

# Tag the merge commit
git tag vx.y.z origin/main
git push origin vx.y.z

# Create a GitHub Release from the tag (uses changelog content as release notes)
gh release create vx.y.z --title "vx.y.z" --notes "{changelog section content without the ## header}"

# Sync dev with main so both branches are identical
git checkout dev
git pull origin main
git push origin dev
```

The GitHub Release is distinct from the git tag — without it, the release won't appear on the repository's Releases page. Always create it.

If the user merges the PR themselves and comes back, still offer to tag, release, and sync.

## Important Rules

- NEVER force push
- NEVER skip the review step — always show the changelog before committing
- NEVER include "Co-Authored-By: Claude" or any AI attribution in the commit
- NEVER add emoji to changelog entries unless the user asks
- If the user says "ship it" without specifying bump type, default to patch
- The commit message is just `Release x.y.z` — clean and simple
