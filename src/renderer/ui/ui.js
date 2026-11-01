'use strict';
/* global icon, ICONS */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const act = (type, p) => window.tide.action(type, p);

const COLORS = ['#1fc7b6', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#eab308', '#22c55e', '#64748b', '#ef4444', '#06b6d4'];
const SYMBOLS = ['briefcase', 'home', 'code', 'star', 'heart', 'globe', 'book', 'music', 'game', 'cart', 'zap', 'search', 'mcp', 'settings'];

let S = null;          // latest state from main
let prevOverlay = false;
let panel = null;      // { name, ... }
const cache = {};      // last rendered html per region

function setHtml(el, key, html) {
  if (cache[key] === html) return false;
  cache[key] = html;
  el.innerHTML = html;
  return true;
}

const iconHtml = (ic, size) => (!ic ? '' : ic.type === 'symbol' ? icon(ic.value, size) : esc(ic.value));
const activeTab = () => S.tabs.find((t) => t.id === S.activeTabId);
const activeGroup = () => S.groups.find((g) => g.id === S.activeGroupId);
const spaceName = (id) => S.spaces.find((s) => s.id === id)?.name || '';
const hostOf = (url) => { try { return new URL(url).host; } catch { return url || ''; } };

function favHtml(t, cls = 'fav') {
  if (t.loading && !t.sleeping) return '<span class="spinner"></span>';
  if (t.newTab) return `<span class="${cls} fav-n">N</span>`;
  if (t.favicon) return `<img class="${cls}" src="${esc(t.favicon)}" alt="" draggable="false" />`;
  return `<span class="${cls}">${icon('globe', 15)}</span>`;
}
// Broken favicons -> globe icon
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.classList.contains('fav')) {
    const s = document.createElement('span');
    s.className = 'fav';
    s.innerHTML = icon('globe', 15);
    e.target.replaceWith(s);
  }
}, true);

// ---------------- static chrome ----------------
function initStatic() {
  $$('.side-btn[data-panel]').forEach((b) => { b.innerHTML = icon(b.dataset.panel, 19); });
  $('#theme-btn').innerHTML = icon('moon', 19);
  $('#new-tab').innerHTML = icon('plus', 17);
  $('#nav-back').innerHTML = icon('back', 18);
  $('#nav-forward').innerHTML = icon('forward', 18);
  $('#nav-reload').innerHTML = icon('reload', 16);
  $$('#tools .tool').forEach((b) => { b.innerHTML = icon(b.dataset.tool, 17); });
  $('[data-win=minimize]').innerHTML = icon('minimize', 15);
  $('[data-win=maximize]').innerHTML = icon('maximize', 13);
  $('[data-win=close]').innerHTML = icon('x', 16);
  $('#find-prev').innerHTML = icon('up', 16);
  $('#find-next').innerHTML = icon('down', 16);
  $('#find-close').innerHTML = icon('x', 15);
}

// ---------------- render ----------------
function render() {
  const b = document.body.classList;
  b.toggle('light', S.settings.theme === 'light');
  b.toggle('darwin', S.platform === 'darwin');
  b.toggle('overlay', S.overlay);
  b.toggle('find-open', S.find.open);
  b.toggle('fullscreen', !!S.layout?.fullscreen);
  if (prevOverlay && !S.overlay && panel) closePanel(false);
  prevOverlay = S.overlay;
  renderSidebar();
  renderTabs();
  renderToolbar();
  renderContent();
  renderFind();
  if (panel?.update) panel.update();
}

function renderSidebar() {
  setHtml($('#spaces'), 'spaces', S.spaces.map((sp) => `
    <button class="space ${sp.id === S.activeSpaceId ? 'active' : ''}" style="--c:${esc(sp.color)}" data-space="${sp.id}" title="${esc(sp.name)}">${iconHtml(sp.icon, 18)}</button>`).join('')
    + `<button class="add-space" id="add-space" title="Add Space">${icon('plus', 14)}</button>`);

  const groups = S.groups.filter((g) => g.spaceId === S.activeSpaceId);
  setHtml($('#groups'), 'groups', groups.map((g) => `
    <button class="group ${g.id === S.activeGroupId ? 'active' : ''}" style="--c:${esc(g.color)}" data-group="${g.id}" title="${esc(g.name)} · ${g.count} tab(s)">
      ${iconHtml(g.icon, 20)}${g.awake ? '<span class="dot"></span>' : ''}<span class="count">${g.count}</span>
    </button>`).join('')
    + `<button class="add-group" id="add-group" title="Add Group">${icon('plus', 16)}</button>`);

  const light = S.settings.theme === 'light';
  setHtml($('#theme-btn'), 'theme', icon(light ? 'sun' : 'moon', 19));
  const mcp = $('#mcp-btn');
  mcp.classList.toggle('running', !!S.mcp.running);
  mcp.classList.toggle('error', !!S.mcp.error);
  mcp.title = S.mcp.running ? `MCP Server · running on ${S.mcp.url}` : S.mcp.error ? `MCP Server · ${S.mcp.error}` : 'MCP Server · stopped';
}

