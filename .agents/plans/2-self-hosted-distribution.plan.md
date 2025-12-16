# Plan: Self-Hosted Distribution

## Summary

Enable easy distribution of the remote-coding-agent for self-hosted users. This involves:
1. **CLI package** with interactive `init` command for guided setup
2. **Docker image publishing** to GitHub Container Registry (GHCR) via CI/CD
3. **One-click deploy buttons** for Railway, Render, and Fly.io
4. **Improved documentation** with deploy guides

Users will be able to:
- Run `npx @dynamous/remote-coding-agent init` for interactive setup
- Pull `ghcr.io/dynamous/remote-coding-agent:latest` directly
- Click a button in README to deploy to Railway/Render/Fly.io

## External Research

### Documentation Sources
- [npm CLI best practices](https://github.com/lirantal/nodejs-cli-apps-best-practices) - Comprehensive CLI patterns
- [prompts npm package](https://www.npmjs.com/package/prompts) - Lightweight interactive prompts
- [GitHub Container Registry Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) - GHCR publishing
- [Railway Config-as-Code](https://docs.railway.com/guides/config-as-code) - railway.json format
- [Render Blueprint Spec](https://render.com/docs/blueprint-spec) - render.yaml format
- [Fly.io Configuration](https://fly.io/docs/reference/configuration/) - fly.toml format

### Key Findings

**CLI Packaging:**
- Use `#!/usr/bin/env node` shebang in bin entry
- Use `prompts` package (lightweight, async/await, testable) over inquirer
- Package.json `bin` field maps command name to script
- Test locally with `npm link` before publishing

**Docker Publishing to GHCR:**
- Use `docker/login-action`, `docker/metadata-action`, `docker/build-push-action`
- Auth via `GITHUB_TOKEN` with `packages: write` permission
- Tag with git sha, branch, and semantic version
- Add `org.opencontainers.image.source` label to link to repo

**One-Click Deploy:**
- Railway: `https://railway.com/template/{template-id}` or direct repo link
- Render: `https://render.com/deploy?repo=REPO_URL` with `render.yaml` in root
- Fly.io: No button, requires `fly launch` CLI command with `fly.toml`

**Gotchas:**
- Railway templates now deploy from template repo by default (not fork)
- Render recommends `autoDeploy: false` for deploy button templates
- Fly.io requires CLI for initial setup, not truly "one-click"

## Patterns to Mirror

### CLI Script Pattern (setup-auth.ts)
```typescript
// FROM: src/scripts/setup-auth.ts:23-35
function setupAuth(): void {
  const idToken = process.env.CODEX_ID_TOKEN;
  // ... validation

  if (!idToken || !accessToken) {
    console.log('⏭️  Skipping Codex auth setup - credentials not provided');
    return;
  }

  console.log('🔐 Setting up Codex authentication...');
  // ... file operations
  console.log('✅ Codex authentication and configuration complete');
}

// Run the setup
setupAuth();
```

### Package.json Scripts Pattern
```json
// FROM: package.json:6-19
"scripts": {
  "dev": "tsx watch src/index.ts",
  "build": "tsc",
  "start": "node dist/index.js",
  "setup-auth": "node dist/scripts/setup-auth.js",
  // ...
}
```

### Dockerfile Pattern
```dockerfile
# FROM: Dockerfile:1-67
FROM node:20-slim
WORKDIR /app
# Install dependencies
RUN apt-get update && apt-get install -y curl git bash ...
# Create non-root user
RUN useradd -m -u 1001 -s /bin/bash appuser
# Build and prune
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --production
USER appuser
EXPOSE 3000
CMD ["sh", "-c", "npm run setup-auth && npm start"]
```

### GitHub Actions CI Pattern
```yaml
# FROM: .github/workflows/test.yml:1-42
name: Test Suite
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          cache: 'npm'
      - run: npm ci
      - run: npm run type-check
      - run: npm run lint
      - run: npm run test:coverage
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `src/cli/index.ts` | CREATE | CLI entry point with command routing |
| `src/cli/commands/init.ts` | CREATE | Interactive setup wizard |
| `src/cli/commands/start.ts` | CREATE | Start the application |
| `src/cli/commands/doctor.ts` | CREATE | Validate configuration |
| `src/cli/utils/prompts.ts` | CREATE | Shared prompt utilities |
| `src/cli/utils/config.ts` | CREATE | Config file management |
| `package.json` | UPDATE | Add bin entry, prompts dependency |
| `.github/workflows/publish.yml` | CREATE | Docker + npm publishing workflow |
| `railway.json` | CREATE | Railway deployment config |
| `render.yaml` | CREATE | Render deployment config |
| `fly.toml` | CREATE | Fly.io deployment config |
| `README.md` | UPDATE | Add deploy buttons, CLI instructions |
| `.dockerignore` | UPDATE | Exclude CLI-only files from image |

## NOT Building

- **Web UI for configuration** - CLI-only for MVP
- **User registration/authentication** - Self-hosted means no central auth
- **Auto-update mechanism** - Users pull new versions manually
- **Telemetry/analytics** - Privacy-first, no tracking
- **Windows installer (.exe)** - npm/Docker work cross-platform
- **Systemd/launchd service files** - Users can create their own

## Tasks

### Task 1: Add prompts dependency

**Why**: Need interactive CLI prompts for the init wizard.

**Do**:
```bash
npm install prompts
npm install -D @types/prompts
```

Update package.json dependencies (will be done by npm install).

**Verify**: `npm run type-check`

---

### Task 2: Create CLI entry point

**Why**: Main CLI script that routes to subcommands.

**Mirror**: `src/scripts/setup-auth.ts` (standalone script pattern)

**Do**: Create `src/cli/index.ts`:
```typescript
#!/usr/bin/env node
/**
 * Remote Coding Agent CLI
 * Interactive setup and management for self-hosted deployments
 */

import { parseArgs } from 'node:util';

const COMMANDS = {
  init: 'Interactive setup wizard',
  start: 'Start the application',
  doctor: 'Validate configuration',
  help: 'Show this help message',
};

async function main(): Promise<void> {
  const { positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0] ?? 'help';

  switch (command) {
    case 'init': {
      const { runInit } = await import('./commands/init.js');
      await runInit();
      break;
    }
    case 'start': {
      const { runStart } = await import('./commands/start.js');
      await runStart();
      break;
    }
    case 'doctor': {
      const { runDoctor } = await import('./commands/doctor.js');
      await runDoctor();
      break;
    }
    case 'help':
    default:
      console.log('Remote Coding Agent CLI\n');
      console.log('Usage: remote-agent <command>\n');
      console.log('Commands:');
      for (const [cmd, desc] of Object.entries(COMMANDS)) {
        console.log(`  ${cmd.padEnd(10)} ${desc}`);
      }
      break;
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
```

**Don't**: Don't add complex argument parsing yet - KISS.

**Verify**: `npm run build && node dist/cli/index.js help`

---

### Task 3: Create config utilities

**Why**: Shared utilities for reading/writing config files.

**Mirror**: `src/scripts/setup-auth.ts` (file operations pattern)

**Do**: Create `src/cli/utils/config.ts`:
```typescript
/**
 * Configuration file utilities
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AgentConfig {
  // Database
  databaseUrl?: string;

  // AI Credentials
  claudeOauthToken?: string;
  claudeApiKey?: string;
  codexIdToken?: string;
  codexAccessToken?: string;
  codexRefreshToken?: string;
  codexAccountId?: string;

  // Platform Tokens
  telegramBotToken?: string;
  discordBotToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;

  // GitHub
  githubToken?: string;
  webhookSecret?: string;

  // Optional
  workspacePath?: string;
  port?: number;
}

export function getConfigDir(): string {
  const configDir = path.join(os.homedir(), '.config', 'remote-coding-agent');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): AgentConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const content = fs.readFileSync(configPath, 'utf-8');
  return JSON.parse(content) as AgentConfig;
}

export function saveConfig(config: AgentConfig): void {
  const configPath = getConfigPath();
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  // Set restrictive permissions (owner read/write only)
  fs.chmodSync(configPath, 0o600);
  console.log(`✅ Configuration saved to ${configPath}`);
}

export function configToEnv(config: AgentConfig): string {
  const lines: string[] = [
    '# Remote Coding Agent Configuration',
    '# Generated by: remote-agent init',
    '',
  ];

  if (config.databaseUrl) {
    lines.push(`DATABASE_URL=${config.databaseUrl}`);
  }

  if (config.claudeOauthToken) {
    lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${config.claudeOauthToken}`);
  } else if (config.claudeApiKey) {
    lines.push(`CLAUDE_API_KEY=${config.claudeApiKey}`);
  }

  if (config.codexIdToken) {
    lines.push(`CODEX_ID_TOKEN=${config.codexIdToken}`);
    lines.push(`CODEX_ACCESS_TOKEN=${config.codexAccessToken ?? ''}`);
    lines.push(`CODEX_REFRESH_TOKEN=${config.codexRefreshToken ?? ''}`);
    lines.push(`CODEX_ACCOUNT_ID=${config.codexAccountId ?? ''}`);
  }

  if (config.telegramBotToken) {
    lines.push(`TELEGRAM_BOT_TOKEN=${config.telegramBotToken}`);
  }

  if (config.discordBotToken) {
    lines.push(`DISCORD_BOT_TOKEN=${config.discordBotToken}`);
  }

  if (config.slackBotToken) {
    lines.push(`SLACK_BOT_TOKEN=${config.slackBotToken}`);
    lines.push(`SLACK_APP_TOKEN=${config.slackAppToken ?? ''}`);
  }

  if (config.githubToken) {
    lines.push(`GH_TOKEN=${config.githubToken}`);
    lines.push(`GITHUB_TOKEN=${config.githubToken}`);
  }

  if (config.webhookSecret) {
    lines.push(`WEBHOOK_SECRET=${config.webhookSecret}`);
  }

  if (config.workspacePath) {
    lines.push(`WORKSPACE_PATH=${config.workspacePath}`);
  }

  lines.push(`PORT=${String(config.port ?? 3000)}`);

  return lines.join('\n');
}

export function writeEnvFile(config: AgentConfig, targetPath: string): void {
  const content = configToEnv(config);
  fs.writeFileSync(targetPath, content);
  fs.chmodSync(targetPath, 0o600);
  console.log(`✅ Environment file written to ${targetPath}`);
}
```

**Verify**: `npm run type-check`

---

### Task 4: Create init command

**Why**: Interactive wizard for first-time setup.

**Mirror**: Uses prompts library patterns from external research.

**Do**: Create `src/cli/commands/init.ts`:
```typescript
/**
 * Interactive setup wizard
 */
import prompts from 'prompts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentConfig, saveConfig, writeEnvFile } from '../utils/config.js';

export async function runInit(): Promise<void> {
  console.log('\n🚀 Remote Coding Agent Setup Wizard\n');
  console.log('This wizard will help you configure your self-hosted instance.\n');

  const config: AgentConfig = {};

  // Step 1: Database
  console.log('📦 Step 1/4: Database Configuration\n');

  const dbChoice = await prompts({
    type: 'select',
    name: 'database',
    message: 'How will you run PostgreSQL?',
    choices: [
      { title: 'Docker (local)', description: 'Run PostgreSQL in Docker alongside the app', value: 'docker' },
      { title: 'External (Supabase, Neon, etc.)', description: 'Use an external PostgreSQL service', value: 'external' },
    ],
  });

  if (dbChoice.database === 'external') {
    const dbUrl = await prompts({
      type: 'text',
      name: 'url',
      message: 'PostgreSQL connection URL:',
      validate: (v: string) => v.startsWith('postgresql://') || 'Must start with postgresql://',
    });
    config.databaseUrl = dbUrl.url;
  } else {
    config.databaseUrl = 'postgresql://postgres:postgres@postgres:5432/remote_coding_agent';
  }

  // Step 2: AI Assistant
  console.log('\n🤖 Step 2/4: AI Assistant Configuration\n');

  const aiChoice = await prompts({
    type: 'select',
    name: 'assistant',
    message: 'Which AI assistant will you use?',
    choices: [
      { title: 'Claude (recommended)', description: 'Anthropic Claude via Claude Code', value: 'claude' },
      { title: 'Codex', description: 'OpenAI Codex', value: 'codex' },
      { title: 'Both', description: 'Configure both assistants', value: 'both' },
    ],
  });

  if (aiChoice.assistant === 'claude' || aiChoice.assistant === 'both') {
    console.log('\n💡 To get your Claude OAuth token:');
    console.log('   1. Install Claude Code CLI: https://docs.claude.com/claude-code/installation');
    console.log('   2. Run: claude setup-token');
    console.log('   3. Copy the token (starts with sk-ant-oat01-...)\n');

    const claudeToken = await prompts({
      type: 'password',
      name: 'token',
      message: 'Claude OAuth Token (sk-ant-oat01-...):',
      validate: (v: string) => !v || v.startsWith('sk-ant-') || 'Token should start with sk-ant-',
    });

    if (claudeToken.token) {
      config.claudeOauthToken = claudeToken.token;
    }
  }

  if (aiChoice.assistant === 'codex' || aiChoice.assistant === 'both') {
    console.log('\n💡 To get your Codex credentials:');
    console.log('   1. Run: codex login');
    console.log('   2. View credentials: cat ~/.codex/auth.json\n');

    const codexTokens = await prompts([
      {
        type: 'password',
        name: 'idToken',
        message: 'Codex ID Token (from auth.json):',
      },
      {
        type: 'password',
        name: 'accessToken',
        message: 'Codex Access Token:',
      },
      {
        type: 'password',
        name: 'refreshToken',
        message: 'Codex Refresh Token:',
      },
      {
        type: 'text',
        name: 'accountId',
        message: 'Codex Account ID:',
      },
    ]);

    if (codexTokens.idToken) {
      config.codexIdToken = codexTokens.idToken;
      config.codexAccessToken = codexTokens.accessToken;
      config.codexRefreshToken = codexTokens.refreshToken;
      config.codexAccountId = codexTokens.accountId;
    }
  }

  // Step 3: Platform
  console.log('\n💬 Step 3/4: Platform Configuration\n');

  const platformChoice = await prompts({
    type: 'multiselect',
    name: 'platforms',
    message: 'Which platforms will you use? (Space to select, Enter to confirm)',
    choices: [
      { title: 'Telegram', value: 'telegram' },
      { title: 'Discord', value: 'discord' },
      { title: 'Slack', value: 'slack' },
      { title: 'GitHub Webhooks', value: 'github' },
    ],
    min: 1,
    hint: '- Select at least one',
  });

  if (platformChoice.platforms.includes('telegram')) {
    console.log('\n💡 Create a Telegram bot via @BotFather and get the token.\n');
    const telegram = await prompts({
      type: 'password',
      name: 'token',
      message: 'Telegram Bot Token:',
    });
    config.telegramBotToken = telegram.token;
  }

  if (platformChoice.platforms.includes('discord')) {
    console.log('\n💡 Create a Discord bot at https://discord.com/developers/applications\n');
    const discord = await prompts({
      type: 'password',
      name: 'token',
      message: 'Discord Bot Token:',
    });
    config.discordBotToken = discord.token;
  }

  if (platformChoice.platforms.includes('slack')) {
    console.log('\n💡 Create a Slack app at https://api.slack.com/apps\n');
    const slack = await prompts([
      {
        type: 'password',
        name: 'botToken',
        message: 'Slack Bot Token (xoxb-...):',
      },
      {
        type: 'password',
        name: 'appToken',
        message: 'Slack App Token (xapp-...):',
      },
    ]);
    config.slackBotToken = slack.botToken;
    config.slackAppToken = slack.appToken;
  }

  if (platformChoice.platforms.includes('github')) {
    console.log('\n💡 Generate a GitHub token at https://github.com/settings/tokens\n');
    const github = await prompts([
      {
        type: 'password',
        name: 'token',
        message: 'GitHub Personal Access Token (ghp_...):',
      },
      {
        type: 'text',
        name: 'secret',
        message: 'Webhook Secret (or press Enter to generate):',
      },
    ]);
    config.githubToken = github.token;
    config.webhookSecret = github.secret || generateSecret();
  }

  // Step 4: Optional settings
  console.log('\n⚙️ Step 4/4: Optional Settings\n');

  const optional = await prompts([
    {
      type: 'text',
      name: 'workspace',
      message: 'Workspace path for cloned repos:',
      initial: path.join(os.homedir(), 'remote-agent-workspace'),
    },
    {
      type: 'number',
      name: 'port',
      message: 'HTTP port:',
      initial: 3000,
    },
  ]);

  config.workspacePath = optional.workspace;
  config.port = optional.port;

  // Save configuration
  console.log('\n📝 Saving configuration...\n');

  saveConfig(config);

  // Ask about .env file
  const envChoice = await prompts({
    type: 'confirm',
    name: 'createEnv',
    message: 'Create .env file in current directory?',
    initial: true,
  });

  if (envChoice.createEnv) {
    writeEnvFile(config, path.join(process.cwd(), '.env'));
  }

  // Final instructions
  console.log('\n✅ Setup complete!\n');
  console.log('Next steps:');

  if (dbChoice.database === 'docker') {
    console.log('  1. Start with Docker:');
    console.log('     docker compose --profile with-db up -d\n');
  } else {
    console.log('  1. Run database migrations:');
    console.log('     psql $DATABASE_URL < migrations/000_combined.sql');
    console.log('');
    console.log('  2. Start with Docker:');
    console.log('     docker compose --profile external-db up -d\n');
  }

  console.log('  Or start directly:');
  console.log('     remote-agent start\n');
}

function generateSecret(): string {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}
```

**Don't**: Don't add validation that blocks progress - users can fix later.

**Verify**: `npm run build && node dist/cli/commands/init.js`

---

### Task 5: Create start command

**Why**: Convenience command to start the app with proper env loading.

**Do**: Create `src/cli/commands/start.ts`:
```typescript
/**
 * Start the application
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, configToEnv } from '../utils/config.js';

export async function runStart(): Promise<void> {
  console.log('🚀 Starting Remote Coding Agent...\n');

  // Check for .env file first
  const envPath = path.join(process.cwd(), '.env');
  const hasEnvFile = fs.existsSync(envPath);

  // Check for saved config
  const config = loadConfig();

  if (!hasEnvFile && !config) {
    console.error('❌ No configuration found.');
    console.error('   Run "remote-agent init" first, or create a .env file.');
    process.exit(1);
  }

  // If we have config but no .env, set env vars from config
  if (config && !hasEnvFile) {
    const envContent = configToEnv(config);
    for (const line of envContent.split('\n')) {
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          process.env[key] = valueParts.join('=');
        }
      }
    }
  }

  // Find the main entry point
  const distPath = path.join(__dirname, '..', '..', 'index.js');

  if (!fs.existsSync(distPath)) {
    console.error('❌ Application not built. Run "npm run build" first.');
    process.exit(1);
  }

  // Start the application
  const child = spawn('node', [distPath], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    console.error('❌ Failed to start:', error.message);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
```

**Verify**: `npm run build && node dist/cli/commands/start.js`

---

### Task 6: Create doctor command

**Why**: Help users diagnose configuration issues.

**Do**: Create `src/cli/commands/doctor.ts`:
```typescript
/**
 * Validate configuration and diagnose issues
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, getConfigPath } from '../utils/config.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

export async function runDoctor(): Promise<void> {
  console.log('🔍 Remote Coding Agent Doctor\n');

  const results: CheckResult[] = [];

  // Check 1: Config file
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    results.push({ name: 'Config file', status: 'ok', message: configPath });
  } else {
    results.push({ name: 'Config file', status: 'warn', message: 'Not found (run "remote-agent init")' });
  }

  // Check 2: .env file
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    results.push({ name: '.env file', status: 'ok', message: envPath });
  } else {
    results.push({ name: '.env file', status: 'warn', message: 'Not found in current directory' });
  }

  // Check 3: Load and validate config
  const config = loadConfig();

  // Check 4: Database
  const dbUrl = config?.databaseUrl ?? process.env.DATABASE_URL;
  if (dbUrl) {
    results.push({ name: 'Database URL', status: 'ok', message: 'Configured' });
  } else {
    results.push({ name: 'Database URL', status: 'error', message: 'Missing DATABASE_URL' });
  }

  // Check 5: AI Assistant
  const hasClaudeToken = config?.claudeOauthToken ?? config?.claudeApiKey ??
                         process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.CLAUDE_API_KEY;
  const hasCodexToken = config?.codexIdToken ?? process.env.CODEX_ID_TOKEN;

  if (hasClaudeToken || hasCodexToken) {
    const assistants = [];
    if (hasClaudeToken) assistants.push('Claude');
    if (hasCodexToken) assistants.push('Codex');
    results.push({ name: 'AI Assistant', status: 'ok', message: assistants.join(', ') });
  } else {
    results.push({ name: 'AI Assistant', status: 'error', message: 'No AI credentials configured' });
  }

  // Check 6: Platform adapters
  const platforms: string[] = [];
  if (config?.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN) platforms.push('Telegram');
  if (config?.discordBotToken ?? process.env.DISCORD_BOT_TOKEN) platforms.push('Discord');
  if (config?.slackBotToken ?? process.env.SLACK_BOT_TOKEN) platforms.push('Slack');
  if ((config?.githubToken ?? process.env.GITHUB_TOKEN) &&
      (config?.webhookSecret ?? process.env.WEBHOOK_SECRET)) platforms.push('GitHub');

  if (platforms.length > 0) {
    results.push({ name: 'Platforms', status: 'ok', message: platforms.join(', ') });
  } else {
    results.push({ name: 'Platforms', status: 'error', message: 'No platform configured' });
  }

  // Check 7: Workspace
  const workspace = config?.workspacePath ?? process.env.WORKSPACE_PATH ?? '/workspace';
  if (fs.existsSync(workspace)) {
    results.push({ name: 'Workspace', status: 'ok', message: workspace });
  } else {
    results.push({ name: 'Workspace', status: 'warn', message: `${workspace} (will be created)` });
  }

  // Check 8: Docker
  try {
    const { execSync } = require('child_process');
    execSync('docker --version', { stdio: 'pipe' });
    results.push({ name: 'Docker', status: 'ok', message: 'Available' });
  } catch {
    results.push({ name: 'Docker', status: 'warn', message: 'Not found (optional for local dev)' });
  }

  // Print results
  const icons = { ok: '✅', warn: '⚠️', error: '❌' };

  for (const result of results) {
    console.log(`${icons[result.status]} ${result.name.padEnd(15)} ${result.message}`);
  }

  const hasErrors = results.some(r => r.status === 'error');
  const hasWarnings = results.some(r => r.status === 'warn');

  console.log('');
  if (hasErrors) {
    console.log('❌ Configuration has errors. Run "remote-agent init" to fix.');
    process.exit(1);
  } else if (hasWarnings) {
    console.log('⚠️ Configuration has warnings but should work.');
  } else {
    console.log('✅ All checks passed!');
  }
}
```

**Verify**: `npm run build && node dist/cli/commands/doctor.js`

---

### Task 7: Update package.json for CLI

**Why**: Add bin entry, scripts, and prompts dependency.

**Mirror**: Standard npm CLI package patterns.

**Do**: Update `package.json`:

1. Add `bin` field after `main`:
```json
"bin": {
  "remote-agent": "./dist/cli/index.js"
},
```

2. Add prompts to dependencies (already in deps from Task 1).

3. Add script for CLI build verification:
```json
"cli": "node dist/cli/index.js"
```

4. Update name if publishing to npm scope:
```json
"name": "@dynamous/remote-coding-agent",
```

**Don't**: Don't change existing scripts or main entry.

**Verify**: `npm run build && npm link && remote-agent help`

---

### Task 8: Create Docker publish workflow

**Why**: Publish Docker images to GHCR on release.

**Mirror**: `.github/workflows/test.yml` (GitHub Actions pattern)

**Do**: Create `.github/workflows/publish.yml`:
```yaml
name: Publish

on:
  release:
    types: [published]
  push:
    tags:
      - 'v*'
  workflow_dispatch:  # Allow manual trigger

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  docker:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=ref,event=branch
            type=ref,event=pr
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  npm:
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20.x'
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci
      - run: npm run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Don't**: Don't add secrets to the file - they're configured in GitHub settings.

**Verify**: Workflow syntax: `cat .github/workflows/publish.yml`

---

### Task 9: Create Railway config

**Why**: Enable one-click deploy to Railway.

**Mirror**: External research on railway.json format.

**Do**: Create `railway.json`:
```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE"
  },
  "deploy": {
    "startCommand": "npm run setup-auth && npm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 3
  }
}
```

**Verify**: JSON syntax valid: `cat railway.json | jq .`

---

### Task 10: Create Render config

**Why**: Enable one-click deploy to Render.

**Mirror**: External research on render.yaml format.

**Do**: Create `render.yaml`:
```yaml
services:
  - type: web
    name: remote-coding-agent
    runtime: docker
    plan: starter
    autoDeploy: false  # Important: Prevents auto-deploy from template repo
    healthCheckPath: /health
    envVars:
      - key: DATABASE_URL
        sync: false  # User must provide
      - key: CLAUDE_CODE_OAUTH_TOKEN
        sync: false
      - key: TELEGRAM_BOT_TOKEN
        sync: false
      - key: WORKSPACE_PATH
        value: /workspace
      - key: PORT
        value: 3000

databases:
  - name: remote-coding-agent-db
    plan: starter
    databaseName: remote_coding_agent
    user: postgres
    ipAllowList: []  # Only internal access
```

**Verify**: YAML syntax valid: `cat render.yaml`

---

### Task 11: Create Fly.io config

**Why**: Provide config for Fly.io users (not one-click but still useful).

**Mirror**: External research on fly.toml format.

**Do**: Create `fly.toml`:
```toml
# Fly.io Configuration
# Deploy with: fly launch --copy-config

app = "remote-coding-agent"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[http_service.concurrency]
  type = "requests"
  hard_limit = 100
  soft_limit = 80

[[http_service.checks]]
  grace_period = "10s"
  interval = "30s"
  method = "GET"
  timeout = "5s"
  path = "/health"

[env]
  PORT = "3000"
  WORKSPACE_PATH = "/workspace"

[mounts]
  source = "workspace_data"
  destination = "/workspace"

# Secrets to set via: fly secrets set KEY=value
# - DATABASE_URL
# - CLAUDE_CODE_OAUTH_TOKEN (or CLAUDE_API_KEY)
# - TELEGRAM_BOT_TOKEN (or other platform tokens)
```

**Don't**: Don't include secrets in the file.

**Verify**: TOML syntax: `cat fly.toml`

---

### Task 12: Update Dockerfile with GHCR labels

**Why**: Link Docker image to repository for better discoverability.

**Do**: Add labels to Dockerfile after `FROM` line:
```dockerfile
# Add after FROM node:20-slim
LABEL org.opencontainers.image.source="https://github.com/dynamous-community/remote-coding-agent"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"
```

**Verify**: `docker build -t test . --no-cache`

---

### Task 13: Update README with deploy buttons and CLI instructions

**Why**: Make distribution options visible and easy to use.

**Do**: Add new section after "Prerequisites" in README.md:

```markdown
---

## Quick Deploy

### Option 1: CLI Setup (Recommended)

```bash
# Install and run interactive setup
npx @dynamous/remote-coding-agent init

# Or install globally
npm install -g @dynamous/remote-coding-agent
remote-agent init
```

### Option 2: Docker Image

```bash
# Pull the latest image
docker pull ghcr.io/dynamous-community/remote-coding-agent:latest

# Run with your .env file
docker run --env-file .env -v ./workspace:/workspace ghcr.io/dynamous-community/remote-coding-agent
```

### Option 3: One-Click Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/TEMPLATE_ID?referralCode=dynamous)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/dynamous-community/remote-coding-agent)

> **Note:** After deploying, you'll need to set environment variables for your AI credentials and platform tokens.

---
```

**Note**: TEMPLATE_ID needs to be obtained after publishing Railway template.

**Verify**: Preview README in GitHub or markdown viewer.

---

### Task 14: Update .dockerignore

**Why**: Exclude CLI-specific and development files from Docker image.

**Do**: Add to `.dockerignore`:
```
# CLI development files
src/cli/
.agents/
.claude/

# Test files
*.test.ts
jest.config.js
coverage/

# Development configs
.env
.env.*
!.env.example
```

**Don't**: Don't exclude the compiled CLI from dist/ - it can be useful.

**Verify**: `docker build -t test . --no-cache`

---

## Validation Strategy

### Automated Checks
- [ ] `npm run type-check` - Types valid for all new files
- [ ] `npm run lint` - No lint errors
- [ ] `npm run test` - Existing tests pass
- [ ] `npm run build` - Build succeeds including CLI

### New Tests to Write

| Test File | Test Case | What It Validates |
|-----------|-----------|-------------------|
| `src/cli/utils/config.test.ts` | `saveConfig saves JSON` | Config file creation |
| `src/cli/utils/config.test.ts` | `configToEnv generates valid env` | Env file format |
| `src/cli/utils/config.test.ts` | `loadConfig returns null for missing` | Graceful handling |
| `src/cli/commands/doctor.test.ts` | `reports missing config` | Error detection |

### Manual Validation

```bash
# 1. Build the CLI
npm run build

# 2. Test CLI entry point
node dist/cli/index.js help

# 3. Test init command (mock inputs with env vars)
node dist/cli/index.js init

# 4. Test doctor command
node dist/cli/index.js doctor

# 5. Test npm link
npm link
remote-agent help
remote-agent doctor
npm unlink

# 6. Test Docker build with new labels
docker build -t remote-coding-agent-test .
docker inspect remote-coding-agent-test | grep -A5 Labels

# 7. Validate config files
cat railway.json | jq .
cat render.yaml
cat fly.toml
```

### Edge Cases

- [ ] Init wizard with Ctrl+C (should exit cleanly)
- [ ] Init wizard with all fields empty (should warn, not crash)
- [ ] Doctor with no config file (should show clear error)
- [ ] Start with no config or .env (should show helpful error)
- [ ] Config file with restrictive permissions (should work)

### Regression Check

- [ ] Existing `npm run dev` still works
- [ ] Existing `docker compose --profile with-db up` still works
- [ ] Test adapter endpoints still work: `POST /test/message`
- [ ] Health endpoints still work: `GET /health`

## Risks

1. **npm package name availability** - `@dynamous/remote-coding-agent` may be taken. Check before publishing.

2. **Railway template ID** - Need to publish template to Railway to get the ID for the button URL.

3. **CI secrets** - Need to configure `NPM_TOKEN` secret in GitHub for npm publishing.

4. **prompts package compatibility** - May have issues in non-interactive environments. The CLI should detect and skip prompts.

5. **Cross-platform paths** - Config paths use `os.homedir()` which should work cross-platform, but test on Windows.
