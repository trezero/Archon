# Phase 5: CLI Binary Distribution

## Overview

Phase 5 creates standalone binary distributions of the Archon CLI for macOS and Linux. This enables users to install and run Archon without needing Bun, Node.js, or any other runtime installed. Windows users will use a documented manual installation process via cloning the repository.

**Why this matters:**

- Zero-dependency installation for end users
- Single binary download (no `npm install`, no `bun install`)
- Works immediately after install (`archon workflow list`)
- Leverages Phase 3's SQLite support (no PostgreSQL required)

## Prerequisites

- [x] Phase 1 complete: Monorepo structure with `@archon/core` extracted
- [x] Phase 2 complete: CLI entry point and basic commands working
- [x] Phase 3 complete: Database abstraction (SQLite + PostgreSQL auto-detection)
- [x] Phase 4 complete: Express → Hono migration
- [x] **Issue #322 complete**: Default commands/workflows loaded at runtime (not copied) - PR #324 merged

**Critical dependency from Phase 3**: The CLI uses SQLite by default when `DATABASE_URL` is not set. This is essential for standalone binary distribution - users don't need a database server.

**Critical dependency from Issue #322**: Default commands and workflows must be bundled into the binary. See "Bundled Defaults" section below.

## Current State

The CLI exists at `packages/cli/` with:

- Entry point: `src/cli.ts` (shebang: `#!/usr/bin/env bun`)
- Commands: `workflow list/run/status`, `isolation list/cleanup`, `version`
- Package name: `@archon/cli`
- Current invocation: `bun run cli` or `bun packages/cli/src/cli.ts`

**Existing GitHub Actions:**

- `publish.yml` - Docker image publishing (triggers on tags/releases)
- `test.yml` - CI testing

## Desired End State

Users can install Archon CLI with a single command:

```bash
# macOS/Linux - Primary method
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash

# Homebrew - Alternative for Homebrew users
brew install https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/Formula/archon.rb

# Then use immediately
archon workflow list
archon workflow run assist "Hello world"
```

**Note**: This repository is currently at `dynamous-community/remote-coding-agent` and will be moved to a public repository (likely `archon-cli/archon` or similar) before the first release. All URLs in this plan use a `REPO` variable that will be updated at that time.

**Platform support:**
| Platform | Architecture | Distribution Method |
|----------|-------------|---------------------|
| macOS | ARM64 (Apple Silicon) | curl script, Homebrew, direct download |
| macOS | x64 (Intel) | curl script, Homebrew, direct download |
| Linux | x64 | curl script, direct download |
| Linux | ARM64 | curl script, direct download |
| Windows | x64 | Manual: clone repo + `bun run cli` |

**Verification:**

- Downloaded binary runs without Bun installed
- `archon version` shows correct version
- `archon workflow list` works (uses SQLite, no DATABASE_URL needed)
- curl script detects OS/arch and downloads correct binary
- GitHub Releases contains all platform binaries

## What We're NOT Doing

- NOT creating a separate Homebrew tap repository (deferred to Phase 6)
- NOT publishing to npm
- NOT creating Windows binary (users clone + run with Bun)
- NOT setting up custom domain (using GitHub URLs)
- NOT adding new CLI features (distribution only)
- NOT changing CLI behavior

## Repository Location

**Current**: `dynamous-community/remote-coding-agent` (private)

**Future**: Will be moved to a public repository before the first binary release. When this happens:

1. Update the `REPO` variable in `scripts/install.sh`
2. Update the URLs in `Formula/archon.rb`
3. Update the README.md installation instructions

All scripts use variables (`$REPO`, `${{ github.repository }}`) to make this transition easier.

---

## Bundled Defaults (Critical for Binary Distribution)

### The Problem

When the CLI is compiled into a standalone binary, it has **no access to filesystem defaults**. The binary is just compiled TypeScript—it cannot read the loose `.archon/commands/defaults/` and `.archon/workflows/defaults/` files that exist in the source repository.

**Without bundling:**
| Scenario | Result |
|----------|--------|
| User installs standalone binary | 0 commands, 0 workflows available |
| User runs `archon workflow list` | Empty list |
| User runs `archon workflow run assist "Hello"` | "Workflow not found" error |

### The Solution

Bundle default commands and workflows **into the compiled binary** at build time using Bun's static imports:

```typescript
// packages/core/src/defaults/bundled-defaults.ts
import assistCommand from '../../../.archon/commands/defaults/assist.md' with { type: 'text' };
import fixGithubIssueWorkflow from '../../../.archon/workflows/defaults/fix-github-issue.yaml' with { type: 'text' };
// ... all other defaults

export const BUNDLED_COMMANDS = {
  assist: assistCommand,
  implement: implementCommand,
  // ... 16 total commands
};

export const BUNDLED_WORKFLOWS = {
  'fix-github-issue': fixGithubIssueWorkflow,
  assist: assistWorkflow,
  // ... 8 total workflows
};
```