function renderTabs() {
  const tabs = S.tabs.filter((t) => t.groupId === S.activeGroupId);
  const split = activeGroup()?.split || [];
  const pinned = tabs.filter((t) => t.pinned);
  const normal = tabs.filter((t) => !t.pinned);
  setHtml($('#pinned'), 'pinned', pinned.map((t) => `
    <button class="pin-tab ${t.id === S.activeTabId ? 'active' : ''} ${t.sleeping ? 'sleeping' : ''}" data-tab="${t.id}" title="${esc(t.title)}" draggable="true">${favHtml(t)}</button>`).join(''));
  setHtml($('#tabs'), 'tabs', normal.map((t) => `
    <div class="tab ${t.id === S.activeTabId ? 'active' : ''} ${t.sleeping ? 'sleeping' : ''} ${split.includes(t.id) ? 'docked' : ''}" data-tab="${t.id}" title="${esc(t.title)}\n${esc(t.url)}" draggable="true">
      ${favHtml(t)}
      <span class="title">${esc(t.title || t.url)}</span>
      ${t.audible ? `<span class="audio">${icon('volume', 13)}</span>` : ''}
      ${t.sleeping ? '<span class="zz">zᶻ</span>' : ''}
      <button class="close" data-close="${t.id}" title="Close tab (Ctrl+W)">${icon('x', 12)}</button>
    </div>`).join(''));
  setHtml($('[data-win=maximize]'), 'max', icon(S.maximized ? 'restore' : 'maximize', 13));
}

function renderToolbar() {
  const t = activeTab();
  if (!t) return;
  $('#nav-back').disabled = !t.canGoBack;
  $('#nav-forward').disabled = !t.canGoForward;
  setHtml($('#nav-reload'), 'reload', icon(t.loading ? 'stop' : 'reload', t.loading ? 17 : 16));
  $('#nav-reload').title = t.loading ? 'Stop' : 'Reload (Ctrl+R)';
  const addr = $('#address');
  if (document.activeElement !== addr) addr.value = t.newTab ? '' : t.url;
  setHtml($('#address-icon'), 'addricon', t.url?.startsWith('https://') ? icon('lock', 13) : '');
  const split = activeGroup()?.split?.includes(t.id);
  const on = { devtools: t.devtools, mobile: !!t.mobile, dock: split };
  $$('#tools .tool').forEach((b) => b.classList.toggle('on', !!on[b.dataset.tool]));
  $('[data-tool=mobile]').title = t.mobile ? `Mobile View · ${t.mobile.name} (click to exit)` : 'Mobile View (Ctrl+Shift+M)';
  $('[data-tool=sleep]').disabled = t.sleeping;
}

