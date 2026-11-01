'use strict';
// Core browser controller: window, UI view, tab views, spaces/groups, layout and actions.
const path = require('path');
const fs = require('fs');
const {
  app, BaseWindow, WebContentsView, ipcMain, session, Menu, clipboard, shell, nativeImage, dialog, net,
} = require('electron');
const { pathToFileURL } = require('url');
const { uid } = require('./store');
const F = require('./features');

const SIDEBAR_W = 70;
const TOP_H = 84; // tab strip (42) + toolbar (42)
const PAD = 8;
const GAP = 8;
const FIND_H = 40;
const DEVICE_BAR_H = 36;
const NEWTAB_URL = 'tide://newtab/';
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const isNewTab = (url) => !url || url.startsWith('tide://newtab');

class Browser {
  constructor(store) {
    this.store = store;
    this.rt = new Map(); // tabId -> runtime info
    this.sessions = new Map();
    this.overlay = false;
    this.find = { open: false, text: '', active: 0, matches: 0 };
    this.closed = []; // recently closed tabs
    this.permissionMemo = new Map();
    this.mcpLog = [];
    this.mcp = null; // set by McpController
    this._stateTimer = null;
    this.lastLayout = null;
  }

  // ---------------- lookup helpers ----------------
  get d() { return this.store.data; }
  space(id) { return this.d.spaces.find((s) => s.id === id); }
  group(id) { return this.d.groups.find((g) => g.id === id); }
  tab(id) { return this.d.tabs.find((t) => t.id === id); }
  activeSpace() { return this.space(this.d.activeSpaceId) || this.d.spaces[0]; }
  spaceGroups(spaceId) { return this.d.groups.filter((g) => g.spaceId === spaceId); }
  groupTabs(groupId) {
    const tabs = this.d.tabs.filter((t) => t.groupId === groupId);
    return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
  }
  activeGroup() {
    const sp = this.activeSpace();
    let g = this.group(sp.activeGroupId);
    if (!g || g.spaceId !== sp.id) {
      g = this.spaceGroups(sp.id)[0] || this.createGroup({ spaceId: sp.id, name: 'Main', silent: true });
      sp.activeGroupId = g.id;
    }
    return g;
  }
  activeTab() {
    const g = this.activeGroup();
    let t = this.tab(g.activeTabId);
    if (!t || t.groupId !== g.id) {
      t = this.groupTabs(g.id)[0] || this.createTab({ groupId: g.id, activate: false, silent: true });
      g.activeTabId = t.id;
    }
    return t;
  }
  spaceOfTab(t) { const g = this.group(t.groupId); return g ? this.space(g.spaceId) : null; }
  runtime(id) {
    if (!this.rt.has(id)) this.rt.set(id, { view: null, devtools: null, loading: false, mobile: null, lastActive: Date.now(), audible: false, crashed: false, history: null, zoom: 0 });
    return this.rt.get(id);
  }

