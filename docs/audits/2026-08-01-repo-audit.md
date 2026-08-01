# Audit repository penuh — 1 Agustus 2026

| Bidang | Nilai |
|---|---|
| Ref yang diaudit | `main` = `d260ad58bb512c9a1192b143f1ce26d3a6b017cb` |
| Waktu | 1 Agustus 2026, ±15:00 dan ±22:30 WIB |
| Metode | Read-only GitHub API atas seluruh pohon repo, lalu dua perbaikan lewat PR #52 |
| Status produksi saat audit | `d260ad58…`, soak T10 berjalan sampai `2026-08-02T02:42:18Z` (`09:42:18 WIB`) |
| Verdict | **Nol regresi pada kode runtime. Dua defect tata kelola CI diperbaiki. Tiga gerbang tetap terbuka.** |

Audit sebelumnya: `docs/audits/2026-07-28-production-readiness.md`.

---

## 1. Cakupan

Ditelusuri seluruhnya: akar repo (19 entri), `.github/` beserta `CODEOWNERS`, `dependabot.yml`, `pull_request_template.md`, `ISSUE_TEMPLATE/`, dan kedua workflow; `scripts/` (11 berkas); `src/` (11 entri termasuk `src/http/` 5 berkas dan `src/billing/` 3 berkas); `web/` (11 entri); `package.json`; `vitest.config.ts`; `.gitignore`; `.gitattributes`; `check-conventions.mjs`; `scan-secrets.mjs`. Ditambah 49 pull request, 2 issue terbuka, 43 cabang remote (dua halaman penuh), dan daftar tag.

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

## 3. Gerbang yang MASIH terbuka

| # | Severity | Temuan | Bukti | Kenapa belum diperbaiki |
|---|---|---|---|---|
| A8 | MEDIUM | 42 cabang remote selain `main`, nol tag | Dua halaman `list_branches`; `list_tags` kosong | Penghapusan cabang dilarang selama soak. Akar penyebabnya sudah ditutup di §2.1 |
| A9 | MEDIUM | `.github/CODEOWNERS` dekoratif | Endpoint proteksi menjawab `403 Upgrade to GitHub Pro`; repo privat di akun personal; nol cabang `protected` | Keputusan berbayar/kebijakan, bukan perubahan kode |
| A10 | MEDIUM | Semua action dipin ke tag yang bisa berubah: `actions/checkout@v4`, `actions/setup-node@v4`, `actions/github-script@v7`, `actions/upload-artifact@v4` | Kedua workflow | `lockfile.yml` berjalan dengan `contents: write`, jadi action yang di-retag hulu memperoleh token tulis repo. Perbaikannya pin ke SHA commit — SHA wajib dicari dan diverifikasi, bukan ditebak |
| A11 | LOW | `quality.yml` memberi `actions: write` yang tidak pernah dipakai | Blok `permissions:`; nol pemanggilan Actions API di seluruh workflow | Hapus satu baris, tetapi berarti menulis ulang 10 KB YAML gerbang rilis dengan tangan di tengah jendela soak. Lakukan lewat editor |

---

## 4. Yang diverifikasi sehat

- **`parseLimitInput` benar-benar dipanggil** `web/src/admin/main.tsx`. Kelas cacat "fungsi hidup tapi yatim" yang pernah membuat bug kotak-dikosongkan tayang ±40 menit **tidak ada** di `main`.
- **`src/billing/limit-bounds.ts` benar-benar dibaca ketiga penulis** — `src/billing/plan-input.ts`, `src/http/console.ts`, `web/src/admin/limits-validation.ts` — dan berkas itu nol dependency, sehingga zod tidak terseret ke bundel browser. Verifikasi akhir tetap pada `dist/public/assets/*.js` sesudah build.
- `tests/` memuat **33** berkas `*.test.ts`, cocok dengan angka gate T5.
- Kedua lockfile ada di `main`: `package-lock.json` (144.492 B) dan `web/package-lock.json` (95.693 B). Konsekuensinya `lockfile.yml` kini no-op — bug §2.1 tidak sedang menyala, hanya terpasang.
- `.gitattributes` mengunci `*.sh`, `*.service`, `*.timer`, `*.mjs`, `*.yaml`, `*.yml` ke `eol=lf`.
- `vitest.config.ts` menjaga `pool: 'forks'`, `fileParallelism: false`, dan budget 45 s sebagai sumber tunggal; `check-conventions.mjs` menolak `timeout:` inline di `tests/`.
- Nol pull request terbuka sebelum #52. Dua issue terbuka: #47 (budget) dan #51 (uji DOM modal limits).

---

## 5. Batas audit ini — jangan diperlakukan sebagai lulus

Baca bagian ini sebelum mengutip audit ini sebagai bukti.

- **Struktur squash ketiga merge (#48, #49, #50) tidak diverifikasi ulang** pada sesi ini; API mengembalikan detail commit tanpa daftar parent. Statusnya "pernah diverifikasi sebelumnya", bukan "diverifikasi hari ini".
- **Hasil workflow run tidak terbaca**; tidak ada perkakas Actions yang tersedia pada sesi audit. Verdict `quality` dan `lockfile` di `main` berasal dari catatan sebelumnya, bukan pembacaan langsung.
- **Nol eksekusi kode.** Tidak ada `npm run validate`, tidak ada build, tidak ada uji yang dijalankan. Seluruh temuan bersifat struktural, dari pembacaan sumber.
- **Nol pemeriksaan host.** Audit ini murni repository.

---

## 6. Aturan untuk agent berikutnya

1. **Jangan merge PR #52 sebelum soak T10 tutup** `2026-08-02T02:42:18Z` (`09:42:18 WIB`), dan sebelum gerbang wajib `quality` hijau.
2. **Jangan hapus cabang mana pun selama soak.** Sesudah soak, hapus hanya cabang yang pull request-nya `MERGED`.
3. **Konfirmasi setiap epoch dengan `date -u -d @<epoch>` sebelum memakainya.** Titik nol soak yang benar adalah `1785552138`; nilai `1785537738` pernah tercatat dan salah 4 jam, yang bisa membuat operator menyatakan T10 lulus terlalu cepat.
4. Bila menyentuh `.github/workflows/`, baca §2.1 dan §2.2 lebih dulu — keduanya defect yang tidak terlihat sampai kondisi tertentu terpenuhi.
