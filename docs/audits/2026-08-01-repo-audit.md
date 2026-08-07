# Audit repository penuh — 1 Agustus 2026

| Bidang | Nilai |
|---|---|
| Ref yang diaudit | `main` = `d260ad58bb512c9a1192b143f1ce26d3a6b017cb` |
| Waktu | 1 Agustus 2026, ±15:00 dan ±22:30 WIB; dilanjutkan 2 Agustus 2026, ±09:00–09:50 WIB |
| Metode | Read-only GitHub API atas seluruh pohon repo, lalu dua perbaikan lewat PR #52 |
| Status produksi saat audit | `d260ad58…`, soak T10 berjalan sampai `2026-08-02T02:42:18Z` (`09:42:18 WIB`) |
| Verdict | **Dua defect tata kelola CI diperbaiki. Satu defect runtime yang memblokir rilis ditemukan (A19). Satu temuan audit sebelumnya (A9) terbukti SALAH dan dikoreksi di bawah.** |

Audit sebelumnya: `docs/audits/2026-07-28-production-readiness.md`.

> **Koreksi 2 Agustus 2026.** Versi pertama dokumen ini menyatakan repositori tidak punya proteksi cabang. Pernyataan itu salah. Baca §3.1 sebelum mengutip apa pun dari dokumen ini soal tata kelola merge.

---

## 1. Cakupan

Ditelusuri seluruhnya pada 1 Agustus: akar repo (19 entri), `.github/` beserta `CODEOWNERS`, `dependabot.yml`, `pull_request_template.md`, `ISSUE_TEMPLATE/`, dan kedua workflow; `scripts/` (11 berkas); `src/` (11 entri termasuk `src/http/` 5 berkas dan `src/billing/` 3 berkas); `web/` (11 entri); `package.json`; `vitest.config.ts`; `.gitignore`; `.gitattributes`; `check-conventions.mjs`; `scan-secrets.mjs`. Ditambah 49 pull request, 2 issue terbuka, 43 cabang remote (dua halaman penuh), dan daftar tag.

Ditelusuri pada 2 Agustus, lapisan yang pada 1 Agustus hanya didaftar namanya dan tidak pernah dibaca isinya: `src/upstream.ts`, `src/config.ts`, `src/main.ts`, `src/preflight.ts`, `src/http/pipeline.ts`, `src/http/stream-lifecycle.ts`, `src/policy/` (`egress.ts`, `rate-limit.ts`, `semaphore.ts`, `tenant-limits.ts`), serta seluruh shell rilis: `build-release.sh`, `deploy.sh`, `rollback.sh`, `backup.sh`. Hasilnya di §3.2.

---

## 2. Defect yang diperbaiki di PR #52

### 2.1 `lockfile.yml` memperbanyak cabang dan pull request sendiri — HIGH

Nama cabang bot dikunci ke commit pemicu:

```bash
BRANCH="chore/materialize-lockfiles-${GITHUB_SHA:0:7}"   # sebelum
```

Workflow berjalan pada **setiap** push ke `main`. Selama salah satu lockfile hilang, setiap push menghasilkan nama cabang berbeda, push berbeda, dan `gh pr create` berbeda. Penjaga `|| echo 'pull request already exists'` tidak pernah menyala, karena bagi GitHub itu memang pull request baru dari head baru.

**Inilah mekanisme di balik tumpukan cabang `chore/materialize-lockfile*`.** Penyebabnya bukan kelalaian operator. Sekarang nama cabangnya stabil, sehingga re-run menyegarkan satu pull request.

### 2.2 `--force-with-lease` tidak mungkin bekerja di job itu — MEDIUM

Job checkout dengan `fetch-depth: 1` lalu membuat cabang lokal via `git checkout -b`. Tidak ada remote-tracking ref `origin/chore/materialize-lockfiles` di clone itu, jadi lease tidak punya pembanding dan menolak dengan *stale info* begitu cabangnya sudah ada di remote.

