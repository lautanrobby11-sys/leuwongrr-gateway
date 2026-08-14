# Final Go-Live LeuwongRR Gateway — Design

Tanggal: 2026-08-12
Status: Menunggu review tertulis sebelum eksekusi lanjutan
Repository: `lautanrobby11-sys/leuwongrr-gateway`

## 1. Tujuan dan batas

Menyelesaikan LeuwongRR Gateway sampai go-live final melalui delivery slice yang
terpisah, teruji, dapat di-rollback, dan dicatat dengan bukti yang sama di
worktree lokal, GitHub, VPS#2, dan Notion.

OmniRoute tetap sistem terpisah di `127.0.0.1:20128`. Gateway tetap bind ke
`127.0.0.1:2080`. Gateway dan `leuwongrr.online` tidak berbagi database; Gateway
menggunakan SQLite sendiri dan komunikasi antarsistem hanya melalui HTTP webhook
terverifikasi.

## 2. Baseline yang harus diperlakukan sebagai fakta kerja

- Worktree lokal berada di branch `main`, HEAD `a531056` menurut pemeriksaan
  terakhir.
- Worktree saat ini **belum clean**: ada perubahan Model Catalog dan folder
  untracked `infra/cloudflare/otp-relay/`. Ini bukan release evidence.
- Release 2 dilaporkan telah aktif di VPS#2 pada SHA penuh turunan `a531056`,
  tetapi setiap final-golive gate harus membaca ulang bukti host, bukan mengulang
  klaim lama.
- Console tetap OFF sampai OTP delivery, Cloudflare Access, secret, acceptance
  test, dan konfigurasi produksi lulus.
- Audit repo menandai A19 sebagai release blocker. Walaupun jalur saat ini sudah
  membaca body error, regression test yang membuktikan permit upstream dilepas
  setelah streaming error tetap wajib; perubahan minimal harus dipilih setelah
  test gagal karena alasan yang benar.

## 3. Prinsip konfigurasi dan data

### 3.1 Database

Semua data bisnis Gateway hidup di `gateway.db`, termasuk plans, subscriptions,
usage, wallets, exchange rates, dan model catalog. Database MySQL milik
`leuwongrr.online` tidak boleh dibaca atau ditulis oleh Gateway. Tidak ada shared
table, foreign key lintas database, atau cross-database query.

### 3.2 Environment

Environment hanya menyimpan secret dan konfigurasi infrastruktur/runtime:

- secret: webhook token/secret, OTP token, API-key pepper, provider key;
- runtime: `DB_PATH`, port/host, OmniRoute URL, console flag, OTP delivery,
  Cloudflare Access domain/audience, dan konfigurasi loopback.

Pricing, duration, token allowance, tier, reset count, model pricing, dan nilai
bisnis lain harus berada di database dan dapat diubah admin tanpa restart.

## 4. Delivery slices dan stop gates

### Slice A — A19 release blocker

Owner menulis regression test untuk streaming response non-2xx yang memiliki
body, membuktikan semaphore permit dapat dipakai kembali setelah error. Test harus
gagal sebelum fix. Setelah itu owner menerapkan perubahan minimal, menjalankan
focused test, `npm run validate`, dan meninjau diff. Tidak ada deploy bila test
atau gate lain merah.

### Slice B — Model Catalog

Review working diff yang sudah ada sebagai slice terpisah dari A19. Migration
forward-only `0008` boleh dipertahankan hanya jika schema dan nama field sesuai
kontrak kanonis. Katalog menyimpan identity/provider, active state, multimodal
support, `input_price_cents`, `output_price_cents`, `cache_read_price_cents`, dan
upstream model identifier. Admin CRUD wajib melalui allowlist, Access JWT + role,
validasi Zod, audit event, soft-disable, dan test perilaku. Katalog Gateway tetap
manual dan tidak membaca konfigurasi OmniRoute.

### Slice C — API documentation

OpenAPI, allowlist, route resolver, dan dokumentasi publik harus sepakat. Tidak
boleh menambah route catch-all. Dokumentasi hanya menyebut endpoint dan auth
behavior yang benar-benar terverifikasi melalui source/test.

### Slice D — OTP relay dan Cloudflare Access

Worker OTP hanya boleh di-commit setelah source, secret boundary, error mapping,
dan deployment procedure direview. Resend key, verified sender, Cloudflare API
token, Access domain, audience, dan OTP token tidak boleh masuk repo, Notion,
terminal transcript, artifact, atau log. Owner memasang nilai ke
`gateway.env` setelah semua pasangan config tersedia. `CONSOLE_ENABLED` tetap
false selama preflight.

### Slice E — Console acceptance dan activation

Setelah konfigurasi lengkap, lakukan satu activation attempt yang disetujui:

1. clean release artifact dari full SHA;
2. checksum, signature, manifest, dan `ci:local` cocok;
3. backup age dan restore evidence tersedia;
4. deploy ke VPS#2 dengan migration forward-only;
5. health live/readiness, restart count, migration status, loopback binding, dan
   negative auth checks lulus;
6. enable console hanya setelah config guard lulus;
7. acceptance test login OTP, member, admin Access + app role, webhook payment,
   subscription, model catalog, dan error paths;
8. soak dan rollback drill lulus.

Kegagalan setelah release directory, dependency install, application preflight,
activation, restart, health check, atau traffic berarti SHA ditinggalkan. Buat
commit baru, ulangi seluruh gate, dan jangan retry SHA yang gagal.

## 5. Peran dan komunikasi

- **Owner — full control:** perencanaan, desain, keputusan kontrak, coding, test,
  commit, artifact, release, deploy, host verification, backup/rollback evidence,
  monitoring, dan pencatatan status Notion. Satu peran tunggal; tidak ada aktor
  kedua.

Keputusan desain dicatat langsung ke Notion; laporan berupa checkpoint: perubahan,
bukti, blocker, dan next gate.

## 6. Notion/GitHub/local synchronization

Setiap slice memiliki catatan yang sama:

- status: `PLANNED`, `IN_PROGRESS`, `BLOCKED`, `VERIFIED`, atau `DEPLOYED`;
- full commit SHA jika ada;
- test/validation command dan hasil;
- artifact checksum/signature jika release;
- VPS active SHA, health, migrations, restarts, backup, rollback target;
- item yang belum diverifikasi, tanpa klaim DONE.

Owner memperbarui Notion, GitHub, dan worktree melalui commit atomic.
Local/GitHub/VPS/Notion dianggap selaras hanya setelah full SHA dan bukti gate
sama.

## 7. Final go-live definition

Final go-live hanya boleh dinyatakan bila:

- worktree bersih dan tidak ada file terlarang/untracked yang terselubung;
- A19 regression gate, `npm run validate`, dan `npm run ci:local` lulus pada
  full SHA yang sama;
- kedua lockfile, artifact, checksum, signature, dan manifest cocok;
- GitHub required check `validate` benar-benar success, bukan komentar diagnostik;
- VPS#2 menjalankan full SHA yang sama dengan health/readiness, migration,
  backup/restore, rollback, binding, dan journal evidence;
- database Gateway terpisah dari database `leuwongrr.online`;
- secrets tidak muncul di source, DB, log, response, Notion, atau evidence;
- Cloudflare boundary, OTP relay, Access JWT, app role, origin, dan negative
  cases lulus;
- console acceptance dan soak lulus;
- Notion mencatat bukti final dan blocker yang tersisa sebagai nol.

Jika salah satu bukti tidak tersedia atau tidak dapat diverifikasi, status tetap
`BLOCKED`/`NO-GO`, bukan DONE.
