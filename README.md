# LeuwongRR LLM Gateway

Gateway produk untuk `api.leuwongrr.cloud`, terpisah dari OmniRoute.

| Item | Nilai |
| --- | --- |
| Origin | `127.0.0.1:2080` |
| Upstream | `http://127.0.0.1:20128` |
| Runtime root | `/opt/leuwongrr-gateway` |
| Stack | Node.js 22, Fastify, SQLite WAL |
| PR fondasi | https://github.com/lautanrobby11-sys/leuwongrr-gateway/pull/1 |

## Jalur normal (lokal → CI hijau → produksi)

### 1) Bootstrap mesin developer (sekali)

```bash
node -v   # >= 22
sudo apt-get install -y build-essential python3
git clone git@github.com:lautanrobby11-sys/leuwongrr-gateway.git
cd leuwongrr-gateway
git checkout feat/gateway-foundation
cp .env.example .env
# isi API_KEY_PEPPER dan INTERNAL_READY_TOKEN (min 32 char), JANGAN commit .env
```

### 2) Buat lockfile + buktikan gate lokal (WAJIB sebelum merge)

```bash
npm install
git add package-lock.json
git commit -m "chore(deps): pin package-lock for deterministic CI"
npm run validate
npm run ci:local
git push origin feat/gateway-foundation
```

Buka PR #1 → pastikan workflow **quality** hijau pada HEAD. Jika merah, salin **nama langkah + baris error** saja.

### 3) Merge ke main

Hanya setelah quality hijau. Jangan force-push `main`.

### 4) Staging / first deploy di VPS

```bash
# di VPS (root), dari checkout yang berisi scripts/infra:
sudo bash scripts/vps-bootstrap.sh infra/systemd/leuwongrr-gateway.service
sudo nano /opt/leuwongrr-gateway/config/gateway.env   # ganti placeholder secrets

# di mesin build (atau CI artifact):
scripts/build-release.sh <40-char-sha>
# transfer .release/<sha>.tar.gz{,.sha256} ke VPS, lalu:
sudo scripts/deploy.sh <40-char-sha> /path/to/<sha>.tar.gz
curl -sS http://127.0.0.1:2080/health/live

# seed tenant pertama (cetak key sekali):
sudo -u leuwongrr-gateway bash -lc '
  set -a; . /opt/leuwongrr-gateway/config/gateway.env; set +a
  cd /opt/leuwongrr-gateway/current
  node scripts/seed-tenant.mjs --tenant demo --scopes models:read,chat:write
'
```

Checklist penuh: `docs/runbooks/operations.md`.

### 5) Produksi stabil (baru setelah bukti)

- quality CI hijau di `main`
- bind hanya loopback, service non-root, secret mode 600
- Cloudflare Tunnel ke origin; Access **hanya** `/admin*`
- negative auth + tenant isolation lulus
- backup restore drill + rollback drill lulus
- resource envelope tidak mengganggu OmniRoute/SSH

## Endpoint fondasi

- `GET /health/live` — publik minimal
- `GET /health/ready` — token internal
- `GET /v1/models` — key + `models:read`
- `POST /v1/chat/completions` — key + `chat:write`
- di luar allowlist → 404, tanpa menyentuh OmniRoute

## Operasi

Lihat `docs/runbooks/operations.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`.