These imports are resolved at **compile time** and embedded directly into the binary. At runtime, the CLI reads from the embedded content.

### How It Works With Issue #322

Issue #322 changes the loading behavior to:

1. Load app's defaults at runtime (from filesystem when running with Bun)
2. Load target repo's project-specific commands (additive)

For the standalone binary, we extend this:

1. **If running as binary**: Load from `BUNDLED_COMMANDS` and `BUNDLED_WORKFLOWS`
2. **If running with Bun**: Load from filesystem (existing behavior)
3. Load target repo's project-specific commands (additive, same either way)

```typescript
// packages/core/src/workflows/loader.ts
import { BUNDLED_WORKFLOWS } from '../defaults/bundled-defaults';

function isBinaryBuild(): boolean {
  return !process.execPath.toLowerCase().includes('bun');
}

async function discoverWorkflows(targetRepoPath: string): Promise<Workflow[]> {
  const workflows: Workflow[] = [];

  // 1. Load defaults (bundled for binary, filesystem for bun)
  if (isBinaryBuild()) {
    // Binary: use embedded defaults
    for (const [name, content] of Object.entries(BUNDLED_WORKFLOWS)) {
      workflows.push(parseWorkflow(name, content));
    }
  } else {
    // Bun: load from filesystem (existing behavior)
    const appDefaultsPath = join(getAppArchonBasePath(), 'workflows', 'defaults');
    workflows.push(...(await loadWorkflowsFrom(appDefaultsPath)));
  }

  // 2. Load repo's project-specific workflows (additive)
  const repoWorkflowsPath = join(targetRepoPath, '.archon', 'workflows');
  workflows.push(...(await loadWorkflowsFrom(repoWorkflowsPath)));

  return dedupeByName(workflows);
}
```

### Binary Size Impact

The defaults are just text files (~150KB total). This adds negligible size to the ~50-100MB binary.

### Implementation Note

**Issue #322 must be completed first.** It establishes:

- Runtime loading architecture (no more copying)
- Multi-source discovery (app defaults + repo-specific)
- Opt-out configuration

Phase 5 then adds:

- The `bundled-defaults.ts` file with static imports
- Detection of binary vs Bun runtime
- Conditional loading from bundled content

---

## Implementation Plan

### Phase 5.0: Bundle Defaults for Binary Distribution

**Goal**: Create the bundled defaults module so default commands and workflows are embedded in the compiled binary.

**Prerequisite**: Issue #322 must be merged first (runtime loading architecture).

**Files Created:**

- `packages/core/src/defaults/bundled-defaults.ts` - Static imports of all defaults
- `packages/core/src/defaults/index.ts` - Exports for the defaults module

**Changes:**

#### 5.0.1: Create bundled-defaults.ts

```typescript
// packages/core/src/defaults/bundled-defaults.ts
// Static imports - resolved at compile time and embedded in binary

// Commands (16 total)
import assistCmd from '../../../../.archon/commands/defaults/assist.md' with { type: 'text' };
import implementCmd from '../../../../.archon/commands/defaults/implement.md' with { type: 'text' };
import planCmd from '../../../../.archon/commands/defaults/plan.md' with { type: 'text' };
import investigateCmd from '../../../../.archon/commands/defaults/investigate.md' with { type: 'text' };
import debugCmd from '../../../../.archon/commands/defaults/debug.md' with { type: 'text' };
import reviewCmd from '../../../../.archon/commands/defaults/review.md' with { type: 'text' };
import commitCmd from '../../../../.archon/commands/defaults/commit.md' with { type: 'text' };
import prCmd from '../../../../.archon/commands/defaults/pr.md' with { type: 'text' };
// ... import all 16 commands

// Workflows (8 total)
import fixGithubIssueWf from '../../../../.archon/workflows/defaults/fix-github-issue.yaml' with { type: 'text' };
import assistWf from '../../../../.archon/workflows/defaults/assist.yaml' with { type: 'text' };
import implementWf from '../../../../.archon/workflows/defaults/implement.yaml' with { type: 'text' };
import planWf from '../../../../.archon/workflows/defaults/plan.yaml' with { type: 'text' };
// ... import all 8 workflows

export const BUNDLED_COMMANDS: Record<string, string> = {
  assist: assistCmd,
  implement: implementCmd,
  plan: planCmd,
  investigate: investigateCmd,
  debug: debugCmd,
  review: reviewCmd,
  commit: commitCmd,
  pr: prCmd,
  // ... all 16 commands
};

export const BUNDLED_WORKFLOWS: Record<string, string> = {
  'fix-github-issue': fixGithubIssueWf,
  assist: assistWf,
  implement: implementWf,
  plan: planWf,
  // ... all 8 workflows
};
```

**Note**: The actual file will need to import ALL defaults. Generate this file by listing `.archon/commands/defaults/` and `.archon/workflows/defaults/`.