function renderContent() {
  const t = activeTab();
  const L = S.layout;
  let html = '';
  if (t && t.sleeping) {
    html = `<div class="placeholder"><div class="big">zᶻ</div><h3>This tab is sleeping</h3><div class="url">${esc(t.title)}<br>${esc(t.url)}</div><button class="btn primary" data-wake="${t.id}">Wake tab</button></div>`;
  } else if (t && t.crashed) {
    html = `<div class="placeholder"><div style="color:var(--danger)">${icon('alert', 34)}</div><h3>This tab crashed</h3><div class="url">${esc(t.url)}</div><button class="btn primary" data-recover="${t.id}">Reload</button></div>`;
  }
  setHtml($('#content-frame'), 'content', html);

  let decor = '';
  if (L && !L.fullscreen) {
    for (const p of L.panes) {
      if (L.split && p.tabId === S.activeTabId) {
        decor += `<div class="pane-ring" style="left:${p.rect.x - 1}px;top:${p.rect.y - 1}px;width:${p.rect.width + 2}px;height:${p.rect.height + 2}px"></div>`;
      }
      if (p.mobile) {
        const a = p.mobile.area;
        const opts = Object.entries(S.devices).map(([id, d]) => `<option value="${id}" ${id === p.mobile.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
        decor += `<div class="device-bar" data-tabid="${p.tabId}" style="left:${a.x}px;top:${a.y + 4}px;width:${a.width}px">
          <select data-device>${opts}</select>
          <span class="mono">${p.mobile.width} × ${p.mobile.height}</span>
          <button class="icon-btn" data-rotate title="Rotate">${icon('rotate', 14)}</button>
          <button class="icon-btn" data-exit-mobile title="Exit mobile view">${icon('x', 14)}</button>
        </div>`;
      }
    }
  }
  setHtml($('#pane-decor'), 'decor', decor);
}

function renderFind() {
  const fb = $('#findbar');
  fb.hidden = !S.find.open;
  if (!S.find.open) return;
  $('#find-count').textContent = S.find.text ? `${S.find.active}/${S.find.matches}` : '';
}

// ---------------- events: sidebar ----------------
$('#sidebar').addEventListener('click', (e) => {
  const sp = e.target.closest('[data-space]');
  if (sp) return act('space:activate', { id: sp.dataset.space });
  const g = e.target.closest('[data-group]');
  if (g) return act('group:activate', { id: g.dataset.group });
  if (e.target.closest('#add-space')) return openModal('space');
  if (e.target.closest('#add-group')) return openModal('group');
  if (e.target.closest('#theme-btn')) return act('settings:set', { patch: { theme: S.settings.theme === 'light' ? 'dark' : 'light' } });
  const pb = e.target.closest('[data-panel]');
  if (pb) return panel?.name === pb.dataset.panel ? closePanel() : openPanel(pb.dataset.panel);
});
$('#sidebar').addEventListener('contextmenu', (e) => {
  const sp = e.target.closest('[data-space]');
  const g = e.target.closest('[data-group]');
  if (sp) { e.preventDefault(); act('space:menu', { id: sp.dataset.space, x: e.clientX, y: e.clientY }); }
  if (g) { e.preventDefault(); act('group:menu', { id: g.dataset.group, x: e.clientX, y: e.clientY }); }
});

// ---------------- events: tabs ----------------
const tabstrip = $('#tabstrip');
tabstrip.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const close = e.target.closest('[data-close]');
  if (close) return;
  const tab = e.target.closest('[data-tab]');
  if (tab && tab.dataset.tab !== S.activeTabId) act('tab:activate', { id: tab.dataset.tab });
});
tabstrip.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) { e.stopPropagation(); act('tab:close', { id: close.dataset.close }); }
});
tabstrip.addEventListener('auxclick', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab && e.button === 1) act('tab:close', { id: tab.dataset.tab });
});
tabstrip.addEventListener('contextmenu', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { e.preventDefault(); act('tab:menu', { id: tab.dataset.tab, x: e.clientX, y: e.clientY }); }
});
tabstrip.addEventListener('dblclick', (e) => { if (e.target.classList.contains('drag-spacer') || e.target === tabstrip) act('win:maximize'); });
$('#new-tab').addEventListener('click', () => act('tab:new'));
$$('#win-controls button').forEach((b) => b.addEventListener('click', () => act('win:' + b.dataset.win)));

// drag & drop reorder
let dragId = null;
tabstrip.addEventListener('dragstart', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  dragId = tab.dataset.tab;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
tabstrip.addEventListener('dragover', (e) => {
  const tab = e.target.closest('.tab[data-tab], .pin-tab[data-tab]');
  if (!dragId || !tab) return;
  e.preventDefault();
  $$('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const r = tab.getBoundingClientRect();
  tab.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
});
tabstrip.addEventListener('drop', (e) => {
  const tab = e.target.closest('[data-tab]');
  $$('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  if (!dragId || !tab || tab.dataset.tab === dragId) return;
  e.preventDefault();
  const dragged = S.tabs.find((t) => t.id === dragId);
  const list = S.tabs.filter((t) => t.groupId === S.activeGroupId && !!t.pinned === !!dragged.pinned && t.id !== dragId);
  const r = tab.getBoundingClientRect();
  let idx = list.findIndex((t) => t.id === tab.dataset.tab);
  if (idx < 0) return;
  if (e.clientX >= r.left + r.width / 2) idx += 1;
  act('tab:move', { id: dragId, index: idx });
});
tabstrip.addEventListener('dragend', () => { dragId = null; $$('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); });

// ---------------- events: toolbar ----------------
$('#nav-back').addEventListener('click', () => act('nav:back'));
$('#nav-forward').addEventListener('click', () => act('nav:forward'));
$('#nav-reload').addEventListener('click', () => act(activeTab()?.loading ? 'nav:stop' : 'nav:reload'));
const addr = $('#address');
addr.addEventListener('focus', () => setTimeout(() => addr.select(), 0));
addr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = addr.value.trim();
    if (!v) return;
    if (e.altKey) act('tab:new', { url: v }); else act('nav:go', { input: v });
    addr.blur();
  } else if (e.key === 'Escape') {
    const t = activeTab();
    addr.value = t?.newTab ? '' : t?.url || '';
    addr.blur();
  }
});
$$('#tools .tool').forEach((b) => b.addEventListener('click', () => {
  const r = b.getBoundingClientRect();
  act('tool:' + b.dataset.tool, { x: r.left, y: r.bottom + 4 });
}));

// find bar
const findInput = $('#find-input');
findInput.addEventListener('input', () => act('find', { text: findInput.value, findNext: false }));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') act('find', { text: findInput.value, forward: !e.shiftKey, findNext: true });
  if (e.key === 'Escape') act('find:close');
});
$('#find-prev').addEventListener('click', () => act('find', { text: findInput.value, forward: false, findNext: true }));
$('#find-next').addEventListener('click', () => act('find', { text: findInput.value, forward: true, findNext: true }));
$('#find-close').addEventListener('click', () => act('find:close'));

// content placeholders & device bars
document.addEventListener('click', (e) => {
  const w = e.target.closest('[data-wake]');
  if (w) return act('tab:wake', { id: w.dataset.wake });
  const rc = e.target.closest('[data-recover]');
  if (rc) return act('tab:reload-crashed', { id: rc.dataset.recover });
  if (e.target.closest('[data-rotate]')) return act('tool:mobileRotate');
  if (e.target.closest('[data-exit-mobile]')) return act('tool:mobile');
});
document.addEventListener('change', (e) => {
  if (e.target.matches('[data-device]')) act('tool:mobileDevice', { device: e.target.value });
});

// ---------------- toasts ----------------
function toast({ message, kind, actions = [] }) {
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`;
  el.innerHTML = `<span class="msg">${esc(message)}</span>${actions.map((a, i) => `<button class="btn small" data-i="${i}">${esc(a.label)}</button>`).join('')}`;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) { const a = actions[Number(b.dataset.i)].action; act(a.type, a); el.remove(); }
  });
  const box = $('#toasts');
  box.prepend(el);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : actions.length ? 6500 : 3200);
}

