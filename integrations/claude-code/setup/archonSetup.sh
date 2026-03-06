#!/usr/bin/env bash
# Archon Setup Script — Connect this machine to Archon
# Server URL is baked in at download time.

set -e

ARCHON_API_URL="{{ARCHON_API_URL}}"
ARCHON_MCP_URL="{{ARCHON_MCP_URL}}"
API_BASE="$ARCHON_API_URL"

# ── Helpers ─────────────────────────────────────────────────────────────────

print_header() {
  echo ""
  echo "╔══════════════════════════════════════╗"
  echo "║         Archon Setup                 ║"
  printf "║  Server: %-28s  ║\n" "$ARCHON_MCP_URL"
  echo "╚══════════════════════════════════════╝"
  echo ""
}

check_dependency() {
  if ! command -v "$1" &>/dev/null; then
    echo "Error: '$1' is required but not installed." >&2
    exit 1
  fi
}

ask() {
  local prompt="$1"
  local default="$2"
  local answer
  printf "%s [%s]: " "$prompt" "$default"
  read -r answer
  echo "${answer:-$default}"
}

# ── Dependency checks ────────────────────────────────────────────────────────

check_dependency curl
check_dependency python3
check_dependency claude

# ── Start ────────────────────────────────────────────────────────────────────

print_header

# ── Step 1/4: System name ────────────────────────────────────────────────────

echo "[1/4] System name"
DETECTED_HOSTNAME=$(hostname)
SYSTEM_NAME=$(ask "      Name for this machine" "$DETECTED_HOSTNAME")
echo ""

# ── Step 2/4: Project ────────────────────────────────────────────────────────

echo "[2/4] Project"

# Try to match current directory name to an Archon project
DIR_NAME=$(basename "$(pwd)")
MATCHED_PROJECT=""
MATCHED_PROJECT_ID=""
PROJECT_ID=""
PROJECT_TITLE=""

SEARCH_RESULT=$(curl -sf "$API_BASE/api/projects?include_content=false&q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$DIR_NAME")" 2>/dev/null || echo '{"projects":[]}')
MATCH_COUNT=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(len(d.get('projects',[])))" "$SEARCH_RESULT")

if [ "$MATCH_COUNT" -eq 1 ]; then
  MATCHED_PROJECT=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['projects'][0]['title'])" "$SEARCH_RESULT")
  MATCHED_PROJECT_ID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d['projects'][0]['id'])" "$SEARCH_RESULT")
  printf "      Matched in Archon: %s\n" "$MATCHED_PROJECT"
  CONFIRM=$(ask "      Press Enter to accept or type to search" "")
  if [ -z "$CONFIRM" ]; then
    PROJECT_ID="$MATCHED_PROJECT_ID"
    PROJECT_TITLE="$MATCHED_PROJECT"
  else
    SEARCH_TERM="$CONFIRM"
    MATCHED_PROJECT=""
  fi
fi

# Search loop
if [ -z "$PROJECT_ID" ]; then
  SEARCH_TERM="${SEARCH_TERM:-}"
  while true; do
    if [ -z "$SEARCH_TERM" ]; then
      printf "      Search (or Enter to list all): "
      read -r SEARCH_TERM
    fi

    ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$SEARCH_TERM")
    RESULTS=$(curl -sf "$API_BASE/api/projects?include_content=false&q=$ENCODED" 2>/dev/null || echo '{"projects":[]}')
    COUNT=$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1]).get('projects',[])))" "$RESULTS")

    echo ""
    if [ "$COUNT" -eq 0 ]; then
      echo "      No results found."
    else
      python3 - "$RESULTS" <<'PYEOF'
import json, sys
data = json.loads(sys.argv[1])
projects = data.get("projects", [])[:10]
for i, p in enumerate(projects, 1):
    print(f"        {i}. {p['title']}")
PYEOF
    fi

    echo "        C. Create new project in Archon"
    echo ""
    printf "      Enter number, new search term, or C to create: "
    read -r SELECTION

    if [ "$SELECTION" = "C" ] || [ "$SELECTION" = "c" ]; then
      # Create new project
      DEFAULT_NAME="$DIR_NAME"
      NEW_NAME=$(ask "      New project name" "$DEFAULT_NAME")
      printf "      Description (optional): "
      read -r NEW_DESC
      echo "      Creating project..."
      CREATE_PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({'title': sys.argv[1], 'description': sys.argv[2]}))
