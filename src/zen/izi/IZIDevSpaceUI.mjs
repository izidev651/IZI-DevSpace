// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// IZI DevSpace UI layer on top of Zen.
//
//   Space  = a Firefox container (separate cookies / logins), drawn as a circle.
//   Group  = a Zen workspace bound to that container, drawn as a rounded tile.
//            Switching Group shows only that workspace's tabs (Zen does this).
//
// The strip lives at the far left of the window (inside #zen-main-app-wrapper).
// Toolbar buttons (DevTools, Mobile View, Capture, Tools, Dock, Sleep) are
// CustomizableUI widgets placed in the nav-bar once, then fully user-movable.

import { nsZenDOMOperatedFeature } from "chrome://browser/content/zen-components/ZenCommonUtils.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICONS = "chrome://browser/content/izi/icons/";
const PREF_ENABLED = "izi.ui.enabled";
const PREF_PLACED = "izi.toolbar.placed";
const PREF_MIGRATED = "izi.spaces.migrated";
const PREF_LAST_GROUP = "izi.spaces.last-group"; // JSON { [userContextId]: workspaceUuid }

// Container colour names -> strip colours.
const COLORS = {
  turquoise: "#1fc7b6",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  pink: "#ec4899",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  red: "#ef4444",
  toolbar: "#64748b",
};
const COLOR_CYCLE = ["turquoise", "blue", "purple", "pink", "orange", "yellow", "green", "red"];
const LETTER_ICONS = new Set(["fingerprint", "circle"]);

