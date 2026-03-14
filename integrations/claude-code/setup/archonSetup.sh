#!/usr/bin/env bash
# Archon Setup Script — Connect this machine to Archon
# Server URL is baked in at download time.

set -e

ARCHON_API_URL="{{ARCHON_API_URL}}"
ARCHON_MCP_URL="{{ARCHON_MCP_URL}}"

# Fall back to defaults if placeholders were not substituted (script run directly from repo)
[ "$ARCHON_API_URL" = "{{ARCHON_API_URL}}" ] && ARCHON_API_URL="http://172.16.1.230:8181"
[ "$ARCHON_MCP_URL" = "{{ARCHON_MCP_URL}}" ] && ARCHON_MCP_URL="http://172.16.1.230:8051"

API_BASE="$ARCHON_API_URL"

# ── UI helpers ────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_MAGENTA=$'\033[35m'
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_BLUE=""
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_MAGENTA=""
fi

print_header() {
  echo
  printf "%s%sArchon Setup%s\n" "$C_BOLD" "$C_CYAN" "$C_RESET"
  printf "  %sServer:%s %s\n" "$C_DIM" "$C_RESET" "$ARCHON_MCP_URL"
  printf "  %sAPI:%s    %s\n" "$C_DIM" "$C_RESET" "$ARCHON_API_URL"
  printf "  %s%s%s\n\n" "$C_DIM" "--------------------------------------------------" "$C_RESET"
}

ui_step() {
  printf "%s%s[%s/4] %s%s\n" "$C_BOLD" "$C_BLUE" "$1" "$2" "$C_RESET"
}

ui_info() {
  printf "  %s%s%s\n" "$C_DIM" "$1" "$C_RESET"
}

ui_success() {
  printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"
}

ui_warn() {
  printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1"
}

ui_error() {
  printf "  %sx%s %s\n" "$C_RED" "$C_RESET" "$1" >&2
}

ask() {
  local prompt="$1"
  local default="$2"
  local answer

  if [ -n "$default" ]; then
    printf "  %s%s%s [%s]: " "$C_MAGENTA" "$prompt" "$C_RESET" "$default" >&2
  else
    printf "  %s%s%s: " "$C_MAGENTA" "$prompt" "$C_RESET" >&2
  fi

  read -r answer || true
  printf "%s\n" "${answer:-$default}"
}

check_dependency() {
  if ! command -v "$1" &>/dev/null; then
    ui_error "'$1' is required but not installed."
    exit 1
  fi
}

url_encode() {
  python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"
}

# ── Dependency checks ────────────────────────────────────────────────────────

check_dependency curl
check_dependency python3
check_dependency claude

# ── Start ────────────────────────────────────────────────────────────────────

print_header

# ── Confirm server URLs ───────────────────────────────────────────────────────

printf "  %sArchon server URLs:%s\n" "$C_BOLD" "$C_RESET"
printf "  API: %s\n" "$ARCHON_API_URL"
printf "  MCP: %s\n" "$ARCHON_MCP_URL"
echo
NEW_API=$(ask "API URL (Enter to accept)" "$ARCHON_API_URL")
if [ "$NEW_API" != "$ARCHON_API_URL" ]; then
  ARCHON_API_URL="$NEW_API"
  # Derive a sensible MCP default by swapping :8181→:8051, then let user confirm
  ARCHON_MCP_URL=$(printf "%s" "$ARCHON_API_URL" | sed 's/:8181/:8051/')
fi
ARCHON_MCP_URL=$(ask "MCP URL (Enter to accept)" "$ARCHON_MCP_URL")
API_BASE="$ARCHON_API_URL"
echo

# ── Step 1/4: System name ────────────────────────────────────────────────────

ui_step 1 "System name"
SYSTEM_NAME=$(ask "System name" "$(hostname)")
echo

# ── Step 2/4: Project ────────────────────────────────────────────────────────

ui_step 2 "Project"

# Verify API is reachable before attempting any project operations
if ! curl -sf "$API_BASE/api/projects?include_content=false&q=" >/dev/null 2>&1; then
  ui_error "Cannot reach Archon API at $API_BASE"
  ui_info "Check that Archon is running and the URL is correct, then re-run this script."
  exit 1
fi

DIR_NAME=$(basename "$(pwd)")
PROJECT_ID=""
PROJECT_TITLE=""

ui_info "Searching for \"$DIR_NAME\"..."
SEARCH_RESULT=$(curl -sf "$API_BASE/api/projects?include_content=false&q=$(url_encode "$DIR_NAME")" 2>/dev/null || echo '{"projects":[]}')
MATCH_COUNT=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1]).get('projects',[])))" "$SEARCH_RESULT")