  // ---------------- init ----------------
  init() {
    const bounds = this.d.window || { width: 1400, height: 900 };
    const isMac = process.platform === 'darwin';
    this.win = new BaseWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 420,
      show: false,
      title: 'Tide Browser',
      backgroundColor: this.bgColor(),
      titleBarStyle: 'hidden',
      ...(isMac ? { trafficLightPosition: { x: 12, y: 14 } } : { frame: false }),
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    });
    if (this.d.window?.maximized) this.win.maximize();

    this.ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-ui.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(path.join(RENDERER_DIR, 'ui', 'index.html'));
    this.ui.webContents.on('before-input-event', (e, input) => this.handleShortcut(e, input, true));
    this.ui.webContents.once('did-finish-load', () => {
      this.win.show();
      this.layout();
      this.sendState();
    });

    const persistBounds = () => {
      if (this.win.isDestroyed()) return;
      const maximized = this.win.isMaximized();
      this.d.window = { ...(maximized ? this.d.window || {} : this.win.getNormalBounds()), maximized };
      this.store.save();
    };
    this.win.on('resize', () => { this.layout(); persistBounds(); });
    this.win.on('move', persistBounds);
    this.win.on('maximize', () => this.changed());
    this.win.on('unmaximize', () => this.changed());
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => this.layout());
    this.win.on('closed', () => { this.store.flush(); app.quit(); });

    this.setupIpc();
    // Show the active tab right away; everything else stays asleep until used.
    this.activateTab(this.activeTab().id);
    this.autoSleepTimer = setInterval(() => this.autoSleep(), 60 * 1000);
  }

  bgColor() { return this.d.settings.theme === 'light' ? '#e9edf1' : '#0d1218'; }

  // ---------------- sessions ----------------
  sessionFor(spaceId) {
    if (this.sessions.has(spaceId)) return this.sessions.get(spaceId);
    const ses = session.fromPartition(`persist:space-${spaceId}`);
    ses.setUserAgent(app.userAgentFallback);
    ses.protocol.handle('tide', (req) => {
      const u = new URL(req.url);
      const root = path.join(RENDERER_DIR, u.hostname);
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    ses.setPermissionRequestHandler((wc, permission, callback, details) => this.onPermission(wc, permission, callback, details));
    ses.on('will-download', (_e, item) => this.onDownload(item));
    this.sessions.set(spaceId, ses);
    return ses;
  }

  async onPermission(wc, permission, callback, details) {
    const always = ['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'keyboardLock', 'window-management'];
    if (always.includes(permission)) return callback(true);
    if (wc?.getURL().startsWith('tide://')) return callback(true);
    let origin = '';
    try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
    const key = `${origin}|${permission}`;
    if (this.permissionMemo.has(key)) return callback(this.permissionMemo.get(key));
    const labels = { media: 'use your camera/microphone', geolocation: 'know your location', notifications: 'show notifications', 'clipboard-read': 'read your clipboard', midi: 'use MIDI devices', midiSysex: 'use MIDI devices', openExternal: 'open an external application' };
    const { response, checkboxChecked } = await dialog.showMessageBox(this.win, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
      message: `${origin} wants to ${labels[permission] || permission}`,
      checkboxLabel: 'Remember for this session', checkboxChecked: true,
    });
    const ok = response === 0;
    if (checkboxChecked) this.permissionMemo.set(key, ok);
    callback(ok);
  }

  onDownload(item) {
    const dir = app.getPath('downloads');
    const base = item.getFilename();
    let target = path.join(dir, base);
    const ext = path.extname(base);
    for (let i = 1; fs.existsSync(target); i++) target = path.join(dir, `${path.basename(base, ext)} (${i})${ext}`);
    item.setSavePath(target);
    this.toast({ message: `Downloading ${path.basename(target)}…` });
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        this.toast({ message: `Downloaded ${path.basename(target)}`, actions: [
          { label: 'Open', action: { type: 'file:open', path: target } },
          { label: 'Show in folder', action: { type: 'file:reveal', path: target } },
        ] });
      } else {
        this.toast({ message: `Download ${state}: ${path.basename(target)}`, kind: 'error' });
      }
    });
  }

  // ---------------- tab views ----------------
  ensureView(t) {
    const r = this.runtime(t.id);
    if (r.view) return r.view;
    const sp = this.spaceOfTab(t);
    const view = new WebContentsView({
      webPreferences: {
        session: this.sessionFor(sp.id),
        preload: path.join(__dirname, 'preload-tab.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setBorderRadius?.(8);
    r.view = view;
    r.crashed = false;
    r.spaceId = sp.id;
    this.wireTab(t, view.webContents);
    const history = r.history;
    r.history = null;
    if (history?.entries?.length && view.webContents.navigationHistory?.restore) {
      view.webContents.navigationHistory.restore(history).catch(() => view.webContents.loadURL(t.url || NEWTAB_URL));
    } else {
      view.webContents.loadURL(t.url || NEWTAB_URL).catch(() => {});
    }
    if (r.zoom) view.webContents.setZoomLevel(r.zoom);
    return view;
  }

  wireTab(t, wc) {
    const r = this.runtime(t.id);
    const upd = () => this.changed();
    wc.on('page-title-updated', (_e, title) => { t.title = title; upd(); });
    wc.on('page-favicon-updated', (_e, favs) => { t.favicon = favs?.[0] || null; upd(); });
    wc.on('did-start-loading', () => { r.loading = true; upd(); });
    wc.on('did-stop-loading', () => { r.loading = false; upd(); });
    wc.on('did-navigate', (_e, url) => {
      t.url = url;
      if (isNewTab(url)) { t.title = 'New tab'; t.favicon = null; }
      if (this.find.open && this.activeTab().id === t.id) this.closeFind();
      upd();
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { t.url = url; upd(); } });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3) return; // -3 = aborted
      wc.executeJavaScript(`document.body && (document.body.innerHTML = ${JSON.stringify(
        `<div style="font:15px system-ui;color:#9fb3c8;background:#0b1016;position:fixed;inset:0;display:grid;place-items:center;text-align:center"><div><div style="font-size:42px">🌊</div><h2 style="color:#e6edf3;margin:12px 0 6px">This page can't be reached</h2><div>${desc} (${code})</div><div style="opacity:.6;margin-top:6px;word-break:break-all">${String(url).replace(/</g, '&lt;')}</div></div></div>`,
      )})`).catch(() => {});
    });
    wc.on('audio-state-changed', (e) => { r.audible = !!e.audible; upd(); });
    wc.on('render-process-gone', () => { r.crashed = true; upd(); });
    wc.on('found-in-page', (_e, res) => {
      if (res.finalUpdate) { this.find.active = res.activeMatchOrdinal; this.find.matches = res.matches; upd(); }
    });
    wc.on('enter-html-full-screen', () => { r.htmlFullscreen = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { r.htmlFullscreen = false; this.win.setFullScreen(false); this.layout(); });
    wc.on('focus', () => { if (this.overlay) this.setOverlay(false); });
    wc.on('before-input-event', (e, input) => this.handleShortcut(e, input, false));
    wc.on('context-menu', (_e, params) => this.pageContextMenu(t, params));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window' && url === 'about:blank') return { action: 'allow' };
      this.createTab({ groupId: t.groupId, url, activate: disposition !== 'background-tab', after: t.id });
      return { action: 'deny' };
    });
    wc.debugger.on('detach', () => { r.cdpAttached = false; });
  }

  disposeView(t, keepHistory = true) {
    const r = this.rt.get(t.id);
    if (!r?.view) return;
    const wc = r.view.webContents;
    if (keepHistory && !wc.isDestroyed()) {
      try {
        const nh = wc.navigationHistory;
        if (nh?.getAllEntries) r.history = { entries: nh.getAllEntries(), index: nh.getActiveIndex() };
      } catch {}
    }
    this.closeDevtools(t, false);
    try { this.win.contentView.removeChildView(r.view); } catch {}
    try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {}
    try { wc.close(); } catch {}
    r.view = null;
    r.loading = false;
    r.audible = false;
    r.mobileApplied = null;
  }

  // ---------------- tabs ----------------
  createTab({ groupId, url, activate = true, after, silent } = {}) {
    const g = this.group(groupId) || this.activeGroup();
    const t = { id: uid('tab'), groupId: g.id, url: url || NEWTAB_URL, title: isNewTab(url) ? 'New tab' : url, favicon: null, pinned: false };
    const tabs = this.d.tabs;
    const idx = after ? tabs.findIndex((x) => x.id === after) : -1;
    if (idx >= 0) tabs.splice(idx + 1, 0, t); else tabs.push(t);
    this.runtime(t.id);
    if (activate) this.activateTab(t.id);
    else if (!silent) this.changed();
    return t;
  }

  activateTab(id) {
    const t = this.tab(id);
    if (!t) return;
    const g = this.group(t.groupId);
    const sp = this.space(g.spaceId);
    this.d.activeSpaceId = sp.id;
    sp.activeGroupId = g.id;
    g.activeTabId = t.id;
    const r = this.runtime(t.id);
    r.lastActive = Date.now();
    this.ensureView(t);
    if (g.split?.includes(t.id)) g.split.forEach((sid) => { const st = this.tab(sid); if (st) this.ensureView(st); });
    if (this.find.open) this.closeFind();
    this.layout();
    this.changed();
    if (!this.overlay) {
      const wc = r.view.webContents;
      if (isNewTab(t.url)) this.uiCommand({ cmd: 'focusAddress' }); else wc.focus();
    }
  }

  closeTab(id) {
    const t = this.tab(id);
    if (!t) return;
    const g = this.group(t.groupId);
    const siblings = this.groupTabs(g.id);
    const pos = siblings.findIndex((x) => x.id === id);
    if (!isNewTab(t.url)) this.closed.push({ ...t });
    if (this.closed.length > 25) this.closed.shift();
    this.disposeView(t, false);
    this.rt.delete(id);
    this.d.tabs = this.d.tabs.filter((x) => x.id !== id);
    if (g.split?.includes(id)) g.split = null;
    if (g.activeTabId === id) {
      const rest = siblings.filter((x) => x.id !== id);
      const next = rest[pos] || rest[pos - 1];
      if (next) { g.activeTabId = next.id; if (this.activeGroup().id === g.id) return this.activateTab(next.id); }
      else {
        const nt = this.createTab({ groupId: g.id, activate: false, silent: true });
        g.activeTabId = nt.id;
        if (this.activeGroup().id === g.id) return this.activateTab(nt.id);
      }
    }
    this.layout();
    this.changed();
  }

  reopenClosed() {
    const t = this.closed.pop();
    if (!t) return;
    const g = this.group(t.groupId) || this.activeGroup();
    this.createTab({ groupId: g.id, url: t.url });
  }

  sleepTab(id) {
    const t = this.tab(id);
    const r = this.rt.get(id);
    if (!t || !r?.view) return false;
    if (isNewTab(t.url)) { /* nothing worth keeping, still allow */ }
    const g = this.group(t.groupId);
    const wasActive = this.activeTab().id === id;
    this.disposeView(t, true);
    if (wasActive) {
      const others = this.groupTabs(g.id).filter((x) => x.id !== id);
      const awake = others.filter((x) => this.rt.get(x.id)?.view).sort((a, b) => this.runtime(b.id).lastActive - this.runtime(a.id).lastActive);
      const next = awake[0] || others[0];
      if (next) { g.activeTabId = next.id; this.activateTab(next.id); }
    }
    this.layout();
    this.changed();
    return true;
  }

  wakeTab(id) {
    const t = this.tab(id);
    if (!t) return;
    this.ensureView(t);
    this.layout();
    this.changed();
  }

  autoSleep() {
    const mins = Number(this.d.settings.autoSleepMinutes) || 0;
    if (mins <= 0) return;
    const visible = new Set((this.lastLayout?.panes || []).map((p) => p.tabId));
    const cutoff = Date.now() - mins * 60 * 1000;
    for (const t of this.d.tabs) {
      const r = this.rt.get(t.id);
      if (!r?.view || visible.has(t.id) || r.audible || r.devtools || t.pinned) continue;
      if (r.lastActive < cutoff) this.disposeView(t, true);
    }
    this.layout();
    this.changed();
  }

  moveTab(id, toIndex) {
    const t = this.tab(id);
    if (!t) return;
    const siblings = this.groupTabs(t.groupId).filter((x) => x.id !== id && !!x.pinned === !!t.pinned);
    const target = siblings[Math.max(0, Math.min(toIndex, siblings.length))];
    this.d.tabs = this.d.tabs.filter((x) => x.id !== id);
    const idx = target ? this.d.tabs.findIndex((x) => x.id === target.id) : this.d.tabs.length;
    this.d.tabs.splice(idx, 0, t);
    this.changed();
  }

  moveTabToGroup(id, groupId) {
    const t = this.tab(id);
    const g = this.group(groupId);
    if (!t || !g || t.groupId === groupId) return;
    const oldGroup = this.group(t.groupId);
    const wasActive = this.activeTab().id === id;
    const oldSpace = this.spaceOfTab(t);
    if (oldGroup.split?.includes(id)) oldGroup.split = null;
    if (oldSpace.id !== g.spaceId) this.disposeView(t, false); // different session => reload
    if (oldGroup.activeTabId === id) {
      const rest = this.groupTabs(oldGroup.id).filter((x) => x.id !== id);
      oldGroup.activeTabId = rest[0]?.id || this.createTab({ groupId: oldGroup.id, activate: false, silent: true }).id;
    }
    t.groupId = g.id;
    if (wasActive) this.activateTab(oldGroup.activeTabId);
    this.layout();
    this.changed();
  }

  // ---------------- spaces & groups ----------------
  createSpace({ name, icon, color }) {
    const sp = { id: uid('space'), name: name || 'Space', icon: icon || { type: 'letter', value: (name || 'S')[0].toUpperCase() }, color: color || '#1fc7b6' };
    this.d.spaces.push(sp);
    const g = this.createGroup({ spaceId: sp.id, name: 'Main', silent: true });
    sp.activeGroupId = g.id;
    this.activateSpace(sp.id);
    return sp;
  }

  updateSpace({ id, name, icon, color }) {
    const sp = this.space(id);
    if (!sp) return;
    if (name) sp.name = name;
    if (icon) sp.icon = icon;
    if (color) sp.color = color;
    this.changed();
  }

  async deleteSpace(id) {
    if (this.d.spaces.length <= 1) return this.toast({ message: 'You need at least one Space', kind: 'error' });
    const sp = this.space(id);
    const { response } = await dialog.showMessageBox(this.win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete Space "${sp.name}"?`, detail: 'All groups and tabs in this Space will be closed.' });
    if (response !== 0) return;
    for (const g of this.spaceGroups(id)) for (const t of this.groupTabs(g.id)) { this.disposeView(t, false); this.rt.delete(t.id); }
    const gids = new Set(this.spaceGroups(id).map((g) => g.id));
    this.d.tabs = this.d.tabs.filter((t) => !gids.has(t.groupId));
    this.d.groups = this.d.groups.filter((g) => g.spaceId !== id);
    this.d.spaces = this.d.spaces.filter((s) => s.id !== id);
    if (this.d.activeSpaceId === id) this.d.activeSpaceId = this.d.spaces[0].id;
    this.activateTab(this.activeTab().id);
  }

  activateSpace(id) {
    if (!this.space(id)) return;
    this.d.activeSpaceId = id;
    this.activateTab(this.activeTab().id);
  }

  createGroup({ spaceId, name, icon, color, silent }) {
    const sid = spaceId || this.activeSpace().id;
    const g = { id: uid('group'), spaceId: sid, name: name || 'Group', icon: icon || { type: 'letter', value: (name || 'G')[0].toUpperCase() }, color: color || '#1fc7b6', activeTabId: null, split: null };
    this.d.groups.push(g);
    const t = this.createTab({ groupId: g.id, activate: false, silent: true });
    g.activeTabId = t.id;
    if (!silent) this.activateGroup(g.id);
    return g;
  }

  updateGroup({ id, name, icon, color }) {
    const g = this.group(id);
    if (!g) return;
    if (name) g.name = name;
    if (icon) g.icon = icon;
    if (color) g.color = color;
    this.changed();
  }

  async deleteGroup(id) {
    const g = this.group(id);
    if (!g) return;
    const tabs = this.groupTabs(id);
    if (tabs.some((t) => !isNewTab(t.url))) {
      const { response } = await dialog.showMessageBox(this.win, { type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: `Delete group "${g.name}"?`, detail: `${tabs.length} tab(s) will be closed.` });
      if (response !== 0) return;
    }
    for (const t of tabs) { this.disposeView(t, false); this.rt.delete(t.id); }
    this.d.tabs = this.d.tabs.filter((t) => t.groupId !== id);
    this.d.groups = this.d.groups.filter((x) => x.id !== id);
    const sp = this.space(g.spaceId);
    if (!this.spaceGroups(sp.id).length) this.createGroup({ spaceId: sp.id, name: 'Main', silent: true });
    if (sp.activeGroupId === id) sp.activeGroupId = this.spaceGroups(sp.id)[0].id;
    this.activateTab(this.activeTab().id);
  }

  activateGroup(id) {
    const g = this.group(id);
    if (!g) return;
    this.space(g.spaceId).activeGroupId = g.id;
    this.d.activeSpaceId = g.spaceId;
    this.activateTab(this.activeTab().id);
  }

  // ---------------- tools ----------------
  activeWc() {
    const t = this.activeTab();
    const r = this.rt.get(t.id);
    return r?.view?.webContents || null;
  }

  toggleDevtools(t = this.activeTab()) {
    const r = this.runtime(t.id);
    if (r.devtools) return this.closeDevtools(t);
    this.ensureView(t);
    const dt = new WebContentsView();
    dt.setBackgroundColor('#202124');
    dt.setBorderRadius?.(8);
    r.devtools = dt;
    const wc = r.view.webContents;
    wc.setDevToolsWebContents(dt.webContents);
    wc.openDevTools({ mode: 'detach', activate: false });
    wc.once('devtools-closed', () => { if (r.devtools === dt) this.closeDevtools(t); });
    this.layout();
    this.changed();
  }

  closeDevtools(t, relayout = true) {
    const r = this.rt.get(t.id);
    if (!r?.devtools) return;
    const dt = r.devtools;
    r.devtools = null;
    try { r.view?.webContents.closeDevTools(); } catch {}
    try { this.win.contentView.removeChildView(dt); } catch {}
    try { dt.webContents.close(); } catch {}
    if (relayout) { this.layout(); this.changed(); }
  }

  async toggleMobile(t = this.activeTab(), deviceId) {
    const r = this.runtime(t.id);
    this.ensureView(t);
    const wc = r.view.webContents;
    if (r.mobile && !deviceId) {
      r.mobile = null;
      r.mobileApplied = null;
      try {
        await F.cdp(wc, 'Emulation.clearDeviceMetricsOverride');
        await F.cdp(wc, 'Emulation.setTouchEmulationEnabled', { enabled: false });
        await F.cdp(wc, 'Emulation.setEmitTouchEventsForMouse', { enabled: false });
      } catch {}
      wc.setUserAgent(app.userAgentFallback);
      this.layout();
      wc.reload();
    } else {
      const id = deviceId || this.d.settings.mobileDevice;
      const dev = F.DEVICES[id] || F.DEVICES['iphone-15-pro'];
      if (deviceId) { this.d.settings.mobileDevice = deviceId; }
      r.mobile = { id, ...dev };
      r.mobileApplied = null;
      wc.setUserAgent(dev.ua);
      try {
        await F.cdp(wc, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        await F.cdp(wc, 'Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      } catch (err) { console.warn('[mobile]', err.message); }
      this.layout();
      wc.reload();
    }
    this.changed();
  }

  async applyMobileMetrics(t, w, h) {
    const r = this.rt.get(t.id);
    if (!r?.view || !r.mobile) return;
    const key = `${r.mobile.id}:${w}x${h}`;
    if (r.mobileApplied === key) return;
    r.mobileApplied = key;
    try {
      await F.cdp(r.view.webContents, 'Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: r.mobile.dpr, mobile: true });
    } catch (err) { console.warn('[mobile metrics]', err.message); }
  }

  async capture(t = this.activeTab()) {
    const r = this.rt.get(t.id);
    if (!r?.view) return this.toast({ message: 'Tab is sleeping — wake it first', kind: 'error' });
    this.toast({ message: 'Capturing full page…' });
    try {
      const { buffer, width, height } = await F.captureFullPage(r.view.webContents);
      const dir = path.join(app.getPath('downloads'), 'Tide Captures');
      fs.mkdirSync(dir, { recursive: true });
      let host = 'page';
      try { host = new URL(t.url).hostname.replace(/[^\w.-]/g, '') || 'page'; } catch {}
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = path.join(dir, `${host}-${stamp}.png`);
      fs.writeFileSync(file, buffer);
      try { clipboard.writeImage(nativeImage.createFromBuffer(buffer)); } catch {}
      this.toast({ message: `Full page captured (${width}×${height}) · copied to clipboard`, actions: [
        { label: 'Open', action: { type: 'file:open', path: file } },
        { label: 'Show in folder', action: { type: 'file:reveal', path: file } },
      ] });
      return file;
    } catch (err) {
      this.toast({ message: 'Capture failed: ' + err.message, kind: 'error' });
      return null;
    }
  }

  async fakeFill(t = this.activeTab()) {
    const r = this.rt.get(t.id);
    if (!r?.view) return 0;
    try {
      const n = await F.fakeFill(r.view.webContents);
      this.toast({ message: n ? `Fake Fill: ${n} field(s) filled` : 'Fake Fill: no fillable fields found' });
      return n;
    } catch (err) {
      this.toast({ message: 'Fake Fill failed: ' + err.message, kind: 'error' });
      return 0;
    }
  }

  dock(otherId) {
    const t = this.activeTab();
    const g = this.group(t.groupId);
    if (otherId === null) { g.split = null; }
    else if (otherId === 'swap' && g.split) { g.split = [g.split[1], g.split[0]]; }
    else {
      const other = otherId === 'new' ? this.createTab({ groupId: g.id, activate: false, after: t.id }) : this.tab(otherId);
      if (!other || other.id === t.id) return;
      g.split = [t.id, other.id];
      this.ensureView(other);
    }
    this.layout();
    this.changed();
  }

  dockMenu(pos) {
    const t = this.activeTab();
    const g = this.group(t.groupId);
    const items = [];
    if (g.split?.includes(t.id)) {
      items.push({ label: 'Undock (close split view)', click: () => this.dock(null) });
      items.push({ label: 'Swap sides', click: () => this.dock('swap') });
    } else {
      items.push({ label: 'Dock beside current tab:', enabled: false });
      for (const o of this.groupTabs(g.id)) {
        if (o.id === t.id) continue;
        items.push({ label: `   ${(o.title || o.url).slice(0, 60)}`, click: () => this.dock(o.id) });
      }
      items.push({ type: 'separator' }, { label: 'Dock a new tab', click: () => this.dock('new') });
    }
    Menu.buildFromTemplate(items).popup({ window: this.win, ...pos });
  }

  toolsMenu(pos) {
    const t = this.activeTab();
    const wc = this.activeWc();
    const r = this.runtime(t.id);
    const zoom = (delta) => { if (!wc) return; r.zoom = delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta)); wc.setZoomLevel(r.zoom); this.toast({ message: `Zoom ${Math.round(Math.pow(1.2, r.zoom) * 100)}%` }); };
    const template = [
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5), enabled: !!wc },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5), enabled: !!wc },
      { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => zoom(0), enabled: !!wc },
      { type: 'separator' },
      { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', click: () => this.openFind() },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => wc?.print(), enabled: !!wc },
      { label: 'Save Page as PDF…', click: () => this.savePdf(), enabled: !!wc },
      { label: 'Copy Page URL', click: () => clipboard.writeText(t.url || '') },
      { type: 'separator' },
      { label: 'Sleep Other Tabs in Group', click: () => this.groupTabs(t.groupId).forEach((x) => x.id !== t.id && this.sleepTab(x.id)) },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => this.reopenClosed(), enabled: this.closed.length > 0 },
      { label: 'Clear Browsing Data (this Space)…', click: () => this.clearData() },
      { type: 'separator' },
      { label: 'Open App Data Folder', click: () => shell.openPath(app.getPath('userData')) },
    ];
    Menu.buildFromTemplate(template).popup({ window: this.win, ...pos });
  }

  async savePdf() {
    const wc = this.activeWc();
    if (!wc) return;
    const t = this.activeTab();
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, { defaultPath: path.join(app.getPath('downloads'), `${(t.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (canceled || !filePath) return;
    const data = await wc.printToPDF({ printBackground: true });
    fs.writeFileSync(filePath, data);
    this.toast({ message: 'Saved PDF', actions: [{ label: 'Open', action: { type: 'file:open', path: filePath } }] });
  }

  async clearData() {
    const sp = this.activeSpace();
    const { response } = await dialog.showMessageBox(this.win, { type: 'warning', buttons: ['Clear', 'Cancel'], defaultId: 1, cancelId: 1, message: `Clear cookies, cache and storage for Space "${sp.name}"?` });
    if (response !== 0) return;
    const ses = this.sessionFor(sp.id);
    await ses.clearStorageData();
    await ses.clearCache();
    this.toast({ message: 'Browsing data cleared' });
  }

  // ---------------- find ----------------
  openFind() { this.find.open = true; this.layout(); this.changed(); this.uiCommand({ cmd: 'focusFind' }); }
  closeFind() {
    this.find = { open: false, text: '', active: 0, matches: 0 };
    try { this.activeWc()?.stopFindInPage('clearSelection'); } catch {}
    this.layout();
    this.changed();
  }
  doFind({ text, forward = true, findNext = false }) {
    const wc = this.activeWc();
    this.find.text = text;
    if (!wc) return;
    if (!text) { wc.stopFindInPage('clearSelection'); this.find.matches = 0; this.find.active = 0; return this.changed(); }
    wc.findInPage(text, { forward, findNext });
  }

  // ---------------- layout ----------------
  setOverlay(open) {
    if (this.overlay === open) return;
    this.overlay = open;
    if (open) {
      this.win.contentView.addChildView(this.ui); // bring UI to the top
      this.ui.webContents.focus();
    } else {
      this.layout(true);
    }
    this.changed();
  }

  layout(reorder = false) {
    if (!this.win || this.win.isDestroyed()) return;
    const [W, H] = this.win.getContentSize();
    this.ui.setBounds({ x: 0, y: 0, width: W, height: H });
    const t = this.activeTab();
    const g = this.group(t.groupId);
    const rt = this.runtime(t.id);

    let content = { x: SIDEBAR_W + PAD, y: TOP_H + PAD, width: W - SIDEBAR_W - PAD * 2, height: H - TOP_H - PAD * 2 };
    if (this.find.open) { content.y += FIND_H; content.height -= FIND_H; }
    const fullscreen = rt.htmlFullscreen;
    if (fullscreen) content = { x: 0, y: 0, width: W, height: H };

    const split = !fullscreen && g.split && g.split.includes(t.id) && g.split.every((id) => this.tab(id)) ? g.split : null;
    const paneTabs = split ? split.map((id) => this.tab(id)) : [t];
    const panes = [];
    const pw = split ? Math.floor((content.width - GAP) / 2) : content.width;
    paneTabs.forEach((pt, i) => {
      const rect = { x: content.x + i * (pw + GAP), y: content.y, width: i === 1 ? content.width - pw - GAP : pw, height: content.height };
      panes.push(this.layoutPane(pt, rect, fullscreen));
    });

    const visibleViews = new Set();
    for (const p of panes) {
      const r = this.runtime(p.tabId);
      if (r.view && p.page) { r.view.setBounds(p.page); r.view.setBorderRadius?.(fullscreen ? 0 : 8); visibleViews.add(r.view); }
      if (r.devtools && p.devtools) { r.devtools.setBounds(p.devtools); visibleViews.add(r.devtools); }
    }
    const children = new Set(this.win.contentView.children);
    for (const [, r] of this.rt) {
      for (const v of [r.view, r.devtools]) {
        if (!v) continue;
        if (visibleViews.has(v)) {
          if (!children.has(v) || reorder) this.win.contentView.addChildView(v);
        } else if (children.has(v)) {
          this.win.contentView.removeChildView(v);
        }
      }
    }
    if (this.overlay) this.win.contentView.addChildView(this.ui);
    this.lastLayout = { content, panes, split: !!split, fullscreen: !!fullscreen };
  }

  layoutPane(t, rect, fullscreen) {
    const r = this.runtime(t.id);
    const pane = { tabId: t.id, rect, page: null, devtools: null, mobile: null, sleeping: !r.view };
    if (!r.view) return pane;
    let pageArea = { ...rect };
    if (r.devtools && !fullscreen) {
      const dw = Math.round(Math.max(320, Math.min(rect.width * 0.42, rect.width - 260)));
      pageArea = { ...rect, width: rect.width - dw - GAP };
      pane.devtools = { x: rect.x + pageArea.width + GAP, y: rect.y, width: dw, height: rect.height };
    }
    if (r.mobile && !fullscreen) {
      const availH = pageArea.height - DEVICE_BAR_H - PAD;
      const w = Math.max(200, Math.min(r.mobile.width, pageArea.width - PAD * 2));
      const h = Math.max(200, Math.min(r.mobile.height, availH));
      pane.page = { x: Math.round(pageArea.x + (pageArea.width - w) / 2), y: pageArea.y + DEVICE_BAR_H, width: w, height: h };
      pane.mobile = { id: r.mobile.id, name: r.mobile.name, width: w, height: h, area: pageArea };
      this.applyMobileMetrics(t, w, h);
    } else {
      pane.page = pageArea;
    }
    return pane;
  }

  // ---------------- context menus ----------------
  pageContextMenu(t, p) {
    const wc = this.rt.get(t.id)?.view?.webContents;
    if (!wc) return;
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.createTab({ groupId: t.groupId, url: p.linkURL, after: t.id }) },
        { label: 'Open Link in Background Tab', click: () => this.createTab({ groupId: t.groupId, url: p.linkURL, after: t.id, activate: false }) },
        { label: 'Open Link in Split View', click: () => { const nt = this.createTab({ groupId: t.groupId, url: p.linkURL, after: t.id, activate: false }); this.dock(nt.id); } },
        { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.createTab({ groupId: t.groupId, url: p.srcURL, after: t.id }) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Save Image', click: () => wc.downloadURL(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }, { label: 'Fake Fill Form', click: () => this.fakeFill(t) }, { type: 'separator' });
    } else if (p.selectionText) {
      const sel = p.selectionText.trim().slice(0, 40);
      items.push({ role: 'copy' }, { label: `Search for “${sel}”`, click: () => this.createTab({ groupId: t.groupId, url: F.resolveInput(p.selectionText, this.d.settings.searchEngine), after: t.id }) }, { type: 'separator' });
    }
    const nh = wc.navigationHistory;
    items.push(
      { label: 'Back', enabled: nh.canGoBack(), click: () => nh.goBack() },
      { label: 'Forward', enabled: nh.canGoForward(), click: () => nh.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Capture Full Page', click: () => this.capture(t) },
      { label: 'Save Page as PDF…', click: () => this.savePdf() },
      { type: 'separator' },
      { label: 'Inspect', click: () => { if (!this.runtime(t.id).devtools) this.toggleDevtools(t); setTimeout(() => wc.inspectElement(p.x, p.y), 150); } },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  tabMenu(id, pos) {
    const t = this.tab(id);
    if (!t) return;
    const r = this.runtime(id);
    const g = this.group(t.groupId);
    const otherGroups = this.d.groups.filter((x) => x.id !== g.id);
    const template = [
      { label: 'New Tab to the Right', click: () => this.createTab({ groupId: g.id, after: id }) },
      { label: 'Reload', enabled: !!r.view, click: () => r.view?.webContents.reload() },
      { label: 'Duplicate', click: () => this.createTab({ groupId: g.id, url: t.url, after: id }) },
      { label: t.pinned ? 'Unpin Tab' : 'Pin Tab', click: () => { t.pinned = !t.pinned; this.changed(); } },
      { type: 'separator' },
      r.view ? { label: 'Sleep Tab', click: () => this.sleepTab(id) } : { label: 'Wake Tab', click: () => this.wakeTab(id) },
      { label: 'Dock Beside Active Tab', enabled: this.activeTab().id !== id, click: () => this.dock(id) },
      { label: 'Move to Group', submenu: otherGroups.length ? otherGroups.map((og) => ({ label: `${this.space(og.spaceId)?.name} › ${og.name}`, click: () => this.moveTabToGroup(id, og.id) })) : [{ label: 'No other groups', enabled: false }] },
      { label: 'Copy URL', click: () => clipboard.writeText(t.url) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => this.closeTab(id) },
      { label: 'Close Other Tabs', click: () => this.groupTabs(g.id).forEach((x) => x.id !== id && !x.pinned && this.closeTab(x.id)) },
    ];
    Menu.buildFromTemplate(template).popup({ window: this.win, ...pos });
  }

  spaceMenu(id, pos) {
    Menu.buildFromTemplate([
      { label: 'Edit Space…', click: () => this.uiCommand({ cmd: 'editSpace', id }) },
      { label: 'New Group in this Space', click: () => { this.activateSpace(id); this.uiCommand({ cmd: 'newGroup' }); } },
      { type: 'separator' },
      { label: 'Delete Space', enabled: this.d.spaces.length > 1, click: () => this.deleteSpace(id) },
    ]).popup({ window: this.win, ...pos });
  }

  groupMenu(id, pos) {
    const g = this.group(id);
    Menu.buildFromTemplate([
      { label: 'Edit Group…', click: () => this.uiCommand({ cmd: 'editGroup', id }) },
      { label: 'New Tab in Group', click: () => this.createTab({ groupId: id }) },
      { label: 'Sleep All Tabs', click: () => this.groupTabs(id).forEach((t) => this.sleepTab(t.id)) },
      { label: 'Move Group to Space', submenu: this.d.spaces.filter((s) => s.id !== g.spaceId).map((s) => ({ label: s.name, click: () => this.moveGroupToSpace(id, s.id) })) },
      { type: 'separator' },
      { label: 'Delete Group', click: () => this.deleteGroup(id) },
    ]).popup({ window: this.win, ...pos });
  }

  moveGroupToSpace(gid, spaceId) {
    const g = this.group(gid);
    if (!g) return;
    const from = this.space(g.spaceId);
    for (const t of this.groupTabs(gid)) this.disposeView(t, false); // cookies differ per space
    g.spaceId = spaceId;
    if (!this.spaceGroups(from.id).length) this.createGroup({ spaceId: from.id, name: 'Main', silent: true });
    if (from.activeGroupId === gid) from.activeGroupId = this.spaceGroups(from.id)[0].id;
    this.activateGroup(gid);
  }

  // ---------------- shortcuts ----------------
  handleShortcut(e, input, fromUi) {
    if (input.type !== 'keyDown') return;
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    const k = input.key.toLowerCase();
    const run = (fn) => { e.preventDefault(); fn(); };
    const t = this.activeTab();
    if (mod && !input.shift && k === 't') return run(() => this.createTab({ groupId: t.groupId }));
    if (mod && input.shift && k === 't') return run(() => this.reopenClosed());
    if (mod && k === 'w') return run(() => this.closeTab(t.id));
    if (mod && k === 'l') return run(() => { this.setOverlay(false); this.uiCommand({ cmd: 'focusAddress' }); });
    if (mod && k === 'k') return run(() => this.uiCommand({ cmd: 'openPanel', panel: 'search' }));
    if (mod && k === 'f') return run(() => this.openFind());
    if ((mod && k === 'r') || k === 'f5') return run(() => { const wc = this.activeWc(); input.shift ? wc?.reloadIgnoringCache() : wc?.reload(); });
    if (k === 'f12' || (mod && input.shift && k === 'i')) return run(() => this.toggleDevtools());
    if (mod && input.shift && k === 'm') return run(() => this.toggleMobile());
    if (mod && input.shift && k === 's') return run(() => this.capture());
    if (mod && k === 'tab') return run(() => this.cycleTab(input.shift ? -1 : 1));
    if (mod && /^[1-9]$/.test(k)) return run(() => { const tabs = this.groupTabs(t.groupId); const target = k === '9' ? tabs[tabs.length - 1] : tabs[Number(k) - 1]; if (target) this.activateTab(target.id); });
    if (input.alt && k === 'arrowleft') return run(() => this.activeWc()?.navigationHistory.goBack());
    if (input.alt && k === 'arrowright') return run(() => this.activeWc()?.navigationHistory.goForward());
    if (mod && (k === '=' || k === '+')) return run(() => this.zoomBy(0.5));
    if (mod && k === '-') return run(() => this.zoomBy(-0.5));
    if (mod && k === '0') return run(() => this.zoomBy(0));
    if (mod && k === 'p' && !fromUi) return run(() => this.activeWc()?.print());
    if (k === 'escape' && this.find.open) return run(() => this.closeFind());
  }

  zoomBy(delta) {
    const wc = this.activeWc();
    if (!wc) return;
    const r = this.runtime(this.activeTab().id);
    r.zoom = delta === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + delta));
    wc.setZoomLevel(r.zoom);
    this.toast({ message: `Zoom ${Math.round(Math.pow(1.2, r.zoom) * 100)}%` });
  }

  cycleTab(dir) {
    const t = this.activeTab();
    const tabs = this.groupTabs(t.groupId);
    const i = tabs.findIndex((x) => x.id === t.id);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (next) this.activateTab(next.id);
  }

  // ---------------- UI bridge ----------------
  setupIpc() {
    ipcMain.handle('ui:action', async (e, action) => {
      if (e.sender !== this.ui.webContents) return null;
      try { return await this.dispatch(action || {}); } catch (err) { console.error('[action]', action?.type, err); this.toast({ message: err.message, kind: 'error' }); return null; }
    });
    ipcMain.handle('ui:state', (e) => (e.sender === this.ui.webContents ? this.snapshot() : null));

    const fromNewTab = (e) => { try { return e.sender.getURL().startsWith('tide://'); } catch { return false; } };
    ipcMain.handle('newtab:settings', (e) => (fromNewTab(e) ? { newTab: this.d.settings.newTab, engine: this.d.settings.searchEngine, theme: this.d.settings.theme } : null));
    ipcMain.handle('newtab:set', (e, patch) => {
      if (!fromNewTab(e) || !patch || typeof patch !== 'object') return null;
      this.d.settings.newTab = { ...this.d.settings.newTab, ...patch };
      this.changed();
      this.broadcastNewTab();
      return this.d.settings.newTab;
    });
    ipcMain.handle('newtab:navigate', (e, input) => {
      if (!fromNewTab(e)) return null;
      const url = F.resolveInput(input, this.d.settings.searchEngine);
      if (url) e.sender.loadURL(url);
      return url;
    });
  }

  broadcastNewTab() {
    for (const [id, r] of this.rt) {
      const t = this.tab(id);
      if (r.view && t && isNewTab(t.url)) r.view.webContents.send('newtab:settings-changed', { newTab: this.d.settings.newTab, theme: this.d.settings.theme });
    }
  }

  async dispatch(a) {
    const t = this.activeTab();
    const wc = this.activeWc();
    const pos = a.x != null ? { x: Math.round(a.x), y: Math.round(a.y) } : {};
    switch (a.type) {
      case 'win:minimize': return this.win.minimize();
      case 'win:maximize': return this.win.isMaximized() ? this.win.unmaximize() : this.win.maximize();
      case 'win:close': return this.win.close();

      case 'space:activate': return this.activateSpace(a.id);
      case 'space:create': return this.createSpace(a);
      case 'space:update': return this.updateSpace(a);
      case 'space:delete': return this.deleteSpace(a.id);
      case 'space:menu': return this.spaceMenu(a.id, pos);

      case 'group:activate': return this.activateGroup(a.id);
      case 'group:create': return this.createGroup(a);
      case 'group:update': return this.updateGroup(a);
      case 'group:delete': return this.deleteGroup(a.id);
      case 'group:menu': return this.groupMenu(a.id, pos);

      case 'tab:new': return this.createTab({ groupId: a.groupId || t.groupId, url: a.url ? F.resolveInput(a.url, this.d.settings.searchEngine) : undefined });
      case 'tab:activate': this.setOverlay(false); return this.activateTab(a.id);
      case 'tab:close': return this.closeTab(a.id);
      case 'tab:menu': return this.tabMenu(a.id, pos);
      case 'tab:move': return this.moveTab(a.id, a.index);
      case 'tab:sleep': return this.sleepTab(a.id || t.id);
      case 'tab:wake': return this.wakeTab(a.id || t.id);
      case 'tab:reload-crashed': { const ct = this.tab(a.id); if (ct) { this.disposeView(ct, false); this.activateTab(ct.id); } return; }

      case 'nav:back': return wc?.navigationHistory.goBack();
      case 'nav:forward': return wc?.navigationHistory.goForward();
      case 'nav:reload': return wc?.reload();
      case 'nav:stop': return wc?.stop();
      case 'nav:go': {
        const url = F.resolveInput(a.input, this.d.settings.searchEngine);
        if (!url) return;
        this.ensureView(t);
        const v = this.rt.get(t.id).view;
        t.url = url;
        v.webContents.loadURL(url).catch(() => {});
        v.webContents.focus();
        return this.changed();
      }

      case 'tool:devtools': return this.toggleDevtools();
      case 'tool:mobile': return this.toggleMobile();
      case 'tool:mobileDevice': return this.toggleMobile(t, a.device);
      case 'tool:mobileRotate': {
        const r = this.runtime(t.id);
        if (r.mobile) { r.mobile = { ...r.mobile, width: r.mobile.height, height: r.mobile.width }; r.mobileApplied = null; this.layout(); this.changed(); }
        return;
      }
      case 'tool:capture': return this.capture();
      case 'tool:fakefill': return this.fakeFill();
      case 'tool:menu': return this.toolsMenu(pos);
      case 'tool:dock': return this.dockMenu(pos);
      case 'tool:sleep': return this.sleepTab(t.id);

      case 'overlay': return this.setOverlay(!!a.open);
      case 'find': return this.doFind(a);
      case 'find:open': return this.openFind();
      case 'find:close': return this.closeFind();

      case 'notes:set': this.d.notes[a.spaceId || this.d.activeSpaceId] = String(a.text || ''); this.store.save(); return;
      case 'settings:set': {
        this.d.settings = { ...this.d.settings, ...a.patch };
        if (a.patch.theme) { this.win.setBackgroundColor(this.bgColor()); this.broadcastNewTab(); }
        this.changed();
        return this.d.settings;
      }

      case 'mcp:toggle': return this.mcp?.setEnabled(!this.d.settings.mcp.enabled);
      case 'mcp:configure': return this.mcp?.configure(a);
      case 'mcp:copy': clipboard.writeText(String(a.text || '')); return this.toast({ message: 'Copied to clipboard' });
      case 'mcp:clearLog': this.mcpLog = []; return this.changed();

      case 'file:open': return shell.openPath(a.path);
      case 'file:reveal': return shell.showItemInFolder(a.path);
      default: return null;
    }
  }

  snapshot() {
    const d = this.d;
    const tabs = d.tabs.map((t) => {
      const r = this.rt.get(t.id) || {};
      const wc = r.view?.webContents;
      let canGoBack = false; let canGoForward = false;
      try { canGoBack = !!wc?.navigationHistory.canGoBack(); canGoForward = !!wc?.navigationHistory.canGoForward(); } catch {}
      return {
        ...t,
        newTab: isNewTab(t.url),
        sleeping: !r.view,
        loading: !!r.loading,
        crashed: !!r.crashed,
        audible: !!r.audible,
        devtools: !!r.devtools,
        mobile: r.mobile ? { id: r.mobile.id, name: r.mobile.name } : null,
        canGoBack, canGoForward,
      };
    });
    return {
      platform: process.platform,
      maximized: this.win?.isMaximized() || false,
      spaces: d.spaces,
      activeSpaceId: this.activeSpace().id,
      groups: d.groups.map((g) => ({ ...g, awake: this.d.tabs.some((t) => t.groupId === g.id && this.rt.get(t.id)?.view), count: this.d.tabs.filter((t) => t.groupId === g.id).length })),
      activeGroupId: this.activeGroup().id,
      activeTabId: this.activeTab().id,
      tabs,
      settings: d.settings,
      notes: d.notes,
      devices: Object.fromEntries(Object.entries(F.DEVICES).map(([k, v]) => [k, { name: v.name, width: v.width, height: v.height }])),
      engines: Object.fromEntries(Object.entries(F.SEARCH_ENGINES).map(([k, v]) => [k, v.name])),
      layout: this.lastLayout,
      overlay: this.overlay,
      find: this.find,
      mcp: this.mcp ? this.mcp.status() : { running: false },
      mcpLog: this.mcpLog.slice(-60),
      closedCount: this.closed.length,
    };
  }

  changed() {
    this.store.save();
    if (this._stateTimer) return;
    this._stateTimer = setTimeout(() => { this._stateTimer = null; this.sendState(); }, 16);
  }

  sendState() {
    if (!this.ui || this.ui.webContents.isDestroyed()) return;
    this.ui.webContents.send('ui:state', this.snapshot());
  }

  uiCommand(cmd) {
    if (this.ui && !this.ui.webContents.isDestroyed()) {
      if (cmd.cmd === 'focusAddress' || cmd.cmd === 'focusFind') this.ui.webContents.focus();
      this.ui.webContents.send('ui:command', cmd);
    }
  }

  toast(t) { this.uiCommand({ cmd: 'toast', ...t }); }

  logMcp(entry) {
    this.mcpLog.push({ time: Date.now(), ...entry });
    if (this.mcpLog.length > 200) this.mcpLog.splice(0, this.mcpLog.length - 200);
    this.changed();
  }

  // ---------------- helpers used by MCP ----------------
  resolveTab(tabId) {
    const t = tabId ? this.tab(tabId) : this.activeTab();
    if (!t) throw new Error(`Tab not found: ${tabId}`);
    return t;
  }

  async wcFor(tabId, { wait = true } = {}) {
    const t = this.resolveTab(tabId);
    const view = this.ensureView(t);
    this.layout();
    this.changed();
    const wc = view.webContents;
    if (wait) await this.waitForLoad(wc);
    return { t, wc };
  }

  waitForLoad(wc, timeout = 20000) {
    return new Promise((resolve) => {
      if (!wc.isLoading()) return resolve(true);
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { wc.removeListener('did-stop-loading', done); resolve(false); }, timeout);
      wc.once('did-stop-loading', done);
    });
  }
}

module.exports = { Browser, NEWTAB_URL, isNewTab };
