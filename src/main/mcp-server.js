'use strict';
// Built-in MCP server (Streamable HTTP) that lets AI agents drive the browser.
const http = require('http');
const { randomUUID } = require('crypto');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const F = require('./features');

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function registerTools(server, browser, log) {
  const tool = (name, description, shape, handler) => {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      const started = Date.now();
      try {
        const res = await handler(args || {});
        log({ tool: name, args, ok: true, ms: Date.now() - started });
        return res;
      } catch (err) {
        log({ tool: name, args, ok: false, error: err.message, ms: Date.now() - started });
        return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    });
  };
  const tabId = z.string().optional().describe('Tab id (from list_tabs). Defaults to the active tab.');
  const target = { ref: z.number().int().optional().describe('Element ref number from snapshot'), selector: z.string().optional().describe('CSS selector (alternative to ref)') };
  const needTarget = (a) => { if (a.ref == null && !a.selector) throw new Error('Provide either ref or selector'); };

  const describeTab = (t) => {
    const s = browser.snapshot().tabs.find((x) => x.id === t.id);
    const g = browser.group(t.groupId);
    return { id: t.id, title: t.title, url: t.url, group: g?.name, groupId: g?.id, space: browser.space(g?.spaceId)?.name, active: browser.activeTab().id === t.id, sleeping: s?.sleeping, loading: s?.loading };
  };

  tool('list_spaces', 'List Spaces and their Groups.', {}, async () => text(browser.d.spaces.map((s) => ({
    id: s.id, name: s.name, active: browser.activeSpace().id === s.id,
    groups: browser.spaceGroups(s.id).map((g) => ({ id: g.id, name: g.name, tabs: browser.groupTabs(g.id).length, active: s.activeGroupId === g.id })),
  }))));

  tool('list_tabs', 'List tabs. By default only tabs in the active Space; set all=true for every Space.', { all: z.boolean().optional() }, async ({ all }) => {
    const sp = browser.activeSpace().id;
    const tabs = browser.d.tabs.filter((t) => all || browser.group(t.groupId)?.spaceId === sp);
    return text(tabs.map(describeTab));
  });

  tool('get_active_tab', 'Get the active tab.', {}, async () => text(describeTab(browser.activeTab())));

  tool('open_tab', 'Open a new tab with a URL (or search text). Returns the new tab id.', {
    url: z.string().describe('URL or search query'),
    groupId: z.string().optional(),
    background: z.boolean().optional().describe('Open without switching to it'),
  }, async ({ url, groupId, background }) => {
    const t = browser.createTab({ groupId, url: F.resolveInput(url, browser.d.settings.searchEngine), activate: !background });
    const { wc } = await browser.wcFor(t.id);
    return text({ ...describeTab(t), title: wc.getTitle() });
  });

  tool('switch_tab', 'Activate (focus) a tab.', { tabId: z.string() }, async ({ tabId: id }) => { browser.activateTab(browser.resolveTab(id).id); return text('ok'); });
  tool('close_tab', 'Close a tab.', { tabId: z.string() }, async ({ tabId: id }) => { browser.closeTab(browser.resolveTab(id).id); return text('closed'); });

  tool('navigate', 'Navigate a tab to a URL (or search text) and wait for it to load.', { url: z.string(), tabId }, async ({ url, tabId: id }) => {
    const { t, wc } = await browser.wcFor(id, { wait: false });
    const u = F.resolveInput(url, browser.d.settings.searchEngine);
    t.url = u;
    await wc.loadURL(u).catch(() => {});
    await browser.waitForLoad(wc);
    return text({ url: wc.getURL(), title: wc.getTitle() });
  });

  tool('history', 'Go back, forward or reload.', { action: z.enum(['back', 'forward', 'reload']), tabId }, async ({ action, tabId: id }) => {
    const { wc } = await browser.wcFor(id, { wait: false });
    if (action === 'back') wc.navigationHistory.goBack();
    if (action === 'forward') wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
    await sleep(150);
    await browser.waitForLoad(wc);
    return text({ url: wc.getURL(), title: wc.getTitle() });
  });

  tool('get_page_text', 'Get the readable text of the page (title, url, innerText).', { tabId, maxChars: z.number().int().optional() }, async ({ tabId: id, maxChars = 20000 }) => {
    const { wc } = await browser.wcFor(id);
    const res = await wc.executeJavaScript(`({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n') })`, true);
    const body = res.text.length > maxChars ? res.text.slice(0, maxChars) + `\n…[truncated ${res.text.length - maxChars} chars]` : res.text;
    return text(`# ${res.title}\n${res.url}\n\n${body}`);
  });

  tool('snapshot', 'List interactive elements on the page with ref numbers. Use the refs with click/type.', { tabId }, async ({ tabId: id }) => {
    const { wc } = await browser.wcFor(id);
    const res = await wc.executeJavaScript(F.SNAPSHOT_SCRIPT, true);
    return text(`Page: ${res.title}\nURL: ${res.url}\n\n${res.elements.join('\n') || '(no interactive elements found)'}`);
  });

  tool('click', 'Click an element by ref (from snapshot) or CSS selector, using real mouse events.', { ...target, tabId }, async (a) => {
    needTarget(a);
    const { wc } = await browser.wcFor(a.tabId);
    const pt = await wc.executeJavaScript(F.elementCenterScript(a), true);
    if (!pt) throw new Error('Element not found — run snapshot again');
    await sleep(60);
    const zoom = wc.getZoomFactor();
    const x = Math.round(pt.x * zoom); const y = Math.round(pt.y * zoom);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await sleep(300);
    await browser.waitForLoad(wc, 10000);
    return text({ clicked: pt.tag, url: wc.getURL(), title: wc.getTitle() });
  });

  tool('type', 'Type text into an input/textarea/contenteditable (by ref or selector).', {
    ...target, text: z.string(), clear: z.boolean().optional().describe('Replace existing content (default true)'), submit: z.boolean().optional().describe('Press Enter after typing'), tabId,
  }, async (a) => {
    needTarget(a);
    const { wc } = await browser.wcFor(a.tabId);
    const ok = await wc.executeJavaScript(F.focusScript(a, a.clear !== false), true);
    if (!ok) throw new Error('Element not found — run snapshot again');
    wc.focus();
    await wc.insertText(a.text);
    if (a.submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await sleep(300);
      await browser.waitForLoad(wc, 10000);
    }
    return text('typed');
  });

  tool('press_key', 'Press a key (e.g. Enter, Tab, Escape, ArrowDown, PageDown, a).', { key: z.string(), tabId }, async ({ key, tabId: id }) => {
    const { wc } = await browser.wcFor(id);
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: key });
    if (key.length === 1 || key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: key === 'Enter' ? '\r' : key });
    wc.sendInputEvent({ type: 'keyUp', keyCode: key });
    await sleep(120);
    return text('pressed ' + key);
  });

  tool('scroll', 'Scroll the page.', { direction: z.enum(['up', 'down', 'top', 'bottom']), amount: z.number().optional().describe('Pixels (default: one screen)'), tabId }, async ({ direction, amount, tabId: id }) => {
    const { wc } = await browser.wcFor(id);
    const js = {
      up: `window.scrollBy(0, -${amount || 'innerHeight * 0.85'})`,
      down: `window.scrollBy(0, ${amount || 'innerHeight * 0.85'})`,
      top: 'window.scrollTo(0, 0)',
      bottom: 'window.scrollTo(0, document.documentElement.scrollHeight)',
    }[direction];
    const pos = await wc.executeJavaScript(`${js}; ({ y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight })`, true);
    return text(pos);
  });

  tool('evaluate', 'Run JavaScript in the page and return the (JSON-serializable) result.', { expression: z.string(), tabId }, async ({ expression, tabId: id }) => {
    const { wc } = await browser.wcFor(id);
    const res = await wc.executeJavaScript(`(async () => { const __r = await (async () => (${expression}))(); try { return JSON.parse(JSON.stringify(__r)); } catch { return String(__r); } })()`, true);
    return text(res === undefined ? 'undefined' : res);
  });

  tool('screenshot', 'Take a screenshot of the visible viewport (or the full page).', { fullPage: z.boolean().optional(), tabId }, async ({ fullPage, tabId: id }) => {
    const { wc } = await browser.wcFor(id);
    let png;
    if (fullPage) png = (await F.captureFullPage(wc)).buffer;
    else {
      const img = await wc.capturePage();
      png = img.resize({ width: Math.min(img.getSize().width, 1280) }).toJPEG(80);
      return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/jpeg' }] };
    }
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
  });

  tool('wait_for', 'Wait for a CSS selector to appear (or just wait ms).', { selector: z.string().optional(), ms: z.number().int().optional(), timeoutMs: z.number().int().optional(), tabId }, async ({ selector, ms, timeoutMs = 10000, tabId: id }) => {
    if (!selector) { await sleep(Math.min(ms || 1000, 30000)); return text('waited'); }
    const { wc } = await browser.wcFor(id);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(selector)})`, true)) return text('found');
      await sleep(200);
    }
    throw new Error('Timed out waiting for ' + selector);
  });

  tool('capture_full_page', 'Capture the whole page and save it as PNG in Downloads/Tide Captures. Returns the file path.', { tabId }, async ({ tabId: id }) => {
    const { t } = await browser.wcFor(id);
    const file = await browser.capture(t);
    if (!file) throw new Error('Capture failed');
    return text({ file });
  });

  tool('fake_fill', 'Fill all forms on the page with realistic fake data (testing).', { tabId }, async ({ tabId: id }) => {
    const { t } = await browser.wcFor(id);
    return text({ filled: await browser.fakeFill(t) });
  });

  tool('mobile_view', 'Turn mobile emulation on/off for a tab.', { enabled: z.boolean(), device: z.enum(Object.keys(F.DEVICES)).optional(), tabId }, async ({ enabled, device, tabId: id }) => {
    const { t } = await browser.wcFor(id, { wait: false });
    const on = !!browser.runtime(t.id).mobile;
    if (enabled && (device || !on)) await browser.toggleMobile(t, device || browser.d.settings.mobileDevice);
    if (!enabled && on) await browser.toggleMobile(t);
    return text({ mobile: !!browser.runtime(t.id).mobile });
  });

  tool('sleep_tab', 'Put a tab to sleep to free memory.', { tabId: z.string() }, async ({ tabId: id }) => text({ slept: browser.sleepTab(browser.resolveTab(id).id) }));

  tool('dock_tab', 'Show a tab side-by-side (split view) with the active tab. Pass undock=true to close the split.', { tabId: z.string().optional(), undock: z.boolean().optional() }, async ({ tabId: id, undock }) => {
    if (undock) browser.dock(null); else browser.dock(browser.resolveTab(id).id);
    return text('ok');
  });

  tool('create_group', 'Create a new Group (in the active Space unless spaceId is given).', { name: z.string(), spaceId: z.string().optional() }, async ({ name, spaceId }) => {
    const g = browser.createGroup({ name, spaceId });
    return text({ id: g.id, name: g.name });
  });
}

class McpController {
  constructor(browser) {
    this.browser = browser;
    this.httpServer = null;
    this.sessions = new Map(); // sessionId -> { transport, server, client }
    this.error = null;
    browser.mcp = this;
  }

  get cfg() { return this.browser.d.settings.mcp; }

  status() {
    const port = this.cfg.port;
    return {
      enabled: !!this.cfg.enabled,
      running: !!this.httpServer?.listening,
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      token: this.cfg.token || '',
      clients: [...this.sessions.values()].map((s) => s.client).filter(Boolean),
      error: this.error,
    };
  }

  async setEnabled(on) {
    this.browser.d.settings.mcp = { ...this.cfg, enabled: on };
    if (on) await this.start(); else await this.stop();
    this.browser.changed();
  }

  async configure({ port, token }) {
    const p = Number(port);
    this.browser.d.settings.mcp = { ...this.cfg, ...(p >= 1024 && p < 65536 ? { port: p } : {}), ...(token !== undefined ? { token: String(token) } : {}) };
    if (this.cfg.enabled) { await this.stop(); await this.start(); }
    this.browser.changed();
  }

  newServer() {
    const server = new McpServer({ name: 'tide-browser', version: require('../../package.json').version }, {
      instructions: 'Tide Browser MCP: control the user\'s browser. Typical flow: list_tabs/open_tab -> snapshot -> click/type by ref -> get_page_text/screenshot. Tabs may be sleeping; tools wake them automatically.',
    });
    registerTools(server, this.browser, (e) => this.browser.logMcp(e));
    return server;
  }

  async start() {
    if (this.httpServer) return;
    const port = this.cfg.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    this.error = null;
    this.httpServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        // DNS-rebinding / cross-site protection
        if (!allowedHosts.includes(req.headers.host || '')) { res.writeHead(403).end('Forbidden host'); return; }
        const origin = req.headers.origin;
        if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { res.writeHead(403).end('Forbidden origin'); return; }
        if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, name: 'tide-browser' })); return; }
        if (url.pathname !== '/mcp') { res.writeHead(404).end('Not found'); return; }
        if (this.cfg.token && req.headers.authorization !== `Bearer ${this.cfg.token}`) { res.writeHead(401).end('Unauthorized'); return; }

        let body;
        if (req.method === 'POST') {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString('utf8');
          body = raw ? JSON.parse(raw) : undefined;
        }
        const sid = req.headers['mcp-session-id'];
        let entry = sid ? this.sessions.get(sid) : null;
        if (!entry) {
          if (req.method === 'POST' && !sid && (Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
            const server = this.newServer();
            const initMsg = Array.isArray(body) ? body.find(isInitializeRequest) : body;
            const client = initMsg?.params?.clientInfo ? `${initMsg.params.clientInfo.name} ${initMsg.params.clientInfo.version || ''}`.trim() : 'unknown client';
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              onsessioninitialized: (id) => { this.sessions.set(id, { transport, server, client }); this.browser.logMcp({ tool: 'connect', ok: true, args: { client } }); },
            });
            transport.onclose = () => { if (transport.sessionId) { this.sessions.delete(transport.sessionId); this.browser.changed(); } };
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
            return;
          }
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session' }, id: null }));
          return;
        }
        await entry.transport.handleRequest(req, res, body);
      } catch (err) {
        console.error('[mcp]', err);
        if (!res.headersSent) res.writeHead(500).end(String(err.message || err));
      }
    });
    await new Promise((resolve) => {
      this.httpServer.once('error', (err) => { this.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message; this.httpServer = null; resolve(); });
      this.httpServer.listen(port, '127.0.0.1', resolve);
    });
    this.browser.changed();
  }

  async stop() {
    for (const [, s] of this.sessions) { try { await s.transport.close(); } catch {} }
    this.sessions.clear();
    if (this.httpServer) await new Promise((r) => { this.httpServer.close(() => r()); this.httpServer.closeAllConnections?.(); });
    this.httpServer = null;
    this.browser.changed();
  }
}

module.exports = { McpController };
