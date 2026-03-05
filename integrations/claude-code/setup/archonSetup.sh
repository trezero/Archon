#!/usr/bin/env bash
# Archon Setup Script — Connect this machine to Archon
# Server URL is baked in at download time.

set -e

ARCHON_SERVER="{{ARCHON_SERVER_URL}}"
API_BASE="$ARCHON_SERVER"

# ── Helpers ─────────────────────────────────────────────────────────────────

print_header() {
  echo ""
  echo "╔══════════════════════════════════════╗"
  echo "║         Archon Setup                 ║"
  printf "║  Server: %-28s  ║\n" "$ARCHON_SERVER"
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
MCP_URL="$ARCHON_SERVER/mcp"
if claude mcp add --transport http archon "$MCP_URL" 2>/dev/null; then
  echo "      ✓ Added archon MCP server ($MCP_URL)"
else
  echo "      ✓ Archon MCP already configured (or updated)"
fi
echo ""

# ── Step 4/4: Install /archon-setup command ──────────────────────────────────

echo "[4/4] Installing /archon-setup command..."
mkdir -p "$HOME/.claude/commands"
curl -sf "$ARCHON_SERVER/archon-setup.md" -o "$HOME/.claude/commands/archon-setup.md"
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
echo "  This will register your system and install all project skills."
echo "══════════════════════════════════════"
echo ""
