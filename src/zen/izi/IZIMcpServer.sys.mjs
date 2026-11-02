// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// IZI DevSpace built-in MCP server.
//
// Model Context Protocol over Streamable HTTP (JSON responses) on
// http://127.0.0.1:<port>/mcp so AI agents (Claude Code, Claude Desktop,
// Cursor, ...) can drive the browser. One server per application; it always
// acts on the most recent browser window.
//
// Safety: binds to loopback only; httpd rejects unknown Host headers (DNS
// rebinding); browser Origins other than localhost are refused; optional
// bearer token (pref izi.mcp.token). Off by default (pref izi.mcp.enabled).

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const PREF_ENABLED = "izi.mcp.enabled";
const PREF_PORT = "izi.mcp.port";
const PREF_TOKEN = "izi.mcp.token";
const SERVER_NAME = "izi-devspace";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// httpd writes "binary strings" (one char per byte): UTF-8 encode, then map
// bytes to chars in chunks (large screenshots would overflow a single spread).
function toBinaryString(str) {
  const bytes = new TextEncoder().encode(str);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

const text = (v) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });

const S = (props = {}, required = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });
const bool = (description) => ({ type: "boolean", description });
const TAB_ID = str("Tab id (from list_tabs). Defaults to the active tab.");
const TARGET = { ref: int("Element ref number from snapshot"), selector: str("CSS selector (alternative to ref)") };

class McpServer {
  #server = null;
  #sessions = new Map(); // id -> { client, created }
  #listeners = new Set();
  log = [];
  error = null;

  get port() {
    return Services.prefs.getIntPref(PREF_PORT, 9420);
  }
  get token() {
    return Services.prefs.getStringPref(PREF_TOKEN, "");
  }
  get enabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, false);
  }
  get running() {
    return !!this.#server && !this.#server.isStopped();
  }
  get url() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }
  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      port: this.port,
      url: this.url,
      token: this.token,
      error: this.error,
      clients: [...this.#sessions.values()].map((s) => s.client),
      tools: TOOLS.map((t) => t.name),
    };
  }

  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  #emit() {
    for (const fn of this.#listeners) {
      try { fn(this.status()); } catch {}
    }
  }
  #log(entry) {
    this.log.push({ time: Date.now(), ...entry });
    if (this.log.length > 200) this.log.splice(0, this.log.length - 200);
    this.#emit();
  }
  clearLog() {
    this.log = [];
    this.#emit();
  }

  // Called once per window; starts/stops to match the pref.
  sync() {
    if (this.enabled && !this.running) this.start();
    else if (!this.enabled && this.running) this.stop();
  }

  start() {
    if (this.running) return;
    this.error = null;
    const port = this.port;
    try {
      const server = new lazy.HttpServer();
      server.registerPathHandler("/mcp", (req, res) => this.#handle(req, res));
      server.registerPathHandler("/health", (req, res) => {
        res.setStatusLine("1.1", 200, "OK");
        res.setHeader("Content-Type", "application/json", false);
        res.write(JSON.stringify({ ok: true, name: SERVER_NAME }));
      });
      server._start(port, "localhost");
      server.identity.add("http", "127.0.0.1", port);
      this.#server = server;
    } catch (e) {
      this.#server = null;
      this.error = e?.result === Cr.NS_ERROR_SOCKET_ADDRESS_IN_USE ? `Port ${port} is already in use` : String(e?.message || e);
      console.error("[IZI MCP] failed to start", e);
    }
    this.#emit();
  }

  stop() {
    const server = this.#server;
    this.#server = null;
    this.#sessions.clear();
    if (server) {
      server.stop(() => {});
    }
    this.#emit();
  }

  restart() {
    this.stop();
    this.sync();
  }

  // ---------------------------------------------------------------- HTTP
  #reply(res, status, body, headers = {}) {
    res.setStatusLine("1.1", status, status === 200 ? "OK" : status === 202 ? "Accepted" : "Error");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v, false);
    if (body !== undefined) {
      res.setHeader("Content-Type", "application/json", false);
      res.write(toBinaryString(typeof body === "string" ? body : JSON.stringify(body)));
    }
    res.finish();
  }

  #handle(req, res) {
    res.processAsync();
    this.#handleAsync(req, res).catch((e) => {
      console.error("[IZI MCP]", e);
      try { this.#reply(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e?.message || e) } }); } catch {}
    });
  }

  async #handleAsync(req, res) {
    const header = (n) => (req.hasHeader(n) ? req.getHeader(n) : "");
    const origin = header("Origin");
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return this.#reply(res, 403, { error: "Forbidden origin" });
    }
    if (this.token && header("Authorization") !== `Bearer ${this.token}`) {
      return this.#reply(res, 401, { error: "Unauthorized" });
    }
    if (req.method === "GET") {
      return this.#reply(res, 405, { error: "SSE stream not offered; use POST" }, { Allow: "POST, DELETE" });
    }
    if (req.method === "DELETE") {
      this.#sessions.delete(header("Mcp-Session-Id"));
      this.#emit();
      return this.#reply(res, 200, {});
    }
    if (req.method !== "POST") return this.#reply(res, 405, { error: "Method not allowed" });

    const stream = req.bodyInputStream;
    const raw = stream.available() ? lazy.NetUtil.readInputStreamToString(stream, stream.available(), { charset: "UTF-8" }) : "";
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.#reply(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    const extraHeaders = {};
    const isInit = batch.some((m) => m?.method === "initialize");
    let sid = header("Mcp-Session-Id");
    if (isInit) {
      sid = Services.uuid.generateUUID().toString().slice(1, -1);
      const info = batch.find((m) => m.method === "initialize")?.params?.clientInfo;
      this.#sessions.set(sid, { client: info ? `${info.name} ${info.version || ""}`.trim() : "unknown client", created: Date.now() });
      extraHeaders["Mcp-Session-Id"] = sid;
      this.#log({ tool: "connect", ok: true, args: { client: this.#sessions.get(sid).client } });
    } else if (sid && !this.#sessions.has(sid)) {
      return this.#reply(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    }

    const results = [];
    for (const m of batch) {
      if (!m || typeof m !== "object") continue;
      const r = await this.#dispatch(m);
      if (m.id !== undefined && r) results.push({ jsonrpc: "2.0", id: m.id, ...r });
    }
    if (!results.length) return this.#reply(res, 202, undefined, extraHeaders);
    return this.#reply(res, 200, Array.isArray(msg) ? results : results[0], extraHeaders);
  }

  async #dispatch(m) {
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion;
        return {
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: "IZI DevSpace", version: Services.appinfo.version },
            instructions:
              "IZI DevSpace browser control. Typical flow: list_tabs/open_tab -> snapshot -> click/type by ref -> get_page_text/screenshot. Spaces have separate logins; Groups hold tabs. Tabs may be sleeping; tools wake them automatically.",
          },
        };
      }
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
      case "tools/call": {
        const name = m.params?.name;
        const args = m.params?.arguments || {};
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
        const started = Date.now();
        try {
          const result = await tool.run(args, this);
          this.#log({ tool: name, args, ok: true, ms: Date.now() - started });
          return { result };
        } catch (e) {
          this.#log({ tool: name, args, ok: false, error: String(e?.message || e), ms: Date.now() - started });
          return { result: { isError: true, content: [{ type: "text", text: `Error: ${e?.message || e}` }] } };
        }
      }
      default:
        if (m.id === undefined) return null; // notification
        return { error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }
}

