FROM oven/bun:1-slim

# OCI Labels for GHCR
LABEL org.opencontainers.image.source="https://github.com/dynamous-community/remote-coding-agent"
LABEL org.opencontainers.image.description="Control AI coding assistants remotely from Telegram, Slack, Discord, and GitHub"
LABEL org.opencontainers.image.licenses="MIT"

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    bash \
    ca-certificates \
    gnupg \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for running Claude Code
# Claude Code refuses to run with --dangerously-skip-permissions as root for security
RUN useradd -m -u 1001 -s /bin/bash appuser \
    && chown -R appuser:appuser /app

# Create Archon directories
RUN mkdir -p /.archon/workspaces /.archon/worktrees \
    && chown -R appuser:appuser /.archon

# Copy package files and lockfile
COPY package.json bun.lock ./

# Install ALL dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy application code
COPY . .

# Build TypeScript with Bun
RUN bun build src/index.ts --outdir=dist --target=bun

# Remove devDependencies to reduce image size
RUN bun install --production --frozen-lockfile

# Fix permissions for appuser
RUN chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Create .codex directory for Codex authentication
RUN mkdir -p /home/appuser/.codex

# Configure git to trust Archon directories
# This prevents "fatal: detected dubious ownership" errors when git operations
# are performed in mounted volumes or repos cloned by different users
RUN git config --global --add safe.directory '/.archon/workspaces' && \
    git config --global --add safe.directory '/.archon/workspaces/*' && \
    git config --global --add safe.directory '/.archon/worktrees' && \
    git config --global --add safe.directory '/.archon/worktrees/*'

# Expose port
EXPOSE 3000

# Setup Codex authentication from environment variables, then start app
CMD ["sh", "-c", "bun run setup-auth && bun run start"]