function h(tag, attrs = {}, ...children) {
  const el = document.createElementNS(HTML_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on") {
      for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    } else if (k === "style" && typeof v === "object") {
      Object.assign(el.style, v);
    } else {
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function iconImg(name, cls = "izi-ic") {
  return h("img", { class: cls, src: `${ICONS}${name}.svg`, alt: "" });
}

function firstGrapheme(text) {
  try {
    return new Intl.Segmenter().segment(String(text || "?")).containing(0).segment.toUpperCase();
  } catch {
    return (Array.from(String(text || "?"))[0] || "?").toUpperCase();
  }
}

class nsIZIDevSpaceUI extends nsZenDOMOperatedFeature {
  #strip = null;
  #tabStrip = null;
  #tabsBox = null;
  #pinnedBox = null;
  #spacesBox = null;
  #groupsBox = null;
  #renderQueued = false;
  #tabsQueued = false;
  stage = "constructed";
  errors = [];

  #err(where, e) {
    this.errors.push(`${where}: ${e?.message || e}`);
    console.error(`[IZI] ${where}`, e);
  }

  async init() {
    if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) return;
    if (PrivateBrowsingUtils.isWindowPrivate(window)) return;
    const step = async (name, fn) => {
      this.stage = name;
      try {
        await fn();
      } catch (e) {
        this.#err(name, e);
      }
    };
    await step("strip", () => this.#buildStrip());
    await step("tabstrip", () => this.#buildTabStrip());
    await step("widgets", () => this.#setupToolbarWidgets());
    await step("newtab", () => this.#buildNewTab());
    document.documentElement.setAttribute("izi-devspace", "true");
    await step("wait-workspaces", () =>
      Promise.race([
        gZenWorkspaces.promiseInitialized,
        new Promise((r) => setTimeout(() => { this.errors.push("workspaces init > 15s, continuing"); r(); }, 15000)),
      ])
    );
    await step("migrate", () => this.#migrateOnce());
    await step("listen", () => this.#listen());
    this.stage = "ready";
    this.render();
    this.renderTabs();
  }

  // ------------------------------------------------------------------ data
  get spaces() {
    return ContextualIdentityService.getPublicIdentities().map((id) => ({
      id: id.userContextId,
      name: id.name || (id.l10nId ? ContextualIdentityService.getUserContextLabel(id.userContextId) : "Space"),
      icon: id.icon,
      color: COLORS[id.color] || COLORS.toolbar,
      colorName: id.color,
    }));
  }

  get groups() {
    return gZenWorkspaces.getWorkspaces() || [];
  }

  groupsOf(spaceId) {
    return this.groups.filter((g) => (g.containerTabId || 0) === spaceId);
  }

  get activeGroup() {
    return gZenWorkspaces.getActiveWorkspace();
  }

  get activeSpaceId() {
    return this.activeGroup?.containerTabId || 0;
  }

  #lastGroups() {
    try {
      return JSON.parse(Services.prefs.getStringPref(PREF_LAST_GROUP, "{}"));
    } catch {
      return {};
    }
  }

  #rememberGroup(group) {
    if (!group) return;
    const map = this.#lastGroups();
    map[group.containerTabId || 0] = group.uuid;
    Services.prefs.setStringPref(PREF_LAST_GROUP, JSON.stringify(map));
  }

  // First run: make sure "Personal" and "Work" spaces exist and every group
  // belongs to a space (Zen's default workspace has no container).
  async #migrateOnce() {
    if (Services.prefs.getBoolPref(PREF_MIGRATED, false)) return;
    Services.prefs.setBoolPref("privacy.userContext.enabled", true);
    Services.prefs.setBoolPref("privacy.userContext.ui.enabled", true);
    const find = (n) => this.spaces.find((s) => s.name.toLowerCase() === n.toLowerCase());
    const personal = find("Personal") || { id: ContextualIdentityService.create("Personal", "fingerprint", "turquoise").userContextId };
    if (!find("Work")) ContextualIdentityService.create("Work", "briefcase", "blue");
    for (const g of this.groups) {
      if (!g.containerTabId) {
        g.containerTabId = personal.id;
        gZenWorkspaces.saveWorkspace(g);
      }
    }
    Services.prefs.setBoolPref(PREF_MIGRATED, true);
  }

  #listen() {
    const rerender = () => { this.render(); this.renderTabs(); };
    window.addEventListener("ZenWorkspacesUIUpdate", rerender);
    window.addEventListener("ZenWorkspaceDataChanged", rerender);
    window.addEventListener("ZenWorkspaceAttached", rerender);
    gBrowser.tabContainer.addEventListener("TabOpen", rerender);
    gBrowser.tabContainer.addEventListener("TabClose", rerender);
    gBrowser.tabContainer.addEventListener("TabBrowserDiscarded", rerender);
    gBrowser.tabContainer.addEventListener("TabBrowserInserted", rerender);
    for (const ev of ["TabSelect", "TabMove", "TabAttrModified", "TabPinned", "TabUnpinned", "TabShow", "TabHide"]) {
      gBrowser.tabContainer.addEventListener(ev, () => this.renderTabs());
    }
    window.addEventListener("sizemodechange", () => this.renderTabs());
    const obs = { observe: rerender };
    Services.obs.addObserver(obs, "contextual-identity-created");
    Services.obs.addObserver(obs, "contextual-identity-updated");
    Services.obs.addObserver(obs, "contextual-identity-deleted");
    Services.prefs.addObserver("zen.view.window.scheme", rerender);
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(obs, "contextual-identity-created");
      Services.obs.removeObserver(obs, "contextual-identity-updated");
      Services.obs.removeObserver(obs, "contextual-identity-deleted");
      Services.prefs.removeObserver("zen.view.window.scheme", rerender);
    }, { once: true });
  }

  // ----------------------------------------------------------------- strip
  #buildStrip() {
    const wrapper = document.getElementById("zen-main-app-wrapper");
    this.#spacesBox = h("div", { class: "izi-col", id: "izi-spaces" });
    this.#groupsBox = h("div", { class: "izi-col izi-scroll", id: "izi-groups" });
    const tool = (id, icon, tip, fn) =>
      h("button", { id, class: "izi-side-btn", title: tip, on: { click: fn } }, iconImg(icon));
    const bottom = h(
      "div",
      { class: "izi-col", id: "izi-side-tools" },
      tool("izi-btn-search", "search", "Search tabs & web (Ctrl+K)", () => this.openSearch()),
      tool("izi-btn-tabs", "tabs", "Tab list", (e) => this.openTabList(e)),
      tool("izi-btn-notes", "notes", "Notes", (e) => this.openNotes(e)),
      tool("izi-btn-theme", "moon", "Toggle light / dark", () => this.toggleTheme()),
      tool("izi-btn-mcp", "mcp", "MCP Server (coming in stage 3)", () => {}),
      tool("izi-btn-settings", "settings", "Settings", () => openPreferences())
    );
    this.#strip = h(
      "div",
      { id: "izi-strip" },
      this.#spacesBox,
      h("div", { class: "izi-divider" }),
      this.#groupsBox,
      bottom
    );
    wrapper.prepend(this.#strip);
  }

  render() {
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    window.requestAnimationFrame(() => {
      this.#renderQueued = false;
      try {
        this.#renderNow();
      } catch (e) {
        console.error("[IZI] render failed", e);
      }
    });
  }

  #renderNow() {
    const active = this.activeGroup;
    const activeSpace = this.activeSpaceId;
    if (active) this.#rememberGroup(active);

    this.#spacesBox.replaceChildren(
      ...this.spaces.map((s) =>
        h(
          "button",
          {
            class: "izi-space" + (s.id === activeSpace ? " active" : ""),
            style: { "--c": s.color },
            title: s.name,
            "data-space": s.id,
            on: {
              click: () => this.activateSpace(s.id),
              contextmenu: (e) => this.spaceMenu(e, s),
            },
          },
          LETTER_ICONS.has(s.icon)
            ? h("span", { class: "izi-letter" }, firstGrapheme(s.name))
            : h("img", { class: "izi-ic", src: `resource://usercontext-content/${s.icon}.svg`, alt: "" })
        )
      ),
      h("button", { class: "izi-add-space", id: "izi-add-space", title: "Add Space", on: { click: () => this.addSpace() } }, iconImg("plus"))
    );

    const awake = new Set();
    for (const tab of gBrowser.tabs) {
      if (!tab.hasAttribute("pending") && tab.linkedPanel && !tab.hasAttribute("zen-empty-tab")) {
        awake.add(tab.getAttribute("zen-workspace-id"));
      }
    }
    const space = this.spaces.find((s) => s.id === activeSpace);
    this.#groupsBox.replaceChildren(
      ...this.groupsOf(activeSpace).map((g) => {
        const icon = gZenWorkspaces.getWorkspaceIcon(g);
        const isUrl = /^(chrome|resource|moz-extension|data):/.test(icon || "");
        return h(
          "button",
          {
            class: "izi-group" + (g.uuid === active?.uuid ? " active" : ""),
            style: { "--c": space?.color || COLORS.turquoise },
            title: g.name,
            "data-group": g.uuid,
            on: {
              click: () => this.activateGroup(g.uuid),
              contextmenu: (e) => this.groupMenu(e, g),
            },
          },
          isUrl ? h("img", { class: "izi-ic", src: icon, alt: "" }) : h("span", { class: "izi-letter" }, icon || firstGrapheme(g.name)),
          awake.has(g.uuid) ? h("span", { class: "izi-dot" }) : null
        );
      }),
      h("button", { class: "izi-add-group", id: "izi-add-group", title: "Add Group", on: { click: () => this.addGroup() } }, iconImg("plus"))
    );

    const dark = Services.prefs.getIntPref("zen.view.window.scheme", 2) !== 1;
    const themeImg = document.querySelector("#izi-btn-theme img");
    if (themeImg) themeImg.src = `${ICONS}${dark ? "moon" : "sun"}.svg`;
    this.#updateToolbarState();
  }


  // ------------------------------------------------------------- tab strip
  // Zen only lays tabs out vertically; IZI shows the current Group's tabs in a
  // horizontal strip above the address bar and hides Zen's sidebar.
  #buildTabStrip() {
    const wrapper = document.getElementById("zen-appcontent-wrapper");
    this.#pinnedBox = h("div", { id: "izi-pinned" });
    this.#tabsBox = h("div", { id: "izi-tabs" });
    const isMac = AppConstants.platform == "macosx";
    const winBtn = (id, icon, tip, fn) =>
      h("button", { id, class: "izi-win-btn", title: tip, on: { click: fn } }, iconImg(icon));
    const controls = isMac
      ? null
      : h(
          "div",
          { id: "izi-win-controls" },
          winBtn("izi-win-min", "win-min", "Minimize", () => window.minimize()),
          winBtn("izi-win-max", "win-max", "Maximize", () =>
            window.windowState === window.STATE_MAXIMIZED ? window.restore() : window.maximize()
          ),
          winBtn("izi-win-close", "win-close", "Close", () => window.close())
        );
    this.#tabStrip = h(
      "div",
      { id: "izi-tabstrip" },
      this.#pinnedBox,
      this.#tabsBox,
      h("button", { id: "izi-new-tab", class: "izi-tab-btn", title: "New tab (Ctrl+T)", on: { click: () => BrowserCommands.openTab() } }, iconImg("plus")),
      h("div", { class: "izi-drag-spacer", on: { dblclick: () => (window.windowState === window.STATE_MAXIMIZED ? window.restore() : window.maximize()) } }),
      controls
    );
    wrapper.prepend(this.#tabStrip);
    this.#setupTabDnD();
    // Back / forward / reload live in Zen's (now hidden) sidebar; put them in the nav-bar.
    if (!Services.prefs.getBoolPref("izi.toolbar.nav-placed", false)) {
      ["back-button", "forward-button", "stop-reload-button"].forEach((id, i) => {
        try { CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR, i); } catch (e) { this.#err(`place ${id}`, e); }
      });
      Services.prefs.setBoolPref("izi.toolbar.nav-placed", true);
    }
  }

  get stripTabs() {
    return gBrowser.visibleTabs.filter(
      (t) => !t.hasAttribute("zen-empty-tab") && !t.hasAttribute("zen-glance-tab") && !t.closing
    );
  }

  renderTabs() {
    if (this.#tabsQueued || !this.#tabsBox) return;
    this.#tabsQueued = true;
    window.requestAnimationFrame(() => {
      this.#tabsQueued = false;
      try {
        this.#renderTabsNow();
      } catch (e) {
        this.#err("renderTabs", e);
      }
    });
  }

  #favicon(tab) {
    if (tab.hasAttribute("busy")) return h("span", { class: "izi-spinner" });
    const src = tab.getAttribute("image");
    return src ? h("img", { class: "izi-fav", src, alt: "" }) : iconImg("globe", "izi-fav izi-ic");
  }

  #renderTabsNow() {
    const tabs = this.stripTabs;
    const pinned = tabs.filter((t) => t.pinned || t.hasAttribute("zen-essential"));
    const normal = tabs.filter((t) => !t.pinned && !t.hasAttribute("zen-essential"));
    const common = (t) => ({
      "data-tab-id": t.linkedPanel || t.id,
      draggable: "true",
      title: `${t.label}`,
      on: {
        mousedown: (e) => { if (e.button === 0 && !e.target.closest(".izi-tab-close")) gBrowser.selectedTab = t; },
        auxclick: (e) => { if (e.button === 1) gBrowser.removeTab(t, { animate: true }); },
        contextmenu: (e) => this.tabMenu(e, t),
      },
    });
    this.#pinnedBox.replaceChildren(
      ...pinned.map((t) => {
        const el = h("div", { class: "izi-pin" + (t.selected ? " active" : "") + (t.hasAttribute("pending") ? " sleeping" : ""), ...common(t) }, this.#favicon(t));
        el._tab = t;
        return el;
      })
    );
    this.#tabsBox.replaceChildren(
      ...normal.map((t) => {
        const el = h(
          "div",
          {
            class: "izi-tab" + (t.selected ? " active" : "") + (t.hasAttribute("pending") ? " sleeping" : "") + (t.hasAttribute("split-view") ? " docked" : ""),
            ...common(t),
          },
          this.#favicon(t),
          h("span", { class: "izi-tab-title" }, t.label || ""),
          t.hasAttribute("soundplaying") ? iconImg("volume", "izi-ic izi-audio") : null,
          t.hasAttribute("pending") ? h("span", { class: "izi-zz" }, "zᶻ") : null,
          h("button", { class: "izi-tab-close", title: "Close tab (Ctrl+W)", on: { click: (e) => { e.stopPropagation(); gBrowser.removeTab(t, { animate: true }); } } }, iconImg("x"))
        );
        el._tab = t;
        return el;
      })
    );
    const maxImg = document.querySelector("#izi-win-max img");
    if (maxImg) maxImg.src = `${ICONS}${window.windowState === window.STATE_MAXIMIZED ? "win-restore" : "win-max"}.svg`;
  }

  #setupTabDnD() {
    let dragged = null;
    const clear = () => this.#tabStrip.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    this.#tabStrip.addEventListener("dragstart", (e) => {
      const el = e.target.closest?.(".izi-tab, .izi-pin");
      if (!el) return;
      dragged = el._tab;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/x-izi-tab", "1");
    });
    this.#tabStrip.addEventListener("dragover", (e) => {
      const el = e.target.closest?.(".izi-tab, .izi-pin");
      if (!dragged || !el) return;
      e.preventDefault();
      clear();
      const r = el.getBoundingClientRect();
      el.classList.add(e.clientX < r.left + r.width / 2 ? "drop-before" : "drop-after");
    });
    this.#tabStrip.addEventListener("drop", (e) => {
      const el = e.target.closest?.(".izi-tab, .izi-pin");
      clear();
      if (!dragged || !el || el._tab === dragged) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      try {
        if (before && gBrowser.moveTabBefore) gBrowser.moveTabBefore(dragged, el._tab);
        else if (!before && gBrowser.moveTabAfter) gBrowser.moveTabAfter(dragged, el._tab);
        else gBrowser.moveTabTo(dragged, { tabIndex: el._tab._tPos + (before ? 0 : 1) });
      } catch (err) {
        this.#err("moveTab", err);
      }
      this.renderTabs();
    });
    this.#tabStrip.addEventListener("dragend", () => { dragged = null; clear(); });
  }

  tabMenu(event, tab) {
    const groups = this.groups.filter((g) => g.uuid !== tab.getAttribute("zen-workspace-id"));
    this.#popup("izi-tab-menu", [
      { label: "New Tab to the Right", run: () => { const t = gBrowser.addTrustedTab(BROWSER_NEW_TAB_URL); gBrowser.moveTabAfter?.(t, tab); } },
      { label: "Reload", run: () => gBrowser.reloadTab(tab) },
      { label: "Duplicate", run: () => gBrowser.duplicateTab(tab) },
      { label: tab.pinned ? "Unpin Tab" : "Pin Tab", run: () => (tab.pinned ? gBrowser.unpinTab(tab) : gBrowser.pinTab(tab)) },
      "-",
      { label: tab.hasAttribute("pending") ? "Wake Tab" : "Sleep Tab", run: () => (tab.hasAttribute("pending") ? (gBrowser.selectedTab = tab) : gBrowser.explicitUnloadTabs([tab])) },
      { label: "Dock Beside Active Tab", disabled: tab.selected, run: () => gZenViewSplitter.splitTabs([gBrowser.selectedTab, tab], "vsep", 0) },
      { label: "Move to Group", submenu: groups.length ? groups.map((g) => ({ label: `${this.spaces.find((s) => s.id === (g.containerTabId || 0))?.name || "Space"} › ${g.name}`, run: () => gZenWorkspaces.moveTabToWorkspace(tab, g.uuid) })) : [{ label: "No other Group", disabled: true, run() {} }] },
      "-",
      { label: "Close Tab", run: () => gBrowser.removeTab(tab, { animate: true }) },
      { label: "Close Other Tabs", run: () => this.stripTabs.filter((t) => t !== tab && !t.pinned && !t.hasAttribute("zen-essential")).forEach((t) => gBrowser.removeTab(t)) },
    ], event);
  }


  // --------------------------------------------------------------- new tab
  // Zen's new tab is an "empty tab" (root[zen-has-empty-tab]); IZI paints the
  // wave background, a search pill and a Customize popover over the page area.
  static WAVES = {
    teal: { bg: "#04121a", layers: ["#061b25", "#082833", "#0a3640", "#0e454c", "#125659"] },
    ocean: { bg: "#050b1a", layers: ["#0a1730", "#0e2245", "#132f5c", "#1a3d74", "#22508f"] },
    sunset: { bg: "#140a1c", layers: ["#2a1033", "#45173f", "#6b2245", "#963346", "#c44d3f"] },
    forest: { bg: "#07120c", layers: ["#0c1f15", "#112c1d", "#173b26", "#1e4b30", "#275e3b"] },
    mono: { bg: "#0b0d10", layers: ["#14181d", "#1b2026", "#232930", "#2b333b", "#353e47"] },
  };

  #wavePath(baseY, amp, seed) {
    let st = seed;
    const r = () => { st = (st * 16807) % 2147483647; return (st - 1) / 2147483646; };
    const pts = [];
    for (let x = -240; x <= 1680; x += 240) pts.push([x, baseY + (r() * 2 - 1) * amp]);
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1].toFixed(1)}`;
    }
    return d + " L1680,960 L-240,960 Z";
  }

  #paintWaves() {
    const theme = nsIZIDevSpaceUI.WAVES[Services.prefs.getStringPref("izi.newtab.wave", "teal")] || nsIZIDevSpaceUI.WAVES.teal;
    const layers = [[290, 42, 7], [390, 52, 23], [490, 58, 41], [590, 62, 59], [690, 58, 97]];
    const SVG = "http://www.w3.org/2000/svg";
    const svg = document.getElementById("izi-waves");
    svg.replaceChildren();
    layers.forEach(([y, a, sd], i) => {
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "izi-wave");
      g.style.setProperty("--dur", `${9 + i * 2.5}s`);
      g.style.setProperty("--amp", `${4 + i}px`);
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("d", this.#wavePath(y, a, sd));
      path.setAttribute("fill", theme.layers[i]);
      g.append(path);
      svg.append(g);
    });
    this.newTabEl.style.background = theme.bg;
    this.newTabEl.toggleAttribute("animate", Services.prefs.getBoolPref("izi.newtab.animate", true));
  }

  #buildNewTab() {
    const tabbox = document.getElementById("tabbrowser-tabbox");
    const SVG = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(SVG, "svg");
    svg.id = "izi-waves";
    svg.setAttribute("viewBox", "0 0 1440 900");
    svg.setAttribute("preserveAspectRatio", "none");
    const themes = Object.entries(nsIZIDevSpaceUI.WAVES).map(([k, t]) =>
      h("button", {
        class: "izi-wave-theme",
        "data-wave": k,
        title: k,
        style: { background: `linear-gradient(180deg, ${t.bg}, ${t.layers[2]} 55%, ${t.layers[4]})` },
        on: { click: () => { Services.prefs.setStringPref("izi.newtab.wave", k); } },
      })
    );
    const animate = h("input", { type: "checkbox", id: "izi-wave-animate", on: { change: (e) => Services.prefs.setBoolPref("izi.newtab.animate", e.target.checked) } });
    const custom = h(
      "div",
      { id: "izi-newtab-customize", hidden: true },
      h("div", { class: "izi-nt-head" }, h("b", {}, "Customize"), h("button", { class: "izi-nt-x", on: { click: () => (custom.hidden = true) } }, "✕")),
      h("div", { class: "izi-nt-sec" }, "Wave theme"),
      h("div", { class: "izi-nt-themes" }, themes),
      h("label", { class: "izi-nt-row" }, h("span", {}, "Animate waves"), animate)
    );
    this.newTabEl = h(
      "div",
      { id: "izi-newtab" },
      svg,
      h("div", { id: "izi-newtab-search", on: { click: () => this.openSearch() } }, iconImg("search"), h("span", {}, "Search or type a URL")),
      h("button", { id: "izi-newtab-customize-btn", on: { click: () => { custom.hidden = !custom.hidden; } } }, iconImg("pencil"), " Customize"),
      custom
    );
    tabbox.append(this.newTabEl);
    const sync = () => {
      animate.checked = Services.prefs.getBoolPref("izi.newtab.animate", true);
      const cur = Services.prefs.getStringPref("izi.newtab.wave", "teal");
      themes.forEach((b) => b.toggleAttribute("selected", b.dataset.wave === cur));
      this.#paintWaves();
    };
    Services.prefs.addObserver("izi.newtab.", sync);
    window.addEventListener("unload", () => Services.prefs.removeObserver("izi.newtab.", sync), { once: true });
    sync();
    // Keep the overlay exactly over the page area.
    const panels = document.getElementById("tabbrowser-tabpanels");
    const place = () => {
      const a = tabbox.getBoundingClientRect();
      const b = panels.getBoundingClientRect();
      Object.assign(this.newTabEl.style, { left: `${b.left - a.left}px`, top: `${b.top - a.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    };
    new ResizeObserver(place).observe(panels);
    window.addEventListener("resize", place);
    place();
  }

  // --------------------------------------------------------------- actions
  async activateGroup(uuid) {
    if (uuid === this.activeGroup?.uuid) return;
    await gZenWorkspaces.changeWorkspaceWithID(uuid);
    this.render();
  }

  async activateSpace(spaceId) {
    const groups = this.groupsOf(spaceId);
    const last = this.#lastGroups()[spaceId];
    const target = groups.find((g) => g.uuid === last) || groups[0];
    if (target) return this.activateGroup(target.uuid);
    return this.createGroup(spaceId, "Main");
  }

  #ask(title, label, value = "") {
    const v = { value };
    const ok = Services.prompt.prompt(window, title, label, v, null, {});
    const text = ok ? String(v.value || "").trim() : "";
    return text || null;
  }

  async createGroup(spaceId, name) {
    const ws = await gZenWorkspaces.createAndSaveWorkspace(name, undefined, false, spaceId);
    if (ws && (ws.containerTabId !== spaceId || ws.name !== name)) {
      // Zen may derive name/container from the current tab; enforce ours.
      const fixed = { ...gZenWorkspaces.getWorkspaceFromId(ws.uuid), name, containerTabId: spaceId };
      gZenWorkspaces.saveWorkspace(fixed);
    }
    this.render();
    return ws;
  }

  async addGroup() {
    const name = this.#ask("Add Group", "Group name (e.g. Docs, Social, Shopping):");
    if (!name) return;
    await this.createGroup(this.activeSpaceId, name);
  }

  async addSpace() {
    const name = this.#ask("Add Space", "Space name (e.g. Personal, Work, Research). Each Space keeps its own cookies and logins:");
    if (!name) return;
    const used = new Set(this.spaces.map((s) => s.colorName));
    const color = COLOR_CYCLE.find((c) => !used.has(c)) || COLOR_CYCLE[this.spaces.length % COLOR_CYCLE.length];
    const identity = ContextualIdentityService.create(name, "circle", color);
    await this.createGroup(identity.userContextId, "Main");
  }

  #popup(id, items, event) {
    document.getElementById(id)?.remove();
    const popup = document.createXULElement("menupopup");
    popup.id = id;
    const add = (parent, item) => {
      if (item === "-") return parent.append(document.createXULElement("menuseparator"));
      if (item.submenu) {
        const menu = document.createXULElement("menu");
        menu.setAttribute("label", item.label);
        const sub = document.createXULElement("menupopup");
        item.submenu.forEach((s) => add(sub, s));
        menu.append(sub);
        return parent.append(menu);
      }
      const mi = document.createXULElement("menuitem");
      mi.setAttribute("label", item.label);
      if (item.disabled) mi.setAttribute("disabled", "true");
      if (item.checked) { mi.setAttribute("type", "checkbox"); mi.setAttribute("checked", "true"); }
      mi.addEventListener("command", item.run);
      parent.append(mi);
    };
    items.forEach((i) => add(popup, i));
    document.getElementById("mainPopupSet").append(popup);
    popup.addEventListener("popuphidden", () => popup.remove(), { once: true });
    if (event?.type === "contextmenu") {
      event.preventDefault();
      popup.openPopupAtScreen(event.screenX, event.screenY, true, event);
    } else {
      popup.openPopup(event?.currentTarget || event?.target || null, "after_start");
    }
  }

  spaceMenu(event, space) {
    const colors = COLOR_CYCLE.map((c) => ({
      label: c[0].toUpperCase() + c.slice(1),
      checked: space.colorName === c,
      run: () => ContextualIdentityService.update(space.id, space.name, space.icon, c),
    }));
    const icons = ["circle", "briefcase", "fingerprint", "dollar", "cart", "gift", "vacation", "food", "fruit", "pet", "tree", "chill", "fence"].map((i) => ({
      label: i, checked: space.icon === i,
      run: () => ContextualIdentityService.update(space.id, space.name, i, space.colorName),
    }));
    this.#popup("izi-space-menu", [
      { label: "Rename Space…", run: () => { const n = this.#ask("Rename Space", "Space name:", space.name); if (n) ContextualIdentityService.update(space.id, n, space.icon, space.colorName); } },
      { label: "Color", submenu: colors },
      { label: "Icon", submenu: icons },
      { label: "New Group in this Space…", run: async () => { const n = this.#ask("Add Group", "Group name:"); if (n) await this.createGroup(space.id, n); } },
      "-",
      { label: "Delete Space…", disabled: this.spaces.length <= 1, run: () => this.deleteSpace(space) },
    ], event);
  }

  async deleteSpace(space) {
    const groups = this.groupsOf(space.id);
    const ok = Services.prompt.confirm(window, "Delete Space", `Delete Space "${space.name}"? Its ${groups.length} group(s) move to another Space, and its cookies/logins are removed.`);
    if (!ok) return;
    const target = this.spaces.find((s) => s.id !== space.id);
    for (const g of groups) gZenWorkspaces.saveWorkspace({ ...g, containerTabId: target.id });
    ContextualIdentityService.remove(space.id);
    await this.activateSpace(target.id);
  }

  groupMenu(event, group) {
    const moveTo = this.spaces.filter((s) => s.id !== (group.containerTabId || 0)).map((s) => ({
      label: s.name,
      run: () => { gZenWorkspaces.saveWorkspace({ ...group, containerTabId: s.id }); this.render(); },
    }));
    this.#popup("izi-group-menu", [
      { label: "Rename Group…", run: () => { const n = this.#ask("Rename Group", "Group name:", group.name); if (n) { gZenWorkspaces.saveWorkspace({ ...group, name: n }); this.render(); } } },
      { label: "Change Icon (emoji / letter)…", run: () => { const n = this.#ask("Group icon", "Type an emoji or 1–2 letters (empty = first letter of the name):", gZenWorkspaces.workspaceHasIcon(group) ? group.icon : ""); gZenWorkspaces.saveWorkspace({ ...group, icon: n ? n.slice(0, 4) : "" }); this.render(); } },
      { label: "Sleep All Tabs in Group", run: () => gZenWorkspaces.changeWorkspaceWithID(group.uuid).then(() => gZenWorkspaces.unloadWorkspace()) },
      { label: "Move to Space", submenu: moveTo.length ? moveTo : [{ label: "No other Space", disabled: true, run() {} }] },
      "-",
      { label: "Delete Group…", disabled: this.groups.length <= 1, run: () => this.deleteGroup(group) },
    ], event);
  }

  async deleteGroup(group) {
    const ok = Services.prompt.confirm(window, "Delete Group", `Delete Group "${group.name}" and close its tabs?`);
    if (!ok) return;
    const others = this.groupsOf(group.containerTabId || 0).filter((g) => g.uuid !== group.uuid);
    const next = others[0] || this.groups.find((g) => g.uuid !== group.uuid);
    if (next && this.activeGroup?.uuid === group.uuid) await gZenWorkspaces.changeWorkspaceWithID(next.uuid);
    await gZenWorkspaces.removeWorkspace(group.uuid);
    this.render();
  }

  // ------------------------------------------------------- bottom buttons
  openSearch() {
    if (typeof focusAndSelectUrlBar === "function") focusAndSelectUrlBar();
    else gURLBar.select();
  }

  openTabList(event) {
    if (window.gTabsPanel?.showAllTabsPanel) gTabsPanel.showAllTabsPanel(event, "izi-strip");
  }

  toggleTheme() {
    const cur = Services.prefs.getIntPref("zen.view.window.scheme", 2);
    const dark = cur === 0 || (cur === 2 && window.matchMedia("(prefers-color-scheme: dark)").matches);
    Services.prefs.setIntPref("zen.view.window.scheme", dark ? 1 : 0);
  }

  async #notesFile() {
    return PathUtils.join(PathUtils.profileDir, "izi-notes.json");
  }

  async openNotes(event) {
    let notes = {};
    try { notes = await IOUtils.readJSON(await this.#notesFile()); } catch {}
    const spaceId = String(this.activeSpaceId);
    const space = this.spaces.find((s) => String(s.id) === spaceId);
    document.getElementById("izi-notes-panel")?.remove();
    const panel = document.createXULElement("panel");
    panel.id = "izi-notes-panel";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("noautofocus", "false");
    const ta = h("textarea", { id: "izi-notes-text", placeholder: "Write anything… saved automatically per Space." });
    ta.value = notes[spaceId] || "";
    const status = h("span", { class: "izi-notes-status" });
    let timer = null;
    ta.addEventListener("input", () => {
      status.textContent = "Saving…";
      clearTimeout(timer);
      timer = setTimeout(async () => {
        notes[spaceId] = ta.value;
        await IOUtils.writeJSON(await this.#notesFile(), notes);
        status.textContent = "Saved";
      }, 400);
    });
    panel.append(h("div", { class: "izi-notes" }, h("div", { class: "izi-notes-head" }, h("b", {}, `Notes · ${space?.name || "Space"}`), status), ta));
    document.getElementById("mainPopupSet").append(panel);
    panel.addEventListener("popuphidden", () => panel.remove(), { once: true });
    panel.openPopup(event.currentTarget, "end_after");
    setTimeout(() => ta.focus(), 50);
  }

  // ------------------------------------------------------ toolbar widgets
  #setupToolbarWidgets() {
    const widgets = [
      ["izi-devtools-button", "DevTools (F12)", () => this.#doKey(["key_toggleToolboxF12", "key_toggleToolbox"])],
      ["izi-mobile-button", "Mobile View (Ctrl+Shift+M)", () => this.#doKey(["key_responsiveDesignMode"])],
      ["izi-dock-button", "Dock Tab (split view)", (e) => this.dockMenu(e)],
      ["izi-sleep-button", "Sleep Tab", () => this.sleepTab()],
    ];
    for (const [id, label, onCommand] of widgets) {
      if (CustomizableUI.getWidget(id)?.provider === CustomizableUI.PROVIDER_API) continue;
      CustomizableUI.createWidget({
        id,
        type: "button",
        label,
        tooltiptext: label,
        removable: true,
        defaultArea: null,
        onCommand: (event) => event.target.ownerGlobal.gIZIDevSpaceUI?.[`_cmd_${id}`]?.(event),
      });
    }
    // Commands are per-window (the widget is app-wide).
    for (const [id, , fn] of widgets) this[`_cmd_${id}`] = fn;

    if (!Services.prefs.getBoolPref(PREF_PLACED, false)) {
      const order = ["izi-devtools-button", "izi-mobile-button", "screenshot-button", "developer-button", "izi-dock-button", "izi-sleep-button"];
      const urlbarPos = CustomizableUI.getPlacementOfWidget("urlbar-container")?.position ?? 0;
      let pos = urlbarPos + 1;
      for (const id of order) {
        try {
          CustomizableUI.addWidgetToArea(id, CustomizableUI.AREA_NAVBAR, pos++);
        } catch (e) {
          console.warn("[IZI] could not place", id, e);
        }
      }
      Services.prefs.setBoolPref(PREF_PLACED, true);
    }
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.#updateToolbarState());
  }

  #doKey(ids) {
    for (const id of ids) {
      const key = document.getElementById(id);
      if (key) {
        key.doCommand();
        return true;
      }
    }
    console.warn("[IZI] none of these keys exist:", ids);
    return false;
  }

  #updateToolbarState() {
    const tab = gBrowser.selectedTab;
    const dock = document.getElementById("izi-dock-button");
    if (dock) dock.toggleAttribute("checked", tab.hasAttribute("split-view"));
  }

  dockMenu(event) {
    const current = gBrowser.selectedTab;
    if (current.hasAttribute("split-view")) {
      return this.#popup("izi-dock-menu", [
        { label: "Undock (close split view)", run: () => gZenViewSplitter.unsplitCurrentView() },
      ], event);
    }
    const others = gBrowser.visibleTabs.filter((t) => t !== current && !t.hasAttribute("zen-empty-tab") && !t.hasAttribute("zen-essential"));
    this.#popup("izi-dock-menu", [
      { label: "Dock beside current tab:", disabled: true, run() {} },
      ...others.slice(0, 20).map((t) => ({ label: `   ${t.label}`.slice(0, 70), run: () => gZenViewSplitter.splitTabs([current, t], "vsep", 0) })),
      "-",
      { label: "Dock a new tab", run: () => { const t = gBrowser.addTrustedTab(BROWSER_NEW_TAB_URL, { inBackground: true }); gZenViewSplitter.splitTabs([current, t], "vsep", 0); } },
    ], event);
  }

  async sleepTab() {
    const tab = gBrowser.selectedTab;
    if (tab.hasAttribute("zen-empty-tab")) return;
    await gBrowser.explicitUnloadTabs([tab]);
    this.render();
  }
}

window.gIZIDevSpaceUI = new nsIZIDevSpaceUI();
