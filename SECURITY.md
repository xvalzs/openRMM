# Security Policy

## Reporting a vulnerability

OpenRMM handles remote access to endpoints — security issues are treated
seriously. **Please do not open a public issue for vulnerabilities.**

Report privately via GitHub's [private vulnerability reporting](https://github.com/xvalzs/openRMM/security/advisories/new)
or email the maintainers. You will get a response within 72 hours and a
coordinated disclosure timeline.

## Security model

- Agents authenticate to the server with a shared install key; each device
  then gets a unique token for its WebSocket channel.
- The dashboard uses scrypt-hashed passwords, HMAC-signed session cookies,
  and admin/operator roles. API keys are SHA-256-hashed at rest.
- The agent runs with the privileges of the account it is installed as
  (LocalSystem when installed as a Windows service) — treat agents as
  fully trusted software on the endpoints they manage.
- Always terminate TLS at Cloudflare / a reverse proxy, or enable
  `RMM_TLS_CERT` / `RMM_TLS_KEY`. Unencrypted installs expose keys,
  tokens, and remote-control channels.

## Supported versions

Only the latest release receives security fixes. Pull requests welcome —
the project is AGPL-3.0-or-later.
