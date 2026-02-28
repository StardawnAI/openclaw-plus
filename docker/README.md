# OpenClaw Docker — Cloudflare Tunnel Ready 🚀

Docker-Setup für OpenClaw mit **nativem Cloudflare Tunnel Support**.

Basiert auf dem [coollabsio/openclaw](https://github.com/coollabsio/openclaw) Docker-Fork, behebt aber das Auth-Problem hinter Cloudflare Tunnels.

## Das Problem

Wenn OpenClaw hinter einem Cloudflare Tunnel läuft, leitet nginx die Proxy-Headers (`X-Real-IP`, `X-Forwarded-For`, etc.) an den Gateway weiter. Der Gateway klassifiziert die Verbindung als "remote" und lehnt den Bearer Token ab:

```
disconnected (1008): unauthorized: gateway token missing
```

## Die Lösung

Eine einzige Env-Variable: **`OPENCLAW_STRIP_PROXY_HEADERS=true`**

Das bewirkt:
- Nginx setzt `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto` auf `""`
- `Host` wird auf `localhost:18789` gesetzt
- `openclaw.json` bekommt automatisch `trustedProxies: ["127.0.0.1"]` und `dangerouslyDisableDeviceAuth: true`

→ Gateway sieht die nginx-Verbindung als loopback → Token wird akzeptiert ✅

---

## Quick Start

### 1. Env-Datei erstellen

```bash
cp .env.example .env
```

Mindestens setzen:
```env
# Gateway Token (pflicht!)
OPENCLAW_GATEWAY_TOKEN=dein-token-hier   # openssl rand -hex 32

# Mindestens ein AI Provider
ANTHROPIC_API_KEY=sk-ant-...
# oder: OPENAI_API_KEY=sk-...
# oder: OPENCODE_API_KEY=...

# Cloudflare Tunnel Fix (Standard: true)
OPENCLAW_STRIP_PROXY_HEADERS=true

# Deine Public Domain (für CORS)
OPENCLAW_ALLOWED_ORIGINS=https://claw.example.com
```

### 2. Image bauen & starten

```bash
docker compose up -d --build
```

### 3. Ersten Login machen

Beim **ersten Aufruf** den Token als URL-Parameter mitgeben:

```
https://claw.example.com/?token=DEIN-GATEWAY-TOKEN
```

Das setzt den Token im Browser LocalStorage. Danach funktioniert die URL normal ohne Token.

---

## Coolify Deployment

### Docker Compose in Coolify

1. **Neues Projekt** → **Docker Compose**
2. Repository URL zeigt auf dieses Repo (oder kopiere die Dateien)
3. **Build Pack**: Docker Compose
4. **Docker Compose Location**: `docker/docker-compose.yml`

### Env-Variablen in Coolify setzen

In Coolify UI → Service → Environment:

| Variable | Wert | Pflicht |
|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | `openssl rand -hex 32` | ✅ |
| `ANTHROPIC_API_KEY` | `sk-ant-...` | ✅ (oder anderer Provider) |
| `OPENCLAW_STRIP_PROXY_HEADERS` | `true` | ✅ (für CF Tunnel) |
| `OPENCLAW_ALLOWED_ORIGINS` | `https://your-domain.com` | ✅ (für CF Tunnel) |
| `AUTH_PASSWORD` | dein Passwort | Empfohlen |
| `AUTH_USERNAME` | `admin` | Optional |

### Cloudflare Tunnel einrichten

1. **Cloudflare Dashboard** → Zero Trust → Access → Tunnels
2. Neuen Tunnel erstellen
3. Public Hostname hinzufügen:
   - **Domain**: `claw.example.com`
   - **Service**: `http://openclaw:8080` (oder die interne IP/Port von Coolify)

---

## Architektur

```
Internet
    │
    ▼
Cloudflare Tunnel
    │
    ▼
┌──────────────────────────────┐
│  Docker Container            │
│                              │
│  nginx (:8080)               │
│    │  Bearer Token inject    │
│    │  Headers stripped (CF)   │
│    ▼                         │
│  OpenClaw Gateway (:18789)   │
│    ↔ loopback (127.0.0.1)    │
│                              │
│  Browser Sidecar (:9222)     │
└──────────────────────────────┘
```

nginx empfängt Requests auf Port 8080, injiziert den Bearer Token als `Authorization` Header, und leitet an den Gateway auf Port 18789 weiter. Mit `OPENCLAW_STRIP_PROXY_HEADERS=true` werden die Proxy-Headers geleert, sodass der Gateway die Verbindung als lokal erkennt.

---

## Dateien

| Datei | Beschreibung |
|---|---|
| `Dockerfile` | Multi-Stage Build: OpenClaw from source + nginx + Go + uv |
| `scripts/entrypoint.sh` | Startet nginx + Gateway, generiert Config, **CF Tunnel Fix** |
| `scripts/configure.js` | Generiert `openclaw.json` aus Env-Vars, **CF Tunnel Config** |
| `docker-compose.yml` | Production Compose mit Browser-Sidecar |
| `.env.example` | Alle verfügbaren Env-Variablen |

## Build-Optionen

```bash
# Spezifischen Branch/Tag bauen:
docker compose build --build-arg OPENCLAW_GIT_REF=v1.0.0

# Ohne Browser-Sidecar:
docker compose up -d openclaw  # nur openclaw Service
```
