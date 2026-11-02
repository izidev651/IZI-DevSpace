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
| 2 | UI IZI DevSpace: strip Space (container) / Group (workspace), tab strip horizontal, toolbar (DevTools, Mobile, Capture, Tools, Dock, Sleep), New Tab gelombang, tema gelap | ✅ selesai — dicek otomatis di Windows (20 cek, `scripts/izi_preview.py`) |
| 3 | Fake Fill (tombol toolbar + tool MCP) dan MCP Server bawaan (23 tool, panel di ikon colokan) | ✅ selesai |

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

## MCP Server

Klik ikon **colokan** di strip kiri → nyalakan. Server berjalan di `http://127.0.0.1:9420/mcp`
(hanya localhost; Host/Origin dicek; token Bearer opsional). Default **mati**.

```bash
claude mcp add --transport http izi-devspace http://127.0.0.1:9420/mcp
```

Tool: `list_spaces`, `list_tabs`, `get_active_tab`, `open_tab`, `switch_tab`, `close_tab`, `navigate`,
`history`, `get_page_text`, `snapshot`, `click`, `type`, `press_key`, `scroll`, `evaluate`, `screenshot`,
`wait_for`, `capture_full_page`, `fake_fill`, `mobile_view`, `sleep_tab`, `dock_tab`, `create_group`.
Klik/ketik memakai event *trusted* (windowUtils / nsITextInputProcessor).

Kode: `src/zen/izi/IZIMcpServer.sys.mjs` (server), `IZIDevSpaceChild.sys.mjs` (actor di halaman: Fake Fill,
snapshot, klik, ketik, evaluate), `IZIDevSpaceUI.mjs` (UI).
