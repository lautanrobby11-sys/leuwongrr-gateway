# Desain Audit dan Penyelarasan Repository

Tanggal: 2026-08-11  
Status: Disetujui untuk ditinjau sebelum eksekusi  
Repository: `lautanrobby11-sys/leuwongrr-gateway`

## 1. Tujuan

Menyelaraskan worktree lokal dengan `origin/main`, mengaudit repository dan tata kelola GitHub secara penuh, merapikan artefak lokal dan branch lama secara aman, serta memperbaiki hanya temuan yang memiliki bukti dan verifikasi memadai.

Audit tidak memberi izin merge atau deploy. Semua gate merah, parsial, dibatalkan, belum selesai, atau tidak diketahui tetap merupakan kondisi STOP.

## 2. Baseline terverifikasi

- Branch lokal adalah `main`.
- `HEAD` lokal dan `origin/main` sama-sama menunjuk `ed163043562d2496dde3b2bbf0701699a34771f6`.
- Perubahan pada file tracked adalah konversi LF ke CRLF; `git diff --ignore-cr-at-eol` tidak menemukan perubahan isi.
- Ada lima file untracked:
  - `.zcode/plans/plan-sess_dc360d1c-d4ad-4fe4-b56c-37e497984bfd.md`
  - `.zed/settings.json`
  - `2026-08-08`
  - `docs/superpowers/plans/2026-08-09-omni-gateway-vps-stability.md`
  - `docs/superpowers/specs/2026-08-09-omni-telemetry-stabilization-design.md`
- Tidak ada pull request atau issue terbuka.
- `main` dilaporkan terlindungi oleh GitHub.
- Ada 40 branch non-main. Seluruhnya telah dipetakan ke pull request dengan nilai `merged_at`; PR #17 adalah satu-satunya PR closed-unmerged yang ditemukan dan branch-nya sudah tidak ada.
- Tidak ada GitHub tag atau GitHub Release.

## 3. Batas sistem dan keselamatan

- Repository hanya memuat LeuwongRR Gateway pada `127.0.0.1:2080`.
- OmniRoute tetap sistem terpisah pada `127.0.0.1:20128` dan hanya boleh diakses melalui HTTP loopback sesuai kontrak Gateway.
- Audit tidak membaca file, database, konfigurasi, atau secret OmniRoute.
- Audit tidak mengakses atau mengubah VPS, Cloudflare, DNS, service systemd, release directory, symlink `current`, database produksi, backup, atau artifact produksi.
- Provider secret, API key, cookie, token, prompt, dan response tidak boleh masuk repository, log audit, diff, atau laporan.
- Tidak ada merge, deploy, retry deploy, force-push ke branch bersama, atau perubahan branch `main` secara langsung.
- Route publik baru dilarang kecuali dideklarasikan pada `src/policy/allowlist.ts` dan diminta oleh temuan yang disetujui.
- Perubahan schema, bila benar-benar diperlukan, harus berupa migration forward-only baru.
- File source/config baru tidak boleh memakai suffix yang dilarang `AGENTS.md`.

## 4. Strategi terpilih

Pekerjaan dilakukan dalam empat fase yang masing-masing memiliki stop gate. Fase berikutnya tidak dimulai bila bukti fase sebelumnya tidak lengkap.

### Fase 1 — Penyelarasan lokal yang dapat dipulihkan

1. Catat branch, full SHA, remote URL, status, daftar file untracked, dan hash dokumen yang akan diarsipkan.
2. Buat arsip lokal di luar repository pada sibling directory `../leuwongrr-gateway-local-archive/2026-08-11/`.
3. Pindahkan dua dokumen OmniRoute ke arsip tersebut dengan isi dan hash tetap sama:
   - `docs/superpowers/plans/2026-08-09-omni-gateway-vps-stability.md`
   - `docs/superpowers/specs/2026-08-09-omni-telemetry-stabilization-design.md`
4. Hapus hanya tiga artefak yang telah diklasifikasikan sebagai konfigurasi editor kosong, plan sesi sementara, dan hasil kueri sementara.
5. Pulihkan semua file tracked dari index hanya setelah diff yang mengabaikan CR di ujung baris kembali terbukti kosong.
6. Pastikan `git status --short` bersih kecuali dokumen audit/desain yang memang dibuat oleh pekerjaan ini.

Jika hash arsip berbeda, ada perubahan isi tracked, atau tujuan arsip tidak dapat dibuat, fase berhenti tanpa menghapus sumber.

### Fase 2 — Audit penuh read-only

Audit dibagi menjadi workstream berikut:

1. **Repository hygiene:** file generated, suffix terlarang, ownership ganda, dokumentasi yatim, line ending, ignore rules, dan source-of-truth drift.
2. **GitHub governance:** branch, PR, issue, ruleset/protection yang dapat dibuktikan, CODEOWNERS, Dependabot, workflow permissions, action pinning, concurrency, dan gate semantics.
3. **Application security:** authentication, authorization, tenant isolation, secret handling, SSRF/egress, webhook signature, rate limiting, semaphore, logging/redaction, dan allowlist route.
4. **Persistence and correctness:** migration forward-only, query tenant-scoping, transaction boundary, idempotency, budget/usage accounting, dan preflight schema.
5. **Release safety:** clean-tree gate, reproducible artifact, checksum, signature, install privilege, manifest verification, health gate, rollback, dan documentation consistency.
6. **Dependencies and toolchain:** root dan `web` lockfile, vulnerability audit, Node compatibility, dependency drift, lint, typecheck, unit/integration tests, build, shell gate, dan package gate.
7. **Maintainability:** duplication, unreachable/orphaned code, complexity hotspot, stale TODO/FIXME, naming, test coverage pada jalur berisiko, dan kontrak antarmodul.

