'use strict';
// Google sign-in compatibility.
// Google refuses sign-in from browsers it classifies as "embedded Chromium". On the
// sign-in host(s) we present one consistent, current Firefox identity — in HTTP
// headers and in navigator.* — and every other site keeps the regular Chrome identity.
// Toggle: Settings → Google Sign-in (settings.compat.googleLogin).

const DEFAULT_HOSTS = ['accounts.google.com'];
const controllers = new Set();

// Firefox ships a new major version every 4 weeks (135 shipped 2025-02-04).
function firefoxVersion(now = Date.now()) {
  return 135 + Math.max(0, Math.floor((now - Date.UTC(2025, 1, 4)) / (28 * 864e5)) - 1);
}

function osInfo() {
  if (process.platform === 'darwin') return { ua: 'Macintosh; Intel Mac OS X 10.15', platform: 'MacIntel', appVersion: '5.0 (Macintosh)' };
  if (process.platform === 'win32') return { ua: 'Windows NT 10.0; Win64; x64', platform: 'Win32', appVersion: '5.0 (Windows)' };
  return { ua: 'X11; Linux x86_64', platform: 'Linux x86_64', appVersion: '5.0 (X11)' };
}

function firefoxUA() {
  const v = firefoxVersion();
  return `Mozilla/5.0 (${osInfo().ua}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
}

function hostsFrom(settings) {
  const extra = (process.env.IZI_COMPAT_EXTRA_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return settings?.compat?.googleLogin === false ? extra : [...DEFAULT_HOSTS, ...extra];
}

function matches(url, hosts) {
  try {
    const h = new URL(url).hostname;
    return hosts.some((x) => h === x || h.endsWith('.' + x));
  } catch {
    return false;
  }
}

// Page script, registered once per webContents; it only acts on matching hosts.
function shimSource(hosts) {
  const os = osInfo();
  return `(() => {
  const H = ${JSON.stringify(hosts)};
  const h = location.hostname;
  if (!H.some((x) => h === x || h.endsWith('.' + x))) return;
  try {
    const N = Navigator.prototype;
    const def = (k, v) => Object.defineProperty(N, k, { get: () => v, configurable: true });
    def('userAgent', ${JSON.stringify(firefoxUA())});
    def('appVersion', ${JSON.stringify(os.appVersion)});
    def('platform', ${JSON.stringify(os.platform)});
    def('oscpu', ${JSON.stringify(os.ua)});
    def('vendor', '');
    def('productSub', '20100101');
    delete N.userAgentData;
    try { delete window.chrome; } catch (e) {}
  } catch (e) {}
})();`;
}

// HTTP side. The identity follows the top-level page: the main-frame request to a
// sign-in host and every sub-request made by that page get the Firefox UA.
function installHeaderRewrite(ses, getHosts) {
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const hosts = getHosts();
    if (hosts.length) {
      let pageUrl = details.url;
      if (details.resourceType !== 'mainFrame') {
        try { pageUrl = details.webContents && !details.webContents.isDestroyed() ? details.webContents.getURL() || details.url : details.url; } catch {}
      }
      if (matches(pageUrl, hosts)) {
        const h = details.requestHeaders;
        for (const k of Object.keys(h)) if (/^user-agent$/i.test(k) || /^sec-ch-ua/i.test(k)) delete h[k];
        h['User-Agent'] = firefoxUA();
      }
    }
    cb({ requestHeaders: details.requestHeaders });
  });
}

// JS side: keep the shim registered on this webContents (re-registering if the
// debugger session was reset, e.g. by a crash or another client detaching it).
function attach(wc, getHosts) {
  const ctl = {
    scriptId: null,
    async refresh() {
      if (wc.isDestroyed()) return;
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Page.enable'); // scripts only run while the Page domain is enabled
        if (ctl.scriptId) {
          await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: ctl.scriptId }).catch(() => {});
          ctl.scriptId = null;
        }
        const hosts = getHosts();
        if (!hosts.length) return;
        const r = await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: shimSource(hosts) });
        ctl.scriptId = r.identifier;
      } catch (err) {
        console.warn('[compat]', err.message);
      }
    },
  };
  controllers.add(ctl);
  wc.once('destroyed', () => controllers.delete(ctl));
  wc.debugger.on('detach', () => { ctl.scriptId = null; });
  wc.on('did-start-navigation', () => { if (!ctl.scriptId && getHosts().length) ctl.refresh(); });
  // A brand-new tab/popup can commit its first document before the shim is registered.
  // If that document is a sign-in page, reload it once the shim is in place.
  let reloads = 0;
  wc.on('dom-ready', async () => {
    const hosts = getHosts();
    if (reloads >= 2 || !hosts.length || !matches(wc.getURL(), hosts)) return;
    try {
      const ok = await wc.executeJavaScript("navigator.userAgent.includes('Firefox/')", true);
      if (ok) return;
      if (!ctl.scriptId) await ctl.refresh();
      if (ctl.scriptId && !wc.isDestroyed()) { reloads++; wc.reload(); }
    } catch {}
  });
  ctl.refresh();
  return ctl;
}

// Call after the setting changes.
function refreshAll() { for (const c of controllers) c.refresh(); }

module.exports = { firefoxUA, firefoxVersion, hostsFrom, matches, installHeaderRewrite, attach, refreshAll, DEFAULT_HOSTS };
