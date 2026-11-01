# IZI DevSpace

Browser custom berbasis engine **Chromium** (lewat Electron 45 / Chromium 142) dengan UI sendiri: Space & Group di sidebar, tool developer di toolbar, dan **MCP Server** bawaan agar agen AI (Claude Code, Claude Desktop, Cursor, dll.) bisa mengendalikan browser.

Konsep MCP terinspirasi dari [BrowserOS](https://github.com/browseros-ai/BrowserOS). Tidak ada kode BrowserOS (AGPL-3.0) yang disalin.

## Fitur

| Area | Fitur |
|---|---|
| **Sidebar** | **Space** (lingkaran atas, misalnya Personal / Work). Tiap Space punya cookie & login terpisah (`persist:space-<id>`). **Add Space** memakai nama, huruf/emoji/simbol, dan warna. Di bawahnya ada **Group** (kotak) dan **Add Group**. Klik kanan untuk Edit / Delete / Move to Space |
| **Sidebar bawah** | Search (Ctrl+K, cari tab, URL, dan perintah), Tab list, Notes per Space, Light/Dark, **MCP Server**, Settings |
| **Toolbar** | `</>` **DevTools** (menempel di kanan halaman), 📱 **Mobile View** (iPhone/Pixel/Galaxy/iPad, rotate, UA dan touch emulation), 📷 **Capture Full Page** (PNG ke `Downloads/IZI DevSpace Captures` dan clipboard), **Fake Fill** (mengisi form dengan data palsu yang realistis), 🔧 Tools (zoom, find, print, PDF, clear data), ◫ **Dock Tab** (split view 2 tab), zᶻ **Sleep Tab** |
| **Sleep Tab** | Tab tidur melepas memori tapi riwayat back/forward tetap tersimpan. Ada auto-sleep (default 30 menit, bisa diatur). Saat startup hanya tab aktif yang dimuat |
| **Tab** | Drag untuk mengurutkan, pin, duplicate, pindah ke Group lain, reopen closed (Ctrl+Shift+T), middle-click untuk menutup |
| **New Tab** | Latar gelombang (5 tema: teal/ocean/sunset/forest/mono, animasi bisa dimatikan), pencarian, shortcut. Diatur lewat tombol **Customize** |
| **MCP Server** | `http://127.0.0.1:9420/mcp` (Streamable HTTP), 23 tool. Bearer token opsional, plus proteksi DNS-rebinding/origin |

### Tool MCP
`list_spaces`, `list_tabs`, `get_active_tab`, `open_tab`, `switch_tab`, `close_tab`, `navigate`, `history`, `get_page_text`, `snapshot`, `click`, `type`, `press_key`, `scroll`, `evaluate`, `screenshot`, `wait_for`, `capture_full_page`, `fake_fill`, `mobile_view`, `sleep_tab`, `dock_tab`, `create_group`

Alur yang umum: `open_tab` → `snapshot` (daftar elemen berisi nomor `ref`) → `click`/`type` memakai `ref` → `get_page_text`/`screenshot`.

## Menjalankan

```bash
npm install
npm start
```

Butuh Node.js 20 atau lebih baru. Di Linux sebagai root tambahkan `-- --no-sandbox`.

### Menghubungkan agen AI
Buka panel **MCP Server** (ikon colokan di sidebar). Di sana tersedia snippet siap salin, contohnya:

```bash
claude mcp add --transport http izi-devspace http://127.0.0.1:9420/mcp
```

### Tes end-to-end
Jalankan browser-nya, lalu:

```bash
npm run test:smoke
```

Tes ini mengendalikan browser lewat MCP: buka form → fake fill → type → click → screenshot → capture → mobile → dock → sleep.

## Build installer

```bash
npm run dist:win     # .exe (NSIS) + .zip
npm run dist:mac     # .dmg
npm run dist:linux   # AppImage + .deb
```

Untuk build silang Windows dari Linux tanpa wine, tambahkan `-c.win.signAndEditExecutable=false` (ikon .exe tidak ikut diterapkan). Cara yang paling bersih: push tag `v*` dan GitHub Actions (`.github/workflows/build.yml`) akan mem-build installer untuk Windows, macOS, dan Linux.

## Struktur

```
src/main/main.js          entry: protocol izi://, user-agent, single instance
src/main/browser.js       window, tab views, Space/Group, layout (split, devtools, mobile), sleep, menu, shortcut
src/main/features.js      device preset, capture full page (CDP), script Fake Fill, snapshot elemen
src/main/mcp-server.js    MCP server (Streamable HTTP) dan 23 tool
src/main/store.js         state persisten (userData/devspace-state.json)
src/renderer/ui/          UI chrome (sidebar, tabstrip, toolbar, panel, modal)
src/renderer/newtab/      halaman New Tab (gelombang + Customize)
scripts/smoke-test.js     tes end-to-end lewat MCP
```

## Shortcut

`Ctrl+T` tab baru · `Ctrl+W` tutup · `Ctrl+Shift+T` buka lagi · `Ctrl+L` address · `Ctrl+K` search · `Ctrl+F` find · `Ctrl+Tab` / `Ctrl+1…9` pindah tab · `F12` DevTools · `Ctrl+Shift+M` Mobile · `Ctrl+Shift+S` Capture · `Alt+←/→` back/forward · `Ctrl+= / - / 0` zoom

## Catatan / batasan

- Engine-nya Chromium asli (Blink + V8). Ini **bukan** fork Chromium seperti BrowserOS, jadi build-nya cepat (beberapa menit, bukan berjam-jam dengan source 100GB+).
- Login Google kadang menolak browser berbasis Electron ("browser may not be secure"). Situs lain normal.
- Dukungan Chrome extension di Electron terbatas, jadi belum diaktifkan.