Dengan nama SHA-keyed, cabangnya selalu baru, sehingga lease yang rusak ini **tidak pernah tersingkap**. Begitu nama cabang distabilkan, ia akan gagal pada run kedua. Diganti force push dengan refspec eksplisit, disertai komentar yang menyatakan alasannya. Lease yang tidak bisa menahan apa pun lebih buruk daripada tanpa lease, karena terbaca sebagai jaminan yang tidak ada.

### 2.3 `.gitignore` hanya mengabaikan `.env` telanjang — MEDIUM

`.env.local` dan `.env.production` adalah dua nama yang paling mungkin memuat kredensial gateway hidup di workstation operator, dan keduanya tidak diabaikan. Diperluas ke `.env.*` dengan `!.env.example` sebagai satu-satunya pengecualian terlacak.

`scripts/scan-secrets.mjs` adalah jaring pengaman yang baik, tetapi ia pencocok pola: ia hanya menangkap sembilan bentuk kunci yang sudah dikenalnya, bukan setiap kredensial.

---

## 3.1 KOREKSI: A9 salah — proteksi merge AKTIF

Versi pertama dokumen ini mencatat A9 sebagai berikut:

> A9 | MEDIUM | `.github/CODEOWNERS` dekoratif | Endpoint proteksi menjawab `403 Upgrade to GitHub Pro`; repo privat di akun personal; nol cabang `protected`

**Itu keliru, dan cara ia keliru layak dicatat.**

Pada 2 Agustus 2026 pukul `02:46Z` (`09:46 WIB`), sesudah soak T10 tutup, sebuah upaya squash merge atas PR #52 ditolak GitHub:

```
405 Repository rule violations found
Required status check "validate" is failing.
```

Jadi repositori ini **punya ruleset aktif** yang memaksa status check wajib bernama `validate`, dan ruleset itu benar-benar memblokir merge.

Kesalahan penalarannya: endpoint *branch protection* lama memang menjawab `403 Upgrade to GitHub Pro` pada repo privat di akun personal. Tetapi **repository rulesets adalah mekanisme yang berbeda** dan tersedia pada repo privat akun gratis. `403` dari endpoint lama tidak pernah membuktikan tidak adanya proteksi; ia hanya membuktikan endpoint lama tidak dapat diakses. Ketiadaan bukti diperlakukan sebagai bukti ketiadaan.

Konsekuensi yang ikut ditarik kembali:

- Klaim bahwa **CODEOWNERS dekoratif** — dicabut. Belum diverifikasi apakah ruleset mewajibkan review code owner, tetapi ia jelas bukan tanpa penegakan.
- Klaim bahwa **tidak adanya proteksi itulah yang memungkinkan merge non-squash #46 yang malformed** — dicabut sebagai tidak berdasar. Penjelasan sebenarnya belum diketahui.

`validate` adalah nama job di `.github/workflows/quality.yml` (`jobs.validate`, `name: validate`). Job itu gagal bila **langkah mana pun** gagal, sedangkan komentar diagnostik hanya menilai sebelas gerbang dalam array `required` dan mengabaikan langkah di luarnya. Karena itu komentar diagnostik bisa menyatakan **GREEN** sementara check `validate` tetap merah. Jangan pernah lagi memperlakukan komentar diagnostik hijau sebagai bukti boleh merge; satu-satunya otoritas adalah check `validate` itu sendiri.

Penyebab persis kegagalan `validate` pada head `5d8192d9…` **belum terdiagnosis** — lihat §5.

---

## 3.2 Temuan audit sumber 2 Agustus — A12 sampai A23

