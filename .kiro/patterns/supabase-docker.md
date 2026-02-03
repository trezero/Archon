# Supabase Docker Connection Pattern

## Standard Configuration
```yaml
# Use host.docker.internal:8001 instead of supabase-kong
SUPABASE_URL: http://host.docker.internal:8001
```

## Validation Check
```bash
curl -f http://host.docker.internal:8001/health || echo "Supabase not accessible"
```