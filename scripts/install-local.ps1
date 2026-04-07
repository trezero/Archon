# scripts/install-local.ps1
# LOCAL TEST harness for install.ps1 — installs from a file on disk instead of
# downloading from GitHub Releases. Used to validate the install flow against
# a binary built from the current branch before cutting a release.
#
# Usage (from repo root):
#   # 1. Build a Windows binary first:
#   bun build --compile --outfile dist\archon-windows-x64.exe packages\cli\src\cli.ts
#
#   # 2. Run this script:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-local.ps1
#
# Options (env vars):
#   $env:LOCAL_BINARY  - Path to local binary (default: .\dist\archon-windows-x64.exe)
#   $env:INSTALL_DIR   - Install dir (default: $env:USERPROFILE\.archon-test\bin)
#   $env:SKIP_PATH     - Set to "true" to NOT modify user PATH

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$REPO_ROOT    = Split-Path -Parent $PSScriptRoot
$LOCAL_BINARY = if ($env:LOCAL_BINARY) { $env:LOCAL_BINARY } else { Join-Path $REPO_ROOT 'dist\archon-windows-x64.exe' }
$INSTALL_DIR  = if ($env:INSTALL_DIR)  { $env:INSTALL_DIR }  else { "$env:USERPROFILE\.archon-test\bin" }
$SKIP_PATH    = ($env:SKIP_PATH -eq 'true')
$BINARY_NAME  = 'archon'

function Write-Info { param([string]$Msg) Write-Host "[INFO]  $Msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$Msg) Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
function Write-Err  { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }
function Write-Ok   { param([string]$Msg) Write-Host "[OK]    $Msg" -ForegroundColor Green }

Write-Host ""
Write-Host "  +---------------------------------------+" -ForegroundColor Cyan
Write-Host "  |   Archon CLI Installer (LOCAL TEST)   |" -ForegroundColor Cyan
Write-Host "  +---------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# --- Locate local binary ---
if (-not (Test-Path $LOCAL_BINARY)) {
    Write-Err "Local binary not found: $LOCAL_BINARY"
    Write-Err "Build it first with:"
    Write-Err "  bun build --compile --outfile dist\archon-windows-x64.exe packages\cli\src\cli.ts"
    exit 1
}
$size = (Get-Item $LOCAL_BINARY).Length
Write-Ok "Found local binary: $LOCAL_BINARY ($size bytes)"

# --- Compute checksum (informational only — no verification against a remote file) ---
$hash = (Get-FileHash -Path $LOCAL_BINARY -Algorithm SHA256).Hash.ToLower()
Write-Info "SHA256: $hash"

# --- Create install directory ---
if (-not (Test-Path $INSTALL_DIR)) {
    Write-Info "Creating install directory: $INSTALL_DIR"
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
}

# --- Copy binary ---
$destBinary = Join-Path $INSTALL_DIR "$BINARY_NAME.exe"
Write-Info "Installing to $destBinary..."
Copy-Item -Path $LOCAL_BINARY -Destination $destBinary -Force
Write-Ok "Installed to $destBinary"

# --- Add to PATH (optional) ---
if (-not $SKIP_PATH) {
    $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathParts = $currentPath -split ';' | Where-Object { $_ -ne '' }
    if ($INSTALL_DIR -notin $pathParts) {
        $pathParts += $INSTALL_DIR
        [Environment]::SetEnvironmentVariable('Path', ($pathParts -join ';'), 'User')
        Write-Ok "Added $INSTALL_DIR to user PATH (open a NEW terminal for it to take effect)"
    } else {
        Write-Info "$INSTALL_DIR already in user PATH"
    }
} else {
    Write-Info "Skipping PATH modification (SKIP_PATH=true)"
}

# --- Verify ---
Write-Host ""
Write-Info "Verifying installation (running '$destBinary version')..."
try {
    $output = & $destBinary version 2>&1
    Write-Host $output
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Binary exited with code $LASTEXITCODE"
        exit 1
    }
    Write-Ok "Installation complete!"
} catch {
    Write-Err "Binary failed to run: $($_.Exception.Message)"
    exit 1
}

Write-Host ""
Write-Host "  Cleanup when done testing:" -ForegroundColor Yellow
Write-Host "    `$p = [Environment]::GetEnvironmentVariable('Path','User') -split ';' | Where-Object { `$_ -ne '$INSTALL_DIR' }"
Write-Host "    [Environment]::SetEnvironmentVariable('Path', (`$p -join ';'), 'User')"
Write-Host "    Remove-Item -Recurse -Force '$INSTALL_DIR'"
Write-Host ""