// ------------------------------------------------------------------ helpers
function win() {
  const w = Services.wm.getMostRecentWindow("navigator:browser");
  if (!w) throw new Error("No browser window is open");
  return w;
}

function findTab(w, tabId) {
  if (!tabId) return w.gBrowser.selectedTab;
  const tab = w.gBrowser.tabs.find((t) => t.linkedPanel === tabId || t.id === tabId);
  if (!tab) throw new Error(`Tab not found: ${tabId}`);
  return tab;
}

function describeTab(w, t) {
  const ws = w.gZenWorkspaces?.getWorkspaceFromId?.(t.getAttribute("zen-workspace-id"));
  // The window's ContextualIdentityService global (module URL differs across Firefox versions).
  const space = ws ? w.ContextualIdentityService.getPublicIdentityFromId(ws.containerTabId)?.name : null;
  return {
    id: t.linkedPanel || t.id,
    title: t.label,
    url: t.linkedBrowser?.currentURI?.spec,
    group: ws?.name,
    groupId: ws?.uuid,
    space,
    active: t.selected,
    sleeping: t.hasAttribute("pending"),
    loading: t.hasAttribute("busy"),
  };
}

async function waitForLoad(tab, timeout = 20000) {
  const end = Date.now() + timeout;
  await sleep(150);
  while (Date.now() < end) {
    if (!tab.hasAttribute("busy") && !tab.hasAttribute("pending") && tab.linkedBrowser?.browsingContext?.currentWindowGlobal) return true;
    await sleep(150);
  }
  return false;
}

