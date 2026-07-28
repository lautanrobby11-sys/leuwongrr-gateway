# AGENTS.md — aturan wajib

Baca file ini, `README.md`, dan ADR terkait sebelum mengubah repository.

## Batas sistem
- Repository ini hanya memiliki LeuwongRR LLM Gateway: `127.0.0.1:2080`.
- OmniRoute terpisah di `127.0.0.1:20128`; komunikasi hanya HTTP loopback.
- Jangan membaca file, database, config, atau secret OmniRoute.
- Tidak ada passthrough catch-all. Route publik harus ada di `src/policy/allowlist.ts`.
- Provider secret tidak pernah masuk repository, database Gateway, log, atau respons.

## Prosedur
1. Jalankan `git status --short`; jangan menimpa perubahan yang tidak terkait.
2. Cari pemilik kanonis dengan `rg` sebelum membuat route, config, schema, atau helper.
3. Perubahan schema wajib migration forward-only baru.
4. Tambah test perilaku dan jalankan `npm run validate`.
5. Tinjau diff, secret, ownership ganda, dan file terlarang.
6. Deploy hanya commit bersih ke `releases/<git-sha>`; jangan edit `current`.

## Larangan
Dilarang membuat source/config dengan suffix `-new`, `-final`, `-final2`, `-fix`, `-fixed`, `-hotfix`, `-patch`, `-override`, `-backup`, `-old`, `-temp`, atau `docker-compose.override.yml`. Backup runtime hanya melalui `scripts/backup.sh`.

## Source of truth
| Concern | Pemilik |
|---|---|
| Kontrak dan route | `src/contracts/`, `src/policy/allowlist.ts` |
| Auth dan policy | `src/auth/`, `src/policy/` |
| Config | `src/config.ts` |
| Database | `src/persistence/` |
| OmniRoute client | `src/upstream.ts` |
| Deploy/rollback | `scripts/`, `infra/` |

## Security invariants
- Bind non-loopback ditolak saat startup.
- API key disimpan sebagai HMAC-SHA256 dengan pepper runtime, bukan plaintext.
- Query bisnis selalu menerima `tenant_id`.
- Prompt/response tidak dicatat.
- `/admin*` memerlukan JWT Cloudflare Access valid **dan** role aplikasi.
- URL egress wajib melewati SSRF guard.

DONE hanya setelah validasi, backup-restore, dan rollback drill benar-benar lulus.