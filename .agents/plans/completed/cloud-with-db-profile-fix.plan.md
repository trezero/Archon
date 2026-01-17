# Plan: Fix Cloud Deployment for with-db Profile

## Summary

The `docker-compose.cloud.yml` overlay file only supports the `external-db` profile (which uses the `app` service). Users who run with the `with-db` profile (using `app-with-db` service with local PostgreSQL) cannot use cloud deployment because:
1. The Caddy service depends on `app` which doesn't exist in `with-db` profile
2. No network overrides exist for `app-with-db` or `postgres`
3. The `Caddyfile.example` uses `app:3000` which is wrong for `with-db` profile

This fix adds profile-aware Caddy services and updates documentation.

## External Research

### Docker Compose Profiles
- Docker Compose profiles allow selective service activation
- Services with different profiles are mutually exclusive
- Override files merge with base file, but profile filtering happens after merge

### Gotchas Found
- Cannot have single Caddy service depend on both `app` and `app-with-db` - must create separate Caddy services per profile
- The `reverse_proxy` target in Caddyfile must match the actual service name running

## Patterns to Mirror

### From: `docker-compose.yml:24-45`
```yaml
  app-with-db:
    profiles: ["with-db"]
    build: .
    env_file: .env
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/remote_coding_agent
      ARCHON_DOCKER: "true"
    ports:
      - "${PORT:-3000}:${PORT:-3000}"
    volumes:
      - archon_data:/.archon
    depends_on:
      postgres:
        condition: service_healthy
```

### From: `docker-compose.cloud.yml:6-23` (original `caddy` service)
```yaml
  caddy:
    image: caddy:2-alpine
    container_name: remote-agent-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"  # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - remote-agent-network
    depends_on:
      - app
```

## Files to Change

| File | Action | Justification |
|------|--------|---------------|
| `docker-compose.cloud.yml` | UPDATE | Add `with-db` profile support with `caddy-with-db` service, `app-with-db` and `postgres` network overrides |
| `Caddyfile.example` | UPDATE | Add note about service name difference for `with-db` profile |
| `docs/cloud-deployment.md` | UPDATE | Update Caddyfile section to mention service name for `with-db` |

## NOT Building

- ❌ Separate Caddyfile.with-db.example - would add complexity, just document the difference
- ❌ Automatic service name detection - Caddy doesn't support this, user must configure
- ❌ Single unified Caddy service - impossible with Docker Compose profiles

## Tasks

### Task 1: UPDATE docker-compose.cloud.yml

**Why**: Add profile-aware services so cloud deployment works with both `external-db` and `with-db` profiles.

**Mirror**: Existing `caddy` service structure

**Do**:

1. Add profile to existing `caddy` service:
```yaml
  caddy:
    image: caddy:2-alpine
    profiles: ["external-db"]  # <-- ADD THIS
    container_name: remote-agent-caddy
    # ... rest unchanged
```

2. Add new `caddy-with-db` service after `caddy`:
```yaml
  # Caddy for with-db profile
  caddy-with-db:
    image: caddy:2-alpine
    profiles: ["with-db"]
    container_name: remote-agent-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"  # HTTP/3
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - remote-agent-network
    depends_on:
      - app-with-db
```

3. Add `app-with-db` override after existing `app` override:
```yaml
  # Override for with-db profile
  app-with-db:
    ports: []
    expose:
      - "3000"
    networks:
      - remote-agent-network
```

4. Add `postgres` network override:
```yaml
  # Add postgres to network for with-db profile
  postgres:
    networks:
      - remote-agent-network
```

5. Update header comment:
```yaml
# Cloud deployment configuration with Caddy reverse proxy
# Usage with external-db: docker compose --profile external-db -f docker-compose.yml -f docker-compose.cloud.yml up -d
# Usage with with-db:     docker compose --profile with-db -f docker-compose.yml -f docker-compose.cloud.yml up -d
```

**Don't**:
- Don't remove the existing `caddy` and `app` services - they're needed for `external-db` profile

**Verify**:
```bash
# Syntax check
docker compose -f docker-compose.yml -f docker-compose.cloud.yml config --profiles with-db
docker compose -f docker-compose.yml -f docker-compose.cloud.yml config --profiles external-db
```

### Task 2: UPDATE Caddyfile.example

**Why**: Users with `with-db` profile need to know the correct service name.

**Mirror**: Existing comment style in file

**Do**:

Add note after the main example block (around line 19):

```
# IMPORTANT: Service name depends on your profile:
# - external-db profile: use "app:3000"
# - with-db profile: use "app-with-db:3000"
```

**Verify**: Read file to confirm change

### Task 3: UPDATE docs/cloud-deployment.md

**Why**: Section 6 "Caddy Configuration" tells users to use `app:3000` but this is wrong for `with-db` profile.

**Mirror**: Existing documentation style

**Do**:

In Section 6.1 "Create Caddyfile", update the example to include a note:

Change from:
```
remote-agent.yourdomain.com {
    reverse_proxy app:3000
}
```

To:
```
remote-agent.yourdomain.com {
    reverse_proxy app:3000
}
```

Add after the code block:
```
> **Note:** If using `with-db` profile, change `app:3000` to `app-with-db:3000`
```

**Verify**: Read file to confirm change

## Validation Strategy

### Automated Checks
- [ ] `docker compose -f docker-compose.yml -f docker-compose.cloud.yml config --profiles with-db` - Valid YAML
- [ ] `docker compose -f docker-compose.yml -f docker-compose.cloud.yml config --profiles external-db` - Valid YAML
- [ ] `bun run type-check` - Types valid (no TS changes, but good to verify)
- [ ] `bun run lint` - No lint errors

### Manual Validation

**Test with-db profile:**
```bash
# Create test Caddyfile
cat > Caddyfile << 'EOF'
:80 {
    reverse_proxy app-with-db:3000
}
EOF

# Start services
docker compose --profile with-db -f docker-compose.yml -f docker-compose.cloud.yml up -d

# Verify containers running
docker ps | grep -E "(caddy|app-with-db|postgres)"

# Test internal connectivity
docker exec remote-agent-caddy wget -q -O - http://app-with-db:3000/health

# Cleanup
docker compose --profile with-db -f docker-compose.yml -f docker-compose.cloud.yml down
```

**Test external-db profile (regression):**
```bash
# Create test Caddyfile
cat > Caddyfile << 'EOF'
:80 {
    reverse_proxy app:3000
}
EOF

# Verify config is valid
docker compose --profile external-db -f docker-compose.yml -f docker-compose.cloud.yml config
```

### Edge Cases
- [ ] Both profiles have exactly one Caddy container (same container_name prevents duplicates)
- [ ] Postgres is on network for with-db profile (app-with-db can reach it)
- [ ] Volumes are shared between Caddy services (caddy_data, caddy_config)

### Regression Check
- [ ] `external-db` profile still works (check config validation)
- [ ] Existing health endpoints still work after restart

## Risks

1. **Container name collision**: Both Caddy services use same `container_name: remote-agent-caddy` - this is intentional to prevent both running simultaneously, but could confuse users
2. **User forgets to update Caddyfile**: Documentation update should help, but users might copy example without reading note
