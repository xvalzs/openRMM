# OpenRMM

<p align="center">
  <img src="https://raw.githubusercontent.com/xvalzs/openRMM/main/packages/dashboard/public/logo.svg" width="96" alt="OpenRMM logo" />
</p>

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
- **Remote shell**: interactive PowerShell (Windows) / bash (macOS) sessions from the dashboard, streamed over the agent's WebSocket channel (xterm.js terminal)
- **Job dispatch**: run a script on many devices at once (or a selection), with per-device results, streaming output, timeouts, and cancellation
- **Alert rules**: threshold rules on CPU/memory/disk per device or fleet-wide, with a minimum-duration window, active → resolved lifecycle, and webhooks on state transitions
- **Multi-user permissions**: admin and operator roles. Operators monitor, manage alerts, and run jobs; shells, user management, and webhook settings are admin-only
- **Update management**: devices report OS pending-update counts (Windows Update COM / `softwareupdate`); admins deploy new agent bundles (URL + SHA-256) that self-verify, self-replace, and restart in place
- **Installer builder**: build pre-configured, renamable agent installers from the admin panel — a single Windows .exe (config baked into the binary) or a macOS/Linux zip — with per-campaign deployment tracking and optional code signing
- **File transfer**: push files to any device or pull them back, with per-transfer progress and SHA-256-safe streaming over the agent channel
- **Process manager**: list a device's processes and kill them from the dashboard
- **Real terminal shells**: ConPTY-backed PowerShell (Windows) with ANSI colors, Ctrl+C, and resize; pipe fallback where PTY is unavailable
- **Remote desktop**: view the remote screen live (GDI capture on Windows, `screencapture` on macOS) with mouse and keyboard control
- **API keys**: per-user Bearer tokens for scripting, inheriting the user's role, revocable at any time
- **Audit log**: every security-relevant action (logins, user/rule/job/key changes, shells, updates) is recorded with user, target, and IP
- **Native service installation**: `service install` registers the agent as a Windows service (WinSW, auto-restart on failure) or a macOS LaunchAgent (KeepAlive)
- TLS support via `RMM_TLS_CERT` / `RMM_TLS_KEY` (or any reverse proxy)

### Roadmap

Higher-fidelity remote desktop (hardware capture, better frame rate),
OS patch installation (deploying the updates, not just counting them),
Linux agent builds, SSO/OIDC.

## Requirements

- **Server & agent:** Node.js ≥ 24 (uses built-in `node:sqlite`, `fetch`, `WebSocket`)
- **Dashboard dev:** the same Node.js; browsers with ES2020+

## Quick start

**Docker (fastest — no Node.js needed):**

```bash
docker run -d --name openrmm \
  -p 8787:8787 \
  -v openrmm-data:/app/data \
  -e RMM_ADMIN_PASSWORD='pick-a-strong-password' \
  ghcr.io/xvalzs/openrmm:latest
# dashboard: http://localhost:8787 (admin / your password)
# the boot log prints the install key for agent deployment
```

The image is published automatically by CI on every push to `main`.
Build it yourself with `docker compose up -d --build` if you prefer.

**From source:**

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

## Packaging the agent

Build a distributable agent package — a zip with a single bundled JS file
(no `node_modules` on the target; endpoints only need Node.js ≥ 24):

```bash
npm run package:agent
# → packages/agent/release/openrmm-agent-v<version>.zip
```

Inside the zip: `openrmm-agent.js` (self-contained bundle), `openrmm-agent.cmd`
and `openrmm-agent` launchers for Windows and macOS/Linux, a README, and the
license. On the endpoint:

```bash
openrmm-agent.cmd install --server https://your-server --key <install-key>
openrmm-agent.cmd run
```

## Hosting (Cloudflare / Docker / VPS)

OpenRMM is a self-hosted Node.js server — it cannot run on Cloudflare
Workers/Pages (stateful WebSockets, SQLite, and a build toolchain). The
supported hosting patterns are:

**A. Cloudflare Tunnel (recommended for home/office deployments)**

Run the server anywhere — this machine, a NAS, a homelab box — and expose
it through Cloudflare's edge with your own domain, automatic HTTPS/WSS, and
DDoS protection, with no inbound ports open. Full walkthrough in
[`deploy/cloudflared/README.md`](deploy/cloudflared/README.md):

```bash
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create openrmm
# fill in deploy/cloudflared/config.yml
cloudflared tunnel run openrmm
```