#### 5.0.2: Update workflow loader to use bundled defaults

Modify `packages/core/src/workflows/loader.ts`:

```typescript
import { BUNDLED_WORKFLOWS } from '../defaults/bundled-defaults';

/**
 * Detect if running as compiled binary (vs running with bun)
 */
function isBinaryBuild(): boolean {
  return !process.execPath.toLowerCase().includes('bun');
}

/**
 * Load bundled workflows (for binary distribution)
 */
function loadBundledWorkflows(): Workflow[] {
  return Object.entries(BUNDLED_WORKFLOWS).map(([name, content]) => {
    return parseWorkflowYaml(name, content);
  });
}

// Update discoverWorkflows to check isBinaryBuild()
```

#### 5.0.3: Update command handler to use bundled defaults

Similar changes to `packages/core/src/handlers/command-handler.ts` for commands.

### Success Criteria (5.0):

#### Automated Verification:

- [x] `bun run type-check` passes
- [x] `bun test` passes
- [x] All default commands and workflows are imported in `bundled-defaults.ts`

#### Manual Verification:

- [x] Build a test binary: `bun build --compile packages/cli/src/cli.ts --outfile=test-archon`
- [x] Run `./test-archon workflow list` - should show all default workflows
- [ ] Run `./test-archon workflow run assist "Hello"` - should work (deferred - requires database)
- [x] Compare output to `bun run cli workflow list` - should be identical

**Implementation Note**: This phase must be completed before Phase 5.1 (build scripts). The bundled defaults are essential for the binary to be useful.

---

### Phase 5.1: Build Scripts for Binary Compilation

**Goal**: Create scripts to compile the CLI into standalone binaries for all target platforms.

**Files Created:**

- `scripts/build-binaries.sh` - Main build script
- `scripts/checksums.sh` - Generate SHA256 checksums

**Changes:**

#### 5.1.1: Create build-binaries.sh

```bash
#!/usr/bin/env bash
# scripts/build-binaries.sh
# Build standalone CLI binaries for all supported platforms

set -euo pipefail

# Get version from package.json or git tag
VERSION="${VERSION:-$(grep '"version"' package.json | head -1 | cut -d'"' -f4)}"
echo "Building Archon CLI v${VERSION}"

# Output directory
DIST_DIR="dist/binaries"
mkdir -p "$DIST_DIR"

# Define build targets
# Format: bun-target output-name
TARGETS=(
  "bun-darwin-arm64:archon-darwin-arm64"
  "bun-darwin-x64:archon-darwin-x64"
  "bun-linux-x64:archon-linux-x64"
  "bun-linux-arm64:archon-linux-arm64"
)

# Build each target
for target_pair in "${TARGETS[@]}"; do
  IFS=':' read -r target output_name <<< "$target_pair"
  echo "Building for $target..."

  bun build \
    --compile \
    --target="$target" \
    --outfile="$DIST_DIR/$output_name" \
    packages/cli/src/cli.ts

  echo "  → $DIST_DIR/$output_name"
done

echo ""
echo "Build complete! Binaries in $DIST_DIR:"
ls -lh "$DIST_DIR"
```

#### 5.1.2: Create checksums.sh

```bash
#!/usr/bin/env bash
# scripts/checksums.sh
# Generate SHA256 checksums for release binaries

set -euo pipefail

DIST_DIR="${1:-dist/binaries}"
CHECKSUM_FILE="$DIST_DIR/checksums.txt"

echo "Generating checksums for binaries in $DIST_DIR"

cd "$DIST_DIR"
shasum -a 256 archon-* > checksums.txt

echo "Checksums written to $CHECKSUM_FILE:"
cat checksums.txt
```

#### 5.1.3: Update root package.json

Add build scripts:

```json
{
  "scripts": {
    "build:binaries": "bash scripts/build-binaries.sh",
    "build:checksums": "bash scripts/checksums.sh"
  }
}
```

### Success Criteria (5.1):

#### Automated Verification:

- [x] `bun run build:binaries` completes without errors
- [x] Four binaries exist in `dist/binaries/`:
  - `archon-darwin-arm64`
  - `archon-darwin-x64`
  - `archon-linux-x64`
  - `archon-linux-arm64`
- [x] `bun run build:checksums` generates `dist/binaries/checksums.txt`
- [x] Each binary is executable: `chmod +x` and file shows correct architecture

#### Manual Verification:

- [x] On macOS ARM64: `./dist/binaries/archon-darwin-arm64 version` works
- [ ] Binary runs without Bun installed (test in clean environment or Docker) (deferred - manual verification)

**Implementation Note**: Complete this phase before proceeding. The build scripts are the foundation for all distribution methods.

---

### Phase 5.2: GitHub Actions Release Workflow

**Goal**: Automate binary building and release on git tags.

**Files Created:**

- `.github/workflows/release.yml` - Build and release binaries

**Changes:**

