# LeuwongRR LLM Gateway

Gateway produk untuk `api.leuwongrr.cloud`, terpisah dari OmniRoute.

| Item | Nilai |
| --- | --- |
| Origin | `127.0.0.1:2080` |
| Upstream | `http://127.0.0.1:20128` |
| Runtime root | `/opt/leuwongrr-gateway` |
| Stack | Node.js 22, Fastify, SQLite WAL |

## Jalur normal (lokal → CI hijau → produksi)

### 1) Bootstrap mesin developer (sekali)

```bash
node -v   # >= 22
sudo apt-get install -y build-essential python3
git clone git@github.com:lautanrobby11-sys/leuwongrr-gateway.git
cd leuwongrr-gateway
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
```

`scripts/deploy.sh` menolak berjalan tanpa `package-lock.json`, jadi lockfile adalah syarat produksi, bukan opsi.

### 3) Merge ke main

Hanya setelah workflow **quality** hijau. Jangan force-push `main`.

### 4) Staging / first deploy di VPS

```bash
# di VPS (root), dari checkout yang berisi scripts/infra:
sudo bash scripts/vps-bootstrap.sh infra/systemd/leuwongrr-gateway.service
sudo nano /opt/leuwongrr-gateway/config/gateway.env   # ganti placeholder secrets

# di mesin build (atau CI artifact):
bash scripts/build-release.sh <40-char-sha>
# transfer .release/<sha>.tar.gz{,.sha256} ke VPS, lalu:
sudo scripts/deploy.sh <40-char-sha> /path/to/<sha>.tar.gz
curl -sS http://127.0.0.1:2080/health/live
```

### 5) Produksi stabil (baru setelah bukti)

- quality CI hijau di `main`
- bind hanya loopback, service non-root, secret mode 600
- Cloudflare Tunnel ke origin; Access **hanya** `/admin*`
- negative auth + tenant isolation lulus
- backup restore drill + rollback drill lulus
- resource envelope tidak mengganggu OmniRoute/SSH

## Tenant dan API key

Semua penerbitan key memakai CLI yang ikut dikemas dalam release, sehingga key
yang dibuat selalu cocok dengan cara service memverifikasinya. Key hanya
ditampilkan sekali dan tidak dapat dipulihkan dari database.

```bash
sudo -u leuwongrr-gateway bash -lc '
  set -a; . /opt/leuwongrr-gateway/config/gateway.env; set +a
  cd /opt/leuwongrr-gateway/current

  node dist/cli/keys.js tenant:create --tenant demo --name "Demo" --model lwrr-text
  node dist/cli/keys.js key:issue --tenant demo --name laptop \
    --scopes models:read,chat:write --expires-days 90
'
```

| Perintah | Fungsi |
| --- | --- |
| `tenant:create` | Buat/rename tenant, opsional aktifkan satu model |
| `key:issue` | Terbitkan key (`--mode live\|test`, `--expires-days N`) |
| `key:list` | Daftar key beserta prefix, last4, scope, dan pemakaian terakhir |
| `key:revoke` | Cabut satu key milik tenant tersebut |
| `key:rotate` | Terbitkan pengganti; `--grace-minutes N` memberi jendela migrasi |
| `limits:set` | Batas harian, concurrency, dan rpm per tenant |
| `model:enable` / `model:disable` | Entitlement model per tenant |

Rotasi tanpa downtime: `key:rotate --grace-minutes 60`, sebarkan key baru,
lalu pastikan `key:list` menunjukkan key lama sudah tidak dipakai sebelum masa
tenggang habis.

## Endpoint fondasi

- `GET /health/live` — publik minimal
- `GET /health/ready` — token internal
- `GET /v1/models` — key + `models:read`
- `POST /v1/chat/completions` — key + `chat:write`
- di luar allowlist → 404, tanpa menyentuh OmniRoute

## Operasi

Lihat `docs/runbooks/operations.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`.