Setiap temuan harus memiliki severity, bukti file/baris atau output command, dampak, rekomendasi, dan status `confirmed`, `needs-runtime-evidence`, atau `informational`.

### Fase 3 — Remediasi terkontrol

- Temuan hygiene tanpa perubahan perilaku boleh diperbaiki dalam slice kecil.
- Bug atau perubahan perilaku wajib dimulai dengan regression test yang gagal karena alasan yang benar.
- Refactor harus mempertahankan perilaku dan dipisahkan dari feature/fix bila tidak diperlukan langsung.
- Perubahan workflow, auth, policy, persistence, release script, dan dependency dianggap sensitif dan wajib mendapat diff review khusus.
- Tidak ada dependency baru kecuali dibutuhkan dan dibuktikan lebih aman daripada implementasi lokal.
- Temuan yang membutuhkan host, Cloudflare, atau runtime production hanya didokumentasikan; tidak disimulasikan sebagai bukti lulus.
- Tidak ada temuan yang diperbaiki dengan menyembunyikan file melalui ignore rule yang terlalu luas.

### Fase 4 — Hygiene branch GitHub

1. Simpan manifest lokal berisi nama dan SHA 40 branch kandidat serta PR/`merged_at` terkait.
2. Baca ulang daftar PR terbuka dan branch tepat sebelum penghapusan.
3. Tolak kandidat bila branch adalah `main`, protected, memiliki PR terbuka, tidak mempunyai `merged_at`, atau SHA berubah dari manifest.
4. Hapus branch kandidat satu per satu atau dalam batch kecil yang dapat diaudit.
5. Setelah setiap batch, baca ulang branch GitHub dan hentikan bila hasil berbeda dari ekspektasi.
6. Pastikan `main` tetap ada, protected, dan menunjuk SHA yang sama kecuali ada perubahan remote eksternal; perubahan eksternal menyebabkan STOP dan audit ulang.

## 5. Pendekatan yang ditolak

### Hygiene lokal saja

Lebih cepat tetapi tidak memenuhi permintaan audit penuh dan membiarkan branch serta risiko repository tidak terverifikasi.

### Satu perubahan besar untuk semua temuan

Ditolak karena mencampur line ending, dokumentasi, workflow, security, dependency, dan perilaku aplikasi. Diff besar sulit ditinjau, sulit dibatalkan, dan tidak sesuai prinsip gate proyek.

### Menghapus semua branch closed

Ditolak. Status `closed` tidak membuktikan merge. Hanya PR dengan `merged_at` yang boleh menjadi kandidat penghapusan.

## 6. Validasi dan stop gates

Urutan minimum validasi setelah worktree bersih dan setelah setiap remediasi:

1. `git status --short`
2. `git diff --check`
3. `npm run check:conventions`
4. `npm run scan:secrets`
5. `npm run lint`
6. `npm run typecheck`
7. test terfokus untuk file yang berubah
8. `npm test`
9. `npm run build:all`
10. `npm run ci:local` hanya pada clean committed checkout bila diperlukan sebagai release evidence; keberhasilan pada dirty worktree tidak boleh disebut release authorization
11. audit dependency root dan `web`
12. review diff untuk secret, ownership ganda, file terlarang, dan perubahan line ending

Kegagalan command dicatat apa adanya. Audit tidak mengklaim lulus untuk pemeriksaan yang tidak dapat dijalankan.

## 7. Output

- Worktree lokal yang selaras dan tidak memuat artefak sementara.
- Arsip lokal dua dokumen OmniRoute di luar repository dengan hash verifikasi.
- Laporan audit baru di `docs/audits/` yang membedakan bukti repository dari hal yang tidak diverifikasi.
- Remediasi kecil dan teruji untuk temuan yang aman dikerjakan.
- Manifest branch sebelum penghapusan dan hasil verifikasi sesudahnya.
- Tidak ada commit, push, PR, merge, atau deploy kecuali diminta secara eksplisit pada tahap berikutnya.

## 8. Kriteria selesai

Pekerjaan dianggap selesai hanya bila:

- tidak ada perubahan lokal yang tidak diklasifikasikan;
- dokumen OmniRoute tersimpan di luar repository dan hash cocok;
- artefak sementara yang disetujui telah dihapus;
- audit source, security, CI, dependency, release, dokumentasi, dan GitHub hygiene memiliki bukti;
- seluruh perbaikan yang dibuat lolos validasi relevan;
- branch GitHub yang dihapus seluruhnya terbukti merged dan tidak protected;
- `main` tetap protected dan tidak berubah tanpa otorisasi;
- laporan menyebutkan batas audit serta pemeriksaan yang tidak dijalankan;
- tidak ada merge atau deploy yang dilakukan.