#### 5.2.1: Create release.yml

````yaml
name: Release

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:
    inputs:
      tag:
        description: 'Tag to release (e.g., v0.3.0)'
        required: true

permissions:
  contents: write

jobs:
  build:
    name: Build binaries
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build binaries
        run: bun run build:binaries

      - name: Generate checksums
        run: bun run build:checksums

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: binaries
          path: dist/binaries/*
          retention-days: 7

  release:
    name: Create GitHub Release
    needs: build
    runs-on: ubuntu-latest

    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          name: binaries
          path: dist/binaries

      - name: Get version
        id: version
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "version=${{ inputs.tag }}" >> $GITHUB_OUTPUT
          else
            echo "version=${GITHUB_REF#refs/tags/}" >> $GITHUB_OUTPUT
          fi

      - name: Create Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.version.outputs.version }}
          name: Archon ${{ steps.version.outputs.version }}
          draft: false
          prerelease: ${{ contains(steps.version.outputs.version, '-') }}
          files: |
            dist/binaries/archon-darwin-arm64
            dist/binaries/archon-darwin-x64
            dist/binaries/archon-linux-x64
            dist/binaries/archon-linux-arm64
            dist/binaries/checksums.txt
          body: |
            ## Installation

            ### Quick Install (macOS/Linux)
            ```bash
            curl -fsSL https://raw.githubusercontent.com/${{ github.repository }}/main/scripts/install.sh | bash
            ```

            ### Manual Download
            Download the appropriate binary for your platform below, then:
            ```bash
            chmod +x archon-*
            sudo mv archon-* /usr/local/bin/archon
            ```

            ### Verify Checksums
            ```bash
            shasum -a 256 -c checksums.txt
            ```

            ## What's New
            See [CHANGELOG.md](https://github.com/${{ github.repository }}/blob/main/CHANGELOG.md) for details.
````

### Success Criteria (5.2):

#### Automated Verification:

- [x] Workflow file created at `.github/workflows/release.yml`
- [ ] Push a test tag (e.g., `v0.2.1-test`) triggers the workflow (deferred - manual test)
- [ ] Workflow completes successfully (deferred - requires push)
- [ ] GitHub Release is created with all 5 files (4 binaries + checksums) (deferred - requires push)

#### Manual Verification:

- [ ] Download a binary from the release and verify it runs (deferred - requires release)
- [ ] Checksums match: `shasum -a 256 -c checksums.txt` (deferred - requires release)
- [ ] Delete test release and tag after verification (deferred - requires release)

**Implementation Note**: Test with a pre-release tag first before creating a real release.

---

### Phase 5.3: Curl Install Script

**Goal**: Create an install script that detects OS/architecture and installs the correct binary.

**Files Created:**

- `scripts/install.sh` - Universal install script

**Changes:**

#### 5.3.1: Create install.sh

```bash
#!/usr/bin/env bash
# scripts/install.sh
# Install Archon CLI - downloads the correct binary for your platform
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
#
# Environment variables:
#   ARCHON_VERSION  - Specific version to install (default: latest)
#   ARCHON_INSTALL_DIR - Installation directory (default: /usr/local/bin)

set -euo pipefail

# Configuration
# NOTE: Update this when repository moves to public location
REPO="${ARCHON_REPO:-dynamous-community/remote-coding-agent}"
INSTALL_DIR="${ARCHON_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="archon"

# Colors for output (if terminal supports it)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

# Detect OS
detect_os() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    MINGW* | MSYS* | CYGWIN*)
      error "Windows is not supported via this script. Please see: https://github.com/$REPO#windows-installation"
      ;;
    *) error "Unsupported operating system: $os" ;;
  esac
}

# Detect architecture
detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) echo "x64" ;;
    arm64 | aarch64) echo "arm64" ;;
    *) error "Unsupported architecture: $arch" ;;
  esac
}

# Get latest version from GitHub releases
get_latest_version() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
    grep '"tag_name"' |
    head -1 |
    cut -d'"' -f4
}

# Download and install
main() {
  info "Archon CLI Installer"
  echo ""

  # Detect platform
  local os arch
  os="$(detect_os)"
  arch="$(detect_arch)"
  info "Detected platform: $os-$arch"

  # Get version
  local version
  version="${ARCHON_VERSION:-$(get_latest_version)}"
  if [[ -z "$version" ]]; then
    error "Could not determine version to install. Set ARCHON_VERSION or check GitHub releases."
  fi
  info "Installing version: $version"

  # Construct download URL
  local binary_name="archon-${os}-${arch}"
  local download_url="https://github.com/$REPO/releases/download/${version}/${binary_name}"

  # Create temp directory
  local tmp_dir
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  # Download binary
  info "Downloading $binary_name..."
  if ! curl -fsSL "$download_url" -o "$tmp_dir/archon"; then
    error "Failed to download binary from: $download_url"
  fi

  # Make executable
  chmod +x "$tmp_dir/archon"

  # Verify binary works
  info "Verifying binary..."
  if ! "$tmp_dir/archon" version > /dev/null 2>&1; then
    error "Binary verification failed. The downloaded file may be corrupted."
  fi

  # Install to destination
  info "Installing to $INSTALL_DIR..."
  if [[ -w "$INSTALL_DIR" ]]; then
    mv "$tmp_dir/archon" "$INSTALL_DIR/$BINARY_NAME"
  else
    warn "Need sudo to install to $INSTALL_DIR"
    sudo mv "$tmp_dir/archon" "$INSTALL_DIR/$BINARY_NAME"
  fi

  echo ""
  success "Archon CLI $version installed successfully!"
  echo ""
  info "Run 'archon help' to get started"
  info "Documentation: https://github.com/$REPO"
}

main "$@"
```

### Success Criteria (5.3):

#### Automated Verification:

- [x] Script syntax is valid: `bash -n scripts/install.sh`
- [x] Script is executable: `chmod +x scripts/install.sh`
- [ ] `shellcheck scripts/install.sh` passes (optional - shellcheck not installed)

#### Manual Verification:

- [ ] Test on macOS (after releasing binaries) (deferred - requires release):
  ```bash
  curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
  archon version
  ```
- [ ] Test on Linux (Docker) (deferred - requires release):
  ```bash
  docker run --rm -it ubuntu:22.04 bash -c "
    apt-get update && apt-get install -y curl
    curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
    /usr/local/bin/archon version
  "
  ```
- [ ] Verify correct binary is downloaded for each platform/architecture (deferred - requires release)
- [ ] Verify error message shows for Windows detection (deferred - requires Windows)

**Implementation Note**: The install script must be committed to `main` before it can be used via raw.githubusercontent.com URL.

---

### Phase 5.4: Homebrew Formula (Main Repo)

**Goal**: Create a Homebrew formula in the main repository for users who prefer Homebrew.

**Files Created:**

- `Formula/archon.rb` - Homebrew formula

**Changes:**

#### 5.4.1: Create Formula directory and formula

```ruby
# Formula/archon.rb
# Homebrew formula for Archon CLI
# Install: brew install --HEAD https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/Formula/archon.rb

class Archon < Formula
  desc "AI-powered coding assistant CLI - run workflows from the command line"
  homepage "https://github.com/dynamous-community/remote-coding-agent"
  license "MIT"

  # Version-specific bottles (populated by release workflow)
  # For now, we use HEAD installation which downloads from releases

  on_macos do
    on_arm do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/latest/download/archon-darwin-arm64"
      sha256 :no_check  # Will be populated in versioned releases

      def install
        bin.install "archon-darwin-arm64" => "archon"
      end
    end

    on_intel do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/latest/download/archon-darwin-x64"
      sha256 :no_check  # Will be populated in versioned releases

      def install
        bin.install "archon-darwin-x64" => "archon"
      end
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/latest/download/archon-linux-arm64"
      sha256 :no_check  # Will be populated in versioned releases

      def install
        bin.install "archon-linux-arm64" => "archon"
      end
    end

    on_intel do
      url "https://github.com/dynamous-community/remote-coding-agent/releases/latest/download/archon-linux-x64"
      sha256 :no_check  # Will be populated in versioned releases

      def install
        bin.install "archon-linux-x64" => "archon"
      end
    end
  end

  test do
    assert_match "Archon CLI", shell_output("#{bin}/archon version")
  end
end
```

**Note**: This formula uses `sha256 :no_check` which Homebrew allows but warns about. For production, we'll want to either:

1. Create versioned formulas with actual checksums (Phase 6 with Homebrew tap)
2. Or use the curl script as the primary installation method

#### 5.4.2: Alternative - Simple HEAD formula

If the above approach has issues, here's a simpler HEAD-only formula:

```ruby
# Formula/archon.rb
class Archon < Formula
  desc "AI-powered coding assistant CLI"
  homepage "https://github.com/dynamous-community/remote-coding-agent"
  head "https://github.com/dynamous-community/remote-coding-agent.git", branch: "main"
  license "MIT"

  depends_on "oven-sh/bun/bun" => :build

  def install
    system "bun", "install", "--frozen-lockfile"
    system "bun", "build", "--compile", "--outfile=archon", "packages/cli/src/cli.ts"
    bin.install "archon"
  end

  test do
    assert_match "Archon CLI", shell_output("#{bin}/archon version")
  end
end
```

This builds from source, which works but is slower. Recommend using the first approach with pre-built binaries.

### Success Criteria (5.4):

#### Automated Verification:

- [x] Formula file created at `Formula/archon.rb`
- [ ] Formula syntax is valid: `brew audit Formula/archon.rb` (deferred - requires release with binaries)
- [ ] `brew style Formula/archon.rb` passes (deferred - requires release with binaries)

#### Manual Verification:

- [ ] Install works (deferred - requires release with binaries):
  ```bash
  brew install --HEAD Formula/archon.rb
  archon version
  ```
- [ ] Or via URL (deferred - requires release with binaries):
  ```bash
  brew install https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/Formula/archon.rb
  ```

**Implementation Note**: Homebrew formula with pre-built binaries is the preferred approach. The HEAD formula (building from source) is a fallback.

---

### Phase 5.5: Windows Documentation

**Goal**: Document the Windows installation process clearly for Windows users.

**Files Modified:**

- `README.md` - Add installation section

**Changes:**

#### 5.5.1: Add Installation section to README.md

Add the following section to the README (adjust location as appropriate):

````markdown
## Installation

### macOS / Linux (Recommended)

Install with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
```
````

Or download directly from [GitHub Releases](https://github.com/dynamous-community/remote-coding-agent/releases/latest).

### macOS with Homebrew

```bash
brew install https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/Formula/archon.rb
```

### Windows

Windows binary distribution is not yet available. To use Archon on Windows:

1. **Install Bun** (required):

   ```powershell
   powershell -c "irm bun.sh/install.ps1 | iex"
   ```

2. **Clone the repository**:

   ```powershell
   git clone https://github.com/dynamous-community/remote-coding-agent.git
   cd archon
   ```

3. **Install dependencies**:

   ```powershell
   bun install
   ```

4. **Run the CLI**:
   ```powershell
   bun run cli workflow list
   bun run cli workflow run assist "Hello world"
   ```

**Tip**: Create an alias for easier usage:

```powershell
# Add to your PowerShell profile ($PROFILE)
function archon { bun run cli $args }
```

### Verify Installation

After installation, verify it works:

```bash
archon version
archon help
```

### Updating

**macOS/Linux (curl install)**:

```bash
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
```

**Homebrew**:

```bash
brew upgrade archon
```

**Windows**:

```powershell
cd archon
git pull
bun install
```

````

### Success Criteria (5.5):

#### Automated Verification:
- [x] README.md updated with CLI Installation section
- [x] All code blocks have language specified

#### Manual Verification:
- [x] Instructions are clear and follow correctly
- [ ] Links to releases and repository work (deferred - requires release)
- [ ] Windows instructions work on a Windows machine (or VM) (deferred - requires Windows)

---

### Phase 5.6: Version Command Update

**Goal**: Ensure the version command shows useful information for installed binaries.

**Files Modified:**
- `packages/cli/src/commands/version.ts`

**Changes:**

#### 5.6.1: Enhance version command

The version command should show:
- CLI version (from package.json)
- Platform and architecture
- Installation method hint (binary vs bun)
- Database backend in use

```typescript
// packages/cli/src/commands/version.ts
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getDatabaseType } from '@archon/core';

/**
 * Get version from package.json
 */