// ---------------- overlay panels ----------------
function openPanel(name, opts = {}) {
  if (panel) closePanel(false);
  const builders = { search: buildSearch, tabs: buildTabs, notes: buildNotes, settings: buildSettings, mcp: buildMcp, modal: buildModal };
  panel = { name, ...opts };
  // Fresh element each time so listeners from a previous panel never leak.
  const prev = $('#panel');
  const el = prev.cloneNode(false);
  prev.replaceWith(el);
  el.addEventListener('click', (e) => { if (e.target.closest('[data-close-panel]')) closePanel(); });
  el.className = name === 'search' ? 'palette' : name === 'modal' ? 'modal' : '';
  el.innerHTML = '';
  $('#overlay').hidden = false;
  $$('.side-btn[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  builders[name](el, panel);
  act('overlay', { open: true });
}

function closePanel(notify = true) {
  if (!panel) return;
  panel = null;
  $('#overlay').hidden = true;
  $('#panel').innerHTML = '';
  $$('.side-btn[data-panel]').forEach((b) => b.classList.remove('on'));
  if (notify) act('overlay', { open: false });
}
$('#backdrop').addEventListener('mousedown', () => closePanel());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel) { e.preventDefault(); closePanel(); } });

function head(title, extra = '') {
  return `<div class="panel-head"><h2>${title}</h2>${extra}<button class="icon-btn" data-close-panel title="Close (Esc)">${icon('x', 16)}</button></div>`;
}

