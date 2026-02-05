# Feature: Archon Credentials Setup CLI

The following plan should be complete, but it's important that you validate documentation and codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types, and models. Import from the right files etc.

## Feature Description

Create an interactive CLI command (`archon setup`) that guides users through configuring their Archon credentials securely. This script runs deterministically (no AI) so users can enter API keys and tokens directly without exposing them to the AI assistant. The script collects all necessary configuration, writes to both `~/.archon/.env` (for CLI) and `<archon-repo>/.env` (for server), and provides clear instructions for obtaining each credential.

## User Story

As a developer setting up Archon for the first time
I want an interactive setup wizard that guides me through credential configuration
So that I can securely configure my API keys without sharing them with the AI assistant

## Problem Statement

Currently, the AI agent guides Archon setup but expects users to manually edit `.env` files with their API keys. This creates friction because users must either trust the agent with their secrets (not ideal) or manually edit files outside the conversation (breaks flow). There's no streamlined, secure way to configure credentials during the guided setup process.

## Solution Statement

Create a dedicated `archon setup` command using the `@clack/prompts` library that:
1. Detects existing configuration and offers to update or start fresh
2. Guides users through database selection (SQLite default vs PostgreSQL)
3. Allows selection of AI assistants (Claude and/or Codex) with appropriate auth flows
4. Enables multi-select of platforms (GitHub, Telegram, Slack, Discord)
5. For each selected platform, shows clear step-by-step instructions and collects credentials
6. Writes configuration to both `~/.archon/.env` and `<archon-repo>/.env`
7. Shows a summary and mentions additional customizable options

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium
**Primary Systems Affected**: CLI package, setup skill
**Dependencies**: `@clack/prompts` (new dependency)

---

## CONTEXT REFERENCES

### Relevant Codebase Files - IMPORTANT: YOU MUST READ THESE FILES BEFORE IMPLEMENTING!

- `packages/cli/src/cli.ts` (full file) - Why: Main CLI entry point, shows command routing pattern and how to add new commands
- `packages/cli/src/commands/version.ts` (full file) - Why: Simple command implementation pattern to mirror
- `packages/cli/src/commands/isolation.ts` (full file) - Why: More complex command with user output formatting
- `packages/cli/package.json` (full file) - Why: Need to add @clack/prompts dependency here
- `packages/server/src/scripts/setup-auth.ts` (full file) - Why: Existing script showing file writing patterns for config
- `packages/core/src/utils/archon-paths.ts` (lines 1-50) - Why: Path utilities for ~/.archon/ directory
- `.env.example` (full file) - Why: Complete list of all environment variables and their documentation

### New Files to Create

- `packages/cli/src/commands/setup.ts` - Main setup command implementation with --spawn support
- `packages/cli/src/commands/setup.test.ts` - Unit tests for setup command
- `packages/cli/src/commands/test-clack.ts` - Temporary test file to verify @clack/prompts works (delete after verification)

### Files to Modify

- `packages/cli/src/cli.ts` - Add setup command routing
- `packages/cli/package.json` - Add @clack/prompts dependency
- `.claude/skills/archon/guides/setup.md` - Update to invoke `archon setup` for credentials

### Relevant Documentation - YOU SHOULD READ THESE BEFORE IMPLEMENTING!

