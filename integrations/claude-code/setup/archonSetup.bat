@echo off
setlocal EnableDelayedExpansion

set "ARCHON_SERVER={{ARCHON_SERVER_URL}}"

echo.
echo  =============================================
echo    Archon Setup
echo    Server: %ARCHON_SERVER%
echo  =============================================
echo.

:: Check dependencies
where curl >nul 2>&1 || (echo Error: curl is required. Install from https://curl.se & exit /b 1)
where claude >nul 2>&1 || (echo Error: claude CLI not found. Install Claude Code first. & exit /b 1)
where powershell >nul 2>&1 || (echo Error: PowerShell is required. & exit /b 1)

:: ── Step 1/4: System name ──────────────────────────────────────────────────
echo [1/4] System name
set /p "SYSTEM_NAME=      Name for this machine [%COMPUTERNAME%]: "
if "%SYSTEM_NAME%"=="" set "SYSTEM_NAME=%COMPUTERNAME%"
echo.

:: ── Step 2/4: Project ─────────────────────────────────────────────────────
echo [2/4] Project

for %%F in (.) do set "DIR_NAME=%%~nxF"
set "PROJECT_ID="
set "PROJECT_TITLE="

:: Try auto-match on current directory name
set "ENCODED_DIR="
for /f "delims=" %%E in ('powershell -Command "[uri]::EscapeDataString('!DIR_NAME!')"') do set "ENCODED_DIR=%%E"
set "MATCH_FILE=%TEMP%\archon_match.json"
curl -sf "%ARCHON_SERVER%/api/projects?include_content=false&q=!ENCODED_DIR!" -o "%MATCH_FILE%" 2>nul

set "MATCH_COUNT=0"
for /f "delims=" %%C in ('powershell -Command "$d = Get-Content '%MATCH_FILE%' | ConvertFrom-Json; $d.projects.Count" 2^>nul') do set "MATCH_COUNT=%%C"

if "!MATCH_COUNT!"=="1" (
  set "MATCHED_TITLE="
  set "MATCHED_ID="
  for /f "delims=" %%T in ('powershell -Command "$d = Get-Content '%MATCH_FILE%' | ConvertFrom-Json; $d.projects[0].title" 2^>nul') do set "MATCHED_TITLE=%%T"
  for /f "delims=" %%I in ('powershell -Command "$d = Get-Content '%MATCH_FILE%' | ConvertFrom-Json; $d.projects[0].id" 2^>nul') do set "MATCHED_ID=%%I"
  echo       Matched in Archon: !MATCHED_TITLE!
  set /p "CONFIRM=      Press Enter to accept or type to search: "
  if "!CONFIRM!"=="" (
    set "PROJECT_ID=!MATCHED_ID!"
    set "PROJECT_TITLE=!MATCHED_TITLE!"
    goto :project_done
  ) else (
    set "SEARCH_TERM=!CONFIRM!"
    goto :search_loop_body
  )
)

:search_loop
set /p "SEARCH_TERM=      Search projects (or Enter to list all): "

:search_loop_body
set "ENCODED_TERM="
for /f "delims=" %%E in ('powershell -Command "[uri]::EscapeDataString('%SEARCH_TERM%')"') do set "ENCODED_TERM=%%E"

set "RESULTS_FILE=%TEMP%\archon_projects.json"
curl -sf "%ARCHON_SERVER%/api/projects?include_content=false&q=!ENCODED_TERM!" -o "%RESULTS_FILE%" 2>nul

powershell -Command ^
  "$data = Get-Content '%RESULTS_FILE%' | ConvertFrom-Json; " ^
  "$projects = $data.projects | Select-Object -First 10; " ^
  "$i = 1; foreach ($p in $projects) { Write-Host ('        ' + $i + '. ' + $p.title); $i++ }"

echo         C. Create new project in Archon
echo.
set /p "SELECTION=      Enter number, new search, or C to create: "

if /i "%SELECTION%"=="C" goto :create_project

:: Check if numeric
echo %SELECTION%| findstr /r "^[0-9][0-9]*$" >nul
if %errorlevel%==0 (
  for /f "delims=" %%R in ('powershell -Command ^
    "$data = Get-Content '%RESULTS_FILE%' | ConvertFrom-Json; " ^
    "$projects = $data.projects; " ^
    "$idx = %SELECTION% - 1; " ^
    "if ($idx -lt $projects.Count) { $projects[$idx].id + '|' + $projects[$idx].title }"') do (
    for /f "tokens=1,2 delims=|" %%A in ("%%R") do (
      set "PROJECT_ID=%%A"
      set "PROJECT_TITLE=%%B"
    )
  )
  if defined PROJECT_ID goto :project_done
  echo       Invalid selection.
)

set "SEARCH_TERM=%SELECTION%"
goto :search_loop

:create_project
set /p "NEW_NAME=      New project name [%DIR_NAME%]: "
if "%NEW_NAME%"=="" set "NEW_NAME=%DIR_NAME%"
set /p "NEW_DESC=      Description (optional): "
echo       Creating project...
set "CREATE_FILE=%TEMP%\archon_create.json"
powershell -Command ^
  "$body = @{ title = '%NEW_NAME%'; description = '%NEW_DESC%' } | ConvertTo-Json; " ^
  "Invoke-RestMethod -Uri '%ARCHON_SERVER%/api/projects' -Method POST -Body $body -ContentType 'application/json' | ConvertTo-Json" ^
  > "%CREATE_FILE%" 2>nul
for /f "delims=" %%I in ('powershell -Command ^
  "$d = Get-Content '%CREATE_FILE%' | ConvertFrom-Json; $d.id"') do set "PROJECT_ID=%%I"
set "PROJECT_TITLE=%NEW_NAME%"
echo       Created "%NEW_NAME%"

:project_done
echo.

:: ── Step 3/4: Add MCP ─────────────────────────────────────────────────────
echo [3/4] Setting up Claude Code MCP...
claude mcp add --transport http archon "%ARCHON_SERVER%/mcp" 2>nul || echo       (Already configured)
echo       Added archon MCP server
echo.

:: ── Step 4/4: Install /archon-setup ───────────────────────────────────────
echo [4/4] Installing /archon-setup command...
if not exist "%USERPROFILE%\.claude\commands" mkdir "%USERPROFILE%\.claude\commands"
curl -sf "%ARCHON_SERVER%/archon-setup.md" -o "%USERPROFILE%\.claude\commands\archon-setup.md"
echo       Installed to %USERPROFILE%\.claude\commands\archon-setup.md
echo.

:: ── Write initial state ───────────────────────────────────────────────────
if not exist ".claude" mkdir ".claude"
powershell -Command ^
  "$state = if (Test-Path '.claude\archon-state.json') { Get-Content '.claude\archon-state.json' | ConvertFrom-Json } else { @{} }; " ^
  "$state | Add-Member -Force NotePropertyName 'system_name' -NotePropertyValue '%SYSTEM_NAME%'; " ^
  "if ('%PROJECT_ID%') { $state | Add-Member -Force NotePropertyName 'archon_project_id' -NotePropertyValue '%PROJECT_ID%' }; " ^
  "$state | ConvertTo-Json | Set-Content '.claude\archon-state.json'"

:: ── Done ─────────────────────────────────────────────────────────────────
echo =============================================
echo  Setup complete!
echo.
echo  Open Claude Code and run:
echo.
echo    /archon-setup
echo.
echo  This will register your system and install all project skills.
echo =============================================
echo.