| # | Severity | Berkas | Temuan |
|---|---|---|---|
| A19 | **HIGH** | `src/http/pipeline.ts` + `src/upstream.ts` | Kebocoran permit semaphore. Lihat uraian di bawah |
| A15 | HIGH | `scripts/deploy.sh` | `npm ci --omit=dev --ignore-scripts=false` dijalankan tanpa `runuser`, jadi sebagai root di host produksi. Setiap `postinstall` di pohon dependensi dieksekusi sebagai root saat deploy |
| A18 | MEDIUM | `scripts/rollback.sh` | `manifest.sha256` rilis target tidak diverifikasi ulang sebelum symlink `current` dipindah. `deploy.sh` memverifikasi; rollback tidak |
| A17 | MEDIUM | `scripts/rollback.sh` | Gerbang health 30 s / `--max-time 2`, sedangkan `deploy.sh` memakai 90 s / 5. Rilis sehat yang lambat start bisa divonis gagal tepat pada saat insiden |
| A14 | MEDIUM | `scripts/build-release.sh` | **DITUTUP 7 Agustus 2026.** Artefak tidak reproducible: `RELEASE` memuat `built_at` dan tar tidak dinormalisasi (mtime/owner), sehingga SHA tarball berbeda tiap build dari commit yang sama. Komentar di berkas itu menyiratkan sebaliknya. Direproduksi ulang pada `9d9e7b2`: dua build memberi `b3b8e195…` dan `3e6da856…`, dan `diff -r` atas isi keduanya hanya menunjukkan `RELEASE` (`built_at` beda 18 menit). Perbaikan: `built_at` → `committed_at` dari `git log -1 --format=%ct`, **baris `node` diambil dari `engines.node` package.json (bukan `node --version` mesin build — host VPS sudah satu patch di belakang toolchain workstation)**, mode staged dinormalisasi, manifest disortir `LC_ALL=C`, tar memakai `--sort=name --owner=0 --group=0 --numeric-owner --mtime=@<epoch>`, gzip memakai `-n`. Dijaga `tests/release-reproducible-artifact.test.ts` |
| A16 | MEDIUM | `scripts/deploy.sh` | Artefak hanya di-checksum, tidak ditandatangani. Berkas `.sha256` dibawa bersama tarball, jadi hanya mendeteksi korupsi, bukan pemalsuan |
| A20 | LOW | `src/config.ts` | `INTERNAL_METRICS_TOKEN` wajib berbeda dari `INTERNAL_READY_TOKEN`, tetapi `API_KEY_PEPPER` tidak dicek terhadap keduanya |
| A21 | LOW | `src/policy/egress.ts` | Teredo `2001:0::/32` dan TEST-NET-2/3 (`198.51.100.0/24`, `203.0.113.0/24`) tidak diblok; sebaliknya `192.0.0.0/16` diblok terlalu luas |
| A22 | LOW | `src/policy/rate-limit.ts` | Eviction LRU memberi bucket baru burst penuh, sehingga rotasi kunci dapat menggusur bucket korban sekaligus mereset jatah sendiri |
| A23 | LOW | `src/preflight.ts` | Hanya `PRAGMA integrity_check`; versi skema atau status migrasi tidak diverifikasi sebelum rilis diaktifkan |
| A12 | LOW | `src/upstream.ts` | `new URL(path, this.baseUrl)`: `path` absolut atau protocol-relative membatalkan `baseUrl`, dan `authenticate()` tetap melampirkan kredensial. **Tidak dapat dieksploitasi hari ini** — ketiga call site memakai string literal (`/v1/chat/completions`, `/v1/responses`, `/api/monitoring/health`). Dicatat sebagai defense-in-depth |
| A13 | — | — | Nomor tidak dipakai |

### A19 — kebocoran permit semaphore, HIGH, memblokir rilis

Di `src/http/pipeline.ts`, cabang streaming:

```ts
if (!upstream.ok || !upstream.body) {
  deps.db.releaseBudget(reservation, key.tenantId);
  return sendProtocolError(reply, dialect, 502, 'upstream_error', ...);
}
```

Ketika OmniRoute membalas non-2xx **dengan body** — perilaku normal, karena respons errornya JSON — body itu tidak pernah dibaca dan tidak pernah dibatalkan.