function getVersion(): string {
  try {
    // Try to read from package.json (works in development)
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    // Fallback for compiled binary
    return process.env.ARCHON_VERSION ?? '0.2.0';
  }
}

/**
 * Detect if running as compiled binary
 */
function isBinaryBuild(): boolean {
  // Bun compiled binaries don't have Bun.main set the same way
  // A simple heuristic: if process.execPath doesn't contain 'bun', it's a binary
  return !process.execPath.toLowerCase().includes('bun');
}

/**
 * Display version information
 */
export async function versionCommand(): Promise<void> {
  const version = getVersion();
  const platform = process.platform;
  const arch = process.arch;
  const dbType = getDatabaseType();
  const buildType = isBinaryBuild() ? 'binary' : 'source (bun)';

  console.log(`Archon CLI v${version}`);
  console.log(`  Platform: ${platform}-${arch}`);
  console.log(`  Build: ${buildType}`);
  console.log(`  Database: ${dbType}`);
}
````

#### 5.6.2: Add getDatabaseType to core exports

In `packages/core/src/index.ts`, ensure `getDatabaseType` is exported:

```typescript
export { getDatabaseType } from './db/connection';
```

In `packages/core/src/db/connection.ts`, add:

```typescript
/**
 * Get the current database type
 */
export function getDatabaseType(): 'postgresql' | 'sqlite' {
  return process.env.DATABASE_URL ? 'postgresql' : 'sqlite';
}
```