// ---- search / command palette ----
function buildSearch(el, p) {
  el.innerHTML = `<div class="palette-input">${icon('search', 18)}<input id="pal-input" placeholder="Search tabs, type a URL, or run a command…" spellcheck="false" /></div><div class="results" id="pal-results"></div>`;
  const input = $('#pal-input');
  p.sel = 0;
  const commands = [
    { title: 'New Tab', kind: 'Command', icon: 'plus', run: () => act('tab:new') },
    { title: 'Add Group', kind: 'Command', icon: 'plus', run: () => openModal('group') },
    { title: 'Add Space', kind: 'Command', icon: 'plus', run: () => openModal('space') },
    { title: 'Toggle DevTools', kind: 'F12', icon: 'devtools', run: () => act('tool:devtools') },
    { title: 'Toggle Mobile View', kind: 'Ctrl+Shift+M', icon: 'mobile', run: () => act('tool:mobile') },
    { title: 'Capture Full Page', kind: 'Ctrl+Shift+S', icon: 'capture', run: () => act('tool:capture') },
    { title: 'Fake Fill Forms', kind: 'Command', icon: 'fakefill', run: () => act('tool:fakefill') },
    { title: 'Sleep Current Tab', kind: 'Command', icon: 'sleep', run: () => act('tool:sleep') },
    { title: 'Find in Page', kind: 'Ctrl+F', icon: 'search', run: () => act('find:open') },
    { title: 'MCP Server', kind: 'Panel', icon: 'mcp', run: () => openPanel('mcp') },
    { title: 'Settings', kind: 'Panel', icon: 'settings', run: () => openPanel('settings') },
    { title: 'Toggle Light/Dark Theme', kind: 'Command', icon: 'moon', run: () => act('settings:set', { patch: { theme: S.settings.theme === 'light' ? 'dark' : 'light' } }) },
  ];

  const compute = () => {
    const q = input.value.trim().toLowerCase();
    const items = [];
    if (q) {
      const looksUrl = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q) || /^(https?|izi|file):/.test(q) || /^localhost/.test(q);
      items.push({ title: looksUrl ? `Open ${input.value.trim()}` : `Search ${S.engines[S.settings.searchEngine] || 'Google'} for “${input.value.trim()}”`, kind: 'Enter', icon: looksUrl ? 'globe' : 'search', run: () => act('nav:go', { input: input.value.trim() }) });
      items.push({ title: 'Open in new tab', sub: input.value.trim(), kind: 'Alt+Enter', icon: 'plus', run: () => act('tab:new', { url: input.value.trim() }) });
    }
    const tabs = S.tabs.filter((t) => !q || (t.title || '').toLowerCase().includes(q) || (t.url || '').toLowerCase().includes(q)).slice(0, 12);
    for (const t of tabs) {
      const g = S.groups.find((x) => x.id === t.groupId);
      items.push({ tab: t, title: t.title || t.url, sub: `${spaceName(g?.spaceId)} › ${g?.name} · ${t.newTab ? 'New tab' : t.url}`, kind: t.sleeping ? 'Sleeping' : 'Tab', run: () => act('tab:activate', { id: t.id }) });
    }
    for (const c of commands) if (!q || c.title.toLowerCase().includes(q)) items.push(c);
    p.items = items;
    p.sel = Math.min(p.sel, Math.max(0, items.length - 1));
    $('#pal-results').innerHTML = items.map((it, i) => `
      <div class="result ${i === p.sel ? 'sel' : ''}" data-i="${i}">
        ${it.tab ? favHtml(it.tab) : `<span class="fav">${icon(it.icon || 'zap', 16)}</span>`}
        <div class="r-main"><div class="r-title">${esc(it.title)}</div>${it.sub ? `<div class="r-sub">${esc(it.sub)}</div>` : ''}</div>
        <span class="r-kind">${esc(it.kind || '')}</span>
      </div>`).join('') || '<div class="muted small" style="padding:10px">No results</div>';
  };
  const runSel = (alt) => {
    const it = alt ? p.items?.[1] : p.items?.[p.sel];
    if (!it) return;
    const keep = it.title === 'Add Group' || it.title === 'Add Space' || it.kind === 'Panel';
    if (!keep) closePanel();
    it.run();
  };
  input.addEventListener('input', () => { p.sel = 0; compute(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); p.sel = Math.min(p.sel + 1, p.items.length - 1); compute(); $('.result.sel')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'ArrowUp') { e.preventDefault(); p.sel = Math.max(p.sel - 1, 0); compute(); $('.result.sel')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'Enter') { e.preventDefault(); runSel(e.altKey && input.value.trim()); }
  });
  $('#pal-results').addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) { p.sel = Number(r.dataset.i); runSel(); } });
  compute();
  setTimeout(() => input.focus(), 0);
}

// ---- tab list ----
function buildTabs(el, p) {
  el.innerHTML = head(`Tabs · ${esc(spaceName(S.activeSpaceId))}`) + '<div class="panel-body" id="tablist"></div>';
  p.update = () => {
    const groups = S.groups.filter((g) => g.spaceId === S.activeSpaceId);
    const html = groups.map((g) => {
      const tabs = S.tabs.filter((t) => t.groupId === g.id);
      return `<div class="group-head"><span class="chip" style="background:${esc(g.color)}">${iconHtml(g.icon, 12)}</span>${esc(g.name)}<span class="muted small">${tabs.length}</span></div>`
        + tabs.map((t) => `
          <div class="tab-row ${t.id === S.activeTabId ? 'active' : ''} ${t.sleeping ? 'sleeping' : ''}" data-row="${t.id}">
            ${favHtml(t)}
            <div class="r-main"><div class="r-title">${esc(t.title || t.url)}</div><div class="r-sub">${t.sleeping ? 'zᶻ sleeping · ' : ''}${esc(t.newTab ? 'New tab' : hostOf(t.url))}</div></div>
            <div class="acts">
              ${t.sleeping ? `<button class="icon-btn" data-wake-row="${t.id}" title="Wake">${icon('zap', 14)}</button>` : `<button class="icon-btn" data-sleep-row="${t.id}" title="Sleep">${icon('sleep', 14)}</button>`}
              <button class="icon-btn" data-close-row="${t.id}" title="Close">${icon('x', 14)}</button>
            </div>
          </div>`).join('');
    }).join('');
    setHtml($('#tablist'), 'tablist', html);
  };
  cache.tablist = null;
  el.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sleep-row]'); if (s) return act('tab:sleep', { id: s.dataset.sleepRow });
    const w = e.target.closest('[data-wake-row]'); if (w) return act('tab:wake', { id: w.dataset.wakeRow });
    const c = e.target.closest('[data-close-row]'); if (c) return act('tab:close', { id: c.dataset.closeRow });
    const r = e.target.closest('[data-row]'); if (r) { closePanel(false); act('tab:activate', { id: r.dataset.row }); }
  });
  p.update();
}

