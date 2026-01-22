# DX Quirks

Development experience notes and workarounds.

## Bun Log Elision

When running `bun dev` from the repo root, Bun's `--filter` truncates logs:

```
@archon/server dev $ bun --watch src/index.ts
│ [129 lines elided]
│ [Hono] Server listening on port 3090
└─ Running...
```

**To see full logs**, run directly from the server package:

```bash
cd packages/server && bun --watch src/index.ts
```

Or:

```bash
bun --cwd packages/server run dev
```

Note: The root `bun dev` uses `--filter` to fix hot reload path issues, but this comes with log condensing.