### Success Criteria (5.6):

#### Automated Verification:

- [x] `bun run type-check` passes
- [x] `bun run test` passes (tests updated for new version output format)

#### Manual Verification:

- [x] `bun run cli version` shows correct info:
  ```
  Archon CLI v0.2.0
    Platform: darwin-arm64
    Build: source (bun)
    Database: sqlite
  ```
- [ ] Compiled binary shows `Build: binary` (deferred - tested locally earlier)

---

### Phase 5.7: Developer Release Guide

**Goal**: Document the release process for maintainers so anyone can create a release.

**Files Created:**

- `docs/releasing.md` - Developer guide for creating releases

**Changes:**

#### 5.7.1: Create docs/releasing.md

````markdown
# Releasing Archon CLI

This guide explains how to create new releases of the Archon CLI binary.

## Overview

Archon CLI releases are automated via GitHub Actions. When you push a version tag (e.g., `v0.3.0`), the workflow:

1. Builds binaries for all supported platforms (macOS ARM64/x64, Linux ARM64/x64)
2. Generates SHA256 checksums
3. Creates a GitHub Release with all artifacts
4. Updates the release notes

## Prerequisites

- Push access to the repository
- Git configured with your credentials

## Release Process

### 1. Prepare the Release

Before releasing, ensure:

```bash
# All tests pass
bun run validate

# You're on the main branch with latest changes
git checkout main
git pull origin main
```
````

### 2. Update Version Number

Update the version in `package.json` (root):

```bash
# Edit package.json and update "version" field
# Example: "0.2.0" → "0.3.0"
```

Also update `packages/cli/package.json` if it has its own version.

### 3. Update CHANGELOG.md

Add a new section for the release:

```markdown
## [0.3.0] - 2026-01-21

### Added

- New feature X
- New feature Y

### Changed

- Improved Z

### Fixed

- Bug fix A
```

### 4. Commit Version Bump

```bash
git add package.json packages/cli/package.json CHANGELOG.md
git commit -m "chore: bump version to 0.3.0"
git push origin main
```

### 5. Create and Push Tag

```bash
# Create annotated tag
git tag -a v0.3.0 -m "Release v0.3.0"

# Push tag to trigger release workflow
git push origin v0.3.0
```

### 6. Monitor Release Workflow

1. Go to **Actions** tab in GitHub
2. Watch the "Release" workflow
3. Verify all jobs complete successfully

### 7. Verify Release

Once the workflow completes:

1. Check [GitHub Releases](../../releases) for the new release
2. Verify all 5 files are attached:
   - `archon-darwin-arm64`
   - `archon-darwin-x64`
   - `archon-linux-arm64`
   - `archon-linux-x64`
   - `checksums.txt`
3. Test installation:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
   archon version
   ```

## Manual Release (If Workflow Fails)

If the GitHub Actions workflow fails, you can build and release manually:

### Build Binaries Locally

```bash
# Build all platform binaries
bun run build:binaries

# Generate checksums
bun run build:checksums

# Verify binaries exist
ls -la dist/binaries/
```

### Create Release Manually

1. Go to **Releases** → **Draft a new release**
2. Choose the tag you created
3. Set release title: `Archon v0.3.0`
4. Upload all files from `dist/binaries/`
5. Add release notes (copy from CHANGELOG.md)
6. Publish release

## Pre-release / Beta Releases

For pre-release versions:

```bash
# Use semantic versioning pre-release format
git tag -a v0.3.0-beta.1 -m "Beta release v0.3.0-beta.1"
git push origin v0.3.0-beta.1
```

Pre-releases (tags containing `-`) are automatically marked as pre-release in GitHub.

## Hotfix Releases

For urgent fixes:

```bash
# Create hotfix branch from the release tag
git checkout -b hotfix/0.3.1 v0.3.0

# Make fixes, commit
git commit -m "fix: critical bug"

# Merge to main
git checkout main
git merge hotfix/0.3.1

# Tag and release
git tag -a v0.3.1 -m "Hotfix release v0.3.1"
git push origin main v0.3.1
```

## Rollback a Release

If a release has critical issues:

1. **Do NOT delete the release** (users may have already downloaded it)
2. Create a new patch release with the fix
3. Mark the broken release as pre-release (edit in GitHub UI)
4. Update release notes to warn about the issue

## Versioning Guidelines

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0): Breaking changes to CLI interface or behavior
- **MINOR** (0.1.0): New features, backward compatible
- **PATCH** (0.0.1): Bug fixes, backward compatible

Examples:

- Adding a new command: MINOR
- Changing command output format: MAJOR (if scripts depend on it)
- Fixing a bug: PATCH
- Adding new optional flags: MINOR

## Troubleshooting

### Workflow fails on "Build binaries"

Check if Bun can compile for all targets:

```bash
bun build --compile --target=bun-darwin-arm64 packages/cli/src/cli.ts --outfile=test
```

### Binary doesn't run on target platform

Ensure you're using the correct target. Test in Docker for Linux:

```bash
docker run --rm -v $(pwd)/dist/binaries:/bins ubuntu:22.04 /bins/archon-linux-x64 version
```

### Checksums don't match

Regenerate checksums and re-upload:

```bash
cd dist/binaries
shasum -a 256 archon-* > checksums.txt
```

````

### Success Criteria (5.7):

#### Automated Verification:
- [x] `docs/releasing.md` exists and is valid markdown
- [x] All commands in the guide are correct (test locally)

#### Manual Verification:
- [x] Guide is clear and complete enough for a new maintainer to follow
- [ ] All links work (GitHub releases, repository URLs) (deferred - requires release)

---

## Testing Strategy

### Unit Tests

- Update version command tests if output format changed
- No other new unit tests needed (distribution doesn't change behavior)

### Integration Tests

Test the full installation flow:

```bash
# 1. Build binaries locally
bun run build:binaries

