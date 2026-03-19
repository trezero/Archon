# Archon Setup — Register This Machine

Connect this machine to Archon: register it as a system, download all project extensions, and install them locally.

## Phase 0: Health Check

Call `health_check()` via the Archon MCP tool.

If the tool is not found (MCP not configured), do the following:

1. Check if `archon-config.json` exists in `.claude/` or `~/.claude/`. If found, read
   `archon_mcp_url` from it. Otherwise, ask the user:
   > "What is your Archon MCP URL? (e.g., http://172.16.1.230:8051)"

   Store the answer as `<archon_mcp_url>`.

2. Tell the user:
   ```
   Archon MCP is not configured. I'll add it now.
   ```

3. Run:
   ```bash
   claude mcp add --transport http archon <archon_mcp_url>/mcp
   ```

4. Tell the user:
   ```
   Archon MCP has been added. Please restart Claude Code for the new MCP
   connection to take effect, then run /archon-setup again.
   ```

5. Stop.

If the tool exists but the server is unreachable, print:
```
Archon server is not reachable. Check that the Archon stack is running.
```
Stop.

## Phase 1: Load Existing State and Determine Install Scope

Read `.claude/archon-state.json` if it exists. Extract:
- `system_fingerprint` → `<fingerprint>` (may be absent)
- `system_name` → `<system_name>` (may be absent)
- `archon_project_id` → `<project_id>` (may be absent)

Read `.claude/archon-config.json` if it exists (fall back to `~/.claude/archon-config.json`). Extract:
- `install_scope` → `<install_scope>` (may be absent)

Determine `<install_dir>`:
- If `<install_scope>` is `"project"` → `.claude`
- If `<install_scope>` is `"global"` or absent → `~/.claude`

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

## Phase 5: Verify Extensions

Extensions are pre-installed by the setup script. Verify they exist:

```bash
ls <install_dir>/skills/*/SKILL.md 2>/dev/null
```

If extensions are found, count them and continue to Phase 6.

If NO extensions are found (setup script download may have failed), download them:

1. Read `archon_mcp_url` from `.claude/archon-config.json` (fall back to `~/.claude/archon-config.json`)
2. Run:

```bash
mkdir -p <install_dir>/skills
curl -sf "<archon_mcp_url>/archon-setup/extensions.tar.gz" | tar xz -C "<install_dir>/skills/"
```

3. Verify again with the `ls` command above

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
Extensions installed: <N> → <install_dir>/skills/
  - <list each extension name>
Project: <project name if registered, else "No project linked">

Restart Claude Code for the new extensions to take effect.
```

If `response.system.is_new` is `true`, also print:
```
This system has been registered with Archon for the first time.
```