// ---- notes ----
function buildNotes(el, p) {
  const sid = S.activeSpaceId;
  el.innerHTML = head(`Notes · ${esc(spaceName(sid))}`, '<span class="muted small" id="note-saved"></span>')
    + '<div class="panel-body" style="display:flex"><textarea class="input" id="note" style="flex:1;min-height:100%" placeholder="Write anything… saved automatically per Space."></textarea></div>';
  const ta = $('#note');
  ta.value = S.notes[sid] || '';
  let timer;
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    $('#note-saved').textContent = 'Saving…';
    timer = setTimeout(() => { act('notes:set', { spaceId: sid, text: ta.value }); S.notes[sid] = ta.value; $('#note-saved').textContent = 'Saved'; }, 350);
  });
  setTimeout(() => ta.focus(), 0);
}

// ---- settings ----
function buildSettings(el) {
  const st = S.settings;
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(typeof v === 'string' ? v : v.name)}</option>`).join('');
  el.innerHTML = head('Settings') + `<div class="panel-body">
    <div class="section">General</div>
    <div class="field"><label>Search engine</label><select class="input" data-set="searchEngine">${opt(S.engines, st.searchEngine)}</select></div>
    <div class="field"><label>Theme</label><select class="input" data-set="theme">${opt({ dark: 'Dark', light: 'Light' }, st.theme)}</select></div>
    <div class="section">Sleep Tabs</div>
    <div class="field"><label>Auto-sleep inactive tabs after</label>
      <select class="input" data-set="autoSleepMinutes" data-num>${opt({ 0: 'Never', 5: '5 minutes', 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 120: '2 hours', 240: '4 hours' }, String(st.autoSleepMinutes))}</select></div>
    <div class="section">Google Sign-in</div>
    <div class="field"><label>Google sign-in compatibility</label>
      <select class="input" data-set-compat="googleLogin">${opt({ on: 'On (recommended)', off: 'Off' }, st.compat?.googleLogin === false ? 'off' : 'on')}</select>
      <div class="small muted">When on, accounts.google.com sees a standard Firefox identity so Google allows sign-in; every other site sees Chrome.</div></div>
    <div class="section">Mobile View</div>
    <div class="field"><label>Default device</label><select class="input" data-set="mobileDevice">${opt(S.devices, st.mobileDevice)}</select></div>
    <div class="section">Shortcuts</div>
    <div class="small muted" style="line-height:2">
      <kbd>Ctrl+T</kbd> new tab · <kbd>Ctrl+W</kbd> close · <kbd>Ctrl+Shift+T</kbd> reopen<br>
      <kbd>Ctrl+L</kbd> address · <kbd>Ctrl+K</kbd> search · <kbd>Ctrl+F</kbd> find<br>
      <kbd>Ctrl+Tab</kbd> next tab · <kbd>Ctrl+1…9</kbd> go to tab<br>
      <kbd>F12</kbd> DevTools · <kbd>Ctrl+Shift+M</kbd> mobile · <kbd>Ctrl+Shift+S</kbd> capture
    </div>
    <div class="section">About</div>
    <div class="small muted">IZI DevSpace · Chromium engine via Electron</div>
  </div>`;
  el.addEventListener('change', (e) => {
    const c = e.target.closest('[data-set-compat]');
    if (c) return act('settings:set', { patch: { compat: { ...(S.settings.compat || {}), [c.dataset.setCompat]: c.value === 'on' } } });
    const s = e.target.closest('[data-set]');
    if (!s) return;
    const v = s.hasAttribute('data-num') ? Number(s.value) : s.value;
    act('settings:set', { patch: { [s.dataset.set]: v } });
  });
}

// ---- MCP ----
const MCP_TOOLS = ['list_spaces', 'list_tabs', 'get_active_tab', 'open_tab', 'switch_tab', 'close_tab', 'navigate', 'history', 'get_page_text', 'snapshot', 'click', 'type', 'press_key', 'scroll', 'evaluate', 'screenshot', 'wait_for', 'capture_full_page', 'fake_fill', 'mobile_view', 'sleep_tab', 'dock_tab', 'create_group'];
function buildMcp(el, p) {
  p.client = p.client || 'claude-code';
  el.innerHTML = head('MCP Server') + `<div class="panel-body">
    <div class="status" id="mcp-status"></div>
    <div class="row" style="gap:10px;margin-bottom:14px">
      <div class="field" style="flex:1;margin:0"><label>Port</label><input class="input mono" id="mcp-port" value="${S.mcp.port}" /></div>
      <div class="field" style="flex:2;margin:0"><label>Bearer token (optional)</label>
        <div class="row"><input class="input mono" id="mcp-token" value="${esc(S.mcp.token)}" placeholder="none" /><button class="btn small" id="mcp-gen" title="Generate">${icon('zap', 13)}</button></div></div>
    </div>
    <div class="row" style="justify-content:flex-end;margin:-6px 0 6px"><button class="btn small" id="mcp-apply">Apply</button></div>
    <div class="section">Connect an agent</div>
    <div class="tabsel" id="mcp-clients">
      <button data-client="claude-code">Claude Code</button><button data-client="claude-desktop">Claude Desktop</button><button data-client="cursor">Cursor / VS Code</button>
    </div>
    <div id="mcp-snippet"></div>
    <div class="section">Tools (${MCP_TOOLS.length})</div>
    <div class="tool-list">${MCP_TOOLS.map((t) => `<code>${t}</code>`).join('')}</div>
    <div class="section row between"><span>Activity</span><button class="btn small" id="mcp-clear">Clear</button></div>
    <div class="log" id="mcp-log"></div>
  </div>`;

  const snippet = () => {
    const url = S.mcp.url;
    const tok = S.mcp.token;
    const hdr = tok ? { Authorization: `Bearer ${tok}` } : undefined;
    const snippets = {
      'claude-code': `claude mcp add --transport http izi-devspace ${url}${tok ? ` --header "Authorization: Bearer ${tok}"` : ''}`,
      'claude-desktop': JSON.stringify({ mcpServers: { 'izi-devspace': { command: 'npx', args: ['-y', 'mcp-remote', url, ...(tok ? ['--header', `Authorization: Bearer ${tok}`] : [])] } } }, null, 2),
      cursor: JSON.stringify({ mcpServers: { 'izi-devspace': { url, ...(hdr ? { headers: hdr } : {}) } } }, null, 2),
    };
    $$('#mcp-clients button').forEach((b) => b.classList.toggle('on', b.dataset.client === p.client));
    const s = snippets[p.client];
    setHtml($('#mcp-snippet'), 'mcpsnip', `<div class="snip-wrap"><pre class="snippet">${esc(s)}</pre><button class="btn small copy" data-copy="${esc(s)}">${icon('copy', 13)} Copy</button></div>`);
  };

  p.update = () => {
    const m = S.mcp;
    const clients = m.clients?.length ? ` · ${m.clients.length} client(s): ${m.clients.map(esc).join(', ')}` : '';
    setHtml($('#mcp-status'), 'mcpstatus', `
      <span class="led ${m.running ? 'on' : m.error ? 'err' : ''}"></span>
      <div style="flex:1;min-width:0"><div style="font-weight:600">${m.running ? 'Running' : m.error ? 'Error' : 'Stopped'}</div>
      <div class="small muted mono" style="overflow:hidden;text-overflow:ellipsis">${m.running ? esc(m.url) : esc(m.error || 'Enable to let AI agents control this browser')}${clients}</div></div>
      <button class="switch ${m.enabled ? 'on' : ''}" id="mcp-toggle" title="Enable / disable"></button>`);
    const rows = (S.mcpLog || []).slice().reverse().map((l) => `
      <div class="log-row ${l.ok ? '' : 'bad'}"><span class="t mono">${new Date(l.time).toLocaleTimeString()}</span><span class="n mono">${esc(l.tool)}</span>
      <span class="a mono" title="${esc(l.error || JSON.stringify(l.args || {}))}">${esc(l.error || JSON.stringify(l.args || {}))}</span>${l.ms != null ? `<span class="t mono">${l.ms}ms</span>` : ''}</div>`).join('');
    setHtml($('#mcp-log'), 'mcplog', rows || '<div class="muted small">No activity yet. Connect an agent and ask it to use the browser.</div>');
    snippet();
  };
  cache.mcpstatus = cache.mcplog = cache.mcpsnip = null;
  el.addEventListener('click', (e) => {
    if (e.target.closest('#mcp-toggle')) return act('mcp:toggle');
    if (e.target.closest('#mcp-apply')) return act('mcp:configure', { port: $('#mcp-port').value, token: $('#mcp-token').value.trim() });
    if (e.target.closest('#mcp-gen')) { const a = new Uint8Array(18); crypto.getRandomValues(a); $('#mcp-token').value = Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(''); return; }
    if (e.target.closest('#mcp-clear')) return act('mcp:clearLog');
    const c = e.target.closest('[data-client]'); if (c) { p.client = c.dataset.client; cache.mcpsnip = null; return snippet(); }
    const cp = e.target.closest('[data-copy]'); if (cp) return act('mcp:copy', { text: cp.dataset.copy });
  });
  p.update();
}

// ---- space / group modal ----
function openModal(kind, id) { openPanel('modal', { kind, id }); }
function buildModal(el, p) {
  const isSpace = p.kind === 'space';
  const existing = p.id ? (isSpace ? S.spaces : S.groups).find((x) => x.id === p.id) : null;
  const m = p.m = {
    name: existing?.name || '',
    icon: existing?.icon ? { ...existing.icon } : { type: isSpace ? 'symbol' : 'letter', value: isSpace ? 'home' : '' },
    color: existing?.color || COLORS[(isSpace ? S.spaces.length : S.groups.length) % COLORS.length],
  };
  el.innerHTML = head(`${existing ? 'Edit' : 'Add'} ${isSpace ? 'Space' : 'Group'}`) + `<div class="panel-body">
    <div class="preview" id="m-preview"></div>
    <div class="field"><label>Name</label><input class="input" id="m-name" value="${esc(m.name)}" placeholder="${isSpace ? 'e.g. Work, Personal, Research' : 'e.g. Docs, Social, Shopping'}" maxlength="40" /></div>
    <div class="field"><label>Icon</label>
      <div class="tabsel"><button data-ik="letter">Letter / Emoji</button><button data-ik="symbol">Symbol</button></div>
      <div id="m-icon"></div>
    </div>
    <div class="field"><label>Color</label><div class="swatches">${COLORS.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}"></button>`).join('')}</div></div>
    ${!isSpace && !existing ? `<div class="field"><label>Open URL in first tab (optional)</label><input class="input" id="m-url" placeholder="https://…" /></div>` : ''}
  </div>
  <div class="modal-actions">
    ${existing ? `<button class="btn danger" id="m-del">${icon('trash', 14)} Delete</button>` : ''}
    <span class="spacer"></span>
    <button class="btn" data-close-panel>Cancel</button>
    <button class="btn primary" id="m-save">${existing ? 'Save' : 'Create'}</button>
  </div>`;

  const paint = () => {
    const letter = m.icon.type === 'letter' ? (m.icon.value || (m.name || '?')[0] || '?').toUpperCase() : '';
    const ic = m.icon.type === 'symbol' ? icon(m.icon.value, isSpace ? 18 : 20) : esc(letter);
    $('#m-preview').innerHTML = isSpace
      ? `<div class="space active" style="--c:${m.color};opacity:1">${ic}</div>`
      : `<div class="group active" style="--c:${m.color}">${ic}</div>`;
    $$('[data-ik]').forEach((b) => b.classList.toggle('on', b.dataset.ik === m.icon.type));
    $$('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === m.color));
    $$('[data-sym]').forEach((b) => b.classList.toggle('on', b.dataset.sym === m.icon.value));
  };
  const paintIconPicker = () => {
    $('#m-icon').innerHTML = m.icon.type === 'symbol'
      ? `<div class="symbols">${SYMBOLS.map((s) => `<button data-sym="${s}">${icon(s, 17)}</button>`).join('')}</div>`
      : `<input class="input" id="m-letter" maxlength="2" placeholder="Auto from name" value="${esc(m.icon.type === 'letter' ? m.icon.value : '')}" />`;
    $('#m-letter')?.addEventListener('input', (e) => { m.icon.value = e.target.value.trim(); paint(); });
    paint();
  };
  $('#m-name').addEventListener('input', (e) => { m.name = e.target.value; paint(); });
  el.addEventListener('click', (e) => {
    const ik = e.target.closest('[data-ik]');
    if (ik) { m.icon = { type: ik.dataset.ik, value: ik.dataset.ik === 'symbol' ? SYMBOLS[0] : '' }; return paintIconPicker(); }
    const sy = e.target.closest('[data-sym]'); if (sy) { m.icon.value = sy.dataset.sym; return paint(); }
    const co = e.target.closest('[data-color]'); if (co) { m.color = co.dataset.color; return paint(); }
    if (e.target.closest('#m-del')) { closePanel(); return act(`${p.kind}:delete`, { id: p.id }); }
    if (e.target.closest('#m-save')) return save();
  });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') save(); });
  const save = async () => {
    const name = m.name.trim() || (isSpace ? 'Space' : 'Group');
    const ic = m.icon.type === 'letter' ? { type: 'letter', value: (m.icon.value || name[0]).toUpperCase().slice(0, 2) } : m.icon;
    const url = $('#m-url')?.value.trim();
    closePanel();
    if (existing) await act(`${p.kind}:update`, { id: p.id, name, icon: ic, color: m.color });
    else {
      await act(`${p.kind}:create`, { name, icon: ic, color: m.color });
      if (url) await act('nav:go', { input: url });
    }
  };
  paintIconPicker();
  setTimeout(() => $('#m-name').focus(), 0);
}

// ---------------- commands from main ----------------
window.tide.onCommand((c) => {
  switch (c.cmd) {
    case 'focusAddress': if (panel) closePanel(); addr.focus(); addr.select(); break;
    case 'focusFind': setTimeout(() => { findInput.focus(); findInput.select(); }, 30); break;
    case 'openPanel': openPanel(c.panel); break;
    case 'editSpace': openModal('space', c.id); break;
    case 'editGroup': openModal('group', c.id); break;
    case 'newGroup': openModal('group'); break;
    case 'toast': toast(c); break;
    default: break;
  }
});

window.tide.onState((s) => { S = s; render(); });
initStatic();
window.tide.getState().then((s) => { if (!S) { S = s; render(); } });
