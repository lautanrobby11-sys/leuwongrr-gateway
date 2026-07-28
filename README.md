# LeuwongRR LLM Gateway

Gateway produk untuk `api.leuwongrr.cloud`, terpisah dari OmniRoute.

- Origin: `127.0.0.1:2080`
- Upstream: `http://127.0.0.1:20128`
- Runtime root: `/opt/leuwongrr-gateway`
- Node.js 22 LTS, Fastify, SQLite WAL

## Lokal
```bash
cp .env.example .env
npm install
npm run validate
npm run build
npm start
```

`npm run validate` menjalankan convention gate, typecheck, dan seluruh test tanpa provider berbayar. Konfigurasi runtime divalidasi ketat; contoh env tidak berisi secret nyata.

## Endpoint fondasi
- `GET /health/live` — publik dan minimal.
- `GET /health/ready` — memerlukan token internal.
- `GET /v1/models` — key + scope `models:read`.
- `POST /v1/chat/completions` — key + scope `chat:write`, capability/budget/concurrency/idempotency.
- Endpoint lain ditolak sebelum mencapai OmniRoute.

## Operasi
Lihat `docs/runbooks/operations.md`. Deployment immutable memakai `releases/<git-sha>` dan symlink `current`. Tidak ada edit source pada release aktif.