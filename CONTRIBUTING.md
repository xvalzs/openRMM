# Contributing to OpenRMM

Thanks for helping out! OpenRMM is AGPL-3.0-or-later.

## Quick start

```bash
npm install
npm run build
# dev loop:
npm run dev            # tsc watch (server) + Vite (dashboard on :5173)
# server: RMM_ADMIN_PASSWORD=... npm run start:server
```

Requires Node.js >= 24.

## Repository layout

```
packages/
  shared/     wire protocol + shared types (single source of truth)
  server/     Fastify server (REST + WebSocket + SQLite)
  agent/      endpoint agent (Windows, macOS, Linux-compatible)
  dashboard/  React + Vite web UI
deploy/       Docker + Cloudflare Tunnel hosting assets
```

## Conventions

- TypeScript strict mode everywhere; shared types go in `packages/shared`.
- Agent/server protocol changes must bump `PROTOCOL_VERSION` if breaking.
- Everything ships with an end-to-end check (the project has historically
  been verified against a live server + agent on a real machine).
- Keep dependencies AGPL-compatible and minimal — the agent still aims to
  run as a single bundled file.

## Pull requests

- Small, focused PRs with a clear description.
- No signed-off-by ceremony; the CLA is "you license your patch AGPL-3.0+".
- New user-facing features should update the README.
