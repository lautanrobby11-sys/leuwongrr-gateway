# Desain Stabilisasi VPS — Tekanan Memori OmniRoute & Host (router.leuwongrr.cloud)

Tanggal: 2026-08-02
Status: Draft (sedang dieksekusi dengan persetujuan operator)
Lingkup host: VPS AWS Lightsail `18.136.26.152` (Ubuntu 24.04, 2 vCPU, ~1,9 GiB RAM, 8 GiB swap)
Sumber bukti: pembacaan live via SSH `ubuntu@18.136.26.152` (key-only)

## 1. Tujuan

Menstabilkan tekanan sumber daya di VPS yang melayani `router.leuwongrr.cloud`
(OmniRoute, Docker, `127.0.0.1:20128`) dan `api.leuwongrr.cloud`
(LeuwongRR Gateway, systemd `leuwongrr-gateway.service`, `127.0.0.1:2080`)
pada host 2 vCPU / 1,9 GiB RAM. Fokus: mengurangi tekanan memori host dan
reclaim jangka panjang; **tidak** mengubah batas container/compose OmniRoute.

## 2. Batas (sesuai AGENTS.md dan approval operator)

- **Tidak membaca** file/database/config/secret OmniRoute (volume, `.env`,
  `storage.sqlite`, CLI credentials).
- **Tidak mengubah** `mem_limit`, CPU limit, atau konfigurasi OmniRoute lain
  di `/opt/omniroute/compose.yml` pada sesi ini (menunggu bukti tren >1 jam dan
  penutupan soak Gateway).
- Boleh mengubah pengaturan **host** (sysctl, journald) dan hanya sampling
  HTTP `/api/monitoring/health` (endpoint unauthenticated yang memang untuk itu).
- Satu-satunya jalur restart sah untuk layanan systemd Gateway adalah
  `deploy.sh`/`rollback.sh` dari dalam artifact; tidak ada perubahan unit.

## 3. Diagnosis awal (2 Agustus 2026, UTC)

### 3.1 OmniRoute — tekanan cgroup memori kronis
- Container `omniroute` (id `44d7a0b12866…`) — `RestartCount=0`,
  `Health=healthy`, started `2026-08-02T01:06:09Z`.
- `memory.current` ≈ **1,28–1,39 GiB** dari `memory.max` **1,367 GiB**
  (**94%**), headroom ≈ 100–280 MiB.
- `memory.events` (counter sejak container start):
  - `max` = **32.059** — cgroup membentur plafon memori puluhan ribu kali.
  - `sock_throttled` = **2.841** — buffer socket ditahan karena batas memori.
  - `oom` = `0`, `oom_kill` = `0`, `oom_group_kill` = `0` — tidak ada OOM kill.
- `memory.swap.current` ≈ **743 MiB** — sebagian besar memori container
  dipindahkan ke swap host (host swap terpakai ≈ 792 MiB / 8 GiB).
- Heap Node kecil (`heapUsed` ≈ 350 MiB) tetapi RSS besar (≈1,31 GiB,
  `anon` ≈1,26 GiB, `file` ≈84 MiB) — pertumbuhan di luar heap V8
  (library, buffer, caches).
- CPU: `usage_usec` 1.353.377.889 per `cpu.stat`; `nr_throttled` = **1.192**,
  `throttled_usec` = 45,8 s dari `nr_periods` 74.335 — jarang ter-throttle
  (≈1,6% period).

### 3.2 Host — swap aktif dan sedikit `available`
- `free -m`: total 1.906 MiB, `available` ≈ 282–476 MiB, swap terpakai ≈ 792 MiB.
- `vm.swappiness` = `10`; `vm.zone_reclaim_mode` = `0`.
- `pswpin` ≈ 2,51 juta, `pswpout` ≈ 2,58 juta — **aktif** (seumur hidup).
- OmniRoute secara efektif sudah bergantung pada swap host untuk menghindari OOM.

### 3.3 Gateway (api.leuwongrr.cloud)
- Sehat: `/health/live` 200, `/health/ready` 404 (tanpa token internal),
  `/v1/models` 401, `/metrics` 404.
