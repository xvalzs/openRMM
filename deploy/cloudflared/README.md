# Cloudflare Tunnel for OpenRMM

Expose your self-hosted OpenRMM server through Cloudflare's edge — your
domain, automatic TLS (HTTPS + WSS), DDoS protection — without opening any
inbound ports.

## 1. Point a domain at Cloudflare

In the Cloudflare dashboard, add your domain (e.g. `example.com`) and create
a DNS-less hostname for the RMM, e.g. `rmm.example.com`. No DNS record is
needed for a named tunnel — the `ingress` rule binds the hostname.

## 2. Install cloudflared

```bash
# Windows (winget)
winget install Cloudflare.cloudflared

# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared
```

## 3. Create the tunnel

```bash
cloudflared tunnel login        # opens a browser; approve the cert
cloudflared tunnel create openrmm
# → prints the tunnel UUID and writes credentials to
#   ~/.cloudflared/<UUID>.json

cloudflared tunnel route dns openrmm rmm.example.com
# (optional when using the ingress rule below, but makes hostnames explicit)
```

## 4. Configure

Copy `config.yml` next to the credentials file, replacing:

- `<TUNNEL-UUID>` with your tunnel id
- the `credentials-file` path (Windows: `C:\Users\<you>\.cloudflared\<TUNNEL-UUID>.json`)
- `rmm.example.com` with your hostname

## 5. Run the tunnel

```bash
cloudflared tunnel run openrmm          # foreground
# or install as a service:
cloudflared service install             # Windows (as admin)
sudo cloudflared service install        # macOS / Linux (systemd)
```

## 6. Point OpenRMM at the public hostname

Start the server with the public URL so installer builds and agent
heartbeats use the Cloudflare hostname:

```bash
RMM_PUBLIC_URL=https://rmm.example.com npm run start:server
```

Agents then connect to `https://rmm.example.com` over WSS — through
Cloudflare — to the server on your machine or VPS.

## Notes

- Cloudflare Tunnel proxies WebSockets out of the box; the dashboard's
  shell/screen channels work without extra configuration.
- The 100 MB default upload limit is plenty for OpenRMM file transfers;
  raise it in Cloudflare if you routinely push larger files.
- Keep the tunnel credentials secret — they are equivalent to a server key.