Di `src/upstream.ts`, `release()` hanya dipanggil dari `pull` (saat `done` atau error) atau dari `cancel` pada `ReadableStream` pembungkus. Tidak satu pun terjadi di jalur ini. Permit bocor permanen.

`UPSTREAM_CONCURRENCY` default **4**. Empat permintaan streaming yang gagal di upstream sepanjang umur proses sudah menghabiskan seluruh semaphore. Sesudah itu `acquire()` melempar `OverloadError` pada setiap panggilan upstream berikutnya — **termasuk probe readiness `/api/monitoring/health`**, karena probe itu melewati semaphore yang sama. Akibatnya `/health/ready` ikut mati, gateway berhenti melayani, dan prosesnya tetap hidup sehingga systemd tidak me-restart apa pun. Pemulihan hanya lewat restart manual.

Jalur non-streaming aman: `await upstream.json()` dieksekusi sebelum pengecekan `upstream.ok`, jadi body selalu terbaca dan permit selalu lepas.

Perbaikan: batalkan body sebelum keluar, misalnya `await upstream.body?.cancel()` mendahului `sendProtocolError`. Uji regresi wajib menyertai, mengikuti pola `tests/upstream.test.ts` yang sudah menguji pelepasan permit.

Cacat ini ada di `d260ad58…`, yaitu rilis yang menjalani soak T10. Soak hijau tidak membantahnya: pemicunya adalah error upstream pada permintaan streaming, kondisi yang mungkin tidak muncul selama jendela soak.

### Catatan pendukung

`finalizeFailure()` melepas budget tetapi tidak menulis audit apa pun, sedangkan `finalizeSuccess()` menulis. Stream yang gagal karena itu tidak meninggalkan jejak audit. Ini memperluas issue #47, bukan temuan terpisah.

---

## 4. Yang diverifikasi sehat

- **`parseLimitInput` benar-benar dipanggil** `web/src/admin/main.tsx`. Kelas cacat "fungsi hidup tapi yatim" yang pernah membuat bug kotak-dikosongkan tayang ±40 menit **tidak ada** di `main`.
- **`src/billing/limit-bounds.ts` benar-benar dibaca ketiga penulis** — `src/billing/plan-input.ts`, `src/http/console.ts`, `web/src/admin/limits-validation.ts` — dan berkas itu nol dependency, sehingga zod tidak terseret ke bundel browser. Verifikasi akhir tetap pada `dist/public/assets/*.js` sesudah build.
- `tests/` memuat **33** berkas `*.test.ts`, cocok dengan angka gate T5.
- Kedua lockfile ada di `main`: `package-lock.json` (144.492 B) dan `web/package-lock.json` (95.693 B). Konsekuensinya `lockfile.yml` kini no-op — bug §2.1 tidak sedang menyala, hanya terpasang.
- `.gitattributes` mengunci `*.sh`, `*.service`, `*.timer`, `*.mjs`, `*.yaml`, `*.yml` ke `eol=lf`.
- `vitest.config.ts` menjaga `pool: 'forks'`, `fileParallelism: false`, dan budget 45 s sebagai sumber tunggal; `check-conventions.mjs` menolak `timeout:` inline di `tests/`.
- Nol pull request terbuka sebelum #52. Dua issue terbuka: #47 (budget) dan #51 (uji DOM modal limits).
- `scripts/build-release.sh` menegakkan tree bersih dua kali, membuat manifest yang sengaja tidak memuat dirinya sendiri, menormalkan CRLF lalu menolak byte CR yang tersisa, menjalankan `bash -n`, dan memverifikasi ulang artefak jadi dengan cara yang sama seperti `deploy.sh`.
- `scripts/deploy.sh` menangani symlink `current` yang menunjuk dirinya sendiri, `StartLimitBurst` yang habis, dan rollback otomatis saat health gate gagal.
- `src/main.ts` gagal-tertutup: produksi menolak boot tanpa `OMNIROUTE_API_KEY`, dan `closeActiveStreams(db)` dipanggil sebelum `db.close()` sehingga stream SSE yang di-hijack tetap menyelesaikan status budget selagi SQLite masih terbuka.
- `src/config.ts` memvalidasi silang dengan serius: konsol produksi menolak `OTP_DELIVERY` selain `webhook`, origin wajib `https`, token metrics wajib berbeda dari token ready.
- `src/policy/egress.ts` membongkar IPv4-in-IPv6 dalam dua bentuk, memblok metadata cloud, menolak kredensial di URL, dan meresolusi DNS lalu menghakimi setiap jawaban. Jendela sisa DNS rebinding diakui eksplisit dan dibatasi bind loopback (ADR-011).