- [@clack/prompts npm package](https://www.npmjs.com/package/@clack/prompts)
  - Why: Primary UI library for the setup wizard
- [Clack API documentation](https://bomb.sh/docs/clack/packages/prompts/)
  - Why: Complete API reference for all prompt functions
- [BotFather Telegram documentation](https://core.telegram.org/bots#botfather)
  - Why: Instructions for creating Telegram bots
- [Discord Developer Portal](https://discord.com/developers/applications)
  - Why: Instructions for creating Discord bots
- [Slack API - Socket Mode](https://api.slack.com/apis/connections/socket)
  - Why: Instructions for Slack app setup
- [GitHub Fine-grained tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
  - Why: Instructions for creating GitHub tokens

### Patterns to Follow

**Command Implementation Pattern** (from version.ts):
```typescript
/**
 * JSDoc comment describing the command
 */
export async function setupCommand(): Promise<void> {
  // Implementation
}
```

**File Writing Pattern** (from setup-auth.ts):
```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create directory if needed
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// Write file
fs.writeFileSync(filePath, content);
```

**Error Handling Pattern**:
```typescript
try {
  // operation
} catch (error) {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') {
    // handle missing file
  }
  throw new Error(`Operation failed: ${err.message}`);
}
```

**Console Output Pattern** (from isolation.ts):
```typescript
console.log(`\nSection Header:`);
console.log(`  ${itemName}`);
console.log(`    Detail: ${value}`);
```

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation

Set up the new command file structure and add the required dependency.

**Tasks:**
- Add `@clack/prompts` to CLI package dependencies
- Create setup.ts command file with basic structure
- Add command routing in cli.ts

### Phase 2: Core Implementation

Implement the interactive setup flow with all credential collection logic.

**Tasks:**
- Implement existing config detection and handling
- Implement database selection (SQLite/PostgreSQL)
- Implement AI assistant selection and auth collection
- Implement platform multi-select
- Implement platform-specific credential collection with instructions

### Phase 3: File Output

Implement the .env file generation and writing to both locations.

**Tasks:**
- Build .env content from collected values
- Write to ~/.archon/.env
- Write to <archon-repo>/.env
- Show summary and additional options

### Phase 4: Testing & Skill Update

Add tests and update the setup skill to use the new command.

**Tasks:**
- Create unit tests for setup command
- Update setup.md skill guide to invoke `archon setup`

---

## STEP-BY-STEP TASKS

IMPORTANT: Execute every task in order, top to bottom. Each task is atomic and independently testable.

### Task 1: ADD @clack/prompts dependency

**File**: `packages/cli/package.json`

- **IMPLEMENT**: Add `@clack/prompts` to dependencies
- **PATTERN**: Follow existing dependency format in package.json
- **VERSION**: Use `^1.0.0` (latest stable as of February 2025)
- **VALIDATE**: `cd packages/cli && bun install && bun x tsc --noEmit`

```json
"dependencies": {
  "@archon/core": "workspace:*",
  "@clack/prompts": "^1.0.0",
  "dotenv": "^17.2.3"
}
```

### Task 1b: CREATE non-interactive @clack/prompts test

**File**: `packages/cli/src/commands/test-clack.ts` (temporary, delete after verification)

- **IMPLEMENT**: Simple non-interactive test to verify @clack/prompts works with Bun on Windows
- **PATTERN**: Import and call non-interactive functions only
- **VALIDATE**: `cd packages/cli && bun src/commands/test-clack.ts`

```typescript
/**
 * Non-interactive test to verify @clack/prompts works with Bun
 * Delete this file after verification
 */
import { intro, outro, note, log } from '@clack/prompts';

console.log('Testing @clack/prompts with Bun...\n');

intro('Clack Test');

log.info('log.info() works');
log.success('log.success() works');
log.warning('log.warning() works');
log.error('log.error() works');

note('This is a note box\nWith multiple lines', 'Note Title');

outro('Test complete!');

console.log('\n✓ All @clack/prompts functions work correctly');
```

After running successfully, delete `test-clack.ts`.

### Task 2: CREATE setup.ts command file structure

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Create the command file with imports, types, and exported function
- **PATTERN**: Mirror structure from `version.ts` and `isolation.ts`
- **IMPORTS**:
  - `@clack/prompts` for UI (intro, outro, text, password, select, multiselect, confirm, note, spinner, isCancel, cancel)
  - `fs` and `fs/promises` for file operations
  - `path` and `os` for cross-platform paths
  - `crypto` for webhook secret generation
- **TYPES**: Define interfaces for collected config data
- **VALIDATE**: `bun run type-check`

Key interfaces to define:
```typescript
interface SetupConfig {
  database: {
    type: 'sqlite' | 'postgresql';
    url?: string;
  };
  ai: {
    claude: boolean;
    claudeAuthType?: 'global' | 'apiKey' | 'oauthToken';
    claudeApiKey?: string;
    claudeOauthToken?: string;
    codex: boolean;
    codexTokens?: CodexTokens;
    defaultAssistant: 'claude' | 'codex';
  };
  platforms: {
    github: boolean;
    telegram: boolean;
    slack: boolean;
    discord: boolean;
  };
  github?: GitHubConfig;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  discord?: DiscordConfig;
  botDisplayName: string;
}

interface GitHubConfig {
  token: string;
  webhookSecret: string;
  allowedUsers: string;
  botMention?: string;
}

interface TelegramConfig {
  botToken: string;
  allowedUserIds: string;
}

interface SlackConfig {
  botToken: string;
  appToken: string;
  allowedUserIds: string;
}

interface DiscordConfig {
  botToken: string;
  allowedUserIds: string;
}

interface CodexTokens {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
}
```

### Task 3: IMPLEMENT existing config detection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to check if `~/.archon/.env` exists and parse existing values
- **PATTERN**: Use `fs.existsSync()` and read file if present
- **LOGIC**:
  - If file doesn't exist → return null (fresh setup)
  - If file exists → parse and return object showing which values are set
- **GOTCHA**: Don't expose actual values, just whether they're set (for display)
- **VALIDATE**: Manual test with existing and missing .env files

```typescript
interface ExistingConfig {
  hasDatabase: boolean;
  hasClaude: boolean;
  hasCodex: boolean;
  platforms: {
    github: boolean;
    telegram: boolean;
    slack: boolean;
    discord: boolean;
  };
}

function checkExistingConfig(): ExistingConfig | null {
  const envPath = path.join(os.homedir(), '.archon', '.env');
  if (!fs.existsSync(envPath)) return null;

  const content = fs.readFileSync(envPath, 'utf-8');
  // Parse and detect which values are set (non-empty)
  // Return ExistingConfig object
}
```

### Task 4: IMPLEMENT main setup flow entry point

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Main `setupCommand()` function with intro, existing config check, and flow routing
- **PATTERN**: Use `@clack/prompts` intro(), outro(), select()
- **LOGIC**:
  1. Show intro
  2. Check for existing config
  3. If exists → show summary and ask: "Add platforms" / "Update config" / "Start fresh"
  4. If not exists → proceed with fresh setup
- **VALIDATE**: `bun run cli setup` (should show intro)

### Task 5: IMPLEMENT database selection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect database preference
- **PATTERN**: Use `select()` for choice, `text()` for PostgreSQL URL
- **LOGIC**:
  - Option 1: "SQLite (default - no setup needed)" → return { type: 'sqlite' }
  - Option 2: "PostgreSQL" → prompt for DATABASE_URL → return { type: 'postgresql', url }
- **VALIDATE**: Manual test both paths

```typescript
async function collectDatabaseConfig(): Promise<SetupConfig['database']> {
  const dbType = await select({
    message: 'Which database do you want to use?',
    options: [
      { value: 'sqlite', label: 'SQLite (default - no setup needed)', hint: 'Recommended for single user' },
      { value: 'postgresql', label: 'PostgreSQL', hint: 'For server deployments' },
    ],
  });

  if (isCancel(dbType)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  if (dbType === 'postgresql') {
    const url = await text({
      message: 'Enter your PostgreSQL connection string:',
      placeholder: 'postgresql://user:pass@localhost:5432/archon',
      validate: (value) => {
        if (!value.startsWith('postgresql://') && !value.startsWith('postgres://')) {
          return 'Must be a valid PostgreSQL URL';
        }
      },
    });

    if (isCancel(url)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    return { type: 'postgresql', url };
  }

  return { type: 'sqlite' };
}
```

### Task 6: IMPLEMENT AI assistant selection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect AI assistant preferences
- **PATTERN**: Use `multiselect()` for assistant choice, then conditional auth collection
- **LOGIC**:
  1. Multi-select: Claude, Codex (neither required)
  2. If both selected → ask which is default
  3. For Claude: ask global auth vs API key
  4. For Codex: try to read ~/.codex/auth.json, if missing prompt for tokens
- **GOTCHA**: Handle case where neither is selected (warn but allow)
- **VALIDATE**: Test all combinations

```typescript
async function collectAIConfig(): Promise<SetupConfig['ai']> {
  const assistants = await multiselect({
    message: 'Which AI assistant(s) will you use?',
    options: [
      { value: 'claude', label: 'Claude', hint: 'Anthropic Claude Code SDK' },
      { value: 'codex', label: 'Codex', hint: 'OpenAI Codex SDK' },
    ],
    required: false,
  });

  // ... handle selection and collect auth for each
}
```

### Task 7: IMPLEMENT Claude auth collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect Claude authentication method
- **PATTERN**: Use `select()` for auth type, `password()` for keys
- **LOGIC**:
  - Option 1: "Use global auth from `claude /login`" (recommended) → set CLAUDE_USE_GLOBAL_AUTH=true
  - Option 2: "Provide API key" → prompt for CLAUDE_API_KEY
  - Option 3: "Provide OAuth token" → prompt for CLAUDE_CODE_OAUTH_TOKEN
- **VALIDATE**: Test each auth path

### Task 8: IMPLEMENT Codex auth collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect Codex authentication
- **PATTERN**: Try to auto-import from ~/.codex/auth.json first
- **LOGIC**:
  1. Check if ~/.codex/auth.json exists
  2. If exists → read and extract tokens, confirm with user
  3. If not exists → show instructions to run `codex login` first, or allow manual entry
- **VALIDATE**: Test with existing and missing auth.json

### Task 9: IMPLEMENT platform selection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect platform preferences
- **PATTERN**: Use `multiselect()` with hints
- **LOGIC**: Multi-select from: GitHub, Telegram, Slack, Discord
- **VALIDATE**: Test selection

```typescript
async function collectPlatforms(): Promise<SetupConfig['platforms']> {
  const platforms = await multiselect({
    message: 'Which platforms do you want to connect?',
    options: [
      { value: 'github', label: 'GitHub', hint: 'Respond to issues/PRs via webhooks' },
      { value: 'telegram', label: 'Telegram', hint: 'Chat bot via BotFather' },
      { value: 'slack', label: 'Slack', hint: 'Workspace app with Socket Mode' },
      { value: 'discord', label: 'Discord', hint: 'Server bot' },
    ],
    required: false,
  });

  if (isCancel(platforms)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  return {
    github: platforms.includes('github'),
    telegram: platforms.includes('telegram'),
    slack: platforms.includes('slack'),
    discord: platforms.includes('discord'),
  };
}
```

### Task 10: IMPLEMENT GitHub credential collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect GitHub credentials with instructions
- **PATTERN**: Use `note()` for instructions, `password()` for token, `text()` for username
- **INSTRUCTIONS** (display in note):
  ```
  1. Go to github.com/settings/tokens
  2. Click "Generate new token" → "Fine-grained token"
  3. Set expiration and select your target repository
  4. Under Permissions, enable:
     • Issues: Read and write
     • Pull requests: Read and write
     • Contents: Read
  5. Generate and copy the token
  ```
- **COLLECT**:
  - GITHUB_TOKEN (password input)
  - GITHUB_ALLOWED_USERS (text, comma-separated usernames)
  - GITHUB_BOT_MENTION (optional, text with default)
- **AUTO-GENERATE**: WEBHOOK_SECRET using `crypto.randomBytes(32).toString('hex')`
- **VALIDATE**: Test collection and secret generation

### Task 11: IMPLEMENT Telegram credential collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect Telegram credentials with instructions
- **INSTRUCTIONS** (display in note):
  ```
  Step 1: Create your bot
  1. Open Telegram and search for @BotFather
  2. Send /newbot
  3. Choose a display name (e.g., "My Archon Bot")
  4. Choose a username (must end in 'bot')
  5. Copy the token BotFather gives you

  Step 2: Get your user ID
  1. Search for @userinfobot on Telegram
  2. Send any message
  3. It will reply with your user ID (a number)
  ```
- **COLLECT**:
  - TELEGRAM_BOT_TOKEN (password input)
  - TELEGRAM_ALLOWED_USER_IDS (text, comma-separated)
- **VALIDATE**: Test collection

### Task 12: IMPLEMENT Slack credential collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect Slack credentials with instructions
- **INSTRUCTIONS** (display in note):
  ```
  Slack setup requires creating an app at api.slack.com/apps

  1. Create a new app "From scratch"
  2. Enable Socket Mode:
     • Settings → Socket Mode → Enable
     • Generate an App-Level Token (xapp-...)
  3. Add Bot Token Scopes (OAuth & Permissions):
     • app_mentions:read, chat:write, channels:history
     • channels:join, im:history, im:write, im:read
  4. Subscribe to Bot Events (Event Subscriptions):
     • app_mention, message.im
  5. Install to Workspace
     • Copy the Bot User OAuth Token (xoxb-...)
  6. Invite bot to your channel: /invite @YourBotName

  Get your user ID: Click profile → ... → Copy member ID
  ```
- **COLLECT**:
  - SLACK_BOT_TOKEN (password, xoxb-...)
  - SLACK_APP_TOKEN (password, xapp-...)
  - SLACK_ALLOWED_USER_IDS (text, comma-separated)
- **VALIDATE**: Test collection

### Task 13: IMPLEMENT Discord credential collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to collect Discord credentials with instructions
- **INSTRUCTIONS** (display in note):
  ```
  1. Go to discord.com/developers/applications
  2. Click "New Application" and name it
  3. Go to "Bot" in sidebar:
     • Click "Reset Token" and copy it
     • Enable "MESSAGE CONTENT INTENT"
  4. Go to "OAuth2" → "URL Generator":
     • Select scope: bot
     • Select permissions: Send Messages, Read Message History
     • Open generated URL to add bot to your server

  Get your user ID:
  • Discord Settings → Advanced → Enable Developer Mode
  • Right-click yourself → Copy User ID
  ```
- **COLLECT**:
  - DISCORD_BOT_TOKEN (password input)
  - DISCORD_ALLOWED_USER_IDS (text, comma-separated)
- **VALIDATE**: Test collection

### Task 14: IMPLEMENT bot display name collection

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Optional prompt for bot display name
- **PATTERN**: Use `text()` with default value
- **LOGIC**: Allow empty (uses default "Archon")
- **VALIDATE**: Test with custom and default values

### Task 15: IMPLEMENT .env content generation

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to generate .env file content from collected config
- **PATTERN**: Build string with comments matching .env.example structure
- **SECTIONS**:
  1. Database (only if PostgreSQL)
  2. AI Assistants (Claude and/or Codex settings)
  3. Default AI Assistant
  4. GitHub section (if enabled)
  5. Telegram section (if enabled)
  6. Slack section (if enabled)
  7. Discord section (if enabled)
  8. Bot display name
  9. Streaming modes (use defaults)
- **GOTCHA**: Preserve structure and comments from .env.example
- **VALIDATE**: Generate content and verify format

### Task 16: IMPLEMENT file writing to both locations

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Function to write .env to both locations
- **LOCATIONS**:
  1. `~/.archon/.env` (create ~/.archon/ if needed)
  2. `<cwd>/.env` (current directory, assumed to be archon repo)
- **PATTERN**: Follow setup-auth.ts pattern
- **LOGIC**:
  1. Create directories if needed
  2. Write to global location
  3. Write to repo location
  4. Show success messages
- **GOTCHA**: Handle permission errors gracefully
- **VALIDATE**: Test writing to both locations

### Task 17: IMPLEMENT summary and outro

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Final summary showing what was configured
- **PATTERN**: Use `note()` for summary box, `outro()` for closing
- **DISPLAY**:
  ```
  Configuration saved!

  Database: SQLite (default)
  AI: Claude (global auth)
  Platforms:
    ✓ Telegram
    ✓ GitHub (webhook secret generated)

  Files written:
    ~/.archon/.env
    <repo>/.env
  ```
- **ADDITIONAL INFO**: Note about other customizable options
  ```
  Other settings you can customize in ~/.archon/.env:
  • PORT (default: 3000)
  • MAX_CONCURRENT_CONVERSATIONS (default: 10)
  • *_STREAMING_MODE (stream | batch per platform)

  These defaults work well for most users.
  ```
- **VALIDATE**: Test full flow end-to-end

### Task 18: IMPLEMENT spawnTerminal() utility function

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Cross-platform function to spawn a new terminal window in a specific directory and run `archon setup`
- **PATTERN**: Use `child_process.spawn()` with platform-specific commands
- **PLATFORMS**:

**Windows (try Windows Terminal first, fallback to cmd):**
```typescript
// Primary: Windows Terminal
spawn('wt.exe', ['-d', repoPath, 'cmd', '/k', 'archon setup'], { detached: true, stdio: 'ignore' });

// Fallback: cmd.exe via start
spawn('cmd.exe', ['/c', 'start', '""', '/D', repoPath, 'cmd', '/k', 'archon setup'], {
  detached: true,
  stdio: 'ignore',
  shell: true
});
```

**macOS (Terminal.app via osascript):**
```typescript
const script = `tell application "Terminal" to do script "cd '${repoPath}' && archon setup"`;
spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
```

**Linux (x-terminal-emulator with fallback to gnome-terminal):**
```typescript
// Primary: distro default terminal
spawn('x-terminal-emulator', [
  '--working-directory=' + repoPath,
  '-e', 'bash -c "archon setup; exec bash"'
], { detached: true, stdio: 'ignore' });

// Fallback: gnome-terminal
spawn('gnome-terminal', [
  '--working-directory=' + repoPath,
  '--', 'bash', '-c', 'archon setup; exec bash'
], { detached: true, stdio: 'ignore' });
```

- **LOGIC**:
  1. Detect platform via `process.platform`
  2. Try primary command, catch error and try fallback
  3. Return success/failure status
  4. Use `detached: true` and `unref()` so parent process can exit
- **GOTCHA**: Windows paths need proper quoting, macOS script needs escaped quotes
- **VALIDATE**: Test on available platform

```typescript
import { spawn } from 'child_process';

interface SpawnResult {
  success: boolean;
  error?: string;
}

export function spawnTerminalWithSetup(repoPath: string): SpawnResult {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      return spawnWindowsTerminal(repoPath);
    } else if (platform === 'darwin') {
      return spawnMacTerminal(repoPath);
    } else {
      return spawnLinuxTerminal(repoPath);
    }
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }
}
```

### Task 19: IMPLEMENT --spawn flag handling

**File**: `packages/cli/src/commands/setup.ts`

- **IMPLEMENT**: Add `--spawn` flag that spawns a new terminal instead of running interactively
- **LOGIC**:
  1. If `--spawn` flag is passed, call `spawnTerminalWithSetup(cwd)`
  2. Print message: "Opening setup wizard in a new terminal window..."
  3. Exit immediately (the spawned terminal runs independently)
  4. If spawn fails, print error and suggest running `archon setup` directly
- **USE CASE**: AI agent runs `archon setup --spawn` to open setup for user
- **VALIDATE**: `bun run cli setup --spawn`

### Task 20: UPDATE cli.ts to add setup command routing

**File**: `packages/cli/src/cli.ts`

- **IMPLEMENT**: Add import and case statement for setup command
- **PATTERN**: Follow existing command routing structure
- **IMPORTS**: Add `import { setupCommand } from './commands/setup';`
- **ROUTING**: Add case in main switch statement
- **FLAGS**: Parse `--spawn` flag and pass to setupCommand
- **NOTE**: Setup command does NOT require git repo (add to `noGitCommands` array)
- **VALIDATE**: `bun run cli setup --help` (should not error)

```typescript
// Add to imports
import { setupCommand } from './commands/setup';

// Add to noGitCommands
const noGitCommands = ['version', 'help', 'setup'];

// Add --spawn to parseArgs options
spawn: { type: 'boolean' },

// Add to switch statement
case 'setup': {
  const spawnFlag = values.spawn as boolean | undefined;
  await setupCommand({ spawn: spawnFlag, repoPath: cwd });
  break;
}
```

### Task 21: UPDATE printUsage() to include setup command

**File**: `packages/cli/src/cli.ts`

- **IMPLEMENT**: Add setup command to help output
- **PATTERN**: Follow existing help format
- **VALIDATE**: `bun run cli --help` (should show setup command)

### Task 22: CREATE setup.test.ts with unit tests

**File**: `packages/cli/src/commands/setup.test.ts`

- **IMPLEMENT**: Unit tests for setup command utilities
- **PATTERN**: Follow testing patterns from workflow.test.ts and version.test.ts
- **TEST CASES**:
  1. `checkExistingConfig()` returns null when no file exists
  2. `checkExistingConfig()` parses existing file correctly
  3. `generateEnvContent()` produces correct format
  4. `generateWebhookSecret()` produces valid 64-char hex string
  5. Cancellation handling (isCancel checks)
- **MOCKING**: Mock fs operations and @clack/prompts
- **VALIDATE**: `cd packages/cli && bun test setup.test.ts`

### Task 23: UPDATE setup.md skill guide

**File**: `.claude/skills/archon/guides/setup.md`

- **IMPLEMENT**: Update Step 5 and Step 6 to use `archon setup --spawn` command
- **CRITICAL**: Agent must use `--spawn` flag to open setup in a new terminal window
- **REASON**: Interactive prompts cannot receive user input when run via the AI agent's Bash tool
- **CHANGES**:
  1. After CLI setup (Step 4), run `archon setup --spawn` to open a new terminal
  2. Tell user to complete setup in the new window
  3. Wait for user to confirm completion
  4. Verify with `archon version`
  5. Remove manual .env editing instructions
- **PATTERN**: Keep existing structure, just update the credential steps
- **VALIDATE**: Read through flow to ensure it makes sense

Key changes to Step 5 (Database Setup) and Step 6 (Platform-Specific Setup):

```markdown
## Step 5: Configure Credentials

Now we'll configure your credentials securely. I'll open the setup wizard in a new terminal window - you'll enter your API keys and tokens directly there, so I won't see them.

**IMPORTANT**: Do NOT run `archon setup` directly via Bash - it requires interactive input that I cannot provide. Use the `--spawn` flag to open a new terminal window.

```bash
archon setup --spawn
```

This opens a new terminal window with the setup wizard. In that window, you'll:
1. Choose which database to use (SQLite default or PostgreSQL)
2. Select which AI assistant(s) to configure (Claude and/or Codex)
3. Select which platforms to connect (GitHub, Telegram, Slack, Discord)
4. Enter credentials for each selected option (with step-by-step instructions)
5. The wizard saves configuration to both `~/.archon/.env` and the repo `.env`

**Tell me when you've completed the setup wizard** so I can verify the configuration.

## Step 6: Verify Configuration

After the user confirms setup is complete, verify it was successful:

```bash
archon version
```

Should show the configured database type. Check for expected output like:
- `Database: sqlite` or `Database: postgresql`
- No errors about missing configuration

If verification fails, ask the user to run `archon setup` again in their terminal.
```

### Task 24: RUN full validation

**All Files**

- **VALIDATE**: Run full validation suite
  ```bash
  bun run validate
  ```
- **VERIFY**: CLI runs without errors
  ```bash
  bun run cli --help
  bun run cli setup --spawn
  ```
- **NOTE**: Manual interactive testing will be done by the user separately

---

## TESTING STRATEGY

### Unit Tests

**Scope**: Test utility functions in isolation

- `checkExistingConfig()` - file existence and parsing
- `generateEnvContent()` - content generation with various configs
- `generateWebhookSecret()` - crypto random generation
- Input validation functions

**Framework**: Bun Test (built-in)

**Mocking**:
```typescript
import { mock, spyOn } from 'bun:test';

// Mock @clack/prompts
mock.module('@clack/prompts', () => ({
  intro: mock(() => {}),
  outro: mock(() => {}),
  text: mock(() => Promise.resolve('test-value')),
  // ...
}));

// Mock fs
mock.module('fs', () => ({
  existsSync: mock(() => true),
  readFileSync: mock(() => 'TELEGRAM_BOT_TOKEN=xxx'),
  writeFileSync: mock(() => {}),
  mkdirSync: mock(() => {}),
}));
```

### Integration Tests

Not required for this feature - manual testing is sufficient for interactive CLI.

### Manual Testing Checklist (User will perform)

The following tests require interactive input and will be performed by the user:

- [ ] Fresh setup (no existing .env)
- [ ] Existing config detection and display
- [ ] "Add platforms" flow
- [ ] "Update config" flow
- [ ] "Start fresh" flow
- [ ] SQLite selection (no DATABASE_URL prompt)
- [ ] PostgreSQL selection (DATABASE_URL prompt)
- [ ] Claude with global auth
- [ ] Claude with API key
- [ ] Codex with existing auth.json
- [ ] Codex without auth.json
- [ ] Both Claude and Codex (default selection)
- [ ] GitHub platform setup
- [ ] Telegram platform setup
- [ ] Slack platform setup
- [ ] Discord platform setup
- [ ] Multiple platforms at once
- [ ] Cancel handling (Ctrl+C at any point)
- [ ] Files written to both locations
- [ ] Bot display name customization
- [ ] `--spawn` flag opens new terminal on Windows
- [ ] `--spawn` flag opens new terminal on macOS (if available)
- [ ] `--spawn` flag opens new terminal on Linux (if available)

---

## VALIDATION COMMANDS

Execute every command to ensure zero regressions and 100% feature correctness.

### Level 1: Syntax & Style

```bash
# TypeScript type checking
bun run type-check

# ESLint (must pass with 0 errors)
bun run lint --max-warnings 0

# Prettier formatting check
bun run format:check
```

**Expected**: All commands pass with exit code 0

### Level 2: Unit Tests

```bash
# Run all tests
bun run test

# Run setup-specific tests
cd packages/cli && bun test setup.test.ts
```

**Expected**: All tests pass

### Level 3: Build Verification

```bash
# Verify CLI runs without errors
bun run cli --help
bun run cli setup --help 2>&1 || true
```

**Expected**: Help output displays, setup command is listed

### Level 4: Spawn Test

```bash
# Test that --spawn flag opens a new terminal (non-interactive)
bun run cli setup --spawn
```

**Expected**: New terminal window opens with setup wizard

### Level 5: Full Validation

```bash
bun run validate
```

**Expected**: All checks pass (type-check, lint, format, test)

---

## ACCEPTANCE CRITERIA

- [ ] `archon setup` command exists and is documented in help
- [ ] Detects existing ~/.archon/.env and offers options
- [ ] Database selection works (SQLite default, PostgreSQL with URL)
- [ ] AI assistant selection works (Claude, Codex, both, neither)
- [ ] Claude auth options work (global, API key, OAuth token)
- [ ] Codex auth auto-imports from ~/.codex/auth.json if present
- [ ] Platform multi-select works (GitHub, Telegram, Slack, Discord)
- [ ] Each platform shows clear setup instructions
- [ ] GitHub webhook secret is auto-generated
- [ ] Configuration written to ~/.archon/.env
- [ ] Configuration written to <repo>/.env
- [ ] Summary shows what was configured
- [ ] Additional customizable options mentioned at end
- [ ] Cancel (Ctrl+C) handled gracefully at all points
- [ ] `--spawn` flag opens new terminal window (Windows/macOS/Linux)
- [ ] No type errors, lint errors, or test failures
- [ ] Setup skill guide updated to use `archon setup --spawn`

---

## COMPLETION CHECKLIST

- [ ] All tasks completed in order
- [ ] Each task validation passed immediately
- [ ] All validation commands executed successfully:
  - [ ] Level 1: type-check, lint, format:check
  - [ ] Level 2: test
  - [ ] Level 3: CLI runs
  - [ ] Level 4: --spawn flag tested
  - [ ] Level 5: Full validation passes
- [ ] Full test suite passes
- [ ] No linting errors
- [ ] No formatting errors
- [ ] No type checking errors
- [ ] All acceptance criteria met
- [ ] Code reviewed for quality and maintainability

---

## NOTES

### Design Decisions

1. **@clack/prompts chosen over inquirer**: More modern, better TypeScript support, beautiful default styling, actively maintained (v1.0.0 released Feb 2025)

2. **Write to both .env locations**: Simplifies setup - user doesn't need to understand the CLI vs server distinction

3. **Streaming modes not configurable in setup**: Keeps wizard simple, sensible defaults work for most users

4. **Auto-generate webhook secret**: One less thing for user to do, crypto.randomBytes is secure

5. **Codex auth.json auto-import**: Better UX than making user copy 4 tokens manually

6. **--spawn flag for AI agent integration**: Interactive prompts cannot receive input when run via AI agent's Bash tool. The `--spawn` flag opens a new terminal window where the user can interact directly, then control returns to the agent for verification.

### Terminal Spawn Commands (Reference)

**Windows (Primary: Windows Terminal, Fallback: cmd.exe)**
```bash
# Windows Terminal
wt.exe -d "C:\path\to\repo" cmd /k "archon setup"

# Fallback: cmd.exe
start "" /D "C:\path\to\repo" cmd /k "archon setup"
```

**macOS (Terminal.app via osascript)**
```bash
osascript -e 'tell application "Terminal" to do script "cd /path/to/repo && archon setup"'
```

**Linux (x-terminal-emulator with gnome-terminal fallback)**
```bash
# Distro default
x-terminal-emulator --working-directory=/path/to/repo -e "bash -c 'archon setup; exec bash'"

# GNOME fallback
gnome-terminal --working-directory=/path/to/repo -- bash -c "archon setup; exec bash"
```

### Security Considerations

- Tokens entered via `password()` are masked in terminal
- No tokens are ever logged or displayed back
- Generated .env files are in .gitignore
- Webhook secret uses cryptographically secure random generation

### Future Enhancements

- `archon setup --non-interactive` for scripted setup
- `archon setup verify` to test connections
- Platform-specific connection testing during setup
