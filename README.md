# OpenRMM

Open-source Remote Monitoring and Management (RMM). A lightweight agent runs on
each endpoint, reports to a self-hosted central server over a persistent
WebSocket channel, and you watch everything from a web dashboard.

**License:** [AGPL-3.0-or-later](LICENSE) · **Status:** early development (MVP)

## Architecture

```
┌──────────────┐   HTTPS+WSS    ┌────────────────┐   HTTPS    ┌─────────────┐
│   Agent      │ ◄────────────► │  Server        │ ◄────────► │  Dashboard  │
│  (Node.js)   │  register +    │  (Fastify +    │  REST API  │  (React +   │
│  Windows /   │  heartbeat     │   node:sqlite) │            │   Vite)     │
│  macOS       │  every 15s     │                │            │             │
└──────────────┘                └────────────────┘            └─────────────┘
```

| Component  | Package                     | Role                                                            |
| ---------- | --------------------------- | --------------------------------------------------------------- |
| Agent      | `packages/agent`            | Installed on endpoints. Registers with an install key, then holds a WebSocket and sends heartbeats with CPU/memory/disk metrics. |
| Server     | `packages/server`           | Fastify HTTP + WebSocket server. SQLite storage via the built-in `node:sqlite` (zero native deps). Dashboard auth, device API, offline detection. |
| Dashboard  | `packages/dashboard`        | React + Vite web UI. Device list with live resource bars and a detail pane. Polls the REST API. |
| Shared     | `packages/shared`           | TypeScript types for the wire protocol, shared by all three.     |

## Features (MVP)

- Agent registration secured by a shared **install key**; per-device tokens for the WebSocket
- Device inventory: hostname, OS, CPU, RAM, drives, agent version, IP
- Live metrics via heartbeat every 15 s; devices flip to *offline* after 45 s of silence
- Dashboard with sign-in (scrypt-hashed passwords, HMAC-signed session cookies), device list, resource usage bars, detail pane
- Reconnection with exponential backoff, watchdog, and re-registration on every connect
- TLS support via `RMM_TLS_CERT` / `RMM_TLS_KEY` (or any reverse proxy)

### Roadmap

Remote shell, command/job dispatch, alert rules + webhooks, service
installation (Windows service / launchd), Linux agent builds, multi-user
permissions, patch/update management.

## Requirements

- **Server & agent:** Node.js ≥ 24 (uses built-in `node:sqlite`, `fetch`, `WebSocket`)
- **Dashboard dev:** the same Node.js; browsers with ES2020+

## Quick start

```bash
# 1. Install and build everything
npm install
npm run build

# 2. Start the server (first boot seeds the admin user and an install key)
RMM_ADMIN_PASSWORD='pick-a-strong-password' npm run start:server
#   → prints the generated install key; keep it secret
#   → dashboard: http://localhost:8787 (admin / your password)

# 3. Install the agent on an endpoint (Windows or macOS)
node packages/agent/dist/index.js install \
  --server http://your-server:8787 --key <install-key>
node packages/agent/dist/index.js run

# 4. Open the dashboard and watch the device appear
```

The server serves the built dashboard automatically. For development, run the
server and the Vite dev server separately:

```bash
npm run dev            # starts `dev:server` (tsc watch) and `dev:dashboard` (Vite on :5173)
```

Vite proxies `/api` and `/ws` to `http://localhost:8787`.

## Configuration

All server settings are environment variables:

| Variable               | Default      | Description                                              |
| ---------------------- | ------------ | -------------------------------------------------------- |
| `RMM_PORT`             | `8787`       | HTTP/HTTPS listen port                                    |
| `RMM_HOST`             | `0.0.0.0`    | Listen address                                            |
| `RMM_DATA_DIR`         | `./data`     | SQLite database location (`rmm.db`)                       |
| `RMM_INSTALL_KEY`      | *(generated)*| Shared secret authorizing agent registration              |
| `RMM_ADMIN_USERNAME`   | `admin`      | Dashboard username seeded on first boot                   |
| `RMM_ADMIN_PASSWORD`   | `changeme`   | Dashboard password seeded on first boot (change it!)      |
| `RMM_SESSION_SECRET`   | *(generated)*| HMAC key for session cookies; set it to persist sessions across restarts |
| `RMM_TLS_CERT` / `RMM_TLS_KEY` | —     | Paths to a certificate/key to serve HTTPS/WSS             |
| `RMM_LOG_LEVEL`        | `info`       | Fastify log level                                         |

Agent settings:

| Variable             | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `RMM_AGENT_HOME`     | Config directory (default `~/.openrmm-agent`)          |
| `RMM_SERVER_URL`     | Fallback for `--server` on install                     |
| `RMM_INSTALL_KEY`    | Fallback for `--key` on install                        |

## Running agents as services

The MVP runs agents in the foreground. To keep them running after logout:

- **Windows:** wrap `node .../dist/index.js run` with [NSSM](https://nssm.cc/) or Task Scheduler.
- **macOS:** create a LaunchAgent plist calling the same command.

Native service installation is on the roadmap.

## Security notes

- Use TLS in production (`RMM_TLS_CERT`/`RMM_TLS_KEY` or a reverse proxy). Without it, install keys, agent tokens, metrics, and dashboard credentials travel in plaintext.
- Rotate the install key (`RMM_INSTALL_KEY`) to revoke the ability to add devices.
- Change the admin password before exposing the server to anything but localhost.
- The agent is trusted on the endpoint it runs on; treat the WebSocket channel as authenticated, not the metrics as tamper-proof.

## Repository layout

```
packages/
  shared/     wire protocol + shared types
  server/     Fastify server (REST + WebSocket + SQLite)
  agent/      endpoint agent (Windows, macOS)
  dashboard/  React + Vite web UI
```

## Contributing

Issues and pull requests welcome. All code is AGPL-3.0-or-later; keep
dependencies compatible with that license.
