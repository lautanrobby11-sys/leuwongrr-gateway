# AGENTS.md — aturan wajib

Baca file ini, `README.md`, dan ADR terkait sebelum mengubah repository.

> **Audit repo terakhir: `docs/audits/2026-08-01-repo-audit.md`** (1 Agustus 2026, `main` = `d260ad58bb512c9a1192b143f1ce26d3a6b017cb`). Wajib dibaca sebelum menyentuh `.github/workflows/` atau menghapus cabang: dua defect CI di sana hanya menyala pada kondisi tertentu, dan bagian "Batas audit" mencatat apa yang **tidak** diverifikasi.

## Batas sistem
- Repository ini hanya memiliki LeuwongRR LLM Gateway: `127.0.0.1:2080`.
- OmniRoute terpisah di `127.0.0.1:20128`; komunikasi hanya HTTP loopback.
- Jangan membaca file, database, config, atau secret OmniRoute.
- Tidak ada passthrough catch-all. Route publik harus ada di `src/policy/allowlist.ts`.
- Provider secret tidak pernah masuk repository, database Gateway, log, atau respons.

## Gate merah = STOP (wajib)
- **Jangan merge** PR bila quality gate GitHub merah, partial, skipped-on-failure, atau belum selesai.
- **Jangan deploy** SHA bila `npm run ci:local` gagal, quality mirror merah, artifact/checksum tidak cocok, atau health gate gagal.
- **Jangan retry deploy** SHA yang sudah gagal; buat commit baru, validasi ulang, deploy SHA baru.
- Hijau di GitHub Actions **saja** tidak cukup untuk produksi: workstation `ci:local` + evidence di `docs/runbooks/operator-release-authority.md` tetap wajib.
- Status Notion/DONE hanya setelah gate wajib lulus dengan bukti; kode yang “sudah dibuat” bukan izin merge/deploy.

## Prosedur
1. Jalankan `git status --short`; jangan menimpa perubahan yang tidak terkait.
2. Cari pemilik kanonis dengan `rg` sebelum membuat route, config, schema, atau helper.
3. Perubahan schema wajib migration forward-only baru.
4. Tambah test perilaku dan jalankan `npm run validate`.
5. Tinjau diff, secret, ownership ganda, dan file terlarang.
6. Untuk release, ikuti `docs/runbooks/operator-release-authority.md`: clean checkout pada workstation operator, kedua lockfile, `npm run ci:local`, artefak full Git SHA, dan checksum. GitHub adalah mirror source; status branch tidak menggantikan bukti lokal.
7. Deploy hanya commit bersih ke `releases/<git-sha>`; jangan edit `current`, jangan build source di VPS, dan jangan memberi VPS credential GitHub.
8. Sebelum merge: quality diagnostics PR harus seluruh gate wajib `success` (kecuali `release_readiness` yang memang skipped di PR). Bila `tests`/`lint`/`typecheck`/`conventions`/`secrets` merah — perbaiki dulu, jangan squash.

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
| Release authority tanpa branch protection | `docs/adr/ADR-012-local-release-authority.md`, `docs/runbooks/operator-release-authority.md` |
| Kondisi repo dan gerbang tata kelola terbuka | `docs/audits/2026-08-01-repo-audit.md` |

## Security invariants
- Bind non-loopback ditolak saat startup.
- API key disimpan sebagai HMAC-SHA256 dengan pepper runtime, bukan plaintext.
- Query bisnis selalu menerima `tenant_id`.
- Prompt/response tidak dicatat.
- `/admin*` memerlukan JWT Cloudflare Access valid **dan** role aplikasi.
- URL egress wajib melewati SSRF guard.

DONE hanya setelah validasi, backup-restore, dan rollback drill benar-benar lulus.
