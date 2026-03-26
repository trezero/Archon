# Quickstart: Zero to Running in 10 Minutes

New to Archon? This guide gets you from nothing to a working setup with the fewest possible steps. No Docker, no PostgreSQL, no external platforms required.

**What you'll have at the end:** Archon running locally with the Web UI, ready to chat with an AI coding assistant about any Git repository.

---

## Prerequisites

Before you start, make sure you have:

| Requirement                      | How to check       | How to install                                                                                                      |
| -------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Git**                          | `git --version`    | [git-scm.com](https://git-scm.com/)                                                                                 |
| **Bun** (replaces Node.js + npm) | `bun --version`    | Linux/macOS: `curl -fsSL https://bun.sh/install \| bash` — Windows: `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| **Claude Code CLI**              | `claude --version` | [docs.claude.com/claude-code/installation](https://docs.claude.com/en/docs/claude-code/installation)                |
| **GitHub account**               | —                  | [github.com](https://github.com/)                                                                                   |

> **Do not run as root.** Archon (and the Claude Code CLI it depends on) does not work when run as the `root` user. If you're on a VPS or server that only has root, create a regular user first:
>
> ```bash
> adduser archon          # create user (Debian/Ubuntu)
> usermod -aG sudo archon # give sudo access
> su - archon             # switch to the new user
> ```
>
> Then follow this guide from within that user's session.

> **Windows users:** Archon runs natively on Windows — no WSL2 required. Install [Git for Windows](https://git-scm.com/) (which includes Git Bash) and [Bun for Windows](https://bun.sh/docs/installation#windows). One caveat: DAG workflow `bash:` nodes need a bash executable — Git Bash provides this automatically. If you run into issues, see the [Windows notes](README.md#windows-wsl2-setup) in the main README.

> **Bun replaces Node.js** — you do not need Node.js or npm installed. Bun is the runtime, package manager, and test runner for this project. If you already have Node.js, that's fine, but Archon won't use it.

---

## Step 1: Clone and Install

First, pick where to put the Archon server code:

**Option A: Home directory** (personal use, single user)

Linux/macOS:

```bash
cd ~  # or your preferred directory
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
```

Windows (PowerShell):

```powershell
cd $HOME  # or your preferred directory
git clone https://github.com/dynamous-community/remote-coding-agent
cd remote-coding-agent
```

**Option B: /opt** (Linux/macOS server installs — keeps things tidy)

```bash
sudo mkdir -p /opt/archon
sudo chown $USER:$USER /opt/archon
git clone https://github.com/dynamous-community/remote-coding-agent /opt/archon
cd /opt/archon
```

Then install dependencies:

```bash
bun install
```

This installs all dependencies across the monorepo. Takes about 30 seconds.

---

## Step 2: Set Up Authentication

You need two things: a GitHub token (for cloning repos) and Claude authentication (for the AI assistant).

### GitHub Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **"Generate new token (classic)"**
3. Select scope: **`repo`**
4. Copy the token (starts with `ghp_...`)

### Claude Authentication

If you already use Claude Code, you're probably already authenticated. Check with:

```bash
claude --version
```

If not authenticated:

```bash
claude /login
```

Follow the browser flow to log in. This stores credentials globally — no API keys needed.

---

## Step 3: Create Your .env File

```bash
cp .env.example .env
```

Open `.env` in your editor and set these two values:

```env
# Paste your GitHub token in both (they serve different parts of the system)
GH_TOKEN=ghp_your_token_here
GITHUB_TOKEN=ghp_your_token_here

# Use your existing Claude Code login
CLAUDE_USE_GLOBAL_AUTH=true
```

That's it. Everything else has sensible defaults:

- **Database:** SQLite at `~/.archon/archon.db` (auto-created, zero setup)
- **Port:** 3090 for the API server, 5173 for the Web UI dev server
- **AI assistant:** Claude (default)

> **Why two GitHub token variables?** `GH_TOKEN` is used by the GitHub CLI (`gh`), and `GITHUB_TOKEN` is used by Archon's GitHub adapter. Set them to the same value.

---

## Step 4: Start the Server

```bash
bun run dev
```

This starts two things simultaneously:

- **Backend API server** on `http://localhost:3090`
- **Web UI** on `http://localhost:5173`

You should see output like:

```
[server] Hono server listening on port 3090
[web] VITE ready in Xms
[web] Local: http://localhost:5173/
```

> **Homelab / remote server?** The backend API already binds to `0.0.0.0` by default, so it's reachable from other machines. However, the Vite dev server (Web UI) only listens on `localhost`. To expose the Web UI on your network:
>
> ```bash
> bun run dev:web -- --host 0.0.0.0
> ```
>
> Then start the backend separately with `bun run dev:server`. The Web UI will be reachable at `http://<server-ip>:5173`. Make sure your firewall allows ports `5173` and `3090`.

---

## Step 5: Verify It Works

Open **http://localhost:5173** in your browser. You should see the Archon Web UI.

**Quick verification checklist:**

1. **Health check** — In a new terminal:

   ```bash
   curl http://localhost:3090/health
   # Expected: {"status":"ok"}
   ```

2. **Database check:**

   ```bash
   curl http://localhost:3090/health/db
   # Expected: {"status":"ok","database":"connected"}
   ```

3. **Send a test message** — In the Web UI, create a new conversation and type:
   ```
   /status
   ```
   You should see a status response showing the platform type and session info.

If all three work, you're up and running.

---

## Step 6: Clone a Repository and Start Coding

In the Web UI chat, clone a repo to work with:

```
/clone https://github.com/user/your-repo
```

Then just talk to the AI:

```
What's the structure of this repo?
```

The AI will analyze the codebase and respond. You can also use workflows:

```
/workflow list
```

This shows all available workflows. Try one:

```
Help me understand the authentication module
```

The AI router automatically picks the right workflow based on your message.

---

## What's Next?

You now have a working local setup with the Web UI. Here's where to go from here:

### Use the CLI (no server needed)

```bash
# Register the CLI globally
cd packages/cli && bun link && cd ../..
```

You'll see output like `Success! Registered "@archon/cli"` followed by a message about `bun link @archon/cli` — **ignore that second part**, it's for adding Archon as a dependency in another project.

Bun installs linked binaries to `~/.bun/bin/`. If the `archon` command isn't found, that directory is not in your `PATH` yet. Fix it:

```bash
# Add to your shell profile (~/.bashrc, ~/.zshrc, etc.)
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify it works:

```bash
archon version
```

Then run it from any git repo:

```bash
cd /path/to/your/repo
archon workflow list
archon workflow run archon-assist "What does this codebase do?"
```

> **The target directory must be a git repository.** Archon uses git worktrees for isolation, so it needs a `.git` folder. If your project isn't a git repo yet, run `git init && git add . && git commit -m "initial commit"` first.

### Add a chat platform (optional)

Want to message Archon from your phone? Pick one:

| Platform            | Difficulty      | Guide                                                                 |
| ------------------- | --------------- | --------------------------------------------------------------------- |
| **Telegram**        | Easy (5 min)    | [README: Telegram Setup](README.md#3-platform-adapter-setup-optional) |
| **Discord**         | Easy (5 min)    | [README: Discord Setup](README.md#3-platform-adapter-setup-optional)  |
| **Slack**           | Medium (15 min) | [docs/slack-setup.md](docs/slack-setup.md)                            |
| **GitHub Webhooks** | Medium (15 min) | [README: GitHub Setup](README.md#3-platform-adapter-setup-optional)   |

### Create custom commands and workflows

Add AI prompts to your repo that Archon can execute:

```
your-repo/
└── .archon/
    ├── commands/        # Markdown files with AI instructions
    └── workflows/       # YAML files chaining commands together
```

See [Authoring Workflows](docs/authoring-workflows.md) and [Authoring Commands](docs/authoring-commands.md).

### Deploy to a server

For always-on access from any device, see the [Cloud Deployment Guide](docs/cloud-deployment.md).

---

## Troubleshooting

### "Cannot create worktree: not in a git repository" (but the repo exists)

The real cause is usually a stale symlink from a previous Archon run with a different path. Look for this in the error output:

```
Source symlink at ~/.archon/workspaces/.../source already points to <old-path>, expected <new-path>
```

Fix it by manually deleting the stale workspace folder at `~/.archon/workspaces/<github-user>/<repo-name>` and retrying the command.

> In the future, `archon isolation cleanup` will handle this automatically.

---

### "command not found: bun"

Install Bun: `curl -fsSL https://bun.sh/install | bash`, then restart your terminal (or `source ~/.bashrc`).

### "command not found: claude"

Install Claude Code CLI: see [docs.claude.com/claude-code/installation](https://docs.claude.com/en/docs/claude-code/installation).

### Port 3090 already in use

Something else is using the port. Either stop it or override:

```bash
PORT=4000 bun run dev
```

### Web UI shows "disconnected"

Make sure the backend is running (`bun run dev` starts both). Check the terminal for errors. Try refreshing the browser.

### Clone command fails with 401/403

Your GitHub token is missing or invalid. Verify:

```bash
# Test your token
curl -H "Authorization: token $(grep GH_TOKEN .env | cut -d= -f2)" https://api.github.com/user
```

If it returns your GitHub profile, the token works. If not, regenerate it.

### AI doesn't respond

Check that Claude authentication is working:

```bash
claude --version   # Should show version
claude /login      # Re-authenticate if needed
```

### "Cannot find module" or dependency errors

```bash
bun install
```

If that doesn't fix it, delete the `node_modules` folder and reinstall:

```bash
bun install
```

---

## Quick Reference

| Action              | Command                             |
| ------------------- | ----------------------------------- |
| Start everything    | `bun run dev`                       |
| Start backend only  | `bun run dev:server`                |
| Start frontend only | `bun run dev:web`                   |
| Run tests           | `bun run test`                      |
| Type check          | `bun run type-check`                |
| Full validation     | `bun run validate`                  |
| Web UI              | http://localhost:5173               |
| API server          | http://localhost:3090               |
| Health check        | `curl http://localhost:3090/health` |

---

## Further Reading

- [README.md](README.md) — Full documentation (all platforms, Docker, advanced config)
- [docs/new-developer-guide.md](docs/new-developer-guide.md) — How Archon works (concepts and architecture)
- [docs/getting-started-cli.md](docs/getting-started-cli.md) — CLI-focused setup guide
- [docs/configuration.md](docs/configuration.md) — All configuration options
- [docs/authoring-workflows.md](docs/authoring-workflows.md) — Creating custom workflows