# 2. Test each binary on appropriate platform
./dist/binaries/archon-darwin-arm64 version
./dist/binaries/archon-darwin-arm64 help
./dist/binaries/archon-darwin-arm64 workflow list

# 3. Test without DATABASE_URL (should use SQLite)
unset DATABASE_URL
./dist/binaries/archon-darwin-arm64 workflow list

# 4. Test curl script (after first release)
curl -fsSL https://raw.githubusercontent.com/dynamous-community/remote-coding-agent/main/scripts/install.sh | bash
archon version
````

### Manual Testing Steps

1. **Local binary test** (before release):
   - Build all binaries: `bun run build:binaries`
   - Test on current machine
   - Test in Docker container (for Linux)

2. **Release test**:
   - Create pre-release tag: `git tag v0.2.1-test && git push --tags`
   - Verify GitHub Actions workflow runs
   - Download binary from release
   - Test on fresh machine (VM or Docker)

3. **Install script test**:
   - Run curl script on macOS
   - Run curl script in Ubuntu Docker container
   - Run curl script in Alpine Docker container
   - Verify correct binary downloaded for each platform

4. **Homebrew test**:
   - Install formula on macOS
   - Verify binary works after install

---

## Risk Mitigation

| Risk                               | Likelihood | Impact | Mitigation                                               |
| ---------------------------------- | ---------- | ------ | -------------------------------------------------------- |
| Bun compile fails for some target  | Low        | High   | Test build for all targets locally before workflow       |
| Binary too large (>100MB)          | Medium     | Low    | Accept size; Bun runtime is included. Can optimize later |
| curl script fails on some shells   | Low        | Medium | Use POSIX-compatible bash; test on zsh, bash, sh         |
| Homebrew formula rejected by audit | Medium     | Low    | Use HEAD build as fallback; proper tap in Phase 6        |
| Install script permission issues   | Low        | Medium | Detect and prompt for sudo when needed                   |
| Old releases linger                | Low        | Low    | Document upgrade process clearly                         |

---

## Performance Considerations

**Binary size**: Expect 50-100MB per binary. This includes:

- JavaScriptCore runtime (Bun's JS engine)
- All bundled dependencies
- Source code

This is standard for Bun-compiled binaries and acceptable for the benefit of zero-dependency installation.

**Startup time**: Compiled binaries start faster than `bun run cli` since there's no dependency resolution at runtime.

---

## Migration Notes

**For existing users running from source**:

- No migration needed - `bun run cli` continues to work
- Can optionally switch to binary for convenience

**For new users**:

- Use curl script or Homebrew for easiest installation
- Binary uses SQLite by default (no database setup required)

---

## Future Work (Phase 6+)

1. **Homebrew tap**: Create `homebrew-archon` repository for cleaner install experience (`brew install archon/archon/archon`)
2. **Windows binary**: Investigate Windows binary distribution (PowerShell install script, Scoop/Chocolatey)
3. **npm package**: Publish to npm for Node.js ecosystem users
4. **Custom domain**: Set up `get.archon.dev` for shorter curl URL
5. **Auto-update**: Add `archon update` command to self-update binary

---

## References

- Research document: `thoughts/shared/research/2026-01-20-cli-first-refactor-feasibility.md`
- Phase 3 plan (SQLite): `thoughts/shared/plans/2026-01-20-phase-3-database-abstraction-cli-isolation.md`
- Phase 4 plan (Hono): `thoughts/shared/plans/2026-01-21-phase-4-express-to-hono-migration.md`
- Bun compile documentation: https://bun.sh/docs/bundler/executables
- GitHub Actions release: https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#release
- Homebrew formula cookbook: https://docs.brew.sh/Formula-Cookbook

---

## Estimated Effort

| Phase   | Task                       | Estimate   |
| ------- | -------------------------- | ---------- |
| 5.0     | Bundle defaults for binary | 2-3 hours  |
| 5.1     | Build scripts              | 1-2 hours  |
| 5.2     | GitHub Actions workflow    | 2-3 hours  |
| 5.3     | Curl install script        | 1-2 hours  |
| 5.4     | Homebrew formula           | 1 hour     |
| 5.5     | Windows documentation      | 30 minutes |
| 5.6     | Version command update     | 30 minutes |
| 5.7     | Developer release guide    | 30 minutes |
| Testing | End-to-end verification    | 2-3 hours  |

**Total: 1.5-2.5 days**

**Note**: Phase 5.0 depends on Issue #322 being completed first. The issue establishes runtime loading architecture; Phase 5.0 adds the bundled defaults for binary distribution.