- Cgroup gateway: `memory.current` ≈ 38–44 MiB, `memory.events` semua 0
  (termasuk `max`, `sock_throttled`).
- Log error 48 jam: tidak ada (`journalctl -p 3` kosong); SIGTERM terakhir
  adalah peristiwa deploy terencana.
- `cpu.stat` gateway: `nr_throttled` 8, `throttled_usec` ≈ 0,4 s — sehat.

### 3.4 Log OmniRoute (dari `docker logs`, tanpa membaca volume/config)
- Healthcheck rutin aktif: `[HealthCheck]` / `[CredentialHealth]` — ini
  berpotensi menyebabkan lonjakan memori berkala.
- Error bisnis normal (bukan crash): 402/403 provider/limit; 403 "预扣费额度失败"
  untuk user dengan saldo rendah (request tetap diproses, balas 403).
- `docker logs --since 48h` hanya **satu** SIGTERM (shutdown graceful
  `2026-08-02T01:05:49Z`, `Draining 0 request(s)`), bertepatan dengan restart
  host terencana.

## 4. Rencana implementasi (di-host, reversibel)

1. **Sampling baseline** — CSV `/tmp/omni-sample-20260802.csv`: setiap 60 detik
   selama 60 menit: `memory.current`, `max`, `sock_throttled`, swap, load,
   `available`; simpan dan bawa ke workstation. Sebelum sampling berakhir,
   tidak ada perubahan host.
2. **sysctl host** (reversibel via `/etc/sysctl.d/99-leuwongrr-stability.conf`):
   - `vm.swappiness = 20` — kurangi penghindaran memori file yang agresif,
     kurangi thrash di antara OmniRoute dan kernel; Node RSS tetap diprioritaskan.
   - `vm.zone_reclaim_mode = 0` (eksplisit, default) — hindari
     reclaim-dan-eksekusi yang membebani path request pada NUMA.
   - Terapkan dengan `sysctl --system` (bukan `sysctl -p`).
3. **journald** — batasi `SystemMaxUse=100M` (sudah ada), tambahkan
   `MaxRetentionSec=1month` (opsional), `SystemKeepFree` aman. Tidak wajib;
   hanya bila disk menjauh.
4. **Verifikasi pasca-perubahan**:
   - `sysctl vm.swappiness vm.zone_reclaim_mode` — nilai baru persisten.
   - Health gateway & OmniRoute tetap 200; `ss -tlnp` loopback tidak berubah.
   - Sampling lanjutan (5 menit) untuk memastikan `max`/`sock_throttled` tidak
     melonjak; `RestartCount` tetap 0.
5. **Dokumentasi** — catat temuan & tindakan di Notion
   (halaman `OmniRoute VPS — router.leuwongrr.cloud`, id
   `64b9024a-bd24-82cf-9bcd-01dc137225b0`).

## 5. Non-target (explicitly ditunda)

- Menaikkan `mem_limit` OmniRoute ke `1600m`: **ditunda** sampai host
  `available` membaik dan soak Gateway ditutup (keputusan sebelumnya tetap).
- Mengubah routing/`OMNI_MAX_CONCURRENT_CONNECTIONS`, healthcheck interval,
  mode provider, atau batas CPU container.
- Restart container OmniRoute, upgrade image, edit compose.

## 6. Risiko dan mitigasi

| Risiko | Mitigasi |
|---|---|
| `swappiness=20` menambah pemakaian swap host | Pemakaian anon OmniRoute tinggi; swap sudah dipakai. Batas 8 GiB; pantau `free -m` & `memory.swap.current` pasca-perubahan. |
| Perubahan host berdampak pada proses berjalan | Sysctl berlaku tanpa restart; semua reversibel dengan menulis ulang konfigurasi. |
| Sampling menambah beban | Sampling 1×/60 detik, `cat`/`grep` ringan; tidak ada proses tambahan di container. |
| Perubahan journald menggeser log | Ukur disk sebelum; `SystemMaxUse` sudah 100M; tidak menyentuh log Docker (rotasi 3×10 MiB sudah aktif). |
| Validasi `git status` & protokol repo | Spec ditulis di workstation, bukan di host; tidak ada perubahan repo di host. |

