# IZI DevSpace — Zen/Firefox edition (branch `zen`)

Versi IZI DevSpace berbasis **[Zen Browser](https://github.com/zen-browser/desktop)** (engine Firefox/Gecko).
Branch `main` berisi versi Electron (Chromium).

- Basis: `zen-browser/desktop@147e6ebb2ebf` (Firefox 159.0)
- Lisensi: **MPL-2.0** (sama dengan Zen). Lihat `LICENSE`; README asli Zen ada di `docs/ZEN-README.md`.
- IZI DevSpace bukan produk resmi Zen; nama dan logo Zen sudah diganti.

## Status

| Tahap | Isi | Status |
|---|---|---|
| 1 | Rebrand (nama, logo, server update dimatikan, profil terpisah dari Zen) + build Windows x64 di GitHub Actions | ✅ selesai (build pertama ±2 jam, berikutnya ±20–35 menit dengan sccache) |
| 2 | UI IZI DevSpace: sidebar Space/Group gaya kotak, toolbar 7 ikon, New Tab gelombang | ⏳ |
| 3 | Fake Fill + MCP Server | ⏳ |

## Build Windows

Otomatis lewat `.github/workflows/izi-windows-build.yml` setiap push ke branch `zen`
(atau Actions → *Zen Windows build* → *Run workflow*). Hasil: artifact **IZI-DevSpace-Windows-x64**
berisi `IZI-DevSpace-Setup-x64.exe` dan versi portable `.zip`.

Build pertama ±3–6 jam (runner gratis 4-core, tanpa PGO/LTO). Build berikutnya lebih cepat berkat sccache.
Jika build pertama kena batas 6 jam, cukup *Re-run* — bagian yang sudah dikompilasi diambil dari cache.

## Perbedaan dari Zen

- `surfer.json`: nama/vendor/brand → IZI DevSpace, repo update → izidev651/IZI-DevSpace, `updateHostname` → `updates.invalid` (tidak pernah mengambil update Zen resmi)
- `configs/common/mozconfig`: basename `IZIDevSpace` (profil terpisah dari Zen), `IZI_FAST_BUILD` melewati clang-plugin
- `configs/branding/*`: logo IZI DevSpace
- Workflow Zen diganti satu workflow Windows untuk runner gratis