Then start the server with `RMM_PUBLIC_URL=https://rmm.example.com` so
agents and installer builds use the public hostname.

**B. Docker (recommended for a VPS — or a prebuilt image)**

```bash
# published image (CI builds it from main):
docker run -d --name openrmm -p 8787:8787 -v openrmm-data:/app/data \
  -e RMM_ADMIN_PASSWORD=... ghcr.io/xvalzs/openrmm:latest

# or build from source:
docker compose up -d --build
# data lives in ./data (SQLite + uploads + installers)
```

Also deployable on PaaS hosts that accept a root Dockerfile (e.g.
**Railway**: connect the repo, then attach a Railway Volume mounted at
`/app/data` so the database survives redeploys). Set the environment
variables in the service settings: `RMM_ADMIN_PASSWORD`,
`RMM_SESSION_SECRET` (any long random string), and `RMM_PUBLIC_URL`
(your `*.up.railway.app` domain, e.g.
`https://openrmm-production.up.railway.app`). The server listens on
Railway's `PORT` automatically, and the generated install key appears
in the deploy logs.

Put Cloudflare's proxy in front of the VPS (orange-cloud the DNS record)
or run a Tunnel to the container — either way the dashboard, agent
WebSockets, file transfers, and shells all work through it.

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
| `RMM_PUBLIC_URL`       | *(derived)* | Public URL agents connect to; baked into installer builds |
| `RMM_SIGNING_PFX`      | —           | PFX certificate used to sign built Windows installers (via `signtool`, or PowerShell's `Set-AuthenticodeSignature` if the SDK isn't installed) |
| `RMM_SIGNING_PFX_PASSWORD` | —       | Password for the signing certificate                      |
| `RMM_AGENT_SRC`        | *(repo path)* | Agent entry point for installer builds                  |
| `RMM_LOG_LEVEL`        | `info`       | Fastify log level                                         |

Agent settings:

| Variable             | Description                                            |
| -------------------- | ------------------------------------------------------ |
| `RMM_AGENT_HOME`     | Config directory (default `~/.openrmm-agent`)          |
| `RMM_SERVER_URL`     | Fallback for `--server` on install                     |
| `RMM_INSTALL_KEY`    | Fallback for `--key` on install                        |

## Remote shell

Select an online device in the dashboard and press **Open shell**. The
session runs over the agent's existing WebSocket channel:

- Windows: PowerShell; macOS/Linux: bash (piped, not a full TTY — line-based
  programs and simple REPLs work, full-screen TUIs like editors do not)
- output is streamed to the browser terminal (xterm.js) with ANSI colors
- closing the terminal ends the shell on the endpoint

## Alert rules

Create rules on the **Alerts** page: a metric (CPU %, memory %, disk %),
comparison, threshold, and a minimum duration the condition must hold.
Rules can target one device or the whole fleet and are evaluated on every
heartbeat. Firing produces an *active* alert; when the condition clears it
moves to *resolved*. Both transitions POST to the configured webhook as

```json
{ "event": "alert.fired", "alert": { ... } }
{ "event": "alert.resolved", "alert": { ... } }
```

## Job dispatch

On the **Jobs** page, create a job with a script and a target: every online
device or a hand-picked selection. Each agent runs it with its platform
shell (PowerShell on Windows, bash on macOS/Linux) and streams stdout/stderr
back to the job detail. Jobs have per-device statuses (success, failed,
timeout, skipped, cancelled), a configurable timeout that kills runaway
scripts, and can be cancelled while running. Output is capped per stream to
keep the database small.

## Users & roles

The **Users** page (admins only) manages accounts. Roles:

| Role       | Devices | Alerts | Jobs | Shells | Users | Webhook settings |
| ---------- | ------- | ------ | ---- | ------ | ----- | ---------------- |
| admin      | ✅      | ✅     | ✅   | ✅     | ✅    | ✅               |
| operator   | ✅      | ✅     | ✅   | ❌     | ❌    | ❌               |

The user seeded on first boot is always an admin, and the server refuses to
delete or demote the last admin.

## Update management

The **Updates** page lists every device's OS version, agent version, and
pending OS updates. Agents check Windows Update (via COM, no admin needed)
or `softwareupdate -l` at most once per six hours; first results can take
up to ~90 s to appear.

