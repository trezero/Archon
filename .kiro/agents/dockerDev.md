# dockerDev Agent

## Purpose
Handle Docker container management, networking diagnostics, and volume operations for Archon development.

## Key Functions
- Docker-compose service management
- Network connectivity troubleshooting (host.docker.internal patterns)
- Named volume operations with archon prefix
- Container health monitoring

## Usage Patterns
- `docker-compose up -d` with service validation
- Network diagnostics for Supabase connections
- Volume cleanup and management