" "$NEW_NAME" "$NEW_DESC")
      CREATE_RESULT=$(curl -sf -X POST "$API_BASE/api/projects" \
        -H "Content-Type: application/json" \
        -d "$CREATE_PAYLOAD" 2>/dev/null)
      PROJECT_ID=$(python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(d.get('id',''))" "$CREATE_RESULT")
      PROJECT_TITLE="$NEW_NAME"
      if [ -z "$PROJECT_ID" ]; then
        echo "      Error creating project. Continuing without project link."
      else
        echo "      ✓ Created \"$NEW_NAME\""
      fi
      break
    elif echo "$SELECTION" | grep -qE '^[0-9]+$'; then
      IDX=$((SELECTION - 1))
      PROJECT_ID=$(python3 -c "import json,sys; ps=json.loads(sys.argv[1]).get('projects',[]); print(ps[$IDX]['id'] if $IDX < len(ps) else '')" "$RESULTS")
      PROJECT_TITLE=$(python3 -c "import json,sys; ps=json.loads(sys.argv[1]).get('projects',[]); print(ps[$IDX]['title'] if $IDX < len(ps) else '')" "$RESULTS")
      if [ -z "$PROJECT_ID" ]; then
        echo "      Invalid selection."
      else
        break
      fi
    else
      SEARCH_TERM="$SELECTION"
    fi
  done
fi

echo ""

# ── Step 3/4: Add MCP ────────────────────────────────────────────────────────

echo "[3/4] Setting up Claude Code MCP..."
MCP_URL="$ARCHON_MCP_URL/mcp"
if claude mcp add --transport http archon "$MCP_URL" 2>/dev/null; then
  echo "      ✓ Added archon MCP server ($MCP_URL)"
else
  echo "      ✓ Archon MCP already configured (or updated)"
fi
echo ""

# ── Step 3.5: Install scope ──────────────────────────────────────────────────

echo ""
echo "Where should Archon tools be installed?"
echo ""
echo "  [1] This project only (recommended)"
echo "      Installed to .claude/ in your project root."
echo "      Customize per-project, changes stay isolated."
echo ""
echo "  [2] Global (all projects)"
echo "      Installed to ~/.claude/ in your home directory."
echo "      Same setup shared across all projects."
echo ""
read -p "Choice [1]: " install_scope
install_scope="${install_scope:-1}"

if [ "$install_scope" = "2" ]; then
    INSTALL_DIR="$HOME/.claude"
else
    INSTALL_DIR=".claude"
fi
echo ""

# ── Check for existing claude-mem plugin ────────────────────────────────────

SKIP_PLUGIN_INSTALL=false
if [ -d "$HOME/.claude/plugins/cache/thedotmack/claude-mem" ] || [ -d ".claude/plugins/claude-mem" ]; then
    echo "Detected existing plugin: claude-mem"
    echo "The archon-memory plugin replaces claude-mem with enhanced"
    echo "features and Archon integration."
    echo ""
    echo "  [1] Remove claude-mem and install archon-memory (recommended)"
    echo "  [2] Keep both (not recommended - duplicate hooks and tools)"
    echo "  [3] Skip plugin installation"
    echo ""
    read -p "Choice [1]: " claude_mem_choice
    claude_mem_choice="${claude_mem_choice:-1}"

    if [ "$claude_mem_choice" = "1" ]; then
        rm -rf "$HOME/.claude/plugins/cache/thedotmack/claude-mem"
        rm -rf ".claude/plugins/claude-mem"
        echo "✓ Removed claude-mem"
    elif [ "$claude_mem_choice" = "3" ]; then
        SKIP_PLUGIN_INSTALL=true
    fi
    echo ""
fi

# ── Install archon-memory plugin ─────────────────────────────────────────────

if [ "$SKIP_PLUGIN_INSTALL" = "false" ]; then
    echo "Installing archon-memory plugin..."
    mkdir -p "$INSTALL_DIR/plugins/archon-memory"
    if curl -sf "${ARCHON_MCP_URL}/archon-setup/plugin/archon-memory.tar.gz" | \
        tar xz -C "$INSTALL_DIR/plugins/" 2>/dev/null; then
        echo "      ✓ Plugin installed to $INSTALL_DIR/plugins/archon-memory/"
    else
        echo "      ⚠ Plugin download failed — install manually from Archon"
    fi
    echo ""
fi

# ── Write archon-config.json ─────────────────────────────────────────────────

machine_fingerprint=$(python3 -c "import hashlib,socket,os; print(hashlib.md5((socket.gethostname()+str(os.getuid())).encode()).hexdigest()[:16])")

cat > "$INSTALL_DIR/archon-config.json" << CONFIGEOF
{
  "archon_api_url": "$ARCHON_API_URL",
  "archon_mcp_url": "$ARCHON_MCP_URL",
  "project_id": "$PROJECT_ID",
  "project_title": "$PROJECT_TITLE",
  "machine_id": "$machine_fingerprint",
  "install_scope": "$install_scope",
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
CONFIGEOF
echo "      ✓ Wrote $INSTALL_DIR/archon-config.json"
echo ""

# ── Update .gitignore ────────────────────────────────────────────────────────

for entry in ".claude/plugins/" ".claude/archon-config.json" ".claude/archon-memory-buffer.jsonl"; do
    grep -qxF "$entry" .gitignore 2>/dev/null || echo "$entry" >> .gitignore
done

# ── Step 4/4: Install /archon-setup command ──────────────────────────────────

echo "[4/4] Installing /archon-setup command..."
mkdir -p "$HOME/.claude/commands"
curl -sf "$ARCHON_MCP_URL/archon-setup.md" -o "$HOME/.claude/commands/archon-setup.md"
echo "      ✓ Installed to ~/.claude/commands/archon-setup.md"
echo ""

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

echo "══════════════════════════════════════"
echo "✓ Setup complete!"
echo ""
echo "  Open Claude Code in this directory and run:"
echo ""
echo "    /archon-setup"
echo ""
echo "  This will sync extensions and project context."
echo "══════════════════════════════════════"
echo ""