Admins can deploy a new **agent bundle**: build it with
`npm run package:agent`, host the `openrmm-agent.js` somewhere reachable by
the endpoints, and provide its SHA-256 (`certutil -hashfile openrmm-agent.js SHA256`).
Each targeted agent downloads it, verifies the digest, atomically replaces
itself, and restarts — service-managed agents restart via the service
manager, foreground agents respawn themselves. Progress and history are
tracked per device on the Updates page.

## API keys

Every user can mint personal keys on the **API Keys** page. A key is shown
once and carries the same role as its owner:

```bash
curl -H "Authorization: Bearer $OPENRMM_KEY" https://your-server/api/devices
```

Revoking a key invalidates it immediately.

## File transfer

The **Files** page (admins) pushes files to devices and pulls them back.
Uploads stream to the agent over its WebSocket (chunked, paced); downloads
stream back with per-chunk acknowledgements and land in the server's data
directory for the browser to save. Both directions are verified
end-to-end by size and are recorded in the audit log.

## Process manager

Open a device's detail pane (admins) to list its processes and kill them.
Lists are cached per device and refreshed on demand.

## Remote desktop

**View screen** on an online device opens a live view of the remote desktop
with mouse control (click, drag, right-click, scroll) and keyboard input.
The agent captures frames with GDI (Windows, virtual screen, scaled) or
`screencapture` (macOS) and streams JPEGs over its WebSocket; input is
injected via user32 on Windows (macOS input is not supported yet).

Requirements and limits:

- the agent must run in the **interactive user session** — a LocalSystem
  service sits in session 0 and cannot see the desktop (the agent detects
  a black screen and explains this); run the agent in the foreground or
  configure the service to run as the logged-in user
- ~1–2 fps with GDI capture, ~150 KB/frame at 75% scale — fine for
  clicking through settings, not for watching video
- the UAC secure desktop cannot be captured or controlled (by design)

## Installer builder

The **Installers** page (admins) generates pre-configured, deployable agents
— ScreenConnect-style. Pick a name and a target; the server builds:

- **Windows** — a single self-contained `.exe` (Node SEA) with the server
  URL, install key, and a deployment id baked *inside* the binary. The file
  name is meaningless to the payload, so you can rename it freely (e.g.
  `IT-Support-Session.exe`) without breaking anything; an Authenticode
  signature also hashes content, not names, so renames stay valid.
  Devices report their deployment id, so you can tell which campaign a
  machine came from.
- **macOS / Linux** — a zip with the bundled agent, launcher, and node-pty.

```bash
npm run build   # once, so the server can find the agent source
```

**Code signing and Windows security.** An exe is only as trustworthy as its
signature. Without one, Windows SmartScreen / Smart App Control will warn
about — or outright block — the file on user machines (this is exactly why
commercial RMMs ship signed installers). To sign the built exe, give the
server a certificate (Windows SDK's `signtool` must be on PATH):

```bash
RMM_SIGNING_PFX=/path/to/cert.pfx RMM_SIGNING_PFX_PASSWORD=... npm run start:server
```

The zip builds and distribution through your own channels (your RMM itself,
file share, USB) avoid the download-time warnings without signing. Installer
builds are recorded in the audit log with their SHA-256.

## Audit log

Admins can review the **Audit** page: logins (success and failure), user
management, alert rule changes, job dispatch/cancellation, shell sessions,
agent update deployments, API key creation/revocation, and webhook changes —
each with the acting user, target, IP, and timestamp.

## Running agents as services

The agent can install itself as a native service (no external tools needed):

```bash
# Windows — run from an elevated PowerShell; registers a real SCM service
# that auto-restarts on failure (requires .NET Framework 4.6.1+, built into
# Windows 10/11).
openrmm-agent service install
openrmm-agent service status
openrmm-agent service stop
openrmm-agent service uninstall

# macOS — installs a user LaunchAgent with KeepAlive.
openrmm-agent service install
openrmm-agent service status
openrmm-agent service uninstall
```

The service runs the agent from its config directory (`~/.openrmm-agent` by
default, `RMM_AGENT_HOME` to override) and preserves the device identity.
On Windows the service runs as LocalSystem; `service install` must be run
from an Administrator terminal.

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
    vendor/winsw/  WinSW 2.12.0 (MIT) Windows service wrapper
  dashboard/  React + Vite web UI
```

## Contributing

Issues and pull requests welcome. All code is AGPL-3.0-or-later; keep
dependencies compatible with that license.