// Wake (select) a sleeping tab and wait for it to load before talking to it.
async function ready(w, tabId) {
  const tab = findTab(w, tabId);
  if (tab.hasAttribute("pending")) {
    const prev = w.gBrowser.selectedTab;
    w.gBrowser.selectedTab = tab;
    await waitForLoad(tab);
    if (tabId && prev !== tab) w.gBrowser.selectedTab = prev;
  }
  await waitForLoad(tab);
  return tab;
}

async function query(tab, name, data) {
  const wg = tab.linkedBrowser.browsingContext?.currentWindowGlobal;
  if (!wg) throw new Error("Page is not ready");
  return wg.getActor("IZIDevSpace").sendQuery(name, data);
}

function resolveInput(w, input) {
  const t = String(input || "").trim();
  try {
    const info = Services.uriFixup.getFixupURIInfo(t, Services.uriFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP | Services.uriFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS);
    if (info.preferredURI) return info.preferredURI.spec;
  } catch {}
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function load(w, tab, url) {
  tab.linkedBrowser.fixupAndLoadURIString(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
}

async function snapshotPng(tab, fullPage) {
  const wg = tab.linkedBrowser.browsingContext.currentWindowGlobal;
  let rect = null;
  let scale = 1;
  if (fullPage) {
    const m = await query(tab, "IZI:Metrics");
    const h = Math.min(m.height, 16000);
    rect = new (tab.ownerDocument.defaultView.DOMRect)(0, 0, m.width, h);
  } else {
    const b = tab.linkedBrowser.getBoundingClientRect();
    scale = b.width > 1280 ? 1280 / b.width : 1;
  }
  const bitmap = await wg.drawSnapshot(rect, scale, "white", { resetScrollPosition: !!fullPage });
  const doc = tab.ownerDocument;
  const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  bitmap.close();
  const dataUrl = canvas.toDataURL(fullPage ? "image/png" : "image/jpeg", 0.85);
  return { dataUrl, width: canvas.width, height: canvas.height };
}

async function savePng(w, tab, dataUrl) {
  const downloads = await w.Downloads.getPreferredDownloadsDirectory();
  const dir = PathUtils.join(downloads, "IZI DevSpace Captures");
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  let host = "page";
  try { host = tab.linkedBrowser.currentURI.host.replace(/[^\w.-]/g, "") || "page"; } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = PathUtils.join(dir, `${host}-${stamp}.png`);
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
  await IOUtils.write(file, bytes);
  return file;
}

const isRDMOpen = (w) => !!w.document.querySelector(".rdm-toolbar, .rdm-toolbox, browser.rdm-toolbar");

// -------------------------------------------------------------------- tools
const TOOLS = [
  {
    name: "list_spaces",
    description: "List Spaces (separate logins/cookies) and the Groups (tab sets) in each.",
    inputSchema: S(),
    run() {
      const w = win();
      const groups = w.gZenWorkspaces.getWorkspaces();
      const active = w.gZenWorkspaces.getActiveWorkspace();
      return text(
        w.ContextualIdentityService.getPublicIdentities().map((s) => ({
          id: s.userContextId,
          name: s.name,
          active: active?.containerTabId === s.userContextId,
          groups: groups.filter((g) => g.containerTabId === s.userContextId).map((g) => ({ id: g.uuid, name: g.name, active: g.uuid === active?.uuid })),
        }))
      );
    },
  },
  {
    name: "list_tabs",
    description: "List tabs in the active Group (all=true for every Group).",
    inputSchema: S({ all: bool("Include tabs from every Group") }),
    run({ all }) {
      const w = win();
      const tabs = (all ? w.gBrowser.tabs : w.gBrowser.visibleTabs).filter((t) => !t.hasAttribute("zen-empty-tab") && !t.hasAttribute("zen-glance-tab"));
      return text(tabs.map((t) => describeTab(w, t)));
    },
  },
  {
    name: "get_active_tab",
    description: "Get the active tab.",
    inputSchema: S(),
    run() {
      const w = win();
      return text(describeTab(w, w.gBrowser.selectedTab));
    },
  },
  {
    name: "open_tab",
    description: "Open a new tab with a URL or search text in the active Group. Returns the tab id.",
    inputSchema: S({ url: str("URL or search query"), background: bool("Open without switching to it") }, ["url"]),
    async run({ url, background }) {
      const w = win();
      const tab = w.gBrowser.addTrustedTab(resolveInput(w, url), { inBackground: !!background });
      if (!background) w.gBrowser.selectedTab = tab;
      await waitForLoad(tab);
      return text(describeTab(w, tab));
    },
  },
  {
    name: "switch_tab",
    description: "Activate a tab.",
    inputSchema: S({ tabId: str("Tab id") }, ["tabId"]),
    async run({ tabId }) {
      const w = win();
      const tab = findTab(w, tabId);
      if (w.gZenWorkspaces?.switchTabIfNeeded) await w.gZenWorkspaces.switchTabIfNeeded(tab);
      w.gBrowser.selectedTab = tab;
      return text("ok");
    },
  },
  {
    name: "close_tab",
    description: "Close a tab.",
    inputSchema: S({ tabId: str("Tab id") }, ["tabId"]),
    run({ tabId }) {
      const w = win();
      w.gBrowser.removeTab(findTab(w, tabId));
      return text("closed");
    },
  },
  {
    name: "navigate",
    description: "Navigate a tab to a URL (or search text) and wait for it to load.",
    inputSchema: S({ url: str("URL or search text"), tabId: TAB_ID }, ["url"]),
    async run({ url, tabId }) {
      const w = win();
      const tab = await ready(w, tabId);
      load(w, tab, resolveInput(w, url));
      await sleep(300);
      await waitForLoad(tab);
      return text(describeTab(w, tab));
    },
  },
  {
    name: "history",
    description: "Go back, forward or reload.",
    inputSchema: S({ action: { type: "string", enum: ["back", "forward", "reload"] }, tabId: TAB_ID }, ["action"]),
    async run({ action, tabId }) {
      const w = win();
      const tab = await ready(w, tabId);
      const b = tab.linkedBrowser;
      if (action === "back") b.goBack();
      else if (action === "forward") b.goForward();
      else b.reload();
      await sleep(300);
      await waitForLoad(tab);
      return text(describeTab(w, tab));
    },
  },
  {
    name: "get_page_text",
    description: "Get the readable text of the page (title, url, innerText).",
    inputSchema: S({ tabId: TAB_ID, maxChars: int("Maximum characters (default 20000)") }),
    async run({ tabId, maxChars }) {
      const tab = await ready(win(), tabId);
      const r = await query(tab, "IZI:PageText", { maxChars: maxChars || 20000 });
      return text(`# ${r.title}\n${r.url}\n\n${r.text}`);
    },
  },
  {
    name: "snapshot",
    description: "List interactive elements on the page with ref numbers. Use the refs with click/type.",
    inputSchema: S({ tabId: TAB_ID }),
    async run({ tabId }) {
      const tab = await ready(win(), tabId);
      const r = await query(tab, "IZI:Snapshot");
      return text(`Page: ${r.title}\nURL: ${r.url}\n\n${r.elements.join("\n") || "(no interactive elements found)"}`);
    },
  },
  {
    name: "click",
    description: "Click an element by ref (from snapshot) or CSS selector, using real (trusted) mouse events.",
    inputSchema: S({ ...TARGET, tabId: TAB_ID }),
    async run(a) {
      if (a.ref == null && !a.selector) throw new Error("Provide either ref or selector");
      const tab = await ready(win(), a.tabId);
      const r = await query(tab, "IZI:Click", { ref: a.ref, selector: a.selector });
      await sleep(300);
      await waitForLoad(tab, 10000);
      return text(r);
    },
  },
  {
    name: "type",
    description: "Type text into an input/textarea/contenteditable (by ref or selector).",
    inputSchema: S({ ...TARGET, text: str("Text to type"), clear: bool("Replace existing content (default true)"), submit: bool("Press Enter afterwards"), tabId: TAB_ID }, ["text"]),
    async run(a) {
      if (a.ref == null && !a.selector) throw new Error("Provide either ref or selector");
      const tab = await ready(win(), a.tabId);
      const r = await query(tab, "IZI:Type", { ref: a.ref, selector: a.selector, text: a.text, clear: a.clear !== false, submit: !!a.submit });
      if (a.submit) {
        await sleep(300);
        await waitForLoad(tab, 10000);
      }
      return text(r);
    },
  },
  {
    name: "press_key",
    description: "Press a key on the focused element (e.g. Enter, Tab, Escape, ArrowDown, PageDown, a).",
    inputSchema: S({ key: str("Key name"), tabId: TAB_ID }, ["key"]),
    async run({ key, tabId }) {
      const tab = await ready(win(), tabId);
      return text(await query(tab, "IZI:Key", { key }));
    },
  },
  {
    name: "scroll",
    description: "Scroll the page.",
    inputSchema: S({ direction: { type: "string", enum: ["up", "down", "top", "bottom"] }, amount: int("Pixels (default: one screen)"), tabId: TAB_ID }, ["direction"]),
    async run({ direction, amount, tabId }) {
      const tab = await ready(win(), tabId);
      return text(await query(tab, "IZI:Scroll", { direction, amount }));
    },
  },
  {
    name: "evaluate",
    description: "Run a JavaScript expression in the page (page privileges) and return its JSON-serializable result.",
    inputSchema: S({ expression: str("JavaScript expression; may use await"), tabId: TAB_ID }, ["expression"]),
    async run({ expression, tabId }) {
      const tab = await ready(win(), tabId);
      return text(await query(tab, "IZI:Eval", { expression }));
    },
  },
  {
    name: "screenshot",
    description: "Screenshot of the visible page (or the full page).",
    inputSchema: S({ fullPage: bool("Capture the whole page"), tabId: TAB_ID }),
    async run({ fullPage, tabId }) {
      const tab = await ready(win(), tabId);
      const { dataUrl } = await snapshotPng(tab, !!fullPage);
      const [head, data] = dataUrl.split(",");
      return { content: [{ type: "image", data, mimeType: head.includes("png") ? "image/png" : "image/jpeg" }] };
    },
  },
  {
    name: "wait_for",
    description: "Wait for a CSS selector to appear, or just wait ms.",
    inputSchema: S({ selector: str("CSS selector"), ms: int("Milliseconds to wait when no selector"), timeoutMs: int("Timeout (default 10000)"), tabId: TAB_ID }),
    async run({ selector, ms, timeoutMs = 10000, tabId }) {
      if (!selector) {
        await sleep(Math.min(ms || 1000, 30000));
        return text("waited");
      }
      const tab = await ready(win(), tabId);
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await query(tab, "IZI:Exists", { selector })) return text("found");
        await sleep(200);
      }
      throw new Error(`Timed out waiting for ${selector}`);
    },
  },
  {
    name: "capture_full_page",
    description: "Capture the whole page as PNG into Downloads/IZI DevSpace Captures. Returns the file path.",
    inputSchema: S({ tabId: TAB_ID }),
    async run({ tabId }) {
      const w = win();
      const tab = await ready(w, tabId);
      const { dataUrl, width, height } = await snapshotPng(tab, true);
      return text({ file: await savePng(w, tab, dataUrl), width, height });
    },
  },
  {
    name: "fake_fill",
    description: "Fill every form on the page with realistic fake data (for testing).",
    inputSchema: S({ tabId: TAB_ID }),
    async run({ tabId }) {
      const w = win();
      const tab = await ready(w, tabId);
      return text({ filled: await w.gIZIDevSpaceUI.fakeFillTab(tab) });
    },
  },
  {
    name: "mobile_view",
    description: "Turn mobile view (Responsive Design Mode) on or off for the active tab.",
    inputSchema: S({ enabled: bool("true = mobile view on") }, ["enabled"]),
    async run({ enabled }) {
      const w = win();
      if (isRDMOpen(w) !== !!enabled) w.gIZIDevSpaceUI["_cmd_izi-mobile-button"]?.();
      await sleep(1500);
      return text({ mobile: isRDMOpen(w) });
    },
  },
  {
    name: "sleep_tab",
    description: "Put a tab to sleep (unload it) to free memory.",
    inputSchema: S({ tabId: str("Tab id") }, ["tabId"]),
    async run({ tabId }) {
      const w = win();
      const tab = findTab(w, tabId);
      await w.gBrowser.explicitUnloadTabs([tab]);
      return text({ slept: tab.hasAttribute("pending") });
    },
  },
  {
    name: "dock_tab",
    description: "Show a tab side by side (split view) with the active tab; undock=true closes the split.",
    inputSchema: S({ tabId: str("Tab to dock beside the active tab"), undock: bool("Close the split view") }),
    run({ tabId, undock }) {
      const w = win();
      if (undock) w.gZenViewSplitter.unsplitCurrentView();
      else w.gZenViewSplitter.splitTabs([w.gBrowser.selectedTab, findTab(w, tabId)], "vsep", 0);
      return text("ok");
    },
  },
  {
    name: "create_group",
    description: "Create a Group (tab set) in the active Space, or in spaceId.",
    inputSchema: S({ name: str("Group name"), spaceId: int("Space id from list_spaces") }, ["name"]),
    async run({ name, spaceId }) {
      const w = win();
      const ui = w.gIZIDevSpaceUI;
      const ws = await ui.createGroup(spaceId ?? ui.activeSpaceId, name);
      return text({ id: ws?.uuid, name });
    },
  },
];

export const IZIMcpServer = new McpServer();

// Any change to izi.mcp.* (enable, port, token) re-applies the configuration.
Services.prefs.addObserver("izi.mcp.", () => IZIMcpServer.restart());