---

## 5. Batas audit ini — jangan diperlakukan sebagai lulus

Baca bagian ini sebelum mengutip audit ini sebagai bukti.

- **Penyebab kegagalan check `validate` pada PR #52 belum terdiagnosis.** `pull_request_read` metode `get_check_runs` menjawab `403 Resource not accessible by personal access token`, dan tidak ada perkakas Actions (`list_workflow_runs`, `get_job_logs`, rerun) pada server MCP yang tersedia. Yang terbaca hanya *commit status* (CodeRabbit) dan komentar bot. Diagnosis butuh mata manusia di tab Actions.
- **Struktur squash ketiga merge (#48, #49, #50) tidak diverifikasi ulang**; API mengembalikan detail commit tanpa daftar parent. Statusnya "pernah diverifikasi sebelumnya", bukan "diverifikasi hari ini".
- **Nol eksekusi kode.** Tidak ada `npm run validate`, tidak ada build, tidak ada uji yang dijalankan. Seluruh temuan bersifat struktural, dari pembacaan sumber. A19 diturunkan dari pembacaan alur kontrol, bukan dari reproduksi runtime; reproduksinya masih harus dibuat sebagai uji regresi.
- **Nol pemeriksaan host.** Audit ini murni repository. Pembacaan soak akhir T10 tidak diverifikasi oleh agen mana pun; tidak ada akses host pada sesi ini.
- **Isi ruleset belum dibaca.** Yang diketahui hanya bahwa ia ada dan mewajibkan `validate`. Apakah ia juga mewajibkan review code owner, squash-only, atau linear history — belum diverifikasi.

---

## 6. Aturan untuk agent berikutnya

1. **Jangan pernah memakai komentar diagnostik `quality` sebagai izin merge.** Komentar itu hanya menilai sebelas gerbang `required` dan bisa berkata GREEN sementara job `validate` merah. Otoritasnya adalah check `validate`.
2. **Jangan merge PR #52 sebelum check `validate` benar-benar hijau.** Soak T10 sudah tutup `2026-08-02T02:42:18Z`, jadi jendela waktu bukan lagi penghalang; check yang merah adalah penghalangnya.
3. **Jangan menyimpulkan tidak adanya proteksi dari `403` endpoint branch protection.** Baca §3.1. Rulesets adalah mekanisme terpisah dan aktif di repo ini.
4. **Jangan hapus cabang mana pun** sampai pull request-nya benar-benar `MERGED`.
5. **Konfirmasi setiap epoch dengan `date -u -d @<epoch>` sebelum memakainya.** Titik nol soak yang benar adalah `1785552138`; nilai `1785537738` pernah tercatat dan salah 4 jam, yang bisa membuat operator menyatakan T10 lulus terlalu cepat.
6. Bila menyentuh `.github/workflows/`, baca §2.1 dan §2.2 lebih dulu — keduanya defect yang tidak terlihat sampai kondisi tertentu terpenuhi.
7. **A19 (§3.2) memblokir rilis berikutnya.** Perbaiki dengan uji regresi sebelum artefak baru mana pun di-deploy.