if [ "$MATCH_COUNT" -eq 1 ]; then
  # Exactly one match — use it automatically
  PROJECT_ID=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['projects'][0]['id'])" "$SEARCH_RESULT")
  PROJECT_TITLE=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['projects'][0]['title'])" "$SEARCH_RESULT")
  ui_success "Matched: $PROJECT_TITLE"

elif [ "$MATCH_COUNT" -eq 0 ]; then
  # No match — create a project automatically using the directory name
  ui_info "No match found. Creating project \"$DIR_NAME\"..."
  CREATE_PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'title': sys.argv[1]}))" "$DIR_NAME")
  TMPFILE=$(mktemp)
  HTTP_STATUS=$(curl -s -o "$TMPFILE" -w "%{http_code}" -X POST "$API_BASE/api/projects" \
    -H "Content-Type: application/json" \
    -d "$CREATE_PAYLOAD" 2>/dev/null || echo "000")
  CREATE_RESULT=$(cat "$TMPFILE" 2>/dev/null || echo "")
  rm -f "$TMPFILE"
  PROJECT_ID=$(python3 -c "
import json, sys
raw = sys.argv[1].strip()
if not raw:
    print('')
else:
    try:
        data = json.loads(raw)
    except Exception:
        data = {}
    print(data.get('project_id',''))
" "$CREATE_RESULT")
  PROJECT_TITLE="$DIR_NAME"
  if [ -z "$PROJECT_ID" ]; then
    ui_warn "Could not create project (HTTP $HTTP_STATUS). Continuing without project link."
  else
    ui_success "Created: $PROJECT_TITLE"
  fi

else
  # Multiple matches — show list and let user pick
  printf "  %sMultiple matches found — select one:%s\n" "$C_BOLD" "$C_RESET"
  python3 - "$SEARCH_RESULT" <<'PYEOF'
import json, sys
projects = json.loads(sys.argv[1]).get("projects", [])[:10]
for i, p in enumerate(projects, 1):
    print(f"    [{i}] {p['title']}")
PYEOF
  echo
  while true; do
    SELECTION=$(ask "Project number" "1")
    if echo "$SELECTION" | grep -qE '^[0-9]+$'; then
      IDX=$((SELECTION - 1))
      # List endpoint returns 'id'; the create endpoint returns 'project_id' — these are intentionally different
      PROJECT_ID=$(python3 -c "import json,sys; ps=json.loads(sys.argv[1]).get('projects',[]); print(ps[$IDX]['id'] if $IDX < len(ps) else '')" "$SEARCH_RESULT")
      PROJECT_TITLE=$(python3 -c "import json,sys; ps=json.loads(sys.argv[1]).get('projects',[]); print(ps[$IDX]['title'] if $IDX < len(ps) else '')" "$SEARCH_RESULT")
      if [ -z "$PROJECT_ID" ]; then
        ui_warn "Invalid selection."
      else
        ui_success "Selected: $PROJECT_TITLE"
        break
      fi
    else
      ui_warn "Please enter a number."
    fi
  done
fi

echo

# ── Step 3/4: Claude setup ───────────────────────────────────────────────────

ui_step 3 "Claude Code setup"
MCP_URL="$ARCHON_MCP_URL/mcp"
ui_info "Configuring MCP endpoint: $MCP_URL"

# Remove any existing archon MCP from all scopes so the URL is always up to date
claude mcp remove archon -s local   >/dev/null 2>&1 || true
claude mcp remove archon -s user    >/dev/null 2>&1 || true
claude mcp remove archon -s project >/dev/null 2>&1 || true

if claude mcp add --transport http -s local archon "$MCP_URL" >/dev/null 2>&1; then
  ui_success "MCP server configured: $MCP_URL"
else
  ui_warn "Could not configure MCP automatically."
  ui_info "Run manually: claude mcp add --transport http archon $MCP_URL"
fi
echo

printf "  %sInstall scope:%s\n" "$C_BOLD" "$C_RESET"
echo "    [1] This project only (recommended)"
echo "        Uses .claude/ in this repository."
echo "    [2] Global (all projects)"
echo "        Uses ~/.claude/ in your home directory."
echo

while true; do
  install_scope=$(ask "Install scope (1 or 2)" "1")
  if [ "$install_scope" = "1" ]; then
    INSTALL_DIR=".claude"
    INSTALL_SCOPE_LABEL="project"
    break
  fi
  if [ "$install_scope" = "2" ]; then
    INSTALL_DIR="$HOME/.claude"
    INSTALL_SCOPE_LABEL="global"
    break
  fi
  ui_warn "Please enter 1 or 2."
done
echo

# ── Check for existing claude-mem plugin ────────────────────────────────────

SKIP_PLUGIN_INSTALL=false
if [ -d "$HOME/.claude/plugins/cache/thedotmack/claude-mem" ] || [ -d ".claude/plugins/claude-mem" ]; then
  ui_warn "Detected existing plugin: claude-mem"
  echo "  The archon-memory plugin replaces claude-mem with Archon integration."
  echo
  echo "    [1] Remove claude-mem and install archon-memory (recommended)"
  echo "    [2] Keep both (not recommended - duplicate hooks and tools)"
  echo "    [3] Skip plugin installation"
  echo

  while true; do
    claude_mem_choice=$(ask "Plugin action (1, 2, or 3)" "1")
    if [ "$claude_mem_choice" = "1" ]; then
      rm -rf "$HOME/.claude/plugins/cache/thedotmack/claude-mem"
      rm -rf ".claude/plugins/claude-mem"
      ui_success "Removed claude-mem"
      break
    fi
    if [ "$claude_mem_choice" = "2" ]; then
      break
    fi
    if [ "$claude_mem_choice" = "3" ]; then
      SKIP_PLUGIN_INSTALL=true
      break
    fi
    ui_warn "Please enter 1, 2, or 3."
  done
  echo
fi

# ── Install archon-memory plugin ─────────────────────────────────────────────

if [ "$SKIP_PLUGIN_INSTALL" = "false" ]; then
  ui_info "Installing archon-memory plugin..."
  mkdir -p "$INSTALL_DIR/plugins"
  if curl -sf "${ARCHON_MCP_URL}/archon-setup/plugin/archon-memory.tar.gz" | \
    tar xz -C "$INSTALL_DIR/plugins/" 2>/dev/null; then
    ui_success "Plugin installed to $INSTALL_DIR/plugins/archon-memory/"
  else
    ui_warn "Plugin download failed. Install manually from Archon."
  fi
  echo
fi

# ── Write archon-config.json ─────────────────────────────────────────────────

mkdir -p "$INSTALL_DIR"
machine_fingerprint=$(python3 -c "import hashlib,socket,os; print(hashlib.md5((socket.gethostname()+str(os.getuid())).encode()).hexdigest()[:16])")

cat > "$INSTALL_DIR/archon-config.json" << CONFIGEOF
{
  "archon_api_url": "$ARCHON_API_URL",
  "archon_mcp_url": "$ARCHON_MCP_URL",
  "project_id": "$PROJECT_ID",
  "project_title": "$PROJECT_TITLE",
  "machine_id": "$machine_fingerprint",
  "install_scope": "$INSTALL_SCOPE_LABEL",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
CONFIGEOF
ui_success "Wrote $INSTALL_DIR/archon-config.json"
echo

# ── Update .gitignore ────────────────────────────────────────────────────────

for entry in ".claude/plugins/" ".claude/skills/" ".claude/archon-config.json" ".claude/archon-state.json" ".claude/archon-memory-buffer.jsonl"; do
  grep -qxF "$entry" .gitignore 2>/dev/null || echo "$entry" >> .gitignore
done
ui_success "Updated .gitignore with Archon local paths."
echo

# ── Step 4/4: Install /archon-setup command ─────────────────────────────────

ui_step 4 "Install /archon-setup command"
mkdir -p "$HOME/.claude/commands"
if curl -sf "$ARCHON_MCP_URL/archon-setup.md" -o "$HOME/.claude/commands/archon-setup.md"; then
  ui_success "Installed to ~/.claude/commands/archon-setup.md"
else
  ui_warn "Could not download /archon-setup command file."
fi
echo

# ── Write initial state ──────────────────────────────────────────────────────

mkdir -p ".claude"
STATE_FILE=".claude/archon-state.json"

# Merge with existing state if present
if [ -f "$STATE_FILE" ]; then
  EXISTING=$(cat "$STATE_FILE")
else
  EXISTING="{}"
fi

python3 - "$EXISTING" "$SYSTEM_NAME" "$PROJECT_ID" <<'PYEOF'
import json, sys
state = json.loads(sys.argv[1])
state["system_name"] = sys.argv[2]
if sys.argv[3]:
    state["archon_project_id"] = sys.argv[3]
with open(".claude/archon-state.json", "w") as f:
    json.dump(state, f, indent=2)
PYEOF

# ── Done ─────────────────────────────────────────────────────────────────────

printf "%s%sSetup complete!%s\n\n" "$C_BOLD" "$C_GREEN" "$C_RESET"
echo "  Open Claude Code in this directory and run:"
printf "    %s/archon-setup%s\n\n" "$C_BOLD" "$C_RESET"
echo "  This will sync extensions and project context."
echo
