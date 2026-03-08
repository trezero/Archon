# Archon Setup — Register This Machine

Connect this machine to Archon: register it as a system, download all project extensions, and install them to `~/.claude/skills/`.

## Phase 0: Health Check

Call `health_check()` via the Archon MCP tool.

If the server is unreachable, print:
```
Archon server is not reachable. Ensure the MCP is connected.
```
Stop.

## Phase 1: Load Existing State

Read `.claude/archon-state.json` if it exists. Extract:
- `system_fingerprint` → `<fingerprint>` (may be absent)
- `system_name` → `<system_name>` (may be absent)
- `archon_project_id` → `<project_id>` (may be absent)

## Phase 2: Collect System Info and Compute Fingerprint

Always run these first to capture the current machine identity:

```bash
hostname
```

Store result as `<hostname>`.

```bash
uname -s
```

Store result as `<os>`.

If `<fingerprint>` was not in the state file:

If `<os>` is `Darwin`:
```bash
echo -n "$(hostname)|$(whoami)|$(uname -s)" | shasum -a 256 | cut -d' ' -f1
```

Otherwise:
```bash
echo -n "$(hostname)|$(whoami)|$(uname -s)" | sha256sum | cut -d' ' -f1
```

Store result as `<fingerprint>`.

## Phase 3: Confirm System Name (if missing)

If `<system_name>` was not in the state file:

Ask the user:
> I'll register this machine as **`<hostname>`**. Press Enter to confirm or type a different name:

Store confirmed name as `<system_name>`.

## Phase 4: Bootstrap

Call:
```
manage_extensions(
    action="bootstrap",
    system_fingerprint="<fingerprint>",
    system_name="<system_name>",
    hostname="<hostname>",
    os="<os>",
    project_id="<project_id>"   ← omit if no project_id
)
```

If the call fails, report the error and stop.

Extract `<system_id>` from `response.system.id` if present, otherwise `"unknown"`.

## Phase 5: Install Extensions

For each extension in `response.extensions`:

1. Create directory `~/.claude/skills/<name>/`
2. Write extension content to `~/.claude/skills/<name>/SKILL.md` using the Write tool (not bash heredoc)

## Phase 6: Update State

Read `.claude/archon-state.json` or start with `{}`.

Merge — do not overwrite existing fields like `archon_project_id`:
- `system_fingerprint`: `<fingerprint>`
- `system_name`: `<system_name>`
- `system_id`: `<system_id>`
- `last_bootstrap`: current ISO 8601 timestamp

Write merged object back to `.claude/archon-state.json`.

## Phase 7: Report

```
## Archon Setup Complete

System: <system_name> (<system_id>)
Extensions installed: <N> → ~/.claude/skills/
  - <list each extension name>
Project: <project name if registered, else "No project linked">

Restart Claude Code for the new extensions to take effect.
```

If `response.system.is_new` is `true`, also print:
```
This system has been registered with Archon for the first time.
```