## 7. Verifikasi kelayakan

- `npm run validate` **tidak** diperlukan untuk perubahan ops host (di luar
  scope repo). Spec repo: commit + push ke `main` dengan pesan deskriptif.
- Evidence akhir: output perintah di atas + catatan Notion.

## 8. Hasil eksekusi (2 Agustus 2026)

### 8.1 Sampling baseline 60 menit (CSV `2026-08-02-omni-sample.csv`)
- 60 sampel `memory.current` OmniRoute: **min 1318 MiB, max 1400 MiB,
  rata-rata 1357 MiB** (plafon 1400m = 1367 MiB, ~96–97%).
- `memory.events max` bertambah dari `0` (pasca-restart 13:51:30Z) menjadi
  **2784** selama jendela; `sock_throttled` naik ke **152**.
- `memory.swap.current` stabil ≈ **363–380 MiB** — sebagian besar anon
  OmniRoute tinggal di swap host.
- Host `available` ≈ 147–283 MiB; load1 < 1 sepanjang jendela.
- Kesimpulan: tekanan bersifat **memori (cgroup plafon), bukan CPU**. CPU
  container jarang throttle (1,6% period) dan load host rendah.

### 8.2 Perubahan yang diterapkan (reversibel, sudah berjalan)
- `/etc/sysctl.d/99-sysctl-leuwongrr-stability.conf` (root, 234 byte):
  `vm.swappiness = 20`, `vm.zone_reclaim_mode = 0`.
- `sysctl --system` → nilai aktif `vm.swappiness = 20`,
  `vm.zone_reclaim_mode = 0`; bertahan (verifikasi ulang 22:03 WIB).
- Tidak ada perubahan compose/env/secret OmniRoute; tidak ada restart
  container; gateway tidak disentuh.

### 8.3 Sampling pasca-perubahan (5 menit, `omni-post-20260802.csv`)
- `memory.current` ≈ 1429–1444 MiB; `max` naik tipis 2784 → **2827**
  (cgroup tetap menyentuh plafon; swappiness tidak mengubah footprint anon).
- `sock_throttled` datar di **152**; swap ≈ 363–368 MiB; host `available`
  ≈ 202–222 MiB. Tidak ada gejolak.

### 8.4 SIGTERM anonim 13:51:28Z (restart count 0 → 1)
- Log container: `Received SIGTERM. Draining 0 request(s)…` → `Bye.`,
  exit 0, `oom=false`, `manualRestart=false`, restart policy `unless-stopped`.
- Bukan operator: tidak ada `docker stop/restart` di `auth.log`/sudo journal
  20:50–20:51 WIB; hanya sesi SSH penulis menjalankan `docker inspect`.
- Bukan OOM kernel (dmesg bersih), bukan restart dockerd (`NRestarts=0`),
  bukan healthcheck (semua `exit 0`, tidak pernah `unhealthy`).
- Ini kejadian kedua (pertama: 02:32Z 31 Juli). **Pengirim belum
  teridentifikasi** — rekomendasi: pasang `auditd` (watch syscall `kill`)
  sebelum kejadian berikutnya.

### 8.5 Status akhir
- Gateway `api.leuwongrr.cloud`: `/health/live` 200, `/health/ready` 404,
  `/v1/models` 401 — tidak berubah.
- OmniRoute `router.leuwongrr.cloud`: `health=healthy`, `RestartCount=1`
  (sejak 13:51:30Z), `/api/monitoring/health` 200.
- `journald` sudah `SystemMaxUse=100M`; disk log 65 MB.
- Perbaikan struktural (naikkan `mem_limit` 1400m→1600m) **tetap ditunda**
  — host `available` hanya ±200 MiB dan soak Gateway belum ditutup; risiko
  dialihkan ke OOM killer kernel.
