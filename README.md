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
# Node 22 LTS + toolchain native (butuh better-sqlite3)
node -v   # >= 22
# Ubuntu/Debian:
sudo apt-get install -y build-essential python3

git clone git@github.com:lautanrobby11-sys/leuwongrr-gateway.git
cd leuwongrr-gateway
git checkout feat/gateway-foundation
cp .env.example .env
# isi API_KEY_PEPPER dan INTERNAL_READY_TOKEN (min 32 char), JANGAN commit .env
```

### 2) Buat lockfile + buktikan gate lokal

```bash
npm install                 # menghasilkan package-lock.json
git add package-lock.json
git commit -m "chore(deps): pin package-lock for deterministic CI"
npm run validate            # conventions + secrets + lint + typecheck + test
npm run build
npm run ci:local            # validate + build + shell syntax + release artifact
```

Jika `npm run validate` hijau di mesin Anda, push ke PR #1. Actions harus mengikuti hasil yang sama.

### 3) Hijaukan PR lalu merge

1. Buka https://github.com/lautanrobby11-sys/leuwongrr-gateway/pull/1
2. Pastikan workflow `quality` **hijau** pada HEAD terbaru
3. Jika merah: buka job → langkah gagal pertama (Convention / Secret scan / Lint / Typecheck / Tests / Build / Package) → salin **nama langkah + baris error** saja
4. Setelah hijau: merge ke `main` (squash atau merge commit; jangan force-push `main`)

### 4) Staging di VPS (belum publik)

Hanya operator dengan akses root VPS. Jangan tempel secret ke chat/Git/Notion.

```bash
# di VPS, setelah backup OmniRoute + baseline resource tercatat
sudo mkdir -p /opt/leuwongrr-gateway/{releases,config,data,logs,runtime}
# letakkan gateway.env mode 600 root-owned
# deploy artifact dari CI ke staging port 2081 dulu (mock upstream)
scripts/build-release.sh <40-char-sha>
sudo scripts/deploy.sh <40-char-sha> .release/<40-char-sha>.tar.gz
curl -sS http://127.0.0.1:2080/health/live
```

Checklist penuh: `docs/runbooks/operations.md`.

### 5) Produksi stabil (baru setelah bukti)

Baru boleh dianggap normal/produksi bila **semua** ini punya bukti tertangkap:

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